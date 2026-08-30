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
    date +%s > "$STATE_FILE"
    echo "$(date '+%Y-%m-%d %H:%M:%S') — sync OK ($reason, HTTP $HTTP_CODE)" >> "$LOG_DIR/sync.log"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') — echec sync ($reason, HTTP $HTTP_CODE) -> voir $LOG_DIR/last_response.json" >> "$LOG_DIR/sync.log"
    exit 1
  fi
}

# 1) Une synchro a-t-elle ete demandee depuis le CRM ("Rafraichir") ?
STATUS_JSON="$(curl -sS -m 8 "$BASE_URL/api/sync-status" -H "Authorization: Bearer $LEDGER_API_KEY" || echo '{}')"
REQUESTED="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('requested', False))" "$STATUS_JSON" 2>/dev/null || echo "False")"

if [ "$REQUESTED" = "True" ]; then
  do_sync "demande depuis le CRM"
  exit 0
fi

# 2) Sinon, respecter le rythme automatique normal.
LAST_RUN=0
[ -f "$STATE_FILE" ] && LAST_RUN="$(cat "$STATE_FILE")"
NOW="$(date +%s)"
if [ $((NOW - LAST_RUN)) -ge "$SYNC_INTERVAL_SECONDS" ]; then
  do_sync "intervalle automatique"
fi
