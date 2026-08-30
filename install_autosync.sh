#!/bin/bash
# Installe une synchro automatique en tache de fond (LaunchAgent macOS).
#
# Important : macOS bloque les LaunchAgents qui accedent a des fichiers sous
# ~/Documents, ~/Desktop ou ~/Downloads (protection TCC) meme quand
# l'execution manuelle en terminal fonctionne (l'app Terminal a deja recu le
# consentement, mais pas /bin/bash lance par launchd). On copie donc les
# fichiers necessaires a l'agent dans ~/Library/Application Support/Ledger/,
# hors de ce perimetre protege, et le LaunchAgent tourne depuis la.
#
# sync_usage.sh est appele toutes les 60s mais ne pousse reellement les
# donnees que toutes les 4h OU immediatement si le bouton "Rafraichir" du
# CRM a demande une synchro (voir /api/request-sync) — le check frequent
# est une simple requete HTTP legere, pas un export complet a chaque fois.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGENT_DIR="$HOME/Library/Application Support/Ledger/agent"
mkdir -p "$AGENT_DIR"
cp "$DIR/export_usage.py" "$DIR/sync_usage.sh" "$AGENT_DIR/"
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
  <integer>60</integer>
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
echo "Check toutes les 60s ; push reel toutes les 4h ou sur demande depuis le CRM."
echo "Logs : ~/Library/Logs/ledger-autosync/"
echo "Pour desinstaller : ./uninstall_autosync.sh"
