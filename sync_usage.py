#!/usr/bin/env python3
"""
Verifie s'il faut synchroniser (intervalle ecoule, ou synchro demandee depuis
le CRM via le bouton "Rafraichir"), et si oui, regenere l'export et le pousse
vers le serveur Ledger distant.

Cross-platform (Windows / macOS / Linux) : ne depend que de la bibliotheque
standard Python. Concu pour etre appele frequemment (toutes les 60s) par le
planificateur natif de chaque OS (voir install_autosync.py).

Logique partagee dans ledger_core.py (aussi utilisee par ledger_agent.py,
le binaire autonome pour les machines sans Python).
"""
from __future__ import annotations

import sys

from ledger_core import main_sync

if __name__ == "__main__":
    sys.exit(main_sync())
