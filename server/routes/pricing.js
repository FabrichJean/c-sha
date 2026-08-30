const express = require("express");
const { db } = require("../db");

const router = express.Router();

router.put("/api/pricing", (req, res) => {
  const value = JSON.stringify(req.body);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('pricing', @value) ON CONFLICT(key) DO UPDATE SET value = @value`).run({ value });
  res.json({ ok: true });
});

module.exports = router;
