const express = require("express");
const { db, uid } = require("../db");

const router = express.Router();

/* ---------------- factures (facturation virtuelle factice) ---------------- */
router.post("/api/invoices", (req, res) => {
  const { clientId, periodStart, periodEnd, lineItems, subtotal, total, promoCode, promoDivisor, notes } = req.body;
  if (!clientId) return res.status(400).json({ error: "Client requis." });
  if (!Array.isArray(lineItems) || lineItems.length === 0) return res.status(400).json({ error: "Au moins une ligne est requise." });
  const now = new Date().toISOString();
  const row = {
    id: uid(), client_id: clientId, period_start: periodStart || "", period_end: periodEnd || "",
    status: "draft", subtotal: subtotal !== undefined ? subtotal : (total || 0), total: total || 0,
    line_items: JSON.stringify(lineItems || []),
    promo_code: promoCode || null, promo_divisor: promoDivisor || null,
    notes: notes || null, created_at: now, updated_at: now,
  };
  db.prepare(`INSERT INTO invoices (id, client_id, period_start, period_end, status, subtotal, total, line_items, promo_code, promo_divisor, notes, created_at, updated_at)
    VALUES (@id, @client_id, @period_start, @period_end, @status, @subtotal, @total, @line_items, @promo_code, @promo_divisor, @notes, @created_at, @updated_at)`).run(row);
  res.json({ ok: true, id: row.id });
});

router.put("/api/invoices/:id", (req, res) => {
  const { status, lineItems, subtotal, total, notes } = req.body;
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Facture introuvable." });
  const row = {
    id: req.params.id,
    status: status || existing.status,
    subtotal: subtotal !== undefined ? subtotal : existing.subtotal,
    total: total !== undefined ? total : existing.total,
    line_items: lineItems !== undefined ? JSON.stringify(lineItems) : existing.line_items,
    notes: notes !== undefined ? notes : existing.notes,
    updated_at: now,
  };
  db.prepare(`UPDATE invoices SET status=@status, subtotal=@subtotal, total=@total, line_items=@line_items, notes=@notes, updated_at=@updated_at WHERE id=@id`).run(row);
  res.json({ ok: true });
});

router.delete("/api/invoices/:id", (req, res) => {
  db.prepare("DELETE FROM invoices WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
