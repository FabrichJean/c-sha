const express = require("express");
const { db, uid } = require("../db");

const router = express.Router();

/* ---------------- promotions (codes promo relies a une reduction de cout, cout / diviseur) ---------------- */
router.post("/api/promotions", (req, res) => {
  const { name, divisor } = req.body;
  const d = parseFloat(divisor);
  if (!name || !name.trim()) return res.status(400).json({ error: "Le nom est requis." });
  if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: "Le diviseur doit etre un nombre superieur a 0." });
  const row = { id: uid(), name: name.trim(), divisor: d, created_at: new Date().toISOString() };
  db.prepare("INSERT INTO promotions (id, name, divisor, created_at) VALUES (@id, @name, @divisor, @created_at)").run(row);
  res.json({ ok: true, id: row.id });
});

router.put("/api/promotions/:id", (req, res) => {
  const { name, divisor } = req.body;
  const existing = db.prepare("SELECT * FROM promotions WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Promotion introuvable." });
  const d = divisor !== undefined ? parseFloat(divisor) : existing.divisor;
  if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: "Le diviseur doit etre un nombre superieur a 0." });
  db.prepare("UPDATE promotions SET name = @name, divisor = @divisor WHERE id = @id")
    .run({ id: req.params.id, name: (name || existing.name).trim(), divisor: d });
  res.json({ ok: true });
});

router.delete("/api/promotions/:id", (req, res) => {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM promo_codes WHERE promotion_id = ?").run(req.params.id);
    db.prepare("DELETE FROM promotions WHERE id = ?").run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

router.post("/api/promotions/:id/codes", (req, res) => {
  const promotion = db.prepare("SELECT id FROM promotions WHERE id = ?").get(req.params.id);
  if (!promotion) return res.status(404).json({ error: "Promotion introuvable." });
  const code = (req.body.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Le code est requis." });
  const dupe = db.prepare("SELECT id FROM promo_codes WHERE code = ?").get(code);
  if (dupe) return res.status(400).json({ error: "Ce code existe deja." });
  const row = { id: uid(), code, promotion_id: req.params.id, created_at: new Date().toISOString() };
  db.prepare("INSERT INTO promo_codes (id, code, promotion_id, created_at) VALUES (@id, @code, @promotion_id, @created_at)").run(row);
  res.json({ ok: true, id: row.id });
});

router.delete("/api/promo-codes/:id", (req, res) => {
  db.prepare("DELETE FROM promo_codes WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
