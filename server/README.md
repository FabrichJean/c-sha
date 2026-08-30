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

Une fois le serveur en ligne, sur ta machine (à la racine du projet, pas dans `server/`) :

```bash
./configure_sync.sh      # colle l'URL du serveur + la cle API de sync (une fois)
./install_autosync.sh    # programme la synchro toutes les 4h (une fois)
```

`sync_usage.sh` lit ensuite `~/.claude/projects/**/*.jsonl`, agrège les tokens
et les pousse directement sur `POST /api/sync` du serveur — sans presse-papiers,
sans copier-coller, sans navigateur ouvert.

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port d'écoute HTTP | `3000` |
| `CRM_USER` | Utilisateur Basic Auth de l'interface | `admin` |
| `CRM_PASSWORD` | Mot de passe Basic Auth de l'interface | généré au 1er démarrage |
| `SYNC_API_KEY` | Clé Bearer pour `POST /api/sync` (utilisée par `sync_usage.sh`) | générée au 1er démarrage |

## Endpoints

- `GET /api/state` (Basic Auth) — clients, projets, conso, tarifs, dernière synchro
- `POST /api/sync` (Bearer `SYNC_API_KEY`) — ingestion en masse depuis `export_usage.py`
- `POST /api/import` (Basic Auth) — même ingestion, déclenchée depuis l'UI (secours)
- `POST/PUT/DELETE /api/clients[/:id]`, `/api/projects[/:id]` — CRUD
- `PUT /api/pricing` — grille tarifaire
