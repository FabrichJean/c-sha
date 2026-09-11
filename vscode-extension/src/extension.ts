import * as vscode from "vscode";
import { loadConfig, saveConfig, getSettingUrl } from "./config";
import { SyncDaemon, SyncStatus } from "./sync";
import { createStatusBarItem, updateStatusBarItem } from "./statusBar";
import { UsagePanelProvider } from "./panel";
import { setLogSink, log } from "./log";

let daemon: SyncDaemon | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Ledger");
  setLogSink(output);
  context.subscriptions.push(output);

  const statusBarItem = createStatusBarItem();
  context.subscriptions.push(statusBarItem);

  const panelProvider = new UsagePanelProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(UsagePanelProvider.viewType, panelProvider)
  );

  daemon = new SyncDaemon();
  daemon.on("status", (status: SyncStatus) => {
    updateStatusBarItem(statusBarItem, status);
    if (status.state === "waiting" || status.state === "error") panelProvider.refresh();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("ledger.configure", async () => {
      const existing = loadConfig();
      const url = await vscode.window.showInputBox({
        title: "Ledger — URL du serveur",
        prompt: "Adresse de ton serveur Ledger (ex: https://ledger.mondomaine.com)",
        value: existing?.url || "",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : "L'URL est requise."),
      });
      if (url === undefined) return; // annule

      const apiKey = await vscode.window.showInputBox({
        title: "Ledger — Clé API de sync",
        prompt: "SYNC_API_KEY affichée au premier démarrage du serveur (ou dans server/data/.env)",
        password: true,
        ignoreFocusOut: true,
        value: existing?.apiKey || "",
        validateInput: (v) => (v.trim() ? null : "La clé API est requise."),
      });
      if (apiKey === undefined) return; // annule

      saveConfig({ url: url.trim(), apiKey: apiKey.trim() });
      // on reflete aussi l'URL dans le parametre VS Code "ledger.serverUrl"
      // (Settings UI) pour que les deux facons de la configurer restent en phase.
      await vscode.workspace
        .getConfiguration("ledger")
        .update("serverUrl", url.trim(), vscode.ConfigurationTarget.Global);
      log("Configuration enregistree via la commande Ledger: Configurer le serveur.");
      vscode.window.showInformationMessage("Ledger : configuration enregistrée. Test de connexion en cours…");

      const ok = await daemon?.forceSync();
      if (ok) {
        vscode.window.showInformationMessage("Ledger : connexion réussie, synchro effectuée.");
      } else {
        vscode.window.showWarningMessage(
          "Ledger : échec de la synchro de test — vérifie l'URL et la clé (voir la sortie \"Ledger\" pour le détail)."
        );
      }
      panelProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ledger.refresh", async () => {
      const config = loadConfig();
      if (!config || !config.url || !config.apiKey) {
        const choice = await vscode.window.showWarningMessage(
          "Ledger n'est pas encore configuré.",
          "Configurer maintenant"
        );
        if (choice) vscode.commands.executeCommand("ledger.configure");
        return;
      }
      const ok = await daemon?.forceSync();
      if (ok) vscode.window.setStatusBarMessage("Ledger : données à jour", 3000);
      else vscode.window.showWarningMessage("Ledger : la synchro a échoué — voir la sortie \"Ledger\" pour le détail.");
    })
  );

  daemon.start();
  context.subscriptions.push({ dispose: () => daemon?.stop() });

  const watcher = vscode.workspace.onDidChangeWorkspaceFolders(() => panelProvider.refresh());
  context.subscriptions.push(watcher);

  // l'URL peut aussi etre changee directement dans les Settings VS Code
  // (parametre "ledger.serverUrl") sans repasser par la commande : on
  // reagit au changement pour retester la connexion et rafraichir l'UI.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("ledger.serverUrl")) return;
      const newUrl = getSettingUrl();
      if (!newUrl) return;
      log(`URL du serveur modifiee via les parametres VS Code : ${newUrl}`);
      const config = loadConfig();
      if (!config?.apiKey) {
        vscode.window
          .showWarningMessage(
            "Ledger : URL mise à jour, mais aucune clé API n'est enregistrée.",
            "Configurer la clé API"
          )
          .then((choice) => {
            if (choice) vscode.commands.executeCommand("ledger.configure");
          });
        return;
      }
      const ok = await daemon?.forceSync();
      if (ok) vscode.window.setStatusBarMessage("Ledger : nouvelle URL testée avec succès", 3000);
      else vscode.window.showWarningMessage("Ledger : échec de connexion à la nouvelle URL — voir la sortie \"Ledger\".");
      panelProvider.refresh();
    })
  );
}

export function deactivate(): void {
  daemon?.stop();
}
