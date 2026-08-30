const express = require("express");
const { db, uid } = require("../db");

const router = express.Router();

router.post("/api/projects", (req, res) => {
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

router.put("/api/projects/:id", (req, res) => {
  const { name, clientId, projectKeys, rate, billingMode } = req.body;
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE projects SET name=@name, client_id=@client_id, project_keys=@project_keys, rate=@rate, billing_mode=@billing_mode, updated_at=@updated_at WHERE id=@id`)
    .run({ id: req.params.id, name, client_id: clientId || null, project_keys: JSON.stringify(projectKeys || []), rate: rate || null, billing_mode: billingMode === "hourly" ? "hourly" : "tokens", updated_at: now });
  if (info.changes === 0) return res.status(404).json({ error: "Projet introuvable." });
  res.json({ ok: true });
});

router.delete("/api/projects/:id", (req, res) => {
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
