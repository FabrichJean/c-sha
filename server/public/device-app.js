"use strict";
const params = new URLSearchParams(location.search);
const DEVICE_ID = params.get("id");
const TOKEN = params.get("token");
const state = {
  data: null,
  refreshing: false, refreshStartedAt: null, refreshAttempts: 0,
  trendMetric: "tokens", trendPeriod: 7,
  detailSearch: "", detailPage: 0,
};
const DETAIL_PAGE_SIZE = 12;

const DEFAULT_PRICING = {
  models: {
    "claude-fable-5":   { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 },
    "claude-mythos-5":  { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 },
    "claude-opus-5":    { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-opus-4-8":  { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-opus-4-7":  { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-opus-4-6":  { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-sonnet-5":  { in: 2,  out: 10, cacheWrite: 2.5,  cacheRead: 0.2 },
    "claude-sonnet-4-6":{ in: 3,  out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    "claude-haiku-4-5": { in: 1,  out: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
  },
  fallback: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtNum(n) { if (n === undefined || n === null || isNaN(n)) return "–"; return Math.round(n).toLocaleString("fr-FR"); }
function fmtCompact(n) {
  if (n === undefined || n === null || isNaN(n)) return "–";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2).replace(".", ",") + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(".", ",") + "k";
  return Math.round(n).toString();
}
function fmtUsd(n) { if (n === undefined || n === null || isNaN(n)) return "–"; return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pctChange(today, yesterday) {
  if (!yesterday) return today > 0 ? 100 : 0;
  return ((today - yesterday) / yesterday) * 100;
}
function timeAgo(iso) {
  if (!iso) return "";
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `il y a ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
function modelLabel(model) { return model ? model.replace("claude-", "") : "?"; }
function colorForModel(model) {
  if (/opus|fable|mythos/.test(model || "")) return "var(--violet)";
  if (/sonnet/.test(model || "")) return "var(--accent)";
  if (/haiku/.test(model || "")) return "var(--warn)";
  return "var(--ink-faint)";
}
function totalTokens(t) { return (t.input || 0) + (t.output || 0) + (t.cacheCreate || 0) + (t.cacheRead || 0); }
function pricingFor(model) {
  const p = (state.data && state.data.pricing) || DEFAULT_PRICING;
  return p.models[model] || p.fallback || DEFAULT_PRICING.fallback;
}
function costOf(model, totals) {
  const p = pricingFor(model);
  const t = totals || {};
  return (t.input || 0) * p.in / 1e6 + (t.output || 0) * p.out / 1e6 +
         (t.cacheCreate || 0) * p.cacheWrite / 1e6 + (t.cacheRead || 0) * p.cacheRead / 1e6;
}
function projectName(key) { return (state.data && state.data.projectNames && state.data.projectNames[key]) || key; }

function aggregate(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
    const b = map.get(k);
    b.input += r.input || 0; b.output += r.output || 0;
    b.cacheCreate += r.cacheCreate || 0; b.cacheRead += r.cacheRead || 0;
  }
  return map;
}
function dailySeries(rows, days, reducer) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const now = new Date();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) { const dt = new Date(now); dt.setDate(dt.getDate() - i); dates.push(dt.toISOString().slice(0, 10)); }
  return { dates, values: dates.map(d => reducer(byDate.get(d) || [])) };
}
function emptyMini() { return `<div style="padding:20px 0;text-align:center;color:var(--ink-faint)">Pas de données sur cette période.</div>`; }

function buildDetailTableCard(projectEntries, in30) {
  const resolved = projectEntries.map(([pkey, t]) => {
    const cost = in30.filter(r => r.projectKey === pkey).reduce((s, r) => s + costOf(r.model, r), 0);
    return { pkey, name: projectName(pkey), t, cost };
  });

  const q = state.detailSearch.trim().toLowerCase();
  const filtered = q ? resolved.filter(r => r.name.toLowerCase().includes(q)) : resolved;

  const totalPages = Math.max(1, Math.ceil(filtered.length / DETAIL_PAGE_SIZE));
  const page = Math.min(state.detailPage, totalPages - 1);
  const pageRows = filtered.slice(page * DETAIL_PAGE_SIZE, (page + 1) * DETAIL_PAGE_SIZE);

  return `
    <div class="card">
      <div class="trend-head">
        <h3>Détail par projet</h3>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:12px;color:var(--ink-faint)">30 derniers jours, coût estimé</span>
          <input type="search" id="detail-search-input" placeholder="Rechercher un projet…" value="${escapeHtml(state.detailSearch)}"
            style="padding:6px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--ink);font-size:12.5px;width:200px">
        </div>
      </div>
      <div class="card-body" style="padding:0">
        ${pageRows.length === 0 ? `<div class="empty" style="padding:30px 20px">Aucun projet ne correspond à la recherche.</div>` : `
        <table>
          <thead><tr><th>Projet</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache</th><th class="num">Total</th><th class="num">Coût est.</th></tr></thead>
          <tbody>
            ${pageRows.map(r => `<tr>
                <td>${escapeHtml(r.name)}</td>
                <td class="num mono">${fmtNum(r.t.input)}</td>
                <td class="num mono">${fmtNum(r.t.output)}</td>
                <td class="num mono">${fmtNum(r.t.cacheCreate + r.t.cacheRead)}</td>
                <td class="num mono">${fmtNum(totalTokens(r.t))}</td>
                <td class="num mono">${fmtUsd(r.cost)}</td>
              </tr>`).join("")}
          </tbody>
        </table>`}
      </div>
      ${filtered.length > 0 ? `
      <div class="trend-foot">
        <span style="font-size:12px;color:var(--ink-faint)">${filtered.length} projet${filtered.length > 1 ? "s" : ""}${q ? ` (sur ${resolved.length})` : ""} · page ${page + 1} / ${totalPages}</span>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:5px 10px;font-size:12px" id="detail-page-prev" ${page === 0 ? "disabled" : ""}>← Précédent</button>
          <button class="btn" style="padding:5px 10px;font-size:12px" id="detail-page-next" ${page >= totalPages - 1 ? "disabled" : ""}>Suivant →</button>
        </div>
      </div>` : ""}
    </div>`;
}

function sparklineSvg(values, color) {
  const w = 240, h = 34, pad = 3;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [pad + i * stepX, pad + (h - pad * 2) * (1 - (v - min) / range)]);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`;
  const last = pts[pts.length - 1];
  return `<svg class="kpi-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" opacity="0.12" stroke="none"></path>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${color}"></circle>
  </svg>`;
}

function kpiCard({ icon, iconBg, sparkColor, badgePct, title, big, periods, sparkValues }) {
  const cls = badgePct > 0.5 ? "up" : badgePct < -0.5 ? "down" : "flat";
  const arrow = badgePct > 0.5 ? "↗" : badgePct < -0.5 ? "↘" : "→";
  const pctDisplay = Math.min(Math.abs(badgePct), 999);
  const periodsHtml = periods.map(p => `<div><div class="kp-label">${escapeHtml(p.label)}</div><div class="kp-value">${p.value}</div></div>`).join("");
  return `
    <div class="kpi-card">
      <div class="kpi-top">
        <div class="kpi-id"><div class="kpi-icon" style="background:${iconBg}">${icon}</div><div class="kpi-title">${escapeHtml(title)}</div></div>
        <span class="kpi-pct ${cls}">${arrow} ${pctDisplay.toFixed(0)}${pctDisplay >= 999 ? "+" : ""}%</span>
      </div>
      <div class="kpi-big">${big}</div>
      <div class="kpi-periods">${periodsHtml}</div>
      ${sparklineSvg(sparkValues, sparkColor)}
    </div>`;
}

function lineChartDual(dates, seriesTokens, seriesCost, activeMetric) {
  const w = 900, h = 230, padL = 46, padR = 46, padT = 14, padB = 26;
  const maxTok = Math.max(1, ...seriesTokens), maxCost = Math.max(1, ...seriesCost);
  const stepX = dates.length > 1 ? (w - padL - padR) / (dates.length - 1) : 0;
  const yTok = v => padT + (h - padT - padB) * (1 - v / maxTok);
  const yCost = v => padT + (h - padT - padB) * (1 - v / maxCost);
  const pathFor = (values, yFn) => values.map((v, i) => `${i === 0 ? "M" : "L"}${(padL + i * stepX).toFixed(1)},${yFn(v).toFixed(1)}`).join(" ");
  const tokPath = pathFor(seriesTokens, yTok);
  const costPath = pathFor(seriesCost, yCost);
  const tokActive = activeMetric === "tokens";
  const gridY = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const y = padT + (h - padT - padB) * (1 - f);
    return `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="1"></line>
      <text x="${padL - 8}" y="${y + 3}" font-size="10" text-anchor="end">${fmtCompact(maxTok * f)}</text>
      <text x="${w - padR + 8}" y="${y + 3}" font-size="10" text-anchor="start">${fmtUsd(maxCost * f).replace(".00", "")}</text>`;
  }).join("");
  const labelEvery = Math.max(1, Math.ceil(dates.length / 8));
  const labels = dates.map((d, i) => i % labelEvery !== 0 ? "" : `<text x="${padL + i * stepX}" y="${h - 6}" font-size="10" text-anchor="middle">${d.slice(5)}</text>`).join("");
  const dot = (values, yFn, color) => { const i = values.length - 1; return `<circle cx="${(padL + i * stepX).toFixed(1)}" cy="${yFn(values[i]).toFixed(1)}" r="3.5" fill="${color}"></circle>`; };
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;display:block" role="img" aria-label="Consommation dans le temps">
    ${gridY}
    <path d="${costPath}" fill="none" stroke="var(--good)" stroke-width="${tokActive ? 1.5 : 2.25}" opacity="${tokActive ? 0.45 : 1}" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="${tokPath}" fill="none" stroke="#c9622a" stroke-width="${tokActive ? 2.25 : 1.5}" opacity="${tokActive ? 1 : 0.45}" stroke-linecap="round" stroke-linejoin="round"></path>
    ${dot(seriesCost, yCost, "var(--good)")}
    ${dot(seriesTokens, yTok, "#c9622a")}
    ${labels}
  </svg>`;
}

function donutSvg(entries, colors) {
  const total = entries.reduce((s, [, t]) => s + totalTokens(t), 0) || 1;
  const top = entries.slice(0, 4);
  const restTotal = entries.slice(4).reduce((s, [, t]) => s + totalTokens(t), 0);
  const slices = top.map(([, t], i) => ({ value: totalTokens(t), color: colors[i % colors.length] }));
  if (restTotal > 0) slices.push({ value: restTotal, color: "var(--ink-faint)" });
  const r = 58, cx = 76, cy = 76, sw = 24;
  const circumference = 2 * Math.PI * r;
  let acc = 0;
  const arcs = slices.map(s => {
    const frac = s.value / total;
    const dash = frac * circumference;
    const offset = circumference - acc * circumference;
    acc += frac;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
  }).join("");
  return `<svg width="152" height="152" viewBox="0 0 152 152">${arcs}</svg>`;
}

function projectLegendTable(entries, total, colors) {
  if (!entries.length) return emptyMini();
  const top = entries.slice(0, 4);
  const restTotal = entries.slice(4).reduce((s, [, t]) => s + totalTokens(t), 0);
  const rows = top.map(([pkey, t], i) => ({ label: projectName(pkey), value: totalTokens(t), color: colors[i % colors.length] }));
  if (restTotal > 0) rows.push({ label: "Autres", value: restTotal, color: "var(--ink-faint)" });
  return rows.map(r => `
    <div class="lt-row">
      <div class="lt-name"><span class="lt-dot" style="background:${r.color}"></span>${escapeHtml(r.label)}</div>
      <div class="lt-value">${fmtCompact(r.value)}</div>
      <div class="lt-pct">${total ? ((r.value / total) * 100).toFixed(1) : "0.0"}%</div>
    </div>`).join("");
}

async function loadData() {
  try {
    const res = await fetch(`/api/device-view/${encodeURIComponent(DEVICE_ID)}/${encodeURIComponent(TOKEN)}`);
    if (!res.ok) { renderInvalid(); return null; }
    const data = await res.json();
    state.data = data;
    render();
    return data;
  } catch (e) {
    renderInvalid();
    return null;
  }
}

function renderInvalid() {
  document.getElementById("main").innerHTML = `
    <div class="brand"><span class="mark"></span>Ledger · vue appareil</div>
    <div class="empty"><div class="big">⚠</div><strong>Lien invalide ou expiré.</strong><div style="margin-top:6px">Demande un nouveau lien de partage depuis le CRM.</div></div>`;
}

function refreshBanner() {
  if (!state.refreshing) return "";
  const elapsed = Math.round((Date.now() - state.refreshStartedAt) / 1000);
  const seen = state.data && state.data.seen;
  const line = seen
    ? "Appareil détecté — en attente de son prochain passage."
    : elapsed > 90 ? "Aucun signe de cet appareil depuis le début de l'attente." : "En attente d'un premier contact de cet appareil…";
  return `<div class="card" style="border-color:var(--accent)"><div class="info-card" style="gap:14px">
    <div class="mono" style="font-size:20px;color:var(--accent)">${elapsed}s</div>
    <div><div><strong>Synchro en cours</strong> <span style="color:var(--ink-faint);font-size:12px">(vérification n°${state.refreshAttempts})</span></div>
    <div style="color:var(--ink-dim);font-size:12.5px;margin-top:2px">${line}</div></div>
  </div></div>`;
}

function allPromoCodes() {
  const promotions = (state.data && state.data.promotions) || [];
  return promotions.flatMap(p => p.codes.map(c => ({ id: c.id, code: c.code, promotionName: p.name, divisor: p.divisor })));
}

function buildPromoCodeItem() {
  if (!state.data.hasClient) return "";
  const current = state.data.currentPromoCodeId ? allPromoCodes().find(pc => pc.id === state.data.currentPromoCodeId) : null;
  if (current) {
    return `<div class="info-item"><div class="il">Code promo</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:3px">
        <span class="mono" style="font-size:12.5px">${escapeHtml(current.code)} (÷${current.divisor})</span>
        <button class="btn ghost sm" id="btn-remove-device-promo">Retirer</button>
      </div>
    </div>`;
  }
  return `<div class="info-item"><div class="il">Code promo</div>
    <div style="display:flex;gap:6px;margin-top:3px">
      <input id="device-promo-input" placeholder="CODE" style="width:110px;text-transform:uppercase;font-size:12.5px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--ink)">
      <button class="btn sm" id="btn-apply-device-promo">Appliquer</button>
    </div>
  </div>`;
}

const INVOICE_STATUS_LABELS = { draft: "Brouillon", sent: "Envoyée", paid: "Payée" };
const INVOICE_STATUS_COLORS = { draft: "var(--ink-faint)", sent: "var(--warn)", paid: "var(--good)" };

function buildBillingCard(deviceTotalCost) {
  const b = state.data.billing;
  if (!b || b.entries.length === 0) return "";
  const remaining = deviceTotalCost - b.totalPaid;
  return `
    <div class="card">
      <div class="trend-head"><h3>Facturation de cet appareil</h3></div>
      <div class="card-body">
        <div class="hint" style="color:var(--ink-faint);font-size:11.5px;margin-bottom:10px">Le restant est calculé sur le coût réel de l'appareil, pas seulement sur ce qui a été facturé — utile quand une facture ne couvre qu'une partie du coût.</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px">
          <div><div class="il">Coût total (appareil)</div><div class="mono" style="font-size:18px;font-weight:650;margin-top:2px">${fmtUsd(deviceTotalCost)}</div></div>
          <div><div class="il">Payé</div><div class="mono" style="font-size:18px;font-weight:650;margin-top:2px;color:var(--good)">${fmtUsd(b.totalPaid)}</div></div>
          <div><div class="il">Restant</div><div class="mono" style="font-size:18px;font-weight:650;margin-top:2px;color:${remaining > 0 ? "var(--warn)" : "var(--ink-faint)"}">${fmtUsd(remaining)}</div></div>
        </div>
        <table>
          <thead><tr><th>Date</th><th>Statut</th><th class="num">Montant</th></tr></thead>
          <tbody>
            ${b.entries.map(e => `<tr>
              <td class="mono">${new Date(e.date).toLocaleDateString("fr-FR")}</td>
              <td><span class="dot" style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${INVOICE_STATUS_COLORS[e.status]};margin-right:6px"></span>${INVOICE_STATUS_LABELS[e.status] || e.status}</td>
              <td class="num mono">${fmtUsd(e.amount)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function render() {
  if (!state.data) return;
  const d = state.data.device;
  const rows = state.data.rows || [];
  const main = document.getElementById("main");
  const deviceTotalCost = rows.reduce((s, r) => s + costOf(r.model, r), 0);

  const head = `
    <div class="brand"><span class="mark"></span>Ledger · vue appareil</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
      <div><h1>${escapeHtml(d.name)}</h1><div class="desc">Statistiques de consommation Claude Code de cet appareil</div></div>
      <button class="btn primary" id="btn-refresh" ${state.refreshing ? "disabled" : ""}>${state.refreshing ? "⏳ Synchro en cours…" : "↻ Rafraîchir"}</button>
    </div>
    <div class="card"><div class="info-card">
      <span class="widget-live ${state.data.seen ? "on" : "off"}"><span class="w-pulse"></span>${state.data.seen ? "Actif" : "Hors ligne"}</span>
      ${d.hostname && d.hostname !== d.name ? `<div class="info-item"><div class="il">Machine</div><div class="iv">${escapeHtml(d.hostname)}</div></div>` : ""}
      ${d.firstSeen ? `<div class="info-item"><div class="il">Premier contact</div><div class="iv">${new Date(d.firstSeen).toLocaleDateString("fr-FR")}</div></div>` : ""}
      ${d.lastSeen ? `<div class="info-item"><div class="il">Dernier contact</div><div class="iv">${timeAgo(d.lastSeen)}</div></div>` : ""}
      <div class="info-item"><div class="il">Dernière donnée reçue</div><div class="iv">${state.data.lastDataAt ? timeAgo(state.data.lastDataAt) : "—"}</div></div>
      ${buildPromoCodeItem()}
    </div></div>
    ${buildBillingCard(deviceTotalCost)}
    ${refreshBanner()}
  `;

  if (rows.length === 0) {
    main.innerHTML = `${head}<div class="card"><div class="empty"><div class="big">▧</div>Aucune conso reçue pour cet appareil pour l'instant.</div></div>`;
    wire();
    return;
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const ydt = new Date(now); ydt.setDate(ydt.getDate() - 1);
  const yesterdayStr = ydt.toISOString().slice(0, 10);
  const rowsToday = rows.filter(r => r.date === todayStr);
  const rowsYesterday = rows.filter(r => r.date === yesterdayStr);
  const cacheOf = r => (r.cacheCreate || 0) + (r.cacheRead || 0);

  const tokTotal = { today: rowsToday.reduce((s, r) => s + totalTokens(r), 0), yest: rowsYesterday.reduce((s, r) => s + totalTokens(r), 0), all: rows.reduce((s, r) => s + totalTokens(r), 0) };
  const costTotal = { today: rowsToday.reduce((s, r) => s + costOf(r.model, r), 0), yest: rowsYesterday.reduce((s, r) => s + costOf(r.model, r), 0), all: rows.reduce((s, r) => s + costOf(r.model, r), 0) };
  const cacheTotal = { today: rowsToday.reduce((s, r) => s + cacheOf(r), 0), yest: rowsYesterday.reduce((s, r) => s + cacheOf(r), 0), all: rows.reduce((s, r) => s + cacheOf(r), 0) };

  const spTokens = dailySeries(rows, 7, rs => rs.reduce((s, r) => s + totalTokens(r), 0));
  const spCost = dailySeries(rows, 7, rs => rs.reduce((s, r) => s + costOf(r.model, r), 0));
  const spCache = dailySeries(rows, 7, rs => rs.reduce((s, r) => s + cacheOf(r), 0));

  const kpiHtml = `
    <div class="kpi-grid">
      ${kpiCard({
        icon: "◆", iconBg: "linear-gradient(135deg,#e08a3c,#c9622a)", sparkColor: "#c9622a",
        badgePct: pctChange(tokTotal.today, tokTotal.yest), title: "Tokens", big: fmtCompact(tokTotal.today),
        periods: [{ label: "Aujourd'hui", value: fmtCompact(tokTotal.today) }, { label: "Hier", value: fmtCompact(tokTotal.yest) }, { label: "Total", value: fmtCompact(tokTotal.all) }],
        sparkValues: spTokens.values,
      })}
      ${kpiCard({
        icon: "$", iconBg: "linear-gradient(135deg,#3f8f6e,#276b52)", sparkColor: "var(--good)",
        badgePct: pctChange(costTotal.today, costTotal.yest), title: "Coût estimé", big: fmtUsd(costTotal.today),
        periods: [{ label: "Aujourd'hui", value: fmtUsd(costTotal.today) }, { label: "Hier", value: fmtUsd(costTotal.yest) }, { label: "Total", value: fmtUsd(costTotal.all) }],
        sparkValues: spCost.values,
      })}
      ${kpiCard({
        icon: "▤", iconBg: "linear-gradient(135deg,#6a5aa8,#4a3c80)", sparkColor: "var(--violet)",
        badgePct: pctChange(cacheTotal.today, cacheTotal.yest), title: "Cache", big: fmtCompact(cacheTotal.today),
        periods: [{ label: "Aujourd'hui", value: fmtCompact(cacheTotal.today) }, { label: "Hier", value: fmtCompact(cacheTotal.yest) }, { label: "Total", value: fmtCompact(cacheTotal.all) }],
        sparkValues: spCache.values,
      })}
    </div>`;

  const period = state.trendPeriod;
  const trendTok = dailySeries(rows, period, rs => rs.reduce((s, r) => s + totalTokens(r), 0));
  const trendCost = dailySeries(rows, period, rs => rs.reduce((s, r) => s + costOf(r.model, r), 0));
  const trendTok2x = dailySeries(rows, period * 2, rs => rs.reduce((s, r) => s + totalTokens(r), 0));
  const trendCost2x = dailySeries(rows, period * 2, rs => rs.reduce((s, r) => s + costOf(r.model, r), 0));
  const curTok = trendTok2x.values.slice(period).reduce((a, b) => a + b, 0);
  const prevTok = trendTok2x.values.slice(0, period).reduce((a, b) => a + b, 0);
  const curCost = trendCost2x.values.slice(period).reduce((a, b) => a + b, 0);
  const prevCost = trendCost2x.values.slice(0, period).reduce((a, b) => a + b, 0);
  const trendPct = state.trendMetric === "tokens" ? pctChange(curTok, prevTok) : pctChange(curCost, prevCost);
  const trendUp = trendPct >= 0;

  const trendCard = `
    <div class="card" style="margin-bottom:0">
      <div class="trend-head">
        <div class="trend-head-title"><div class="th-icon">▦</div><h3>Consommation des ${period} derniers jours</h3></div>
        <div class="trend-controls">
          <div class="tabs">
            <button data-trend-metric="tokens" class="${state.trendMetric === "tokens" ? "active" : ""}">Tokens</button>
            <button data-trend-metric="cost" class="${state.trendMetric === "cost" ? "active" : ""}">Coût</button>
          </div>
          <select id="trend-period" class="period-select">
            <option value="7" ${period === 7 ? "selected" : ""}>7 jours</option>
            <option value="14" ${period === 14 ? "selected" : ""}>14 jours</option>
            <option value="30" ${period === 30 ? "selected" : ""}>30 jours</option>
          </select>
        </div>
      </div>
      <div class="card-body chart-wrap">
        <div class="legend" style="margin:0 0 10px"><span><span class="sw" style="background:#c9622a"></span>Tokens</span><span><span class="sw" style="background:var(--good)"></span>Coût (USD)</span></div>
        ${lineChartDual(trendTok.dates, trendTok.values, trendCost.values, state.trendMetric)}
      </div>
      <div class="trend-foot">
        <span class="trend-note ${trendUp ? "up" : "down"}">${trendUp ? "↗" : "↘"} ${Math.abs(trendPct).toFixed(0)}% de ${state.trendMetric === "tokens" ? "tokens" : "coût"} par rapport à la période précédente</span>
      </div>
    </div>`;

  const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
  const in30 = rows.filter(r => r.date >= d30.toISOString().slice(0, 10));
  const byProject = aggregate(in30, r => r.projectKey);
  const projectEntries = [...byProject.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));
  const projectTotal = projectEntries.reduce((s, [, t]) => s + totalTokens(t), 0);
  const projColors = ["var(--accent)", "var(--violet)", "#c9622a", "var(--bad)"];

  const donutCard = `
    <div class="card" style="margin-bottom:0">
      <div class="trend-head"><div class="trend-head-title"><div class="th-icon" style="background:linear-gradient(135deg,#6a5aa8,#4a3c80)">◐</div><h3>Répartition par projet</h3></div></div>
      <div class="card-body">
        <div class="donut-row">
          <div style="position:relative">
            ${donutSvg(projectEntries, projColors)}
            <div class="donut-center-label" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div class="dc-total">Total</div><div class="dc-value">${fmtCompact(projectTotal)}</div><div class="dc-unit">tokens</div>
            </div>
          </div>
          <div class="legend-table">
            <div class="lt-head"><span>Projet</span><span>Tokens</span><span>%</span></div>
            ${projectEntries.length ? projectLegendTable(projectEntries, projectTotal, projColors) : emptyMini()}
          </div>
        </div>
      </div>
    </div>`;

  const detailTable = buildDetailTableCard(projectEntries, in30);

  main.innerHTML = `
    ${head}
    ${kpiHtml}
    <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:14px;align-items:start;margin-bottom:20px">
      ${trendCard}
      ${donutCard}
    </div>
    ${detailTable}
  `;
  wire();
}

function wire() {
  const btn = document.getElementById("btn-refresh");
  if (btn) btn.onclick = handleRefresh;
  document.querySelectorAll("[data-trend-metric]").forEach(el => {
    el.onclick = () => { state.trendMetric = el.dataset.trendMetric; render(); };
  });
  const periodSelect = document.getElementById("trend-period");
  if (periodSelect) periodSelect.onchange = () => { state.trendPeriod = parseInt(periodSelect.value, 10); render(); };

  const detailSearchInput = document.getElementById("detail-search-input");
  if (detailSearchInput) {
    detailSearchInput.oninput = () => {
      const pos = detailSearchInput.selectionStart;
      state.detailSearch = detailSearchInput.value;
      state.detailPage = 0;
      render();
      const el = document.getElementById("detail-search-input");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    };
  }
  const detailPagePrev = document.getElementById("detail-page-prev");
  if (detailPagePrev) detailPagePrev.onclick = () => { state.detailPage = Math.max(0, state.detailPage - 1); render(); };
  const detailPageNext = document.getElementById("detail-page-next");
  if (detailPageNext) detailPageNext.onclick = () => { state.detailPage++; render(); };

  async function updateDevicePromoCode(promoCodeId) {
    try {
      const res = await fetch(`/api/device-view/${encodeURIComponent(DEVICE_ID)}/${encodeURIComponent(TOKEN)}/promo-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promoCodeId }),
      });
      if (!res.ok) throw new Error("echec");
      await loadData();
    } catch (e) {
      alert("Erreur lors de la mise à jour du code promo.");
    }
  }
  const applyPromoBtn = document.getElementById("btn-apply-device-promo");
  if (applyPromoBtn) {
    applyPromoBtn.onclick = () => {
      const input = document.getElementById("device-promo-input");
      const raw = input.value.trim().toUpperCase();
      if (!raw) return;
      const match = allPromoCodes().find(pc => pc.code.toUpperCase() === raw);
      if (!match) { alert("Code promo invalide."); return; }
      updateDevicePromoCode(match.id);
    };
  }
  const removePromoBtn = document.getElementById("btn-remove-device-promo");
  if (removePromoBtn) removePromoBtn.onclick = () => updateDevicePromoCode(null);
}

async function handleRefresh() {
  const previousLastDataAt = state.data ? state.data.lastDataAt : null;
  state.refreshing = true;
  state.refreshStartedAt = Date.now();
  state.refreshAttempts = 0;
  render();
  try {
    const res = await fetch(`/api/device-view/${encodeURIComponent(DEVICE_ID)}/${encodeURIComponent(TOKEN)}/request-sync`, { method: "POST" });
    if (!res.ok) throw new Error("Lien invalide.");
  } catch (e) {
    toast("Erreur : " + e.message);
    state.refreshing = false;
    render();
    return;
  }

  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    state.refreshAttempts++;
    const data = await loadData();
    if (data && data.lastDataAt && data.lastDataAt !== previousLastDataAt) {
      state.refreshing = false;
      render();
      toast("Données à jour");
      return;
    }
    render();
  }
  state.refreshing = false;
  render();
  toast(state.data && state.data.seen ? "L'appareil répond mais n'a pas encore terminé — réessaie dans une minute" : "Cet appareil ne répond pas — vérifie que son agent tourne toujours");
}

if (!DEVICE_ID || !TOKEN) {
  renderInvalid();
} else {
  loadData();
  setInterval(() => { if (!state.refreshing) loadData(); }, 60000);
}
