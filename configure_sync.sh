#!/bin/bash
# Configure une seule fois l'URL du serveur Ledger distant et la cle API de
# sync (affichee au premier demarrage du serveur, ou dans server/.env).
set -euo pipefail
CONFIG_FILE="$HOME/.ledger_sync.conf"

read -rp "URL du serveur Ledger (ex: https://ledger.mondomaine.com) : " url
read -rsp "Cle API de sync (SYNC_API_KEY du serveur) : " key
echo

cat > "$CONFIG_FILE" <<EOF
LEDGER_URL="${url}"
LEDGER_API_KEY="${key}"
EOF
chmod 600 "$CONFIG_FILE"

echo "Config enregistree dans $CONFIG_FILE"
echo "Test de connexion..."
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$DIR/sync_usage.sh" && echo "OK — synchro reussie." || echo "Echec — verifie l'URL et la cle."
