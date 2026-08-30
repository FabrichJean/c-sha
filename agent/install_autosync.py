#!/usr/bin/env python3
"""
Installe une synchro automatique en tache de fond, avec le planificateur
natif de l'OS courant :

  - macOS   : LaunchAgent (launchd)
  - Linux   : crontab (cron)
  - Windows : Planificateur de taches (schtasks)

Sur macOS, launchd bloque les taches qui accedent a des fichiers sous
~/Documents, ~/Desktop ou ~/Downloads (protection TCC) meme quand
l'execution manuelle en terminal fonctionne. Les scripts sont donc copies
dans ~/Library/Application Support/Ledger/agent/, hors de ce perimetre
protege, avant d'etre enregistres. Linux et Windows n'ont pas cette
restriction.

Logique partagee dans ledger_core.py (aussi utilisee par ledger_agent.py,
le binaire autonome pour les machines sans Python).
"""
from __future__ import annotations

import sys

from ledger_core import main_install

if __name__ == "__main__":
    sys.exit(main_install())
