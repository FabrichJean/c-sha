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
dépendance à installer). Une fois le serveur en ligne, sur ta machine, dans le
dossier `agent/` du projet (pas dans `server/`) :

```bash
python3 configure_sync.py    # colle l'URL du serveur + la cle API de sync (une fois)
python3 install_autosync.py  # programme la synchro (une fois)
```

Sur Windows, remplace `python3` par `python`. `install_autosync.py` installe un
**processus persistant** (`ledger_agent.py daemon`), supervisé par le
planificateur natif de l'OS (qui le relance s'il s'arrête) :

- **macOS** : LaunchAgent (`launchd`, `KeepAlive`) — les fichiers sont copiés
  dans `~/Library/Application Support/Ledger/` car `launchd` ne peut pas
  accéder aux fichiers sous `~/Documents` (protection TCC).
- **Linux** : service `systemd --user` (`ledger-tokensync.service`,
  `Restart=always`). Si `systemd --user` n'est pas disponible (certains
  conteneurs/VPS minimalistes), repli automatique sur une entrée `crontab`
  classique (latence jusqu'à ~60s au lieu de quasi instantané).
- **Windows** : tâche planifiée (`schtasks`, déclenchement à l'ouverture de
  session + démarrage immédiat après l'installation, nom `LedgerTokenSync`).

Le daemon reste connecté au serveur via **long-polling**
(`GET /api/sync-wait`, sondage interne toutes les 500ms côté serveur) : le
bouton "Rafraîchir" du CRM déclenche une synchro en moins d'une seconde au
lieu d'attendre jusqu'à 60s le prochain passage planifié. En dehors d'une
demande explicite, un push automatique a lieu toutes les 4h. Il lit
`~/.claude/projects/**/*.jsonl`, agrège les tokens et les pousse directement
sur `POST /api/sync` — sans presse-papiers, sans copier-coller, sans
navigateur ouvert. Config et logs dans `~/.ledger/` (identique sur les trois
OS). Pour désinstaller : `python3 uninstall_autosync.py`.

Pour une synchro ponctuelle manuelle (sans passer par le daemon) :
`python3 sync_usage.py`.

### WSL (Windows Subsystem for Linux)

Installer l'agent *dans* WSL suit le chemin Linux (`systemd --user`), mais
attention : `~/.claude/projects` côté WSL est un dossier Linux distinct de
celui où Claude Code (qui tourne nativement sous Windows) écrit vraiment ses
logs. L'agent détecte automatiquement le bon dossier côté Windows
(`/mnt/c/Users/<toi>/.claude/projects`) **si un seul profil Windows en a
un** — sinon (plusieurs comptes sur la même machine), précise-le explicitement
via une variable d'environnement ou dans `~/.ledger/sync_config.json` :

```bash
LEDGER_CLAUDE_DIR=/mnt/c/Users/tonnom/.claude/projects python3 sync_usage.py
```

ou en ajoutant `"claudeDir": "/mnt/c/Users/tonnom/.claude/projects"` dans
`sync_config.json`.

### Sans Python installé

Une seule commande télécharge le binaire de la dernière Release GitHub
correspondant à l'OS courant. `LEDGER_URL` et `LEDGER_SYNC_API_KEY` évitent les
prompts interactifs — indispensable via `curl | bash`, où le pipe consomme déjà
le stdin du script, et sur certains terminaux sans vrai TTY (panels web,
`docker exec` sans `-t`, etc.) :

```bash
# macOS / Linux
LEDGER_URL="https://ton-serveur" LEDGER_SYNC_API_KEY="ta_cle" \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/FabrichJean/c-sha/main/agent/install.sh)"
```

```powershell
# Windows (PowerShell)
$env:LEDGER_URL = "https://ton-serveur"; $env:LEDGER_SYNC_API_KEY = "ta_cle"
irm https://raw.githubusercontent.com/FabrichJean/c-sha/main/agent/install.ps1 | iex
```

Sans ces variables, le script télécharge quand même le binaire mais n'essaie
plus de deviner s'il peut lire un prompt : il affiche juste les commandes à
lancer soi-même (marche dans un terminal réellement interactif) :

```bash
~/.ledger/bin/ledger-agent configure
~/.ledger/bin/ledger-agent install
```

Le binaire est installé dans `~/.ledger/bin/` (`%USERPROFILE%\.ledger\bin\` sur
Windows) sous un nom stable (`ledger-agent` / `ledger-agent.exe`, sans le
numéro de version). Pour resynchroniser/désinstaller ensuite :
`~/.ledger/bin/ledger-agent sync|uninstall`. Les binaires publiés sur la page
Releases portent eux le tag de version dans leur nom (ex.
`ledger-agent-linux-v0.3.1`, `ledger-agent-windows-v0.3.1.exe`) et sont
générés automatiquement par `.github/workflows/release.yml` à chaque tag `v*`
poussé sur le dépôt — il faut qu'au moins une release existe avant de lancer
ces scripts.

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
