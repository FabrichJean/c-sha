const express = require("express");
const { ingestUsagePayload } = require("../lib/ingest");

const router = express.Router();

/* import manuel depuis le navigateur (secours si le push automatique est indisponible) */
router.post("/api/import", (req, res) => {
  try {
    const result = ingestUsagePayload(req.body);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
