#!/usr/bin/env python3
"""
Configure une seule fois l'URL du serveur Ledger distant et la cle API de
sync (affichee au premier demarrage du serveur, ou dans server/data/.env).

Cross-platform : ecrit dans ~/.ledger/sync_config.json, lu ensuite par
sync_usage.py sur Windows, macOS et Linux.
"""
from __future__ import annotations

import sys

from ledger_core import main_configure

if __name__ == "__main__":
    sys.exit(main_configure())
