import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import * as vscode from "vscode";
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

/* L'URL du serveur est modifiable de deux facons : le parametre VS Code
   "ledger.serverUrl" (visible/editable dans les Settings, pratique pour la
   changer sans repasser par la commande) ou la commande "Ledger: Configurer
   le serveur". Quand le parametre est renseigne, il est prioritaire — sinon
   on retombe sur la valeur enregistree dans sync_config.json (celle ecrite
   par l'agent CLI ou par une precedente utilisation de la commande). La cle
   API, elle, ne vit jamais dans les Settings VS Code (synchronises/partages
   en clair) : uniquement dans sync_config.json. */
export function getSettingUrl(): string {
  return (vscode.workspace.getConfiguration("ledger").get<string>("serverUrl") || "").trim();
}

export function loadConfig(): SyncConfig | null {
  const stored = readJson<SyncConfig>(CONFIG_FILE);
  const settingUrl = getSettingUrl();
  if (settingUrl) return { url: settingUrl, apiKey: stored?.apiKey || "", syncIntervalSeconds: stored?.syncIntervalSeconds };
  return stored;
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
