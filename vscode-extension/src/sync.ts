import { EventEmitter } from "events";
import { loadConfig, ensureDevice, loadState, saveState, SyncConfig, Device } from "./config";
import { generateExport, ExportResult } from "./exportUsage";
import { httpCall } from "./httpClient";
import { log } from "./log";
import { SYNC_INTERVAL_MS, SYNC_WAIT_TIMEOUT_MS, SYNC_WAIT_HTTP_TIMEOUT_MS } from "./paths";

export type SyncState = "unconfigured" | "waiting" | "syncing" | "error";

export interface SyncStatus {
  state: SyncState;
  lastSyncAt: number | null;
  lastError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* Reste connecte au serveur via long-polling (GET /api/sync-wait), exactement
   comme le daemon de l'agent CLI (agent/ledger_core.py::main_daemon) — reagit
   en quasi temps reel au bouton "Rafraichir" du CRM sans repoller en boucle
   serree. Tourne tant que l'extension est active (activate -> start,
   deactivate -> stop). */
export class SyncDaemon extends EventEmitter {
  private stopped = true;
  private syncing = false;

  start(): void {
    if (!this.stopped) return; // deja demarre
    this.stopped = false;
    this.loop().catch((e) => log(`daemon: boucle arretee de facon inattendue : ${e}`));
  }

  stop(): void {
    this.stopped = true;
  }

  async forceSync(): Promise<boolean> {
    const config = loadConfig();
    if (!config || !config.url || !config.apiKey) {
      this.emitStatus({ state: "unconfigured", lastSyncAt: null });
      return false;
    }
    const device = ensureDevice();
    return this.doSync(config, device, "commande Rafraichir");
  }

  private emitStatus(status: SyncStatus): void {
    this.emit("status", status);
  }

  private async doSync(config: SyncConfig, device: Device, reason: string): Promise<boolean> {
    if (this.syncing) return false; // evite un chevauchement (force + auto en meme temps)
    this.syncing = true;
    this.emitStatus({ state: "syncing", lastSyncAt: loadState().lastSyncAt || null });
    try {
      let payload: ExportResult;
      try {
        payload = generateExport(90, device.id, device.name).result;
      } catch (e: any) {
        log(`echec export (${reason}) : ${e.message || e}`);
        this.emitStatus({ state: "error", lastSyncAt: loadState().lastSyncAt || null, lastError: e.message });
        return false;
      }
      const url = config.url.replace(/\/$/, "") + "/api/sync";
      try {
        const { status } = await httpCall("POST", url, config.apiKey, payload);
        if (status === 200) {
          const now = Date.now();
          saveState({ lastSyncAt: now });
          log(`sync OK (${reason}, HTTP ${status})`);
          this.emitStatus({ state: "waiting", lastSyncAt: now });
          return true;
        }
        log(`echec sync (${reason}, HTTP ${status})`);
        this.emitStatus({ state: "error", lastSyncAt: loadState().lastSyncAt || null, lastError: `HTTP ${status}` });
        return false;
      } catch (e: any) {
        log(`echec sync (${reason}) : ${e.message || e}`);
        this.emitStatus({ state: "error", lastSyncAt: loadState().lastSyncAt || null, lastError: e.message });
        return false;
      }
    } finally {
      this.syncing = false;
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const config = loadConfig();
      if (!config || !config.url || !config.apiKey) {
        this.emitStatus({ state: "unconfigured", lastSyncAt: null });
        await sleep(5000);
        continue;
      }
      const device = ensureDevice();
      const base = config.url.replace(/\/$/, "");
      const interval = (config.syncIntervalSeconds ?? SYNC_INTERVAL_MS / 1000) * 1000;

      let requested = false;
      try {
        const qs = new URLSearchParams({
          deviceId: device.id,
          deviceName: device.name,
          timeoutMs: String(SYNC_WAIT_TIMEOUT_MS),
        });
        const { body } = await httpCall(
          "GET",
          `${base}/api/sync-wait?${qs.toString()}`,
          config.apiKey,
          undefined,
          SYNC_WAIT_HTTP_TIMEOUT_MS
        );
        requested = !!body.requested;
        if (!this.syncing) this.emitStatus({ state: "waiting", lastSyncAt: loadState().lastSyncAt || null });
      } catch (e: any) {
        log(`echec long-poll : ${e.message || e}`);
        this.emitStatus({ state: "error", lastSyncAt: loadState().lastSyncAt || null, lastError: e.message });
        await sleep(10000);
        continue;
      }

      if (this.stopped) break;

      if (requested) {
        await this.doSync(config, device, "demande depuis le CRM (long-poll)");
        continue; // on relance tout de suite le long-poll, pas d'attente
      }

      const state = loadState();
      const last = state.lastSyncAt || 0;
      if (Date.now() - last >= interval) {
        await this.doSync(config, device, "intervalle automatique");
      }
    }
  }
}
