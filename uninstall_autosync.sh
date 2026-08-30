#!/bin/bash
# Retire la synchro automatique installee par install_autosync.sh.
set -euo pipefail
PLIST_LABEL="com.mdledger.tokensync"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
rm -rf "$HOME/Library/Application Support/Ledger"
echo "Synchro automatique desinstallee."
