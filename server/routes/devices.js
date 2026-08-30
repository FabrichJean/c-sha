const express = require("express");
const { db } = require("../db");
const { setDeviceSyncRequest } = require("../lib/sync-state");

const router = express.Router();

router.put("/api/devices/:id", (req, res) => {
  const { name, clientId } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom est requis." });
  const info = db.prepare("UPDATE devices SET name = @name, client_id = @clientId WHERE id = @id")
    .run({ id: req.params.id, name, clientId: clientId || null });
  if (info.changes === 0) return res.status(404).json({ error: "Appareil introuvable." });
  res.json({ ok: true });
});

/* le bouton "Rafraichir" d'une page appareil demande une synchro a ce seul appareil */
router.post("/api/devices/:id/request-sync", (req, res) => {
  const device = db.prepare("SELECT id FROM devices WHERE id = ?").get(req.params.id);
  if (!device) return res.status(404).json({ error: "Appareil introuvable." });
  setDeviceSyncRequest(req.params.id);
  res.json({ ok: true });
});

router.delete("/api/devices/:id", (req, res) => {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM usage_entries WHERE device_id = ?").run(req.params.id);
    db.prepare("DELETE FROM devices WHERE id = ?").run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
