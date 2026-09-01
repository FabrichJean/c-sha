# Ledger — Token Sync (extension VS Code)

Synchronise automatiquement ta consommation de tokens Claude Code vers ton
serveur Ledger, directement depuis VS Code — sans installer l'agent CLI
séparément. Extension autonome (TypeScript, aucune dépendance à Python ni au
binaire `ledger-agent`).

## Fonctionnalités

- **Synchro en arrière-plan** — reste connectée au serveur via long-polling ;
  le bouton "Rafraîchir" du CRM déclenche une synchro en moins d'une seconde,
  sinon push automatique toutes les 4h.
- **Barre de statut** — indique l'état (actif / synchro en cours / erreur /
  non configuré) et l'heure de la dernière synchro ; clique dessus pour
  rafraîchir manuellement.
- **Commande "Ledger: Rafraîchir maintenant"** — palette de commandes
  (Cmd/Ctrl+Shift+P), pour forcer une synchro sans repasser par le CRM web.
- **Panneau de conso** — vue latérale (icône Ledger dans la barre d'activité)
  montrant la consommation du jour et du mois pour le dossier de projet
  actuellement ouvert (estimation locale, tarif par défaut).

## Installation

1. `npm install && npm run compile` dans ce dossier.
2. `npx vsce package` (nécessite `npm install -g @vscode/vsce` une fois) pour
   générer un fichier `.vsix`.
3. Dans VS Code : palette de commandes → "Extensions: Install from VSIX...".

## Configuration

Palette de commandes → **"Ledger: Configurer le serveur"** — demande l'URL du
serveur et la clé API de sync (`SYNC_API_KEY`, affichée au premier démarrage
du serveur ou dans `server/data/.env`).

La config est partagée avec l'agent CLI (`~/.ledger/`) : si l'agent CLI est
déjà configuré sur cette machine, l'extension le détecte et réutilise la même
identité d'appareil — pas de doublon dans le CRM.

## Développement

```bash
npm install
npm run watch      # rebuild automatique (esbuild --watch)
```

Puis F5 dans VS Code (ouvre ce dossier comme projet d'extension) pour lancer
une fenêtre "Extension Development Host" avec l'extension chargée.
