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

/* ---------------- sync ingestion (shared by script push + manual browser import) ---------------- */
function ingestUsagePayload(payload) {
  if (!payload || !Array.isArray(payload.projects)) {
    throw Object.assign(new Error("Format inattendu (cle 'projects' manquante)."), { status: 400 });
  }
  const upsert = db.prepare(`
    INSERT INTO usage_entries (id, project_key, yyyymm, model, totals, daily, imported_at)
    VALUES (@id, @projectKey, @yyyymm, @model, @totals, @daily, @importedAt)
    ON CONFLICT(id) DO UPDATE SET totals = excluded.totals, daily = excluded.daily, imported_at = excluded.imported_at
  `);
  const now = new Date().toISOString();
  let written = 0;
  const tx = db.transaction(() => {
    for (const proj of payload.projects) {
      for (const month of proj.months || []) {
        for (const m of month.models || []) {
          const id = `${proj.projectKey}__${month.yyyymm}__${m.model}`;
          upsert.run({
            id,
            projectKey: proj.projectKey,
            yyyymm: month.yyyymm,
            model: m.model,
            totals: JSON.stringify(m.totals || {}),
            daily: JSON.stringify(m.daily || {}),
            importedAt: now,
          });
          written++;
        }
      }
    }
  });
  tx();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('last_sync', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify({ at: now, written, messageCount: payload.messageCount || null }) });
  return { written, messageCount: payload.messageCount || null };
}

/* sync endpoint used by sync_usage.sh (cle API, pas de session navigateur) */
app.post("/api/sync", requireApiKey, (req, res) => {
  try {
    const result = ingestUsagePayload(req.body);
    clearSyncRequest();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* le script local interroge ceci pour savoir s'il doit pousser tout de suite
   (au lieu d'attendre son prochain passage planifie) */
app.get("/api/sync-status", requireApiKey, (req, res) => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('agent_last_seen', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify(now) });
  res.json({ requested: !!getSyncRequest(), requestedAt: getSyncRequest() });
});

function getSyncRequest() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sync_requested'").get();
  return row ? JSON.parse(row.value) : null;
}
function clearSyncRequest() {
  db.prepare("DELETE FROM settings WHERE key = 'sync_requested'").run();
}

/* ---------------- everything else behind basic auth ---------------- */
app.use(requireBasicAuth);

app.get("/api/state", (req, res) => {
  const clients = db.prepare("SELECT * FROM clients ORDER BY name").all();
  const projects = db.prepare("SELECT * FROM projects ORDER BY name").all().map(p => ({
    ...p,
    projectKeys: JSON.parse(p.project_keys || "[]"),
  }));
  const usage = db.prepare("SELECT * FROM usage_entries").all().map(u => ({
    id: u.id,
    projectKey: u.project_key,
    yyyymm: u.yyyymm,
    model: u.model,
    totals: JSON.parse(u.totals),
    daily: JSON.parse(u.daily),
    importedAt: u.imported_at,
  }));
  const pricingRow = db.prepare("SELECT value FROM settings WHERE key = 'pricing'").get();
  const pricing = pricingRow ? JSON.parse(pricingRow.value) : null;
  const lastSyncRow = db.prepare("SELECT value FROM settings WHERE key = 'last_sync'").get();
  const lastSync = lastSyncRow ? JSON.parse(lastSyncRow.value) : null;
  const agentSeenRow = db.prepare("SELECT value FROM settings WHERE key = 'agent_last_seen'").get();

  res.json({ clients, projects, usage, pricing, lastSync });
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
  const { name, clientId, projectKeys, rate } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom est requis." });
  const now = new Date().toISOString();
  const row = {
    id: uid(), name, client_id: clientId || null,
    project_keys: JSON.stringify(projectKeys || []),
    rate: rate || null, created_at: now, updated_at: now,
  };
  db.prepare(`INSERT INTO projects (id, name, client_id, project_keys, rate, created_at, updated_at) VALUES (@id, @name, @client_id, @project_keys, @rate, @created_at, @updated_at)`).run(row);
  res.json({ ...row, projectKeys: projectKeys || [] });
});

app.put("/api/projects/:id", (req, res) => {
  const { name, clientId, projectKeys, rate } = req.body;
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE projects SET name=@name, client_id=@client_id, project_keys=@project_keys, rate=@rate, updated_at=@updated_at WHERE id=@id`)
    .run({ id: req.params.id, name, client_id: clientId || null, project_keys: JSON.stringify(projectKeys || []), rate: rate || null, updated_at: now });
  if (info.changes === 0) return res.status(404).json({ error: "Projet introuvable." });
  res.json({ ok: true });
});

app.delete("/api/projects/:id", (req, res) => {
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
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
