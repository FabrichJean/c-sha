const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Vit dans data/ (volume Docker persistant) pour survivre aux redeploiements.
const ENV_PATH = path.join(__dirname, "data", ".env");
bootstrapEnv();
require("dotenv").config({ path: ENV_PATH }); // n'ecrase jamais des variables deja injectees (Docker -e, host env)

const express = require("express");
const { db, uid } = require("./db");

const PORT = process.env.PORT || 3333;
const CRM_USER = process.env.CRM_USER || "admin";
const CRM_PASSWORD = process.env.CRM_PASSWORD;
const SYNC_API_KEY = process.env.SYNC_API_KEY;

const app = express();
app.use(express.json({ limit: "10mb" }));

/* ---------------- bootstrap secrets on first run ---------------- */
function bootstrapEnv() {
  if (fs.existsSync(ENV_PATH)) return;
  if (process.env.CRM_PASSWORD && process.env.SYNC_API_KEY) return; // fournies par l'hote (Docker -e, etc.)
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  const password = crypto.randomBytes(9).toString("base64url");
  const apiKey = crypto.randomBytes(24).toString("hex");
  const content = [
    `PORT=3000`,
    `CRM_USER=admin`,
    `CRM_PASSWORD=${password}`,
    `SYNC_API_KEY=${apiKey}`,
    ``,
  ].join("\n");
  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
  console.log("\n==================== Ledger — identifiants generes ====================");
  console.log(`  Utilisateur CRM : admin`);
  console.log(`  Mot de passe CRM: ${password}`);
  console.log(`  Cle API de sync : ${apiKey}`);
  console.log(`  (enregistres dans server/data/.env — ne les commite pas)`);
  console.log("=========================================================================\n");
}

/* ---------------- auth ---------------- */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireBasicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (timingSafeEqual(user, CRM_USER) && timingSafeEqual(pass, CRM_PASSWORD)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Ledger"');
  return res.status(401).send("Authentification requise.");
}

function requireApiKey(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Bearer" && token && timingSafeEqual(token, SYNC_API_KEY)) return next();
  return res.status(401).json({ error: "Cle API invalide ou manquante." });
}

/* ---------------- devices ---------------- */
function upsertDevice(id, name, hostname) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM devices WHERE id = ?").get(id);
  if (existing) {
    db.prepare(`UPDATE devices SET last_seen = @now, hostname = COALESCE(@hostname, hostname), name = COALESCE(name, @name) WHERE id = @id`)
      .run({ id, now, hostname: hostname || null, name: name || id });
  } else {
    const viewToken = crypto.randomBytes(24).toString("hex");
    db.prepare(`INSERT INTO devices (id, name, hostname, first_seen, last_seen, view_token) VALUES (@id, @name, @hostname, @now, @now, @viewToken)`)
      .run({ id, name: name || id, hostname: hostname || null, now, viewToken });
  }
}

/* lien de partage : genere paresseusement pour les appareils crees avant cette fonctionnalite */
function ensureViewToken(id) {
  const row = db.prepare("SELECT view_token FROM devices WHERE id = ?").get(id);
  if (!row) return null;
  if (row.view_token) return row.view_token;
  const viewToken = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE devices SET view_token = ? WHERE id = ?").run(viewToken, id);
  return viewToken;
}

/* ---------------- pricing (partage entre l'ingestion, l'API et la vue appareil restreinte) ---------------- */
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
/* ---------------- sync ingestion (shared by script push + manual browser import) ---------------- */
function ingestUsagePayload(payload) {
  if (!payload || !Array.isArray(payload.projects)) {
    throw Object.assign(new Error("Format inattendu (cle 'projects' manquante)."), { status: 400 });
  }
  const deviceId = payload.deviceId || "legacy";
  const deviceName = payload.deviceName || (deviceId === "legacy" ? "Historique (avant suivi par appareil)" : deviceId);
  if (deviceId !== "legacy") upsertDevice(deviceId, deviceName, payload.deviceName);

  const upsert = db.prepare(`
    INSERT INTO usage_entries (id, project_key, yyyymm, model, totals, daily, imported_at, device_id)
    VALUES (@id, @projectKey, @yyyymm, @model, @totals, @daily, @importedAt, @deviceId)
    ON CONFLICT(id) DO UPDATE SET totals = excluded.totals, daily = excluded.daily, imported_at = excluded.imported_at
  `);
  const now = new Date().toISOString();
  let written = 0;
  const tx = db.transaction(() => {
    for (const proj of payload.projects) {
      for (const month of proj.months || []) {
        for (const m of month.models || []) {
          const id = `${deviceId}__${proj.projectKey}__${month.yyyymm}__${m.model}`;
          upsert.run({
            id,
            projectKey: proj.projectKey,
            yyyymm: month.yyyymm,
            model: m.model,
            totals: JSON.stringify(m.totals || {}),
            daily: JSON.stringify(m.daily || {}),
            importedAt: now,
            deviceId,
          });
          written++;
        }
      }
    }
  });
  tx();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('last_sync', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify({ at: now, written, messageCount: payload.messageCount || null, deviceId }) });
  return { written, messageCount: payload.messageCount || null, deviceId };
}

/* sync endpoint used by sync_usage.sh (cle API, pas de session navigateur) */
app.post("/api/sync", requireApiKey, (req, res) => {
  try {
    const result = ingestUsagePayload(req.body);
    ackSyncRequest(result.deviceId);
    clearDeviceSyncRequest(result.deviceId);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* le script local interroge ceci pour savoir s'il doit pousser tout de suite
   (au lieu d'attendre son prochain passage planifie) — sert aussi de battement
   de coeur par appareil (mis a jour a chaque appel, meme sans synchro reelle) */
app.get("/api/sync-status", requireApiKey, (req, res) => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('agent_last_seen', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify(now) });
  const deviceId = req.query.deviceId;
  if (deviceId) upsertDevice(deviceId, req.query.deviceName, req.query.deviceName);
  const globalReq = isGlobalSyncPending(deviceId);
  const deviceReq = deviceId ? getDeviceSyncRequest(deviceId) : null;
  res.json({ requested: !!globalReq || !!deviceReq, requestedAt: deviceReq || globalReq });
});

/* long-polling : garde la connexion ouverte (sondage interne toutes les 500ms)
   jusqu'a ce qu'une synchro soit demandee ou que le delai expire. Permet a
   l'agent local (processus persistant, cf. ledger_core.main_daemon) de reagir
   en quasi temps reel au bouton "Rafraichir" sans avoir a re-interroger le
   serveur en boucle serree. */
const SYNC_WAIT_MAX_MS = 30000;
const SYNC_WAIT_POLL_MS = 500;
app.get("/api/sync-wait", requireApiKey, (req, res) => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('agent_last_seen', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify(now) });
  const deviceId = req.query.deviceId;
  if (deviceId) upsertDevice(deviceId, req.query.deviceName, req.query.deviceName);

  const requestedTimeout = parseInt(req.query.timeoutMs, 10);
  const maxWaitMs = Number.isFinite(requestedTimeout) ? Math.min(Math.max(requestedTimeout, 0), SYNC_WAIT_MAX_MS) : SYNC_WAIT_MAX_MS;
  const deadline = Date.now() + maxWaitMs;

  let timer = null;
  const cleanup = () => { if (timer) clearTimeout(timer); };
  req.on("close", cleanup);

  const check = () => {
    if (res.writableEnded) return;
    const globalReq = isGlobalSyncPending(deviceId);
    const deviceReq = deviceId ? getDeviceSyncRequest(deviceId) : null;
    if (globalReq || deviceReq) {
      cleanup();
      return res.json({ requested: true, requestedAt: deviceReq || globalReq });
    }
    if (Date.now() >= deadline) {
      cleanup();
      return res.json({ requested: false });
    }
    timer = setTimeout(check, SYNC_WAIT_POLL_MS);
  };
  check();
});

/* demande de synchro globale (bouton "Rafraichir" du CRM) : doit toucher TOUS
   les appareils, pas seulement le premier qui repond. On memorise donc la
   liste des appareils encore en attente d'accuser reception, plutot qu'un
   simple flag efface par la premiere synchro venue (ce qui laissait les
   autres appareils sans synchro immediate, silencieusement rattrapes par le
   seul intervalle de 4h). */
function getSyncRequest() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sync_requested'").get();
  return row ? JSON.parse(row.value) : null;
}
function setSyncRequest() {
  const deviceIds = db.prepare("SELECT id FROM devices").all().map(d => d.id);
  const value = { at: new Date().toISOString(), deviceIds };
  db.prepare(`INSERT INTO settings (key, value) VALUES ('sync_requested', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify(value) });
}
function isGlobalSyncPending(deviceId) {
  const req = getSyncRequest();
  if (!req) return null;
  if (deviceId && Array.isArray(req.deviceIds) && !req.deviceIds.includes(deviceId)) return null;
  return req.at;
}
function ackSyncRequest(deviceId) {
  const req = getSyncRequest();
  if (!req) return;
  if (!Array.isArray(req.deviceIds)) {
    db.prepare("DELETE FROM settings WHERE key = 'sync_requested'").run();
    return;
  }
  const remaining = req.deviceIds.filter(id => id !== deviceId);
  if (remaining.length === 0) {
    db.prepare("DELETE FROM settings WHERE key = 'sync_requested'").run();
  } else {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('sync_requested', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
      .run({ v: JSON.stringify({ ...req, deviceIds: remaining }) });
  }
}

/* demandes de synchro ciblees sur un seul appareil (bouton "Rafraichir" d'une page device) */
function getAllDeviceSyncRequests() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'device_sync_requested'").get();
  return row ? JSON.parse(row.value) : {};
}
function getDeviceSyncRequest(deviceId) {
  return getAllDeviceSyncRequests()[deviceId] || null;
}
function setDeviceSyncRequest(deviceId) {
  const all = getAllDeviceSyncRequests();
  all[deviceId] = new Date().toISOString();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('device_sync_requested', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify(all) });
}
function clearDeviceSyncRequest(deviceId) {
  const all = getAllDeviceSyncRequests();
  if (!(deviceId in all)) return;
  delete all[deviceId];
  db.prepare(`INSERT INTO settings (key, value) VALUES ('device_sync_requested', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify(all) });
}

/* ---------------- vue restreinte "lien de partage" (aucun compte requis, juste le token) ---------------- */
function requireDeviceToken(req, res, next) {
  const device = db.prepare("SELECT id, view_token FROM devices WHERE id = ?").get(req.params.deviceId);
  if (!device || !device.view_token || !timingSafeEqual(req.params.token, device.view_token)) {
    return res.status(404).json({ error: "Lien invalide." });
  }
  next();
}

/* nom du projet uniquement (jamais le client associe) — un lien partage ne doit
   pas reveler l'identite des clients a quelqu'un d'externe */
function getProjectNamesMap() {
  const map = {};
  for (const p of db.prepare("SELECT name, project_keys FROM projects").all()) {
    for (const key of JSON.parse(p.project_keys || "[]")) map[key] = p.name;
  }
  return map;
}

function getDeviceDailyRows(deviceId) {
  const rows = [];
  for (const u of db.prepare("SELECT project_key, model, daily FROM usage_entries WHERE device_id = ?").all(deviceId)) {
    const daily = JSON.parse(u.daily || "{}");
    for (const [date, t] of Object.entries(daily)) rows.push({ date, projectKey: u.project_key, model: u.model, ...t });
  }
  return rows;
}

/* suivi de facturation pour UN appareil : ne retient que la part de chaque
   facture qui le concerne (ligne "appareil" ou "montant personnalise" plafonne
   sur lui) — jamais le nom du client, pour rester sans danger sur un lien public */
function getDeviceBillingSummary(deviceId) {
  const invoices = db.prepare("SELECT id, status, line_items, created_at FROM invoices ORDER BY created_at DESC").all();
  const entries = [];
  for (const inv of invoices) {
    let items;
    try { items = JSON.parse(inv.line_items || "[]"); } catch (e) { items = []; }
    const amount = items.filter(it => it.deviceId === deviceId).reduce((s, it) => s + (it.amount || 0), 0);
    if (amount > 0) entries.push({ invoiceId: inv.id, date: inv.created_at, amount, status: inv.status });
  }
  const totalPaid = entries.filter(e => e.status === "paid").reduce((s, e) => s + e.amount, 0);
  return { totalPaid, entries };
}

app.get("/api/device-view/:deviceId/:token", requireDeviceToken, (req, res) => {
  const d = db.prepare("SELECT * FROM devices WHERE id = ?").get(req.params.deviceId);
  const lastDataRow = db.prepare("SELECT MAX(imported_at) at FROM usage_entries WHERE device_id = ?").get(req.params.deviceId);
  const secAgo = (Date.now() - new Date(d.last_seen).getTime()) / 1000;
  const linkedClient = d.client_id ? db.prepare("SELECT promo_code_id FROM clients WHERE id = ?").get(d.client_id) : null;
  const promotions = db.prepare("SELECT * FROM promotions ORDER BY created_at DESC").all().map(p => ({
    id: p.id, name: p.name, divisor: p.divisor,
    codes: db.prepare("SELECT id, code FROM promo_codes WHERE promotion_id = ? ORDER BY code").all(p.id),
  }));
  res.json({
    device: { id: d.id, name: d.name, hostname: d.hostname, firstSeen: d.first_seen, lastSeen: d.last_seen },
    seen: secAgo < 150,
    lastDataAt: lastDataRow ? lastDataRow.at : null,
    rows: getDeviceDailyRows(req.params.deviceId),
    pricing: getPricing(),
    projectNames: getProjectNamesMap(),
    billing: getDeviceBillingSummary(req.params.deviceId),
    hasClient: !!d.client_id,
    currentPromoCodeId: linkedClient ? linkedClient.promo_code_id : null,
    promotions,
  });
});

app.post("/api/device-view/:deviceId/:token/request-sync", requireDeviceToken, (req, res) => {
  setDeviceSyncRequest(req.params.deviceId);
  res.json({ ok: true });
});

/* permet de changer le code promo du client lie depuis le lien public — le nom
   du client n'est jamais renvoye ni demande ici, seulement l'id du code */
app.post("/api/device-view/:deviceId/:token/promo-code", requireDeviceToken, (req, res) => {
  const d = db.prepare("SELECT client_id FROM devices WHERE id = ?").get(req.params.deviceId);
  if (!d || !d.client_id) return res.status(400).json({ error: "Aucun client lié à cet appareil." });
  db.prepare("UPDATE clients SET promo_code_id = @promo_code_id WHERE id = @id")
    .run({ id: d.client_id, promo_code_id: resolvePromoCodeId(req.body.promoCodeId) });
  res.json({ ok: true });
});

/* la page elle-meme doit rester accessible sans Basic Auth (le token dans l'URL
   est la seule protection voulue pour ce lien de partage) */
app.get("/device.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "device.html"));
});

/* ---------------- everything else behind basic auth ---------------- */
app.use(requireBasicAuth);

app.get("/api/state", (req, res) => {
  const clients = db.prepare("SELECT * FROM clients ORDER BY name").all().map(c => ({ ...c, promoCodeId: c.promo_code_id }));
  const projects = db.prepare("SELECT * FROM projects ORDER BY name").all().map(p => ({
    ...p,
    clientId: p.client_id,
    projectKeys: JSON.parse(p.project_keys || "[]"),
    billingMode: p.billing_mode || "tokens",
  }));
  const usage = db.prepare("SELECT * FROM usage_entries").all().map(u => ({
    id: u.id,
    projectKey: u.project_key,
    yyyymm: u.yyyymm,
    model: u.model,
    totals: JSON.parse(u.totals),
    daily: JSON.parse(u.daily),
    importedAt: u.imported_at,
    deviceId: u.device_id,
  }));
  const pricingRow = db.prepare("SELECT value FROM settings WHERE key = 'pricing'").get();
  const pricing = pricingRow ? JSON.parse(pricingRow.value) : null;
  const lastSyncRow = db.prepare("SELECT value FROM settings WHERE key = 'last_sync'").get();
  const lastSync = lastSyncRow ? JSON.parse(lastSyncRow.value) : null;
  const agentSeenRow = db.prepare("SELECT value FROM settings WHERE key = 'agent_last_seen'").get();
  const agentLastSeen = agentSeenRow ? JSON.parse(agentSeenRow.value) : null;
  const syncRequested = getSyncRequest();
  const devices = db.prepare("SELECT * FROM devices ORDER BY last_seen DESC").all().map(d => ({
    id: d.id, name: d.name, hostname: d.hostname, clientId: d.client_id, firstSeen: d.first_seen, lastSeen: d.last_seen,
    viewToken: d.view_token || ensureViewToken(d.id),
  }));
  if (usage.some(u => u.deviceId === "legacy") && !devices.some(d => d.id === "legacy")) {
    devices.push({ id: "legacy", name: "Historique (avant suivi par appareil)", hostname: null, firstSeen: null, lastSeen: null });
  }

  const invoices = db.prepare("SELECT * FROM invoices ORDER BY created_at DESC").all().map(i => ({
    id: i.id, clientId: i.client_id, periodStart: i.period_start, periodEnd: i.period_end,
    status: i.status, subtotal: i.subtotal, total: i.total, lineItems: JSON.parse(i.line_items || "[]"),
    promoCode: i.promo_code, promoDivisor: i.promo_divisor,
    notes: i.notes, createdAt: i.created_at, updatedAt: i.updated_at,
  }));

  const promotions = db.prepare("SELECT * FROM promotions ORDER BY created_at DESC").all().map(p => ({
    id: p.id, name: p.name, divisor: p.divisor, createdAt: p.created_at,
    codes: db.prepare("SELECT id, code FROM promo_codes WHERE promotion_id = ? ORDER BY code").all(p.id),
  }));

  res.json({ clients, projects, usage, pricing, lastSync, agentLastSeen, syncRequested, devices, invoices, promotions, syncApiKey: SYNC_API_KEY });
});

/* ---------------- promotions (codes promo relies a une reduction de cout, cout / diviseur) ---------------- */
app.post("/api/promotions", (req, res) => {
  const { name, divisor } = req.body;
  const d = parseFloat(divisor);
  if (!name || !name.trim()) return res.status(400).json({ error: "Le nom est requis." });
  if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: "Le diviseur doit etre un nombre superieur a 0." });
  const row = { id: uid(), name: name.trim(), divisor: d, created_at: new Date().toISOString() };
  db.prepare("INSERT INTO promotions (id, name, divisor, created_at) VALUES (@id, @name, @divisor, @created_at)").run(row);
  res.json({ ok: true, id: row.id });
});

app.put("/api/promotions/:id", (req, res) => {
  const { name, divisor } = req.body;
  const existing = db.prepare("SELECT * FROM promotions WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Promotion introuvable." });
  const d = divisor !== undefined ? parseFloat(divisor) : existing.divisor;
  if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: "Le diviseur doit etre un nombre superieur a 0." });
  db.prepare("UPDATE promotions SET name = @name, divisor = @divisor WHERE id = @id")
    .run({ id: req.params.id, name: (name || existing.name).trim(), divisor: d });
  res.json({ ok: true });
});

app.delete("/api/promotions/:id", (req, res) => {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM promo_codes WHERE promotion_id = ?").run(req.params.id);
    db.prepare("DELETE FROM promotions WHERE id = ?").run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

app.post("/api/promotions/:id/codes", (req, res) => {
  const promotion = db.prepare("SELECT id FROM promotions WHERE id = ?").get(req.params.id);
  if (!promotion) return res.status(404).json({ error: "Promotion introuvable." });
  const code = (req.body.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Le code est requis." });
  const dupe = db.prepare("SELECT id FROM promo_codes WHERE code = ?").get(code);
  if (dupe) return res.status(400).json({ error: "Ce code existe deja." });
  const row = { id: uid(), code, promotion_id: req.params.id, created_at: new Date().toISOString() };
  db.prepare("INSERT INTO promo_codes (id, code, promotion_id, created_at) VALUES (@id, @code, @promotion_id, @created_at)").run(row);
  res.json({ ok: true, id: row.id });
});

app.delete("/api/promo-codes/:id", (req, res) => {
  db.prepare("DELETE FROM promo_codes WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.put("/api/devices/:id", (req, res) => {
  const { name, clientId } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom est requis." });
  const info = db.prepare("UPDATE devices SET name = @name, client_id = @clientId WHERE id = @id")
    .run({ id: req.params.id, name, clientId: clientId || null });
  if (info.changes === 0) return res.status(404).json({ error: "Appareil introuvable." });
  res.json({ ok: true });
});

/* le bouton "Rafraichir" d'une page appareil demande une synchro a ce seul appareil */
app.post("/api/devices/:id/request-sync", (req, res) => {
  const device = db.prepare("SELECT id FROM devices WHERE id = ?").get(req.params.id);
  if (!device) return res.status(404).json({ error: "Appareil introuvable." });
  setDeviceSyncRequest(req.params.id);
  res.json({ ok: true });
});

app.delete("/api/devices/:id", (req, res) => {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM usage_entries WHERE device_id = ?").run(req.params.id);
    db.prepare("DELETE FROM devices WHERE id = ?").run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

/* le bouton "Rafraichir" du CRM appelle ceci pour demander une synchro immediate */
app.post("/api/request-sync", (req, res) => {
  setSyncRequest();
  res.json({ ok: true, ...getSyncRequest() });
});

/* import manuel depuis le navigateur (secours si le push automatique est indisponible) */
app.post("/api/import", (req, res) => {
  try {
    const result = ingestUsagePayload(req.body);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

function resolvePromoCodeId(promoCodeId) {
  if (!promoCodeId) return null;
  const code = db.prepare("SELECT id FROM promo_codes WHERE id = ?").get(promoCodeId);
  return code ? promoCodeId : null; // code supprime entretemps -> on ignore silencieusement
}

app.post("/api/clients", (req, res) => {
  const { name, company, email, notes, promoCodeId } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom est requis." });
  const now = new Date().toISOString();
  const row = {
    id: uid(), name, company: company || "", email: email || "", notes: notes || "",
    promo_code_id: resolvePromoCodeId(promoCodeId), created_at: now, updated_at: now,
  };
  db.prepare(`INSERT INTO clients (id, name, company, email, notes, promo_code_id, created_at, updated_at) VALUES (@id, @name, @company, @email, @notes, @promo_code_id, @created_at, @updated_at)`).run(row);
  res.json(row);
});

app.put("/api/clients/:id", (req, res) => {
  const { name, company, email, notes, promoCodeId } = req.body;
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE clients SET name=@name, company=@company, email=@email, notes=@notes, promo_code_id=@promo_code_id, updated_at=@updated_at WHERE id=@id`)
    .run({ id: req.params.id, name, company: company || "", email: email || "", notes: notes || "", promo_code_id: resolvePromoCodeId(promoCodeId), updated_at: now });
  if (info.changes === 0) return res.status(404).json({ error: "Client introuvable." });
  res.json({ ok: true });
});

app.delete("/api/clients/:id", (req, res) => {
  db.prepare("DELETE FROM clients WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/projects", (req, res) => {
  const { name, clientId, projectKeys, rate, billingMode } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom est requis." });
  const now = new Date().toISOString();
  const row = {
    id: uid(), name, client_id: clientId || null,
    project_keys: JSON.stringify(projectKeys || []),
    rate: rate || null, billing_mode: billingMode === "hourly" ? "hourly" : "tokens",
    created_at: now, updated_at: now,
  };
  db.prepare(`INSERT INTO projects (id, name, client_id, project_keys, rate, billing_mode, created_at, updated_at) VALUES (@id, @name, @client_id, @project_keys, @rate, @billing_mode, @created_at, @updated_at)`).run(row);
  res.json({ ...row, clientId: row.client_id, projectKeys: projectKeys || [], billingMode: row.billing_mode });
});

app.put("/api/projects/:id", (req, res) => {
  const { name, clientId, projectKeys, rate, billingMode } = req.body;
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE projects SET name=@name, client_id=@client_id, project_keys=@project_keys, rate=@rate, billing_mode=@billing_mode, updated_at=@updated_at WHERE id=@id`)
    .run({ id: req.params.id, name, client_id: clientId || null, project_keys: JSON.stringify(projectKeys || []), rate: rate || null, billing_mode: billingMode === "hourly" ? "hourly" : "tokens", updated_at: now });
  if (info.changes === 0) return res.status(404).json({ error: "Projet introuvable." });
  res.json({ ok: true });
});

app.delete("/api/projects/:id", (req, res) => {
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- factures (facturation virtuelle factice) ---------------- */
app.post("/api/invoices", (req, res) => {
  const { clientId, periodStart, periodEnd, lineItems, subtotal, total, promoCode, promoDivisor, notes } = req.body;
  if (!clientId) return res.status(400).json({ error: "Client requis." });
  if (!Array.isArray(lineItems) || lineItems.length === 0) return res.status(400).json({ error: "Au moins une ligne est requise." });
  const now = new Date().toISOString();
  const row = {
    id: uid(), client_id: clientId, period_start: periodStart || "", period_end: periodEnd || "",
    status: "draft", subtotal: subtotal !== undefined ? subtotal : (total || 0), total: total || 0,
    line_items: JSON.stringify(lineItems || []),
    promo_code: promoCode || null, promo_divisor: promoDivisor || null,
    notes: notes || null, created_at: now, updated_at: now,
  };
  db.prepare(`INSERT INTO invoices (id, client_id, period_start, period_end, status, subtotal, total, line_items, promo_code, promo_divisor, notes, created_at, updated_at)
    VALUES (@id, @client_id, @period_start, @period_end, @status, @subtotal, @total, @line_items, @promo_code, @promo_divisor, @notes, @created_at, @updated_at)`).run(row);
  res.json({ ok: true, id: row.id });
});

app.put("/api/invoices/:id", (req, res) => {
  const { status, lineItems, subtotal, total, notes } = req.body;
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Facture introuvable." });
  const row = {
    id: req.params.id,
    status: status || existing.status,
    subtotal: subtotal !== undefined ? subtotal : existing.subtotal,
    total: total !== undefined ? total : existing.total,
    line_items: lineItems !== undefined ? JSON.stringify(lineItems) : existing.line_items,
    notes: notes !== undefined ? notes : existing.notes,
    updated_at: now,
  };
  db.prepare(`UPDATE invoices SET status=@status, subtotal=@subtotal, total=@total, line_items=@line_items, notes=@notes, updated_at=@updated_at WHERE id=@id`).run(row);
  res.json({ ok: true });
});

app.delete("/api/invoices/:id", (req, res) => {
  db.prepare("DELETE FROM invoices WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.put("/api/pricing", (req, res) => {
  const value = JSON.stringify(req.body);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('pricing', @value) ON CONFLICT(key) DO UPDATE SET value = @value`).run({ value });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Ledger en ecoute sur http://localhost:${PORT}`);
});
