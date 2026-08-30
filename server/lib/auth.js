const crypto = require("crypto");
const { db } = require("../db");

const CRM_USER = process.env.CRM_USER || "admin";
const CRM_PASSWORD = process.env.CRM_PASSWORD;
const SYNC_API_KEY = process.env.SYNC_API_KEY;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* protege toute l'UI/API admin */
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

/* protege les endpoints appeles par l'agent local (cle API, pas de session navigateur) */
function requireApiKey(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Bearer" && token && timingSafeEqual(token, SYNC_API_KEY)) return next();
  return res.status(401).json({ error: "Cle API invalide ou manquante." });
}

/* protege le lien de partage public d'un appareil (aucun compte requis, juste le token) */
function requireDeviceToken(req, res, next) {
  const device = db.prepare("SELECT id, view_token FROM devices WHERE id = ?").get(req.params.deviceId);
  if (!device || !device.view_token || !timingSafeEqual(req.params.token, device.view_token)) {
    return res.status(404).json({ error: "Lien invalide." });
  }
  next();
}

module.exports = { CRM_USER, CRM_PASSWORD, SYNC_API_KEY, timingSafeEqual, requireBasicAuth, requireApiKey, requireDeviceToken };
