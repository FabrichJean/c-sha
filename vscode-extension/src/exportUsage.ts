import * as fs from "fs";
import * as path from "path";
import { CLAUDE_PROJECTS_DIR } from "./paths";

/* Reimplementation TypeScript de agent/export_usage.py::generate_export —
   doit rester en parite fonctionnelle avec elle (meme structure de sortie,
   consommee par le meme serveur), l'extension etant volontairement autonome
   (aucune dependance a Python ni a l'agent CLI). */

export interface DailyTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface ExportResult {
  exportedAt: string;
  messageCount: number;
  deviceId: string | null;
  deviceName: string | null;
  projects: Array<{
    projectKey: string;
    months: Array<{
      yyyymm: string;
      models: Array<{
        model: string;
        totals: DailyTotals;
        daily: Record<string, DailyTotals>;
      }>;
    }>;
  }>;
}

function emptyTotals(): DailyTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function projectKeyOf(cwd: string | undefined): string {
  if (!cwd) return "unknown";
  const base = path.basename(cwd);
  return base || cwd;
}

function* iterJsonlFiles(root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) yield path.join(dir, f);
    }
  }
}

function* iterAssistantMessages(root: string): Generator<{ ts: string; cwd?: string; model: string; usage: any }> {
  for (const file of iterJsonlFiles(root)) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch (e) {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: any;
      try {
        rec = JSON.parse(trimmed);
      } catch (e) {
        continue;
      }
      if (rec.type !== "assistant") continue;
      const msg = rec.message || {};
      const usage = msg.usage;
      const model = msg.model;
      const ts = rec.timestamp;
      const cwd = rec.cwd;
      if (!usage || !model || !ts) continue;
      yield { ts, cwd, model, usage };
    }
  }
}

export function generateExport(
  days: number | null,
  deviceId: string | null,
  deviceName: string | null,
  root: string = CLAUDE_PROJECTS_DIR
): { result: ExportResult; count: number } {
  if (!fs.existsSync(root)) {
    throw new Error(`Dossier introuvable: ${root}`);
  }
  const cutoff = days !== null ? Date.now() - days * 86400000 : null;

  // agg[projectKey][yyyymm][model][date] = DailyTotals
  const agg = new Map<string, Map<string, Map<string, Map<string, DailyTotals>>>>();

  let count = 0;
  for (const { ts, cwd, model, usage } of iterAssistantMessages(root)) {
    const t = Date.parse(ts);
    if (Number.isNaN(t)) continue;
    if (cutoff !== null && t < cutoff) continue;
    const d = new Date(t);
    const date = d.toISOString().slice(0, 10);
    const yyyymm = d.toISOString().slice(0, 7);
    const pkey = projectKeyOf(cwd);

    if (!agg.has(pkey)) agg.set(pkey, new Map());
    const byMonth = agg.get(pkey)!;
    if (!byMonth.has(yyyymm)) byMonth.set(yyyymm, new Map());
    const byModel = byMonth.get(yyyymm)!;
    if (!byModel.has(model)) byModel.set(model, new Map());
    const byDate = byModel.get(model)!;
    if (!byDate.has(date)) byDate.set(date, emptyTotals());
    const bucket = byDate.get(date)!;

    bucket.input += usage.input_tokens || 0;
    bucket.output += usage.output_tokens || 0;
    bucket.cacheCreate += usage.cache_creation_input_tokens || 0;
    bucket.cacheRead += usage.cache_read_input_tokens || 0;
    count++;
  }

  const outProjects: ExportResult["projects"] = [];
  for (const [projectKey, byMonth] of agg) {
    const months: ExportResult["projects"][number]["months"] = [];
    for (const [yyyymm, byModel] of byMonth) {
      const models: ExportResult["projects"][number]["months"][number]["models"] = [];
      for (const [model, byDate] of byModel) {
        const totals = emptyTotals();
        const daily: Record<string, DailyTotals> = {};
        for (const [date, t] of byDate) {
          daily[date] = t;
          totals.input += t.input;
          totals.output += t.output;
          totals.cacheCreate += t.cacheCreate;
          totals.cacheRead += t.cacheRead;
        }
        models.push({ model, totals, daily });
      }
      months.push({ yyyymm, models });
    }
    outProjects.push({ projectKey, months });
  }

  const result: ExportResult = {
    exportedAt: new Date().toISOString(),
    messageCount: count,
    deviceId,
    deviceName,
    projects: outProjects,
  };
  return { result, count };
}
