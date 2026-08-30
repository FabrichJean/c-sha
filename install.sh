#!/usr/bin/env bash
# Installe l'agent Ledger sans avoir besoin de Python : telecharge le binaire
# de la derniere Release GitHub correspondant a l'OS courant, puis lance
# 'configure' et 'install'.
#
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/FabrichJean/c-sha/main/install.sh | bash
set -euo pipefail

REPO="FabrichJean/c-sha"
DEST_DIR="$HOME/.ledger/bin"
mkdir -p "$DEST_DIR"

case "$(uname -s)" in
  Darwin) ASSET="ledger-agent-macos" ;;
  Linux)  ASSET="ledger-agent-linux" ;;
  *)
    echo "OS non reconnu par ce script. Sur Windows, utilise install.ps1." >&2
    exit 1
    ;;
esac

echo "Recuperation de la derniere release ($ASSET)..."
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep "\"browser_download_url\"" \
  | grep "$ASSET" \
  | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')

if [ -z "$URL" ]; then
  echo "Aucune release trouvee avec l'asset $ASSET. Cree d'abord un tag (ex: v0.1.0) pour declencher le build." >&2
  exit 1
fi

curl -fsSL "$URL" -o "$DEST_DIR/ledger-agent"
chmod +x "$DEST_DIR/ledger-agent"
echo "Binaire installe : $DEST_DIR/ledger-agent"
echo

# Ce script est presque toujours lance via 'curl ... | bash' : dans ce cas,
# stdin est deja consomme par le pipe (c'est le script lui-meme), donc les
# prompts interactifs de 'configure' liraient EOF immediatement. On relit le
# terminal directement via /dev/tty quand c'est possible.
if exec 3</dev/tty 2>/dev/null; then
  exec 3<&-
  "$DEST_DIR/ledger-agent" configure < /dev/tty
  "$DEST_DIR/ledger-agent" install
  echo
  echo "Termine. Pour resynchroniser/desinstaller : $DEST_DIR/ledger-agent sync|uninstall"
else
  echo "Aucun terminal interactif detecte (ex: SSH non-tty, script automatise)."
  echo "Termine la configuration a la main :"
  echo "  $DEST_DIR/ledger-agent configure"
  echo "  $DEST_DIR/ledger-agent install"
fi
