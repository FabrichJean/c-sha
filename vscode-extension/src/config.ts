import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { CONFIG_FILE, DEVICE_FILE, STATE_FILE } from "./paths";
import { log } from "./log";

export interface SyncConfig {
  url: string;
  apiKey: string;
  syncIntervalSeconds?: number;
}

export interface Device {
  id: string;
  name: string;
}

export interface SyncState {
  lastSyncAt?: number;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (e) {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(require("path").dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

export function loadConfig(): SyncConfig | null {
  return readJson<SyncConfig>(CONFIG_FILE);
}

export function saveConfig(config: SyncConfig): void {
  writeJson(CONFIG_FILE, config);
}

/* meme convention d'id que l'agent CLI (dev-<hex>) — si sync_config.json ou
   device.json existent deja (agent CLI installe en parallele sur la meme
   machine), on les reutilise tels quels plutot que de creer un doublon. */
export function ensureDevice(): Device {
  const existing = readJson<Device>(DEVICE_FILE);
  if (existing && existing.id) return existing;
  const device: Device = {
    id: "dev-" + crypto.randomBytes(5).toString("hex"),
    name: os.hostname() || "Appareil VS Code",
  };
  writeJson(DEVICE_FILE, device);
  log(`Nouvel appareil enregistre (extension VS Code) : ${device.name} (${device.id})`);
  return device;
}

export function loadState(): SyncState {
  return readJson<SyncState>(STATE_FILE) || {};
}

export function saveState(state: SyncState): void {
  writeJson(STATE_FILE, state);
}
