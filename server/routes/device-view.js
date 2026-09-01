const express = require("express");
const { db } = require("../db");
const { requireDeviceToken, requireApiKey } = require("../lib/auth");
const { getPricing } = require("../lib/pricing");
const { resolvePromoCodeId } = require("../lib/promotions");
const { getProjectNamesMap, getDeviceDailyRows, getDeviceTotalCost, getDeviceBillingSummary } = require("../lib/devices");
const { setDeviceSyncRequest } = require("../lib/sync-state");

const router = express.Router();

/* Equivalent de la vue "lien de partage" (device-view ci-dessous), mais pour
   un client agent (extension VS Code, futurs clients) authentifie par la cle
   API de sync partagee plutot que par le view_token propre a l'appareil.
   Meme cloisonnement que le lien public : jamais le nom du client, jamais les
   autres appareils. La cle etant partagee entre tous les appareils (meme
   modele de confiance que POST /api/sync, qui permet deja a un porteur de la
   cle de pousser des donnees au nom de N'IMPORTE QUEL deviceId), un porteur
   de la cle peut lire le statut/facturation de n'importe quel appareil, pas
   seulement le sien — compromis accepte, identique a celui de device.html. */
router.get("/api/device-status/:deviceId", requireApiKey, (req, res) => {
  const d = db.prepare("SELECT * FROM devices WHERE id = ?").get(req.params.deviceId);
  if (!d) return res.status(404).json({ error: "Appareil introuvable." });
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
    totalCost: getDeviceTotalCost(req.params.deviceId),
    billing: getDeviceBillingSummary(req.params.deviceId),
    hasClient: !!d.client_id,
    currentPromoCodeId: linkedClient ? linkedClient.promo_code_id : null,
    promotions,
  });
});

/* ---------------- vue restreinte "lien de partage" (aucun compte requis, juste le token) ---------------- */
router.get("/api/device-view/:deviceId/:token", requireDeviceToken, (req, res) => {
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

router.post("/api/device-view/:deviceId/:token/request-sync", requireDeviceToken, (req, res) => {
  setDeviceSyncRequest(req.params.deviceId);
  res.json({ ok: true });
});

/* permet de changer le code promo du client lie depuis le lien public — le nom
   du client n'est jamais renvoye ni demande ici, seulement l'id du code */
router.post("/api/device-view/:deviceId/:token/promo-code", requireDeviceToken, (req, res) => {
  const d = db.prepare("SELECT client_id FROM devices WHERE id = ?").get(req.params.deviceId);
  if (!d || !d.client_id) return res.status(400).json({ error: "Aucun client lié à cet appareil." });
  db.prepare("UPDATE clients SET promo_code_id = @promo_code_id WHERE id = @id")
    .run({ id: d.client_id, promo_code_id: resolvePromoCodeId(req.body.promoCodeId) });
  res.json({ ok: true });
});

module.exports = router;
