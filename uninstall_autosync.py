#!/usr/bin/env python3
"""Retire la synchro automatique installee par install_autosync.py, quel que
soit l'OS (macOS/launchd, Linux/cron, Windows/Planificateur de taches)."""
from __future__ import annotations

import sys

from ledger_core import main_uninstall

if __name__ == "__main__":
    sys.exit(main_uninstall())
