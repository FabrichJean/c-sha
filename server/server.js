const path = require("path");

// Vit dans data/ (volume Docker persistant) pour survivre aux redeploiements.
const ENV_PATH = path.join(__dirname, "data", ".env");
const { bootstrapEnv } = require("./lib/env");
bootstrapEnv(ENV_PATH);
require("dotenv").config({ path: ENV_PATH }); // n'ecrase jamais des variables deja injectees (Docker -e, host env)

const express = require("express");
const { requireBasicAuth } = require("./lib/auth");

const PORT = process.env.PORT || 3333;

const app = express();
app.use(express.json({ limit: "10mb" }));

/* ---------------- routes publiques (pas de Basic Auth) ---------------- */
app.use(require("./routes/sync"));
app.use(require("./routes/device-view"));

/* la page elle-meme, et ses assets (CSS/JS extraits), doivent rester
   accessibles sans Basic Auth (le token dans l'URL est la seule protection
   voulue pour ce lien de partage) */
app.get("/device.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "device.html"));
});
app.get("/device-style.css", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "device-style.css"));
});
app.get("/device-app.js", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "device-app.js"));
});

/* ---------------- tout le reste derriere Basic Auth ---------------- */
app.use(requireBasicAuth);

app.use(require("./routes/state"));
app.use(require("./routes/promotions"));
app.use(require("./routes/devices"));
app.use(require("./routes/clients"));
app.use(require("./routes/projects"));
app.use(require("./routes/invoices"));
app.use(require("./routes/import"));
app.use(require("./routes/pricing"));

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Ledger en ecoute sur http://localhost:${PORT}`);
});
