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
# prompts interactifs de 'configure' liraient EOF immediatement — et /dev/tty
# n'est pas fiable partout (panels web, 'docker exec' sans -t, etc.). On passe
# donc par les variables d'environnement LEDGER_URL / LEDGER_SYNC_API_KEY si
# elles sont definies ; sinon on n'essaie pas de deviner et on affiche juste
# les commandes a lancer soi-meme.
if [ -n "${LEDGER_URL:-}" ] && [ -n "${LEDGER_SYNC_API_KEY:-}" ]; then
  "$DEST_DIR/ledger-agent" configure
  "$DEST_DIR/ledger-agent" install
  echo
  echo "Termine. Pour resynchroniser/desinstaller : $DEST_DIR/ledger-agent sync|uninstall"
else
  echo "Pour terminer, definis LEDGER_URL et LEDGER_SYNC_API_KEY puis relance ce script :"
  echo "  LEDGER_URL=https://ton-serveur LEDGER_SYNC_API_KEY=ta_cle bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh)\""
  echo
  echo "Ou configure a la main (marche toujours si tu as un terminal interactif) :"
  echo "  $DEST_DIR/ledger-agent configure"
  echo "  $DEST_DIR/ledger-agent install"
fi
