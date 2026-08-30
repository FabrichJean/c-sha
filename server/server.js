const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Vit dans data/ (volume Docker persistant) pour survivre aux redeploiements.
const ENV_PATH = path.join(__dirname, "data", ".env");
bootstrapEnv();
require("dotenv").config({ path: ENV_PATH }); // n'ecrase jamais des variables deja injectees (Docker -e, host env)

const express = require("express");
const { db, uid } = require("./db");

const PORT = process.env.PORT || 3000;
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
    clearSyncRequest();
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
  const globalReq = getSyncRequest();
  const deviceReq = deviceId ? getDeviceSyncRequest(deviceId) : null;
  res.json({ requested: !!globalReq || !!deviceReq, requestedAt: deviceReq || globalReq });
});

function getSyncRequest() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sync_requested'").get();
  return row ? JSON.parse(row.value) : null;
}
function clearSyncRequest() {
  db.prepare("DELETE FROM settings WHERE key = 'sync_requested'").run();
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

app.get("/api/device-view/:deviceId/:token", requireDeviceToken, (req, res) => {
  const d = db.prepare("SELECT * FROM devices WHERE id = ?").get(req.params.deviceId);
  const lastDataRow = db.prepare("SELECT MAX(imported_at) at FROM usage_entries WHERE device_id = ?").get(req.params.deviceId);
  const secAgo = (Date.now() - new Date(d.last_seen).getTime()) / 1000;
  res.json({
    device: { id: d.id, name: d.name, hostname: d.hostname, firstSeen: d.first_seen, lastSeen: d.last_seen },
    seen: secAgo < 150,
    lastDataAt: lastDataRow ? lastDataRow.at : null,
    rows: getDeviceDailyRows(req.params.deviceId),
    pricing: getPricing(),
    projectNames: getProjectNamesMap(),
  });
});

app.post("/api/device-view/:deviceId/:token/request-sync", requireDeviceToken, (req, res) => {
  setDeviceSyncRequest(req.params.deviceId);
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
  const clients = db.prepare("SELECT * FROM clients ORDER BY name").all();
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
    id: d.id, name: d.name, hostname: d.hostname, firstSeen: d.first_seen, lastSeen: d.last_seen,
    viewToken: d.view_token || ensureViewToken(d.id),
  }));
  if (usage.some(u => u.deviceId === "legacy") && !devices.some(d => d.id === "legacy")) {
    devices.push({ id: "legacy", name: "Historique (avant suivi par appareil)", hostname: null, firstSeen: null, lastSeen: null });
  }

  const invoices = db.prepare("SELECT * FROM invoices ORDER BY created_at DESC").all().map(i => ({
    id: i.id, clientId: i.client_id, periodStart: i.period_start, periodEnd: i.period_end,
    status: i.status, total: i.total, lineItems: JSON.parse(i.line_items || "[]"),
    notes: i.notes, createdAt: i.created_at, updatedAt: i.updated_at,
  }));

  res.json({ clients, projects, usage, pricing, lastSync, agentLastSeen, syncRequested, devices, invoices });
});

app.put("/api/devices/:id", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom est requis." });
  const info = db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, req.params.id);
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
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('sync_requested', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify(now) });
  res.json({ ok: true, requestedAt: now });
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

app.post("/api/clients", (req, res) => {
  const { name, company, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom est requis." });
  const now = new Date().toISOString();
  const row = { id: uid(), name, company: company || "", email: email || "", notes: notes || "", created_at: now, updated_at: now };
  db.prepare(`INSERT INTO clients (id, name, company, email, notes, created_at, updated_at) VALUES (@id, @name, @company, @email, @notes, @created_at, @updated_at)`).run(row);
  res.json(row);
});

app.put("/api/clients/:id", (req, res) => {
  const { name, company, email, notes } = req.body;
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE clients SET name=@name, company=@company, email=@email, notes=@notes, updated_at=@updated_at WHERE id=@id`)
    .run({ id: req.params.id, name, company: company || "", email: email || "", notes: notes || "", updated_at: now });
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
  const { clientId, periodStart, periodEnd, lineItems, total, notes } = req.body;
  if (!clientId || !periodStart || !periodEnd) return res.status(400).json({ error: "Client et periode requis." });
  const now = new Date().toISOString();
  const row = {
    id: uid(), client_id: clientId, period_start: periodStart, period_end: periodEnd,
    status: "draft", total: total || 0, line_items: JSON.stringify(lineItems || []),
    notes: notes || null, created_at: now, updated_at: now,
  };
app.put("/api/pricing", (req, res) => {
  const value = JSON.stringify(req.body);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('pricing', @value) ON CONFLICT(key) DO UPDATE SET value = @value`).run({ value });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Ledger en ecoute sur http://localhost:${PORT}`);
});
