const { db } = require("../db");

function resolvePromoCodeId(promoCodeId) {
  if (!promoCodeId) return null;
  const code = db.prepare("SELECT id FROM promo_codes WHERE id = ?").get(promoCodeId);
  return code ? promoCodeId : null; // code supprime entretemps -> on ignore silencieusement
}

module.exports = { resolvePromoCodeId };
