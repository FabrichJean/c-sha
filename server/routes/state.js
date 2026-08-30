const express = require("express");
const { db } = require("../db");
const { SYNC_API_KEY } = require("../lib/auth");
const { ensureViewToken } = require("../lib/devices");
const { getSyncRequest, setSyncRequest } = require("../lib/sync-state");

const router = express.Router();

router.get("/api/state", (req, res) => {
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

/* le bouton "Rafraichir" du CRM appelle ceci pour demander une synchro immediate */
router.post("/api/request-sync", (req, res) => {
  setSyncRequest();
  res.json({ ok: true, ...getSyncRequest() });
});

module.exports = router;
