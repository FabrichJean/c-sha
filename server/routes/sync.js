const express = require("express");
const { db } = require("../db");
const { requireApiKey } = require("../lib/auth");
const { upsertDevice } = require("../lib/devices");
const { ingestUsagePayload } = require("../lib/ingest");
const { isGlobalSyncPending, getDeviceSyncRequest, ackSyncRequest, clearDeviceSyncRequest } = require("../lib/sync-state");

const router = express.Router();

function touchAgentLastSeen() {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('agent_last_seen', @v) ON CONFLICT(key) DO UPDATE SET value = @v`)
    .run({ v: JSON.stringify(now) });
}

/* endpoint de push utilise par l'agent local (cle API, pas de session navigateur) */
router.post("/api/sync", requireApiKey, (req, res) => {
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
router.get("/api/sync-status", requireApiKey, (req, res) => {
  touchAgentLastSeen();
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
router.get("/api/sync-wait", requireApiKey, (req, res) => {
  touchAgentLastSeen();
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

module.exports = router;
