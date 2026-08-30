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


def main_configure() -> int:
    url = input("URL du serveur Ledger (ex: https://ledger.mondomaine.com) : ").strip()
    api_key = input("Cle API de sync (SYNC_API_KEY du serveur) : ").strip()

    if not url or not api_key:
        print("URL et cle API sont requises.", file=sys.stderr)
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


def _sync_command_args() -> list[str]:
    """Commande a enregistrer dans le planificateur pour declencher 'sync'."""
    if is_frozen():
        return [sys.executable, "sync"]
    script_dir = Path(__file__).resolve().parent
    return [sys.executable, str(script_dir / "sync_usage.py")]


def install_mac() -> None:
    agent_dir = Path.home() / "Library" / "Application Support" / "Ledger" / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)

    if is_frozen():
        binary_path = Path(sys.executable)
        target = agent_dir / binary_path.name
        shutil.copy(binary_path, target)
        target.chmod(0o755)
        program_args = [str(target), "sync"]
    else:
        script_dir = Path(__file__).resolve().parent
        for name in ("export_usage.py", "sync_usage.py"):
            shutil.copy(script_dir / name, agent_dir / name)
        program_args = [sys.executable, str(agent_dir / "sync_usage.py")]

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
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
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
    print(f"Synchro automatique installee (macOS, launchd : {LABEL}).")
    print(f"Fichiers de l'agent : {agent_dir}")


def install_linux() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    cron_log = LOG_DIR / "cron.log"
    cmd = _sync_command_args()
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


def install_windows() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if is_frozen():
        cmd_parts = [sys.executable, "sync"]
    else:
        python_exe = shutil.which("pythonw") or sys.executable
        script_dir = Path(__file__).resolve().parent
        cmd_parts = [python_exe, str(script_dir / "sync_usage.py")]
    tr = " ".join(f'"{p}"' for p in cmd_parts)
    subprocess.run(["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], capture_output=True)
    cmd = [
        "schtasks", "/Create",
        "/SC", "MINUTE", "/MO", "1",
        "/TN", WINDOWS_TASK_NAME,
        "/TR", tr,
        "/F",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Echec de l'installation (schtasks) : {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    print(f"Synchro automatique installee (Windows, tache planifiee : {WINDOWS_TASK_NAME}).")
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
        print("Lance sync_usage.py toi-meme via ton propre planificateur (toutes les 1-5 min).", file=sys.stderr)
        return 1
    print("Check toutes les 60s (ou chaque minute) ; push reel toutes les 4h ou sur demande depuis le CRM.")
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
    existing = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
    if existing.returncode != 0:
        print("Aucune crontab existante.")
        return
    lines = [l for l in existing.stdout.splitlines() if "sync_usage.py" not in l and "ledger_agent" not in l]
    subprocess.run(["crontab", "-"], input="\n".join(lines) + ("\n" if lines else ""), text=True)
    print("Synchro automatique desinstallee (Linux, entree crontab retiree).")


def uninstall_windows() -> None:
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
