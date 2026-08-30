#!/usr/bin/env python3
"""
Point d'entree unique de l'agent Ledger, pour les machines sans Python
installe : empaquete en executable autonome par PyInstaller (une seule
fois par OS, via .github/workflows/release.yml) et publie sur la page
Releases du depot.

Usage (binaire) :
    ledger-agent configure   # equivalent de configure_sync.py
    ledger-agent sync        # equivalent de sync_usage.py
    ledger-agent install     # equivalent de install_autosync.py
    ledger-agent uninstall   # equivalent de uninstall_autosync.py

Usage (depuis les sources, identique) :
    python3 ledger_agent.py sync
"""
from __future__ import annotations

import argparse
import sys

from ledger_core import main_configure, main_install, main_sync, main_uninstall

COMMANDS = {
    "sync": main_sync,
    "configure": main_configure,
    "install": main_install,
    "uninstall": main_uninstall,
}


def main() -> int:
    parser = argparse.ArgumentParser(prog="ledger-agent")
    parser.add_argument("command", choices=sorted(COMMANDS.keys()))
    args = parser.parse_args()
    return COMMANDS[args.command]()


if __name__ == "__main__":
    sys.exit(main())
