# Ledger — serveur auto-hébergé

CRM pour suivre la consommation de tokens Claude Code, avec sa propre base
(SQLite) et une API que ta machine locale alimente automatiquement.

## Démarrer en local

```bash
cd server
npm install
node server.js
```

Au premier démarrage, un mot de passe CRM et une clé API de sync sont générés
et affichés dans le terminal, puis stockés dans `server/data/.env`. Note-les
(ou relis ce fichier) — ils ne sont montrés qu'une fois.

Ouvre `http://localhost:3000` (identifiants : `admin` / le mot de passe généré).

## Déployer sur un serveur distant

### Avec Docker (recommandé)

```bash
docker build -t ledger .
docker run -d --name ledger \
  -p 3000:3000 \
  -v ledger_data:/app/data \
  ledger
```

Le volume `ledger_data` garde la base SQLite et les identifiants entre deux
redéploiements. Pour fixer toi-même les secrets plutôt que de laisser le
serveur les générer, ajoute :

```bash
  -e CRM_PASSWORD='...' -e SYNC_API_KEY='...'
```

Mets ensuite un reverse proxy (Caddy, nginx, Traefik) devant avec HTTPS —
les identifiants passent en Basic Auth / Bearer, donc TLS est indispensable
dès que le serveur est exposé publiquement.

### Sans Docker (VPS classique)

```bash
cd server
npm install --omit=dev
CRM_PASSWORD='...' SYNC_API_KEY='...' PORT=3000 node server.js
```

Fais-le tourner avec `pm2`, `systemd` ou équivalent pour qu'il redémarre tout seul.

## Brancher la synchro automatique locale

Cross-platform (Windows / macOS / Linux, Python standard uniquement — aucune
dépendance à installer). Une fois le serveur en ligne, sur ta machine (à la
racine du projet, pas dans `server/`) :

```bash
python3 configure_sync.py    # colle l'URL du serveur + la cle API de sync (une fois)
python3 install_autosync.py  # programme la synchro (une fois)
```

Sur Windows, remplace `python3` par `python`. `install_autosync.py` détecte
l'OS et utilise le planificateur natif :

- **macOS** : LaunchAgent (`launchd`) — les scripts sont copiés dans
  `~/Library/Application Support/Ledger/` car `launchd` ne peut pas accéder
  aux fichiers sous `~/Documents` (protection TCC).
- **Linux** : entrée `crontab` (vérification chaque minute).
- **Windows** : tâche planifiée (`schtasks`, nom `LedgerTokenSync`).

`sync_usage.py` lit ensuite `~/.claude/projects/**/*.jsonl`, agrège les tokens
et les pousse directement sur `POST /api/sync` du serveur — sans presse-papiers,
sans copier-coller, sans navigateur ouvert. Config et logs dans `~/.ledger/`
(identique sur les trois OS). Pour désinstaller : `python3 uninstall_autosync.py`.

### Sans Python installé

Une seule commande télécharge le binaire de la dernière Release GitHub
correspondant à l'OS courant et lance directement `configure` puis `install` :

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/FabrichJean/c-sha/main/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/FabrichJean/c-sha/main/install.ps1 | iex
```

Le binaire est installé dans `~/.ledger/bin/` (`%USERPROFILE%\.ledger\bin\` sur
Windows). Pour resynchroniser/désinstaller ensuite : `~/.ledger/bin/ledger-agent
sync|uninstall`. Les binaires (`ledger-agent-macos`, `ledger-agent-linux`,
`ledger-agent-windows.exe`) sont générés automatiquement par
`.github/workflows/release.yml` à chaque tag `v*` poussé sur le dépôt — il faut
qu'au moins une release existe avant de lancer ces scripts.

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port d'écoute HTTP | `3000` |
| `CRM_USER` | Utilisateur Basic Auth de l'interface | `admin` |
| `CRM_PASSWORD` | Mot de passe Basic Auth de l'interface | généré au 1er démarrage |
| `SYNC_API_KEY` | Clé Bearer pour `POST /api/sync` (utilisée par `sync_usage.py`) | générée au 1er démarrage |

## Endpoints

- `GET /api/state` (Basic Auth) — clients, projets, conso, tarifs, dernière synchro
- `POST /api/sync` (Bearer `SYNC_API_KEY`) — ingestion en masse depuis `export_usage.py`
- `POST /api/import` (Basic Auth) — même ingestion, déclenchée depuis l'UI (secours)
- `POST/PUT/DELETE /api/clients[/:id]`, `/api/projects[/:id]` — CRUD
- `PUT /api/pricing` — grille tarifaire
