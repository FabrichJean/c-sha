#!/usr/bin/env python3
"""
Logique partagee de l'agent Ledger (sync / configure / install / uninstall),
utilisee a la fois par les scripts individuels (sync_usage.py, configure_sync.py,
install_autosync.py, uninstall_autosync.py) et par ledger_agent.py, le point
d'entree unique empaquete en executable autonome avec PyInstaller pour les
machines sans Python.

`generate_export` est importe directement (pas de sous-processus) pour que
tout tienne dans un seul binaire fige.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

from export_usage import generate_export

LEDGER_DIR = Path.home() / ".ledger"
CONFIG_FILE = LEDGER_DIR / "sync_config.json"
DEVICE_FILE = LEDGER_DIR / "device.json"
STATE_FILE = LEDGER_DIR / "state.json"
LOG_DIR = LEDGER_DIR / "logs"
LOG_FILE = LOG_DIR / "sync.log"

SYNC_INTERVAL_SECONDS = 14400  # 4h — override possible via sync_config.json ("syncIntervalSeconds")
LABEL = "com.mdledger.tokensync"
WINDOWS_TASK_NAME = "LedgerTokenSync"


def is_frozen() -> bool:
    """True quand ce code tourne depuis un executable PyInstaller (ledger_agent)."""
    return bool(getattr(sys, "frozen", False))


def log(msg: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{ts} — {msg}\n")


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def ensure_device() -> dict:
    device = load_json(DEVICE_FILE)
    if device and device.get("id"):
        return device
    device = {"id": "dev-" + uuid.uuid4().hex[:10], "name": platform.node() or "Appareil inconnu"}
    save_json(DEVICE_FILE, device)
    log(f"Nouvel appareil enregistre : {device['name']} ({device['id']})")
    return device


def http_call(method: str, url: str, api_key: str, body: dict | None = None, timeout: int = 15):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
        return resp.status, (json.loads(raw) if raw else {})


def run_export(device: dict) -> dict | None:
    try:
        result, _count = generate_export(days=90, device_id=device["id"], device_name=device["name"])
        return result
    except FileNotFoundError as e:
        log(f"echec export : {e}")
        return None


def do_sync(config: dict, device: dict, reason: str) -> bool:
    payload = run_export(device)
    if payload is None:
        return False
    url = config["url"].rstrip("/") + "/api/sync"
    try:
        status, _ = http_call("POST", url, config["apiKey"], body=payload)
    except urllib.error.HTTPError as e:
        log(f"echec sync ({reason}, HTTP {e.code})")
        return False
    except Exception as e:  # reseau, timeout, etc.
        log(f"echec sync ({reason}) : {e}")
        return False
    if status == 200:
        save_json(STATE_FILE, {"lastSyncAt": time.time()})
        log(f"sync OK ({reason}, HTTP {status})")
        return True
    log(f"echec sync ({reason}, HTTP {status})")
    return False


def main_sync() -> int:
    config = load_json(CONFIG_FILE)
    if not config or not config.get("url") or not config.get("apiKey"):
        return 0  # pas encore configure — configure_sync.py n'a pas ete lance

    device = ensure_device()
    base = config["url"].rstrip("/")
    interval = config.get("syncIntervalSeconds", SYNC_INTERVAL_SECONDS)

    requested = False
    try:
        qs = urllib.parse.urlencode({"deviceId": device["id"], "deviceName": device["name"]})
        _, resp = http_call("GET", f"{base}/api/sync-status?{qs}", config["apiKey"])
        requested = bool(resp.get("requested"))
    except Exception as e:
        log(f"echec verification statut : {e}")

    if requested:
        ok = do_sync(config, device, "demande depuis le CRM")
        return 0 if ok else 1

    state = load_json(STATE_FILE, {}) or {}
    last = state.get("lastSyncAt", 0)
    if time.time() - last >= interval:
        ok = do_sync(config, device, "intervalle automatique")
        return 0 if ok else 1

    return 0


SYNC_WAIT_TIMEOUT_MS = 28000  # cote serveur, cap a 30s (voir server.js) ; on reste un peu en dessous
SYNC_WAIT_HTTP_TIMEOUT = 35  # doit depasser SYNC_WAIT_TIMEOUT_MS pour laisser le long-poll repondre normalement
SYNC_WAIT_ERROR_BACKOFF = 10


def main_daemon() -> int:
    """Processus persistant (supervise par launchd/systemd/Task Scheduler) : reste
    connecte au serveur via long-polling (/api/sync-wait) pour reagir en quasi
    temps reel au bouton 'Rafraichir', sans dependre du plancher a 1 minute des
    planificateurs OS. Remplace l'ancien modele 'relance toutes les 60s'."""
    log("daemon demarre")
    while True:
        config = load_json(CONFIG_FILE)
        if not config or not config.get("url") or not config.get("apiKey"):
            time.sleep(5)
            continue

        device = ensure_device()
        base = config["url"].rstrip("/")
        interval = config.get("syncIntervalSeconds", SYNC_INTERVAL_SECONDS)

        try:
            qs = urllib.parse.urlencode({
                "deviceId": device["id"],
                "deviceName": device["name"],
                "timeoutMs": SYNC_WAIT_TIMEOUT_MS,
            })
            _, resp = http_call("GET", f"{base}/api/sync-wait?{qs}", config["apiKey"], timeout=SYNC_WAIT_HTTP_TIMEOUT)
        except Exception as e:
            log(f"echec long-poll : {e}")
            time.sleep(SYNC_WAIT_ERROR_BACKOFF)
            continue

        if resp.get("requested"):
            do_sync(config, device, "demande depuis le CRM (long-poll)")
            continue  # on relance tout de suite le long-poll, pas d'attente

        state = load_json(STATE_FILE, {}) or {}
        last = state.get("lastSyncAt", 0)
        if time.time() - last >= interval:
            do_sync(config, device, "intervalle automatique")
        # sinon : le long-poll a deja consomme jusqu'a ~28s, on reboucle directement


def main_configure() -> int:
    # LEDGER_URL / LEDGER_SYNC_API_KEY permettent une configuration non-interactive
    # (scripts d'installation, terminaux sans TTY reel comme certains panels web
    # ou 'docker exec' sans -t, ou l'ont deja en env pour ne pas re-saisir la cle).
    url = os.environ.get("LEDGER_URL", "").strip()
    api_key = os.environ.get("LEDGER_SYNC_API_KEY", "").strip()

    if not url or not api_key:
        try:
            if not url:
                url = input("URL du serveur Ledger (ex: https://ledger.mondomaine.com) : ").strip()
            if not api_key:
                api_key = input("Cle API de sync (SYNC_API_KEY du serveur) : ").strip()
        except EOFError:
            pass

    if not url or not api_key:
        print("URL et cle API sont requises.", file=sys.stderr)
        print("Sans terminal interactif, definis-les en variables d'environnement, ex :", file=sys.stderr)
        print("  LEDGER_URL=https://ledger.mondomaine.com LEDGER_SYNC_API_KEY=... python3 configure_sync.py", file=sys.stderr)
        return 1

    save_json(CONFIG_FILE, {"url": url, "apiKey": api_key})
    print(f"Config enregistree dans {CONFIG_FILE}")

    print("Test de connexion...")
    ok = main_sync() == 0
    if ok:
        print("OK — synchro reussie (voir ~/.ledger/logs/sync.log pour le detail).")
        return 0
    print("Echec — verifie l'URL, la cle, et ~/.ledger/logs/sync.log.", file=sys.stderr)
    return 1


SYSTEMD_UNIT_NAME = "ledger-tokensync.service"


def _agent_files_dir() -> Path:
    return Path(__file__).resolve().parent


def _install_agent_copy(agent_dir: Path) -> list[str]:
    """Copie les fichiers necessaires au daemon dans agent_dir (hors du repo,
    cf. restriction TCC macOS sur ~/Documents) et renvoie la commande a lancer."""
    agent_dir.mkdir(parents=True, exist_ok=True)
    if is_frozen():
        binary_path = Path(sys.executable)
        target = agent_dir / binary_path.name
        shutil.copy(binary_path, target)
        target.chmod(0o755)
        return [str(target), "daemon"]
    script_dir = _agent_files_dir()
    for name in ("export_usage.py", "ledger_core.py", "ledger_agent.py", "sync_usage.py", "configure_sync.py"):
        shutil.copy(script_dir / name, agent_dir / name)
    return [sys.executable, str(agent_dir / "ledger_agent.py"), "daemon"]


def install_mac() -> None:
    agent_dir = Path.home() / "Library" / "Application Support" / "Ledger" / "agent"
    program_args = _install_agent_copy(agent_dir)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    plist_path = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    args_xml = "".join(f"    <string>{a}</string>\n" for a in program_args)
    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{args_xml}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{LOG_DIR / "launchd.out.log"}</string>
  <key>StandardErrorPath</key>
  <string>{LOG_DIR / "launchd.err.log"}</string>
</dict>
</plist>
"""
    plist_path.write_text(plist, encoding="utf-8")
    subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True)
    subprocess.run(["launchctl", "load", str(plist_path)], check=True)
    print(f"Synchro automatique installee (macOS, launchd, processus persistant : {LABEL}).")
    print(f"Fichiers de l'agent : {agent_dir}")


def _systemd_available() -> bool:
    if not shutil.which("systemctl"):
        return False
    # 'systemctl --user' a besoin d'un bus de session utilisateur — absent sur
    # certains VPS/conteneurs minimalistes meme quand systemd est installe.
    probe = subprocess.run(["systemctl", "--user", "status"], capture_output=True, text=True)
    return probe.returncode in (0, 3)  # 3 = systemd repond mais aucune unite dans cet etat


def install_linux() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    if _systemd_available():
        agent_dir = Path.home() / ".ledger" / "agent"
        program_args = _install_agent_copy(agent_dir)
        exec_start = " ".join(program_args)
        unit_dir = Path.home() / ".config" / "systemd" / "user"
        unit_dir.mkdir(parents=True, exist_ok=True)
        unit_path = unit_dir / SYSTEMD_UNIT_NAME
        unit_path.write_text(f"""[Unit]
Description=Ledger token sync agent

[Service]
ExecStart={exec_start}
Restart=always
RestartSec=5
StandardOutput=append:{LOG_DIR / "daemon.out.log"}
StandardError=append:{LOG_DIR / "daemon.err.log"}

[Install]
WantedBy=default.target
""", encoding="utf-8")
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME], check=True)
        # Permet au service de tourner meme sans session graphique/SSH active (VPS).
        # Peut echouer sans privilege suffisant — non bloquant, juste informatif.
        linger = subprocess.run(["loginctl", "enable-linger", os.environ.get("USER", "")], capture_output=True, text=True)
        print(f"Synchro automatique installee (Linux, systemd --user, processus persistant : {SYSTEMD_UNIT_NAME}).")
        if linger.returncode != 0:
            print("Note : 'loginctl enable-linger' a echoue (permissions) — le service peut s'arreter a la deconnexion SSH.", file=sys.stderr)
            print("Demande a un admin de lancer : sudo loginctl enable-linger " + os.environ.get("USER", "<utilisateur>"), file=sys.stderr)
        print("Verifie avec : systemctl --user status " + SYSTEMD_UNIT_NAME)
        return

    # repli sans systemd : ancien modele par intervalle (latence jusqu'a ~60s)
    print("systemd --user indisponible sur cette machine — repli sur cron (latence jusqu'a ~60s au lieu de quasi instantane).", file=sys.stderr)
    cron_log = LOG_DIR / "cron.log"
    if is_frozen():
        cmd = [sys.executable, "sync"]
    else:
        cmd = [sys.executable, str(_agent_files_dir() / "sync_usage.py")]
    cron_line = f"* * * * * {' '.join(cmd)} >> {cron_log} 2>&1"

    existing = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
    lines = existing.stdout.splitlines() if existing.returncode == 0 else []
    lines = [l for l in lines if "sync_usage.py" not in l and "ledger_agent" not in l]
    lines.append(cron_line)
    proc = subprocess.run(["crontab", "-"], input="\n".join(lines) + "\n", text=True)
    if proc.returncode != 0:
        print("Echec de l'installation crontab — verifie que 'cron' est installe.", file=sys.stderr)
        sys.exit(1)
    print("Synchro automatique installee (Linux, cron : verification chaque minute).")
    print("Verifie avec : crontab -l")


def _windows_task_xml(command: str, arguments: str) -> str:
    """Definition XML complete (au lieu de 'schtasks /Create /TR' basique) —
    necessaire pour desactiver 3 comportements par defaut du Planificateur de
    taches Windows qui tuent silencieusement un daemon cense tourner en
    continu, en particulier sur un portable :
      - ExecutionTimeLimit : 72h par defaut, la tache est tuee au-dela ; on
        passe a PT0S (illimite).
      - StopIfGoingOnBatteries : vrai par defaut, arrete la tache des que le
        portable debranche le secteur.
      - RestartOnFailure : absent par defaut ; on redemarre automatiquement
        (equivalent du KeepAlive de launchd / Restart=always de systemd)."""
    from xml.sax.saxutils import escape
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Ledger — agent de synchro des tokens (processus persistant)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escape(command)}</Command>
      <Arguments>{escape(arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
"""


def install_windows() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if is_frozen():
        program_args = [sys.executable, "daemon"]
    else:
        python_exe = shutil.which("pythonw") or sys.executable
        program_args = [python_exe, str(_agent_files_dir() / "ledger_agent.py"), "daemon"]

    command = program_args[0]
    arguments = " ".join(f'"{a}"' if " " in a else a for a in program_args[1:])
    xml_path = LEDGER_DIR / "task.xml"
    xml_path.parent.mkdir(parents=True, exist_ok=True)
    xml_path.write_text(_windows_task_xml(command, arguments), encoding="utf-16")

    subprocess.run(["schtasks", "/End", "/TN", WINDOWS_TASK_NAME], capture_output=True)
    subprocess.run(["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], capture_output=True)
    result = subprocess.run(
        ["schtasks", "/Create", "/TN", WINDOWS_TASK_NAME, "/XML", str(xml_path), "/F"],
        capture_output=True, text=True,
    )
    xml_path.unlink(missing_ok=True)
    if result.returncode != 0:
        print(f"Echec de l'installation (schtasks) : {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    # demarre tout de suite, sans attendre la prochaine ouverture de session
    subprocess.run(["schtasks", "/Run", "/TN", WINDOWS_TASK_NAME], capture_output=True)
    print(f"Synchro automatique installee (Windows, tache planifiee, processus persistant : {WINDOWS_TASK_NAME}).")
    print("Illimitee en duree, resiste au passage sur batterie, redemarre seule si le processus s'arrete.")
    print("Verifie avec : schtasks /Query /TN " + WINDOWS_TASK_NAME)


def main_install() -> int:
    system = platform.system()
    if system == "Darwin":
        install_mac()
    elif system == "Linux":
        install_linux()
    elif system == "Windows":
        install_windows()
    else:
        print(f"OS non reconnu automatiquement : {system}", file=sys.stderr)
        print("Lance 'ledger_agent.py daemon' toi-meme, supervise par ton propre outil (systemd, supervisord...).", file=sys.stderr)
        return 1
    print("Processus persistant : reagit en quasi temps reel au bouton \"Rafraichir\" (long-polling) ; push automatique toutes les 4h sinon.")
    print(f"Config attendue dans : {CONFIG_FILE} (voir configure_sync.py / 'ledger_agent configure')")
    print("Pour desinstaller : python3 uninstall_autosync.py (ou 'ledger_agent uninstall')")
    return 0


def uninstall_mac() -> None:
    plist_path = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True)
    plist_path.unlink(missing_ok=True)
    agent_dir = Path.home() / "Library" / "Application Support" / "Ledger"
    shutil.rmtree(agent_dir, ignore_errors=True)
    print("Synchro automatique desinstallee (macOS).")


def uninstall_linux() -> None:
    if shutil.which("systemctl"):
        subprocess.run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME], capture_output=True)
        unit_path = Path.home() / ".config" / "systemd" / "user" / SYSTEMD_UNIT_NAME
        unit_path.unlink(missing_ok=True)
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    agent_dir = Path.home() / ".ledger" / "agent"
    shutil.rmtree(agent_dir, ignore_errors=True)

    existing = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
    if existing.returncode == 0:
        lines = [l for l in existing.stdout.splitlines() if "sync_usage.py" not in l and "ledger_agent" not in l]
        subprocess.run(["crontab", "-"], input="\n".join(lines) + ("\n" if lines else ""), text=True)
    print("Synchro automatique desinstallee (Linux).")


def uninstall_windows() -> None:
    subprocess.run(["schtasks", "/End", "/TN", WINDOWS_TASK_NAME], capture_output=True)
    result = subprocess.run(["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], capture_output=True, text=True)
    if result.returncode == 0:
        print("Synchro automatique desinstallee (Windows).")
    else:
        print("Aucune tache planifiee trouvee (ou deja supprimee).")


def main_uninstall() -> int:
    system = platform.system()
    if system == "Darwin":
        uninstall_mac()
    elif system == "Linux":
        uninstall_linux()
    elif system == "Windows":
        uninstall_windows()
    else:
        print(f"OS non reconnu : {system}", file=sys.stderr)
        return 1
    return 0
