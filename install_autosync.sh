#!/bin/bash
# Installe une synchro automatique en tache de fond (LaunchAgent macOS).
# sync_usage.sh est appele toutes les 60s mais ne pousse reellement les
# donnees que toutes les 4h OU immediatement si le bouton "Rafraichir" du
# CRM a demande une synchro (voir /api/request-sync) — le check frequent
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$DIR/sync_usage.sh"

PLIST_LABEL="com.mdledger.tokensync"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/sync_usage.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>14400</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/ledger-autosync/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/ledger-autosync/launchd.err.log</string>
</dict>
</plist>
EOF

mkdir -p "$HOME/Library/Logs/ledger-autosync"
launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"

echo "Synchro automatique installee : $PLIST_LABEL"
echo "Frequence : toutes les 4h, + immediatement au chargement."
echo "Logs : ~/Library/Logs/ledger-autosync/"
echo "Pour desinstaller : ./uninstall_autosync.sh"
