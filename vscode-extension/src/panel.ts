import * as vscode from "vscode";
import * as path from "path";
import { generateExport } from "./exportUsage";
import { estimateCost, totalTokens } from "./pricing";
import { loadState } from "./config";
import { fetchDeviceStatus, DeviceStatus } from "./deviceStatus";

function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

function timeAgo(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `il y a ${sec}s`;
  if (sec < 3600) return `il y a ${Math.round(sec / 60)} min`;
  if (sec < 86400) return `il y a ${Math.round(sec / 3600)} h`;
  return `il y a ${Math.round(sec / 86400)} j`;
}

function currentProjectKey(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return path.basename(folders[0].uri.fsPath);
}

/* Panneau lateral : conso du PROJET OUVERT uniquement, calculee localement a
   partir des logs Claude Code — l'extension n'a pas acces a la grille
   tarifaire ni aux autres appareils/projets du CRM (elle n'a que la cle API
   de sync), donc c'est volontairement une estimation locale et scopee. */
export class UsagePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ledger.usagePanel";
  private view: vscode.WebviewView | undefined;
  private cachedStatus: DeviceStatus | null = null;

  refresh(): void {
    if (this.view) this.view.webview.html = this.render();
    // le statut/facturation vient du serveur (pas calculable localement) :
    // on rend d'abord avec le cache existant (jamais de blocage visuel), puis
    // on rafraichit en tache de fond et on re-rend a l'arrivee.
    this.refreshDeviceStatusInBackground();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = this.render();
    this.refreshDeviceStatusInBackground();
  }

  private refreshDeviceStatusInBackground(): void {
    fetchDeviceStatus().then((status) => {
      if (status) this.cachedStatus = status; // sur echec transitoire, on garde la derniere valeur connue plutot que d'effacer
      if (this.view) this.view.webview.html = this.render();
    });
  }

  private render(): string {
    const projectKey = currentProjectKey();
    if (!projectKey) {
      return this.wrap(`<p class="muted">Ouvre un dossier de projet pour voir sa consommation.</p>`);
    }

    let todayTokens = 0;
    let monthTokens = 0;
    let todayCost = 0;
    let monthCost = 0;
    let error: string | null = null;
    try {
      const { result } = generateExport(35, null, null);
      const project = result.projects.find((p) => p.projectKey === projectKey);
      const today = new Date().toISOString().slice(0, 10);
      const thisMonth = new Date().toISOString().slice(0, 7);
      if (project) {
        for (const month of project.months) {
          if (month.yyyymm !== thisMonth) continue;
          for (const m of month.models) {
            for (const [date, t] of Object.entries(m.daily)) {
              // le cout depend du modele : on l'estime ligne par ligne (par
              // modele) plutot que d'agreger d'abord les tokens tous modeles
              // confondus puis d'appliquer un seul tarif — sinon un projet
              // qui utilise Opus/Haiku affiche un cout errone (tarif Sonnet).
              const tok = totalTokens(t);
              const cost = estimateCost(m.model, t);
              monthTokens += tok;
              monthCost += cost;
              if (date === today) {
                todayTokens += tok;
                todayCost += cost;
              }
            }
          }
        }
      }
    } catch (e: any) {
      error = e.message || String(e);
    }

    if (error) {
      return this.wrap(`<p class="muted">Impossible de lire les logs locaux : ${escapeHtml(error)}</p>`);
    }

    const state = loadState();
    const lastSync = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString("fr-FR") : "jamais";

    return this.wrap(`
      <div class="proj">${escapeHtml(projectKey)}</div>
      <div class="grid">
        <div class="stat">
          <div class="label">Aujourd'hui</div>
          <div class="value">${fmtTokens(todayTokens)} tok</div>
          <div class="cost">≈ ${fmtUsd(todayCost)}</div>
        </div>
        <div class="stat">
          <div class="label">Ce mois-ci</div>
          <div class="value">${fmtTokens(monthTokens)} tok</div>
          <div class="cost">≈ ${fmtUsd(monthCost)}</div>
        </div>
      </div>
      <p class="muted small">Estimation locale (tarif par défaut, hors remise éventuelle du CRM) · dernière synchro : ${lastSync}</p>
      ${this.renderDeviceStatusSection()}
    `);
  }

  /* Statut + facturation de CET appareil, tels que renvoyes par le serveur
     (meme cloisonnement que device.html : jamais le nom du client). Absent
     tant que la premiere synchro n'a pas eu lieu, ou si le serveur ne
     supporte pas encore /api/device-status (ancienne version). */
  private renderDeviceStatusSection(): string {
    const s = this.cachedStatus;
    if (!s) return "";

    const promo = s.currentPromoCodeId
      ? s.promotions.flatMap((p) => p.codes.map((c) => ({ ...c, promotionName: p.name, divisor: p.divisor }))).find((c) => c.id === s.currentPromoCodeId)
      : null;
    const remaining = Math.max(0, s.totalCost - s.billing.totalPaid);

    return `
      <div class="sep"></div>
      <div class="row">
        <span class="dot ${s.seen ? "on" : "off"}"></span>
        <strong>${s.seen ? "Actif" : "Hors ligne"}</strong>
        <span class="muted inline">dernier contact ${timeAgo(s.device.lastSeen)}</span>
      </div>
      ${
        s.hasClient
          ? `<div class="row" style="margin-top:6px"><span class="muted inline">Code promo</span> ${
              promo ? `<code>${escapeHtml(promo.code)}</code> (÷${promo.divisor})` : `<span class="muted">—</span>`
            }</div>`
          : ""
      }
      <div class="grid" style="margin-top:8px">
        <div class="stat">
          <div class="label">Coût total</div>
          <div class="value">${fmtUsd(s.totalCost)}</div>
        </div>
        <div class="stat">
          <div class="label">Payé</div>
          <div class="value good">${fmtUsd(s.billing.totalPaid)}</div>
        </div>
        <div class="stat">
          <div class="label">Restant</div>
          <div class="value ${remaining > 0 ? "warn" : ""}">${fmtUsd(remaining)}</div>
        </div>
      </div>
    `;
  }

  private wrap(body: string): string {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 14px; font-size: 13px; }
  .proj { font-weight: 600; font-size: 13.5px; margin-bottom: 10px; }
  .grid { display: flex; gap: 12px; }
  .stat { flex: 1; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; padding: 8px 10px; }
  .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin-bottom: 4px; }
  .value { font-family: var(--vscode-editor-font-family); font-size: 15px; font-weight: 600; }
  .cost { font-size: 11.5px; opacity: .75; margin-top: 2px; }
  .muted { opacity: .65; }
  .small { font-size: 11px; margin-top: 12px; }
  .sep { border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); margin: 14px 0 12px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .row .inline { margin-left: 2px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-editorWarning-foreground); flex-shrink: 0; }
  .dot.on { background: var(--vscode-testing-iconPassed, #3fb950); }
  .value.good { color: var(--vscode-testing-iconPassed, #3fb950); }
  .value.warn { color: var(--vscode-editorWarning-foreground); }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>${body}</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
