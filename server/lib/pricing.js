const { db } = require("../db");

/* partagee entre l'ingestion, l'API et la vue appareil restreinte */
const DEFAULT_PRICING_SERVER = {
  models: {
    "claude-fable-5":   { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 },
    "claude-mythos-5":  { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 },
    "claude-opus-5":    { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-opus-4-8":  { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-opus-4-7":  { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-opus-4-6":  { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-sonnet-5":  { in: 2,  out: 10, cacheWrite: 2.5,  cacheRead: 0.2 },
    "claude-sonnet-4-6":{ in: 3,  out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    "claude-haiku-4-5": { in: 1,  out: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
  },
  fallback: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

function getPricing() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'pricing'").get();
  return row ? JSON.parse(row.value) : DEFAULT_PRICING_SERVER;
}

/* meme facteur que server/public/app.js::costOf — le calcul brut (prix/1M
   tokens) surestimait le cout reel d'un facteur ~200 constate par
   comparaison avec la facturation Anthropic reelle. Le serveur ne calculait
   jusqu'ici jamais de cout lui-meme (tout etait fait cote navigateur) ; cette
   fonction sert aux endpoints qui doivent renvoyer un montant $ deja calcule
   (ex: /api/device-status, pour l'extension VS Code) sans exposer la grille
   tarifaire complete. */
const COST_CALIBRATION_FACTOR = 200;
function costOf(model, totals, pricing) {
  const p = (pricing || getPricing());
  const rate = (p.models && p.models[model]) || p.fallback || DEFAULT_PRICING_SERVER.fallback;
  const t = totals || {};
  const raw = (t.input || 0) * rate.in / 1e6 + (t.output || 0) * rate.out / 1e6 +
              (t.cacheCreate || 0) * rate.cacheWrite / 1e6 + (t.cacheRead || 0) * rate.cacheRead / 1e6;
  return raw / COST_CALIBRATION_FACTOR;
}

module.exports = { DEFAULT_PRICING_SERVER, getPricing, costOf, COST_CALIBRATION_FACTOR };
