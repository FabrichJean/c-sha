#!/bin/bash
# Regenere l'export de consommation Claude Code et le pousse vers le serveur
# Ledger distant. Appele automatiquement par le LaunchAgent installe via
# install_autosync.sh, ou a la main pour forcer une synchro immediate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

CONFIG_FILE="$HOME/.ledger_sync.conf"
LOG_DIR="$HOME/Library/Logs/ledger-autosync"
mkdir -p "$LOG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Config introuvable : $CONFIG_FILE — lance d'abord ./configure_sync.sh" | tee -a "$LOG_DIR/sync.log" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG_FILE"

if [ -z "${LEDGER_URL:-}" ] || [ -z "${LEDGER_API_KEY:-}" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') — config incomplete (LEDGER_URL / LEDGER_API_KEY)" >> "$LOG_DIR/sync.log"
  exit 1
fi

PAYLOAD="$(python3 "$DIR/export_usage.py" --days 90 2>>"$LOG_DIR/sync.log")"

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
