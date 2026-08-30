const crypto = require("crypto");
const { db } = require("../db");

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

module.exports = { upsertDevice, ensureViewToken, getProjectNamesMap, getDeviceDailyRows, getDeviceBillingSummary };
