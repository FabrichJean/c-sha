const { db } = require("../db");

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

module.exports = {
  getSyncRequest, setSyncRequest, isGlobalSyncPending, ackSyncRequest,
  getAllDeviceSyncRequests, getDeviceSyncRequest, setDeviceSyncRequest, clearDeviceSyncRequest,
};
