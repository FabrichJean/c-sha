import * as os from "os";
import * as path from "path";

/* Memes chemins que l'agent CLI (agent/ledger_core.py) — une machine qui a les
   deux (extension VS Code + agent CLI/daemon installe a part) partage la meme
   identite d'appareil et la meme config, au lieu d'apparaitre deux fois dans
   le CRM. */
export const LEDGER_DIR = path.join(os.homedir(), ".ledger");
export const CONFIG_FILE = path.join(LEDGER_DIR, "sync_config.json");
export const DEVICE_FILE = path.join(LEDGER_DIR, "device.json");
export const STATE_FILE = path.join(LEDGER_DIR, "state.json");
export const LOG_DIR = path.join(LEDGER_DIR, "logs");
export const LOG_FILE = path.join(LOG_DIR, "sync.log");

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h, override possible via sync_config.json.syncIntervalSeconds
export const SYNC_WAIT_TIMEOUT_MS = 28000; // reste sous le plafond de 30s cote serveur
export const SYNC_WAIT_HTTP_TIMEOUT_MS = 35000;
