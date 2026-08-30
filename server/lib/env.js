const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* genere CRM_PASSWORD/SYNC_API_KEY et les ecrit dans envPath au tout premier
   demarrage (vit dans data/, volume Docker persistant, pour survivre aux
   redeploiements) ; ne fait rien si le fichier existe deja ou si l'hote a
   deja fourni les deux variables (Docker -e, etc.) */
function bootstrapEnv(envPath) {
  if (fs.existsSync(envPath)) return;
  if (process.env.CRM_PASSWORD && process.env.SYNC_API_KEY) return;
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const password = crypto.randomBytes(9).toString("base64url");
  const apiKey = crypto.randomBytes(24).toString("hex");
  const content = [
    `PORT=${process.env.PORT || 3000}`,
    `CRM_USER=${process.env.CRM_USER || "admin"}`,
    `CRM_PASSWORD=${password}`,
    `SYNC_API_KEY=${apiKey}`,
    ``,
  ].join("\n");
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  console.log("\n==================== Ledger — identifiants generes ====================");
  console.log(`  Utilisateur CRM : ${process.env.CRM_USER || "admin"}`);
  console.log(`  Mot de passe CRM: ${password}`);
  console.log(`  Cle API de sync : ${apiKey}`);
  console.log(`  (enregistres dans server/data/.env — ne les commite pas)`);
  console.log("=========================================================================\n");
}

module.exports = { bootstrapEnv };
