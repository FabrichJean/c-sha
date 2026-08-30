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
chmod +x "$AGENT_DIR/sync_usage.sh"

# Identite de cet appareil : generee une seule fois, reutilisee a chaque reinstall.
DEVICE_FILE="$AGENT_DIR/device.conf"
if [ ! -f "$DEVICE_FILE" ]; then
  DEVICE_ID="dev-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:10])')"
  DEVICE_NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || hostname)"
  cat > "$DEVICE_FILE" <<EOF
DEVICE_ID="$DEVICE_ID"
DEVICE_NAME="$DEVICE_NAME"
EOF
  echo "Nouvel appareil enregistre : $DEVICE_NAME ($DEVICE_ID)"
else
  # shellcheck source=/dev/null
  source "$DEVICE_FILE"
  echo "Appareil existant reutilise : $DEVICE_NAME ($DEVICE_ID)"
fi

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
    <string>$AGENT_DIR/sync_usage.sh</string>
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

sleep 2
STATUS_LINE="$(launchctl list | grep "$PLIST_LABEL" || true)"
LAST_EXIT="$(echo "$STATUS_LINE" | awk '{print $2}')"

echo "Synchro automatique installee : $PLIST_LABEL"
echo "Fichiers de l'agent : $AGENT_DIR"
echo "Check toutes les 60s ; push reel toutes les 4h ou sur demande depuis le CRM."
echo "Logs : ~/Library/Logs/ledger-autosync/"
if [ "$LAST_EXIT" != "0" ] && [ -n "$LAST_EXIT" ]; then
  echo ""
  echo "ATTENTION : code de sortie $LAST_EXIT au demarrage — verifie ~/Library/Logs/ledger-autosync/launchd.err.log"
fi
echo "Pour desinstaller : ./uninstall_autosync.sh"
