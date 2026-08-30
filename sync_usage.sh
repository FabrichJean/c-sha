#!/bin/bash
# Verifie s'il faut synchroniser (soit parce que l'intervalle normal est
# ecoule, soit parce que le bouton "Rafraichir" du CRM a demande une synchro
# immediate via /api/request-sync), et si oui, regenere l'export et le pousse
# vers le serveur Ledger distant.
#
# Appele frequemment (toutes les 60s, voir install_autosync.sh) : le check
# est une simple requete HTTP legere, le vrai export ne tourne que si besoin.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

CONFIG_FILE="$HOME/.ledger_sync.conf"
LOG_DIR="$HOME/Library/Logs/ledger-autosync"
STATE_FILE="$LOG_DIR/last_sync_at"
mkdir -p "$LOG_DIR"

# Intervalle max entre deux synchros automatiques (secondes). Override possible
# dans ~/.ledger_sync.conf avec SYNC_INTERVAL_SECONDS=...
SYNC_INTERVAL_SECONDS=14400

if [ ! -f "$CONFIG_FILE" ]; then
  exit 0  # pas encore configure — ./configure_sync.sh n'a pas ete lance
fi
# shellcheck source=/dev/null
source "$CONFIG_FILE"

if [ -z "${LEDGER_URL:-}" ] || [ -z "${LEDGER_API_KEY:-}" ]; then
  exit 0
fi
BASE_URL="${LEDGER_URL%/}"

do_sync() {
  local reason="$1"
  PAYLOAD="$(python3 "$DIR/export_usage.py" --days 90 2>>"$LOG_DIR/sync.log")"
  HTTP_CODE=$(curl -sS -o "$LOG_DIR/last_response.json" -w "%{http_code}" \
    -X POST "$BASE_URL/api/sync" \
    -H "Authorization: Bearer $LEDGER_API_KEY" \
    -H "Content-Type: application/json" \
    --data-binary "$PAYLOAD")
  if [ "$HTTP_CODE" = "200" ]; then

HTTP_CODE=$(curl -sS -o "$LOG_DIR/last_response.json" -w "%{http_code}" \
  -X POST "${LEDGER_URL%/}/api/sync" \
  -H "Authorization: Bearer $LEDGER_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD")

if [ "$HTTP_CODE" = "200" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — sync OK ($HTTP_CODE) -> $LEDGER_URL" >> "$LOG_DIR/sync.log"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') — echec sync (HTTP $HTTP_CODE) -> voir $LOG_DIR/last_response.json" >> "$LOG_DIR/sync.log"
  exit 1
fi
