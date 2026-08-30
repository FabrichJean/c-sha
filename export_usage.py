#!/usr/bin/env python3
"""
Exporte la consommation de tokens Claude Code depuis les logs locaux
(~/.claude/projects/**/*.jsonl) vers un JSON compact, pret a coller
dans l'onglet "Import" du CRM.

Usage:
    python3 export_usage.py                 # affiche le JSON
    python3 export_usage.py | pbcopy         # copie direct dans le presse-papiers (macOS)
    python3 export_usage.py --days 30        # limite aux N derniers jours
"""
from __future__ import annotations
import json
import sys
import argparse
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone, timedelta

CLAUDE_DIR = Path.home() / ".claude" / "projects"


def iter_assistant_messages(root: Path):
    for jsonl_path in root.glob("*/*.jsonl"):
        try:
            with jsonl_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if rec.get("type") != "assistant":
                        continue
                    msg = rec.get("message") or {}
                    usage = msg.get("usage")
                    model = msg.get("model")
                    ts = rec.get("timestamp")
                    cwd = rec.get("cwd")
                    if not usage or not model or not ts:
                        continue
                    yield ts, cwd, model, usage
        except OSError:
            continue


def project_key(cwd: str | None) -> str:
    if not cwd:
        return "unknown"
    return Path(cwd).name or cwd


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=None, help="Limiter aux N derniers jours")
    parser.add_argument("--root", type=str, default=str(CLAUDE_DIR), help="Dossier des logs Claude Code")
    args = parser.parse_args()

    root = Path(args.root)
    if not root.exists():
        print(f"Dossier introuvable: {root}", file=sys.stderr)
        sys.exit(1)

    cutoff = None
    if args.days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)

    # aggregation[projectKey][yyyy-mm][model]['daily'][yyyy-mm-dd] = {input, output, cache_creation, cache_read}
    agg = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: {
        "input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0,
    }))))

    count = 0
    for ts, cwd, model, usage in iter_assistant_messages(root):
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        if cutoff and dt < cutoff:
            continue
        date = dt.strftime("%Y-%m-%d")
        yyyymm = dt.strftime("%Y-%m")
        pkey = project_key(cwd)

        day_bucket = agg[pkey][yyyymm][model][date]
        day_bucket["input"] += usage.get("input_tokens", 0) or 0
        day_bucket["output"] += usage.get("output_tokens", 0) or 0
        day_bucket["cacheCreate"] += usage.get("cache_creation_input_tokens", 0) or 0
        day_bucket["cacheRead"] += usage.get("cache_read_input_tokens", 0) or 0
        count += 1

    # shape output for the CRM importer
    out_projects = []
    for pkey, months in agg.items():
        month_list = []
        for yyyymm, models in months.items():
            model_list = []
            for model, daily in models.items():
                totals = {"input": 0, "output": 0, "cacheCreate": 0, "cacheRead": 0}
                for d in daily.values():
                    for k in totals:
                        totals[k] += d[k]
                model_list.append({"model": model, "totals": totals, "daily": daily})
            month_list.append({"yyyymm": yyyymm, "models": model_list})
        out_projects.append({"projectKey": pkey, "months": month_list})

    result = {
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "messageCount": count,
        "projects": out_projects,
    }

    print(json.dumps(result, separators=(",", ":")))
    print(f"{count} messages agreges sur {len(out_projects)} projet(s).", file=sys.stderr)


if __name__ == "__main__":
    main()
