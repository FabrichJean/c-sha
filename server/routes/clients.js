const express = require("express");
const { db, uid } = require("../db");
const { resolvePromoCodeId } = require("../lib/promotions");

const router = express.Router();

router.post("/api/clients", (req, res) => {
  const { name, company, email, notes, promoCodeId } = req.body;
  if (!name) return res.status(400).json({ error: "Le nom est requis." });
  const now = new Date().toISOString();
  const row = {
    id: uid(), name, company: company || "", email: email || "", notes: notes || "",
    promo_code_id: resolvePromoCodeId(promoCodeId), created_at: now, updated_at: now,
  };
  db.prepare(`INSERT INTO clients (id, name, company, email, notes, promo_code_id, created_at, updated_at) VALUES (@id, @name, @company, @email, @notes, @promo_code_id, @created_at, @updated_at)`).run(row);
  res.json(row);
});

router.put("/api/clients/:id", (req, res) => {
  const { name, company, email, notes, promoCodeId } = req.body;
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE clients SET name=@name, company=@company, email=@email, notes=@notes, promo_code_id=@promo_code_id, updated_at=@updated_at WHERE id=@id`)
    .run({ id: req.params.id, name, company: company || "", email: email || "", notes: notes || "", promo_code_id: resolvePromoCodeId(promoCodeId), updated_at: now });
  if (info.changes === 0) return res.status(404).json({ error: "Client introuvable." });
  res.json({ ok: true });
});

router.delete("/api/clients/:id", (req, res) => {
  db.prepare("DELETE FROM clients WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
