import * as vscode from "vscode";
import { SyncStatus } from "./sync";

export function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "ledger.refresh";
  item.text = "$(sync) Ledger";
  item.tooltip = "Ledger — clique pour rafraîchir maintenant";
  item.show();
  return item;
}

function timeAgo(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `il y a ${sec}s`;
  if (sec < 3600) return `il y a ${Math.round(sec / 60)} min`;
  return `il y a ${Math.round(sec / 3600)} h`;
}

export function updateStatusBarItem(item: vscode.StatusBarItem, status: SyncStatus): void {
  switch (status.state) {
    case "unconfigured":
      item.text = "$(warning) Ledger : non configuré";
      item.tooltip = "Clique pour configurer le serveur Ledger";
      item.command = "ledger.configure";
      return;
    case "syncing":
      item.text = "$(sync~spin) Ledger : synchro…";
      item.tooltip = "Synchronisation en cours";
      item.command = "ledger.refresh";
      return;
    case "error":
      item.text = "$(error) Ledger : erreur";
      item.tooltip = `Échec de synchro${status.lastError ? " — " + status.lastError : ""} — clique pour réessayer`;
      item.command = "ledger.refresh";
      return;
    case "waiting":
    default:
      item.text = status.lastSyncAt ? "$(check) Ledger" : "$(sync) Ledger";
      item.tooltip = status.lastSyncAt
        ? `Dernière synchro ${timeAgo(status.lastSyncAt)} — clique pour rafraîchir`
        : "En attente de la première synchro — clique pour rafraîchir";
      item.command = "ledger.refresh";
      return;
  }
}
