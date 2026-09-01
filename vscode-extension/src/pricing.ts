import { DailyTotals } from "./exportUsage";

/* Meme grille que server/lib/pricing.js (DEFAULT_PRICING_SERVER), avec le
   meme facteur de calibration /200 que server/public/app.js::costOf — pour
   que l'estimation locale du panneau corresponde a ce que montre le CRM.
   L'extension n'a pas acces a la grille tarifaire personnalisee de l'admin
   (elle n'a que la cle API de sync, pas les identifiants Basic Auth) : c'est
   volontairement une estimation, jamais la source de verite facturee. */
const COST_CALIBRATION_FACTOR = 200;

const MODEL_PRICING: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  "claude-fable-5": { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-mythos-5": { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-opus-5": { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
const FALLBACK_PRICING = { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 };

export function estimateCost(model: string, totals: DailyTotals): number {
  const p = MODEL_PRICING[model] || FALLBACK_PRICING;
  const raw =
    (totals.input * p.in) / 1e6 +
    (totals.output * p.out) / 1e6 +
    (totals.cacheCreate * p.cacheWrite) / 1e6 +
    (totals.cacheRead * p.cacheRead) / 1e6;
  return raw / COST_CALIBRATION_FACTOR;
}

export function totalTokens(t: DailyTotals): number {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}
