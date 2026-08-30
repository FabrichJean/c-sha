const { db } = require("../db");
const { upsertDevice } = require("./devices");

/* ingestion partagee par le push automatique (agent local) et l'import manuel navigateur */
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

module.exports = { ingestUsagePayload };
