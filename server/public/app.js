"use strict";

const state = {
  view: "dashboard",
  clients: [],
  projects: [],
  usage: [],
  devices: [],
  invoices: [],
  promotions: [],
  syncApiKey: null,
  pricing: null,
  lastSync: null,
  agentLastSeen: null,
  loaded: false,
  refreshing: false,
  refreshStartedAt: null,
  refreshAttempts: 0,
  trendMetric: "tokens",
  trendPeriod: 7,
  selectedDeviceId: null,
  selectedInvoiceId: null,
  deviceRefreshing: false,
  deviceRefreshStartedAt: null,
  deviceRefreshAttempts: 0,
  detailSearch: "",
  detailPage: 0,
  docsOS: "windows",
  docsPythonMode: "no-python",
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
  updatedAt: null,
};

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}

/* navigator.clipboard exige un contexte securise (HTTPS ou localhost) — en
   HTTP simple (deploiement sans reverse proxy TLS), l'API est absente ou
   rejette silencieusement. On retente via un textarea + execCommand('copy')
   (fonctionne en HTTP), puis en dernier recours une invite manuelle. */
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* on retente en dessous */ }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return true;
  } catch (e) { /* on retente en dessous */ }
  window.prompt("Copie manuellement (Ctrl/Cmd+C) :", text);
  return false;
}

function fmtNum(n) { if (n === undefined || n === null || isNaN(n)) return "–"; return Math.round(n).toLocaleString("fr-FR"); }
function fmtCompact(n) {
  if (n === undefined || n === null || isNaN(n)) return "–";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2).replace(".", ",") + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(".", ",") + "k";
  return Math.round(n).toString();
}
function fmtUsd(n) { if (n === undefined || n === null || isNaN(n)) return "–"; return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function modelLabel(model) { return model ? model.replace("claude-", "") : "?"; }
function colorForModel(model) {
  const cls = model ? modelLabel(model) : "";
  if (/opus|fable|mythos/.test(model || "")) return "var(--violet)";
  if (/sonnet/.test(model || "")) return "var(--accent)";
  if (/haiku/.test(model || "")) return "var(--warn)";
  return "var(--ink-faint)";
}
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

/* per-day series over the last `days` days ending today, using `reducer(dayRows) -> number` */
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

function sparklineSvg(values, color) {
  const w = 240, h = 34, pad = 3;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (h - pad * 2) * (1 - (v - min) / range);
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`;
  const last = pts[pts.length - 1];
  return `<svg class="kpi-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" opacity="0.12" stroke="none"></path>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${color}"></circle>
  </svg>`;
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

  const dot = (values, yFn, color) => {
    const i = values.length - 1;
    return `<circle cx="${(padL + i * stepX).toFixed(1)}" cy="${yFn(values[i]).toFixed(1)}" r="3.5" fill="${color}"></circle>`;
  };

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;display:block" role="img" aria-label="Consommation dans le temps">
    ${gridY}
    <path d="${costPath}" fill="none" stroke="var(--good)" stroke-width="${tokActive ? 1.5 : 2.25}" opacity="${tokActive ? 0.45 : 1}" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="${tokPath}" fill="none" stroke="#c9622a" stroke-width="${tokActive ? 2.25 : 1.5}" opacity="${tokActive ? 1 : 0.45}" stroke-linecap="round" stroke-linejoin="round"></path>
    ${dot(seriesCost, yCost, "var(--good)")}
    ${dot(seriesTokens, yTok, "#c9622a")}
    ${labels}
  </svg>`;
}

/* ---------------- KPI + trend cards ---------------- */
function kpiCard({ icon, iconBg, sparkColor, badgePct, title, big, periods, sparkValues }) {
  const cls = badgePct > 0.5 ? "up" : badgePct < -0.5 ? "down" : "flat";
  const arrow = badgePct > 0.5 ? "↗" : badgePct < -0.5 ? "↘" : "→";
  const pctDisplay = Math.min(Math.abs(badgePct), 999);
  const periodsHtml = periods.map(p => `<div><div class="kp-label">${escapeHtml(p.label)}</div><div class="kp-value">${p.value}</div></div>`).join("");
  return `
    <div class="kpi-card">
      <div class="kpi-top">
        <div class="kpi-id">
          <div class="kpi-icon" style="background:${iconBg}">${icon}</div>
          <div class="kpi-title">${escapeHtml(title)}</div>
        </div>
        <span class="kpi-pct ${cls}">${arrow} ${pctDisplay.toFixed(0)}${pctDisplay >= 999 ? "+" : ""}%</span>
      </div>
      <div class="kpi-big">${big}</div>
      <div class="kpi-periods">${periodsHtml}</div>
      ${sparklineSvg(sparkValues, sparkColor)}
    </div>`;
}

function legendTable(entries, total, colors) {
  if (!entries.length) return emptyMini();
  const top = entries.slice(0, 4);
  const restTotal = entries.slice(4).reduce((s, [, t]) => s + totalTokens(t), 0);
  const rows = top.map(([model, t], i) => ({ label: modelLabel(model), value: totalTokens(t), color: colors[i % colors.length] }));
  if (restTotal > 0) rows.push({ label: "Autres", value: restTotal, color: "var(--ink-faint)" });
  return rows.map(r => `
    <div class="lt-row">
      <div class="lt-name"><span class="lt-dot" style="background:${r.color}"></span>${escapeHtml(r.label)}</div>
      <div class="lt-value">${fmtCompact(r.value)}</div>
      <div class="lt-pct">${total ? ((r.value / total) * 100).toFixed(1) : "0.0"}%</div>
    </div>`).join("");
}

function projectLegendTable(entries, total, colors) {
  if (!entries.length) return emptyMini();
  const top = entries.slice(0, 4);
  const restTotal = entries.slice(4).reduce((s, [, t]) => s + totalTokens(t), 0);
  const rows = top.map(([pkey, t], i) => {
    const proj = projectForKey(pkey);
    return { label: proj ? proj.name : pkey, value: totalTokens(t), color: colors[i % colors.length] };
  });
  if (restTotal > 0) rows.push({ label: "Autres", value: restTotal, color: "var(--ink-faint)" });
  return rows.map(r => `
    <div class="lt-row">
      <div class="lt-name"><span class="lt-dot" style="background:${r.color}"></span>${escapeHtml(r.label)}</div>
      <div class="lt-value">${fmtCompact(r.value)}</div>
      <div class="lt-pct">${total ? ((r.value / total) * 100).toFixed(1) : "0.0"}%</div>
    </div>`).join("");
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

/* ---------------- activity feed (built from real, available signals) ---------------- */
function buildActivityFeed(modelsToday) {
  const items = [];
  if (state.lastSync) {
    items.push({ color: "var(--violet)", label: "Synchro reçue", value: `${state.lastSync.written} enreg.`, time: timeAgo(state.lastSync.at), ts: state.lastSync.at });
  }
  if (state.agentLastSeen) {
    const seen = agentStatus().seen;
    items.push({ color: seen ? "var(--good)" : "var(--warn)", label: "Agent local vu", value: seen ? "Actif" : "Hors ligne", time: timeAgo(state.agentLastSeen), ts: state.agentLastSeen });
  }
  if (modelsToday.length) {
    const [m, t] = modelsToday[0];
    items.push({ color: colorForModel(m), label: `Modèle le plus utilisé`, value: `${modelLabel(m)} · ${fmtCompact(totalTokens(t))}`, time: "aujourd'hui", ts: null });
  }
  const recentProject = state.projects.slice().filter(p => p.created_at).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))[0];
  if (recentProject) {
    items.push({ color: "#c9622a", label: "Projet suivi ajouté", value: recentProject.name, time: timeAgo(recentProject.created_at), ts: recentProject.created_at });
  }
  const recentClient = state.clients.slice().filter(c => c.created_at).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))[0];
  if (recentClient) {
    items.push({ color: "var(--violet)", label: "Client ajouté", value: recentClient.name, time: timeAgo(recentClient.created_at), ts: recentClient.created_at });
  }
  return items.slice(0, 5);
}

function pricingFor(model) {
  const p = state.pricing || DEFAULT_PRICING;
  return p.models[model] || p.fallback || DEFAULT_PRICING.fallback;
}
/* facteur de calibration : le calcul brut (prix/1M tokens) surestimait le cout
   reel d'un facteur ~200 constate par comparaison avec la facturation Anthropic
   reelle — a ajuster si les tarifs par modele sont un jour corriges directement. */
const COST_CALIBRATION_FACTOR = 200;
function costOf(model, totals) {
  const p = pricingFor(model);
  const t = totals || {};
  const raw = (t.input || 0) * p.in / 1e6 + (t.output || 0) * p.out / 1e6 +
              (t.cacheCreate || 0) * p.cacheWrite / 1e6 + (t.cacheRead || 0) * p.cacheRead / 1e6;
  return raw / COST_CALIBRATION_FACTOR;
}

/* ---------------- API ---------------- */
async function api(path, opts) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function loadState() {
  try {
    const data = await api("/api/state");
    state.clients = data.clients || [];
    state.projects = data.projects || [];
    state.usage = data.usage || [];
    state.devices = data.devices || [];
    state.invoices = data.invoices || [];
    state.promotions = data.promotions || [];
    state.syncApiKey = data.syncApiKey || null;
    state.pricing = data.pricing || DEFAULT_PRICING;
    state.lastSync = data.lastSync || null;
    state.agentLastSeen = data.agentLastSeen || null;
    state.loaded = true;
    updateSidebarStatus();
    render();
  } catch (e) {
    document.getElementById("sidebar-status").innerHTML = `<span class="dot"></span>Erreur de connexion`;
  }
}

function agentStatus() {
  // l'agent local (daemon) reste connecte via long-polling (/api/sync-wait, ~500ms de latence)
  if (!state.agentLastSeen) return { seen: false, label: "jamais détecté" };
  const secAgo = (Date.now() - new Date(state.agentLastSeen).getTime()) / 1000;
  if (secAgo < 150) return { seen: true, secAgo, label: `actif (vu il y a ${Math.round(secAgo)}s)` };
  return { seen: false, secAgo, label: `silencieux depuis ${Math.round(secAgo / 60)} min` };
}

function updateSidebarStatus() {
  const el = document.getElementById("sidebar-status");
  const agent = agentStatus();
  const dotCls = agent.seen ? "ok" : "stale";
  const title = agent.seen ? "Système opérationnel" : "Agent local hors ligne";
  const syncLine = state.lastSync ? `Dernier envoi : ${new Date(state.lastSync.at).toLocaleTimeString("fr-FR")}` : "Aucun envoi reçu";
  el.innerHTML = `
    <span class="sys-dot ${dotCls}"></span>
    <div>
      <div class="sys-title">${title}</div>
      <div class="sys-sub">${agent.seen ? syncLine : "Vérifie l'agent (onglet Docs)"}</div>
    </div>`;
}

/* ---------------- derived data helpers ---------------- */
function projectForKey(key) { return state.projects.find(p => (p.projectKeys || []).includes(key)); }
function clientForProject(project) { return project ? state.clients.find(c => c.id === project.clientId || c.id === project.client_id) : null; }

function allDailyRows() {
  const rows = [];
  for (const u of state.usage) {
    const daily = u.daily || {};
    for (const [date, t] of Object.entries(daily)) rows.push({ date, projectKey: u.projectKey, model: u.model, deviceId: u.deviceId, ...t });
  }
  return rows;
}
function aggregate(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, count: 0 });
    const b = map.get(k);
    b.input += r.input || 0; b.output += r.output || 0;
    b.cacheCreate += r.cacheCreate || 0; b.cacheRead += r.cacheRead || 0;
    b.count++;
  }
  return map;
}
function totalTokens(t) { return (t.input || 0) + (t.output || 0) + (t.cacheCreate || 0) + (t.cacheRead || 0); }

/* ---------------- rendering ---------------- */
function render() {
  const main = document.getElementById("main");
  const activeNavView = state.view === "device-detail" ? "devices" : state.view === "invoice-detail" ? "invoices" : state.view;
  document.querySelectorAll(".navitem").forEach(b => b.classList.toggle("active", b.dataset.view === activeNavView));
  document.body.classList.toggle("print-isolate", state.view === "invoice-detail");
  if (!state.loaded) { main.innerHTML = `<div class="empty">Chargement…</div>`; return; }
  if (state.view === "dashboard") main.innerHTML = renderDashboard();
  else if (state.view === "clients") main.innerHTML = renderClients();
  else if (state.view === "projects") main.innerHTML = renderProjects();
  else if (state.view === "invoices") main.innerHTML = renderInvoices();
  else if (state.view === "invoice-detail") main.innerHTML = renderInvoiceDetail();
  else if (state.view === "promotions") main.innerHTML = renderPromotions();
  else if (state.view === "import") main.innerHTML = renderImport();
  else if (state.view === "devices") main.innerHTML = renderDevices();
  else if (state.view === "device-detail") main.innerHTML = renderDeviceDetail();
  else if (state.view === "settings") main.innerHTML = renderSettings();
  wireView();
}

const cacheOf = r => (r.cacheCreate || 0) + (r.cacheRead || 0);

/* ---- blocs reutilisables (tableau de bord global + vue par appareil) ---- */
function buildKpiSection(rows) {
  const now = new Date();
  const totalAll = rows.reduce((s, r) => s + totalTokens(r), 0);
  const costAll = rows.reduce((s, r) => s + costOf(r.model, r), 0);
  const todayStr = now.toISOString().slice(0, 10);
  const ydt = new Date(now); ydt.setDate(ydt.getDate() - 1);
  const yesterdayStr = ydt.toISOString().slice(0, 10);
  const rowsToday = rows.filter(r => r.date === todayStr);
  const rowsYesterday = rows.filter(r => r.date === yesterdayStr);

  const tokTotal = { today: rowsToday.reduce((s, r) => s + totalTokens(r), 0), yest: rowsYesterday.reduce((s, r) => s + totalTokens(r), 0), all: totalAll };
  const costTotal = { today: rowsToday.reduce((s, r) => s + costOf(r.model, r), 0), yest: rowsYesterday.reduce((s, r) => s + costOf(r.model, r), 0), all: costAll };
  const cacheTotal = { today: rowsToday.reduce((s, r) => s + cacheOf(r), 0), yest: rowsYesterday.reduce((s, r) => s + cacheOf(r), 0), all: rows.reduce((s, r) => s + cacheOf(r), 0) };
  const projSetToday = new Set(rowsToday.map(r => r.projectKey));
  const projSetYesterday = new Set(rowsYesterday.map(r => r.projectKey));
  const projSetAll = new Set(rows.map(r => r.projectKey));

  const spTokens = dailySeries(rows, 7, rs => rs.reduce((s, r) => s + totalTokens(r), 0));
  const spCost = dailySeries(rows, 7, rs => rs.reduce((s, r) => s + costOf(r.model, r), 0));
  const spCache = dailySeries(rows, 7, rs => rs.reduce((s, r) => s + cacheOf(r), 0));
  const spProjects = dailySeries(rows, 7, rs => new Set(rs.map(r => r.projectKey)).size);

  return `
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
      ${kpiCard({
        icon: "◇", iconBg: "linear-gradient(135deg,#4a7fb5,#345f8c)", sparkColor: "#4a7fb5",
        badgePct: pctChange(projSetToday.size, projSetYesterday.size), title: "Projets actifs", big: String(projSetToday.size),
        periods: [{ label: "Aujourd'hui", value: projSetToday.size }, { label: "Hier", value: projSetYesterday.size }, { label: "Total suivis", value: projSetAll.size }],
        sparkValues: spProjects.values,
      })}
    </div>
  `;
}

function buildTrendCard(rows) {
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

  return `
    <div class="card" style="margin-bottom:0">
      <div class="trend-head">
        <div class="trend-head-title">
          <div class="th-icon">▦</div>
          <h3>Consommation des ${period} derniers jours</h3>
        </div>
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
        <button class="link-arrow" id="btn-scroll-detail">Voir le détail →</button>
      </div>
    </div>`;
}

function buildDonutCard(projectEntries) {
  const projectTotal = projectEntries.reduce((s, [, t]) => s + totalTokens(t), 0);
  const projColors = ["var(--accent)", "var(--violet)", "#c9622a", "var(--bad)"];
  return `
    <div class="card" style="margin-bottom:0">
      <div class="trend-head">
        <div class="trend-head-title">
          <div class="th-icon" style="background:linear-gradient(135deg,#6a5aa8,#4a3c80)">◐</div>
          <h3>Répartition par projet</h3>
        </div>
      </div>
      <div class="card-body">
        <div class="donut-row">
          <div style="position:relative">
            ${donutSvg(projectEntries, projColors)}
            <div class="donut-center-label" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div class="dc-total">Total</div>
              <div class="dc-value">${fmtCompact(projectTotal)}</div>
              <div class="dc-unit">tokens</div>
            </div>
          </div>
          <div class="legend-table">
            <div class="lt-head"><span>Projet</span><span>Tokens</span><span>%</span></div>
            ${projectEntries.length ? projectLegendTable(projectEntries, projectTotal, projColors) : emptyMini()}
          </div>
        </div>
      </div>
      <div class="trend-foot" style="justify-content:flex-end">
        <button class="link-arrow" data-nav="projects">Voir tous les projets →</button>
      </div>
    </div>`;
}

function buildDetailTableCard(projectEntries, in30) {
  const resolved = projectEntries.map(([pkey, t]) => {
    const proj = projectForKey(pkey);
    const client = clientForProject(proj);
    const cost = in30.filter(r => r.projectKey === pkey).reduce((s, r) => s + costOf(r.model, r), 0);
    const name = proj ? proj.name : pkey;
    return { pkey, proj, client, t, cost, name };
  });

  const q = state.detailSearch.trim().toLowerCase();
  const filtered = q
    ? resolved.filter(r => r.name.toLowerCase().includes(q) || (r.client && r.client.name.toLowerCase().includes(q)))
    : resolved;

  const totalPages = Math.max(1, Math.ceil(filtered.length / DETAIL_PAGE_SIZE));
  const page = Math.min(state.detailPage, totalPages - 1);
  const pageRows = filtered.slice(page * DETAIL_PAGE_SIZE, (page + 1) * DETAIL_PAGE_SIZE);

  return `
    <div class="card" id="detail-table">
      <div class="card-head">
        <h3>Détail par projet</h3>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="hint">30 derniers jours, coût estimé</span>
          <input type="search" id="detail-search-input" placeholder="Rechercher un projet ou un client…" value="${escapeHtml(state.detailSearch)}"
            style="padding:6px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--ink);font-size:12.5px;width:220px">
        </div>
      </div>
      <div class="card-body" style="padding:0">
        ${pageRows.length === 0 ? `<div class="empty" style="padding:30px 20px">Aucun projet ne correspond à la recherche.</div>` : `
        <table>
          <thead><tr><th>Projet</th><th>Client</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache</th><th class="num">Total</th><th class="num">Coût est.</th></tr></thead>
          <tbody>
            ${pageRows.map(r => `<tr>
                <td>${escapeHtml(r.name)}${!r.proj ? ` <span class="hint" style="color:var(--warn)">· non lié</span>` : ""}</td>
                <td>${escapeHtml(r.client ? r.client.name : "—")}</td>
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
        <span class="hint" style="color:var(--ink-faint)">${filtered.length} projet${filtered.length > 1 ? "s" : ""}${q ? ` (sur ${resolved.length})` : ""} · page ${page + 1} / ${totalPages}</span>
        <div style="display:flex;gap:6px">
          <button class="btn ghost sm" id="detail-page-prev" ${page === 0 ? "disabled" : ""}>← Précédent</button>
          <button class="btn ghost sm" id="detail-page-next" ${page >= totalPages - 1 ? "disabled" : ""}>Suivant →</button>
        </div>
      </div>` : ""}
    </div>`;
}

function renderDashboard() {
  const rows = allDailyRows();
  if (rows.length === 0) {
    return `
      <div class="pagehead"><div><h1>Tableau de bord</h1><div class="desc">Vue d'ensemble de ta consommation de tokens Claude Code</div></div></div>
      ${refreshProgressBanner()}
      <div class="card"><div class="empty">
        <div class="big">◧</div>
        <div><strong>Aucune donnée pour l'instant.</strong></div>
        <div style="margin-top:6px">La synchro automatique alimentera cette page dès son premier envoi.</div>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:16px">
          <button class="btn primary" id="btn-refresh" ${state.refreshing ? "disabled" : ""}>${state.refreshing ? "⏳ Synchro en cours…" : "↻ Rafraîchir maintenant"}</button>
          <button class="btn" data-nav="import">Voir le statut de synchro</button>
        </div>
      </div></div>`;
  }

  const now = new Date();
  const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
  const in30 = rows.filter(r => r.date >= d30.toISOString().slice(0, 10));
  const byProject = aggregate(in30, r => r.projectKey);
  const projectEntries = [...byProject.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));
  const rowsToday = rows.filter(r => r.date === now.toISOString().slice(0, 10));
  const modelsToday = [...aggregate(rowsToday, r => r.model).entries()].filter(([, t]) => totalTokens(t) > 0).sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));

  /* ---- agent / synchro / activite (concepts globaux, pas par appareil) ---- */
  const agentSeen = agentStatus().seen;
  const agentCard = `
    <div class="card deco-card" style="margin-bottom:0;padding:16px">
      <div class="kpi-id" style="margin-bottom:8px">
        <div class="kpi-icon" style="background:${agentSeen ? "linear-gradient(135deg,#2f8f5b,#206b41)" : "linear-gradient(135deg,#b9791f,#8f5c14)"}">●</div>
        <div><div style="font-weight:650;font-size:13.5px">Agent local</div><div class="hint" style="color:var(--ink-dim);font-size:12px">${agentSeen ? "Connecté à cette machine" : "Aucun contact récent"}</div></div>
      </div>
      ${agentSeen ? `<div class="deco-check">✓</div>` : ""}
      <div style="margin:14px 0 6px"><span class="widget-live ${agentSeen ? "on" : "off"}"><span class="w-pulse"></span>${agentSeen ? "Actif" : "Hors ligne"}</span></div>
      <div class="hint" style="color:var(--ink-faint);font-size:12px">${state.agentLastSeen ? `Dernier contact : ${new Date(state.agentLastSeen).toLocaleTimeString("fr-FR")}` : "Jamais contacté"}</div>
    </div>`;

  const syncCard = `
    <div class="card deco-card" style="margin-bottom:0;padding:16px">
      <div class="kpi-id" style="margin-bottom:8px">
        <div class="kpi-icon" style="background:linear-gradient(135deg,#8a5cc9,#5f3c96)">↻</div>
        <div><div style="font-weight:650;font-size:13.5px">Dernière synchro</div><div class="hint" style="color:var(--ink-dim);font-size:12px">${state.lastSync ? `${state.lastSync.written} enregistrement(s)` : "En attente du premier envoi"}</div></div>
      </div>
      <div class="kpi-big" style="margin:14px 0 4px">${state.lastSync ? new Date(state.lastSync.at).toLocaleTimeString("fr-FR") : "—"}</div>
      <div class="hint" style="color:var(--ink-faint);font-size:12px">${state.lastSync ? new Date(state.lastSync.at).toLocaleDateString("fr-FR") : ""}</div>
    </div>`;

  const activityItems = buildActivityFeed(modelsToday);
  const activityCard = `
    <div class="card" style="margin-bottom:0;padding:16px">
      <div class="trend-head" style="padding:0 0 10px;border-bottom:none">
        <h3 style="font-size:13.5px">Activité récente</h3>
      </div>
      ${activityItems.length ? activityItems.map(a => `
        <div class="activity-row">
          <span class="a-dot" style="background:${a.color}"></span>
          <span class="a-label">${escapeHtml(a.label)}</span>
          <span class="a-value">${escapeHtml(a.value)}</span>
          <span class="a-time">${escapeHtml(a.time)}</span>
        </div>`).join("") : `<div class="hint" style="color:var(--ink-faint);padding:8px 0">Rien à signaler pour l'instant.</div>`}
    </div>`;

  return `
    <div class="pagehead">
      <div><h1>Tableau de bord</h1><div class="desc">Vue d'ensemble de ta consommation de tokens Claude Code.</div></div>
      <div style="display:flex;align-items:center;gap:16px">
        <button class="btn" id="btn-refresh" ${state.refreshing ? "disabled" : ""}>${state.refreshing ? "⏳ Synchro en cours…" : "↻ Rafraîchir"}</button>
        <button class="btn ghost" data-nav="import" style="flex-direction:column;align-items:flex-start;gap:2px;line-height:1.3">
          <span style="font-size:11px;color:var(--ink-faint)">Statut de synchro</span>
          <span style="font-size:12.5px;font-weight:620;display:flex;align-items:center;gap:5px"><span class="sys-dot ${agentSeen ? "ok" : "stale"}" style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${agentSeen ? "var(--good)" : "var(--warn)"}"></span>${agentSeen ? "À jour" : "Décalé"}</span>
        </button>
      </div>
    </div>

    ${refreshProgressBanner()}

    ${buildKpiSection(rows)}

    <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:14px;align-items:start;margin-bottom:20px">
      ${buildTrendCard(rows)}
      ${buildDonutCard(projectEntries)}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1.2fr;gap:14px;align-items:stretch;margin-bottom:24px">
      ${agentCard}
      ${syncCard}
      ${activityCard}
    </div>

    ${buildDetailTableCard(projectEntries, in30)}
  `;
}

/* ---- vue detaillee d'un appareil ---- */
function renderDeviceDetail() {
  const device = state.devices.find(d => d.id === state.selectedDeviceId);
  if (!device) {
    state.view = "devices";
    return renderDevices();
  }
  const rows = allDailyRows().filter(r => r.deviceId === device.id);
  const st = deviceStatus(device);
  const dotColor = st.historic ? "var(--ink-faint)" : st.seen ? "var(--good)" : "var(--warn)";
  const lastImported = state.usage.filter(u => u.deviceId === device.id).reduce((max, u) => !max || u.importedAt > max ? u.importedAt : max, null);
  const deviceClient = state.clients.find(c => c.id === device.clientId);

  const header = `
    <div class="pagehead">
      <div>
        <button class="link-arrow" data-nav="devices" style="margin-bottom:8px;display:inline-block">← Appareils</button>
        <h1>${escapeHtml(device.name)}</h1>
        <div class="desc">Statistiques propres à cet appareil</div>
      </div>
      <div style="display:flex;gap:8px">
        ${device.id !== "legacy" ? `<button class="btn" id="btn-refresh-device" data-refresh-device="${device.id}" ${state.deviceRefreshing ? "disabled" : ""}>${state.deviceRefreshing ? "⏳ Synchro en cours…" : "↻ Rafraîchir"}</button>` : ""}
        ${device.id !== "legacy" ? `<button class="btn" data-share-device="${device.id}">↗ Lien de partage</button>` : ""}
        ${device.id !== "legacy" ? `<button class="btn" data-rename-device="${device.id}">Modifier</button>` : ""}
      </div>
    </div>
    <div class="card">
      <div class="card-body" style="display:flex;gap:28px;flex-wrap:wrap;align-items:center">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="dot" style="width:9px;height:9px;border-radius:50%;display:inline-block;background:${dotColor}"></span>
          <strong>${st.label}</strong>
        </div>
        ${device.hostname && device.hostname !== device.name ? `<div><div class="hint" style="color:var(--ink-faint)">Machine</div><div style="font-size:13px">${escapeHtml(device.hostname)}</div></div>` : ""}
        <div><div class="hint" style="color:var(--ink-faint)">Client</div><div style="font-size:13px">${escapeHtml(deviceClient ? deviceClient.name : "—")}</div></div>
        ${deviceClient ? `
        <div>
          <div class="hint" style="color:var(--ink-faint)">Code promo (${escapeHtml(deviceClient.name)})</div>
          ${(() => {
            const current = deviceClient.promoCodeId ? allPromoCodes().find(pc => pc.id === deviceClient.promoCodeId) : null;
            if (current) {
              return `<div style="display:flex;align-items:center;gap:6px;margin-top:3px">
                <span class="mono" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:12px">${escapeHtml(current.code)} (÷${current.divisor})</span>
                <button class="btn ghost sm" data-remove-client-promo="${deviceClient.id}">Retirer</button>
              </div>`;
            }
            return `<div style="display:flex;gap:6px;margin-top:3px">
              <input id="device-client-promo-input" data-client-id="${deviceClient.id}" placeholder="CODE" style="width:120px;text-transform:uppercase;font-size:12.5px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--ink)">
              <button class="btn sm" id="btn-apply-client-promo">Appliquer</button>
            </div>`;
          })()}
        </div>` : ""}
        ${device.firstSeen ? `<div><div class="hint" style="color:var(--ink-faint)">Premier contact</div><div class="mono" style="font-size:13px">${new Date(device.firstSeen).toLocaleDateString("fr-FR")}</div></div>` : ""}
        ${device.lastSeen ? `<div><div class="hint" style="color:var(--ink-faint)">Dernier contact</div><div class="mono" style="font-size:13px">${timeAgo(device.lastSeen)}</div></div>` : ""}
        <div><div class="hint" style="color:var(--ink-faint)">Dernière donnée reçue</div><div class="mono" style="font-size:13px">${lastImported ? timeAgo(lastImported) : "—"}</div></div>
      </div>
    </div>
    ${deviceRefreshProgressBanner(device)}
    ${buildDeviceBillingCard(device.id)}`;

  if (rows.length === 0) {
    return `${header}<div class="card"><div class="empty"><div class="big">▧</div>Aucune conso reçue pour cet appareil pour l'instant.</div></div>`;
  }

  const now = new Date();
  const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
  const in30 = rows.filter(r => r.date >= d30.toISOString().slice(0, 10));
  const byProject = aggregate(in30, r => r.projectKey);
  const projectEntries = [...byProject.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));

  return `
    ${header}
    ${buildKpiSection(rows)}
    <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:14px;align-items:start;margin-bottom:20px">
      ${buildTrendCard(rows)}
      ${buildDonutCard(projectEntries)}
    </div>
    ${buildDetailTableCard(projectEntries, in30)}
  `;
}

function emptyMini() { return `<div class="hint" style="padding:20px 0;text-align:center">Pas de données sur cette période.</div>`; }


function renderClients() {
  const rows = state.clients.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return `
    <div class="pagehead">
      <div><h1>Clients</h1><div class="desc">Les organisations ou personnes pour qui tu factures du travail Claude Code</div></div>
      <button class="btn primary" id="btn-add-client">+ Nouveau client</button>
    </div>
    <div class="card">
      ${rows.length === 0 ? `<div class="empty"><div class="big">◔</div>Aucun client pour l'instant.</div>` : `
      <table>
        <thead><tr><th>Nom</th><th>Société</th><th>Email</th><th>Code promo</th><th class="num">Projets</th><th></th></tr></thead>
        <tbody>
          ${rows.map(c => {
            const nProj = state.projects.filter(p => p.clientId === c.id).length;
            const promo = c.promoCodeId ? allPromoCodes().find(pc => pc.id === c.promoCodeId) : null;
            return `<tr class="clickable" data-edit-client="${c.id}">
              <td><strong>${escapeHtml(c.name)}</strong></td>
              <td>${escapeHtml(c.company || "—")}</td>
              <td>${escapeHtml(c.email || "—")}</td>
              <td>${promo ? `<span class="mono" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:2px 7px;font-size:12px">${escapeHtml(promo.code)} (÷${promo.divisor})</span>` : `<span class="hint" style="color:var(--ink-faint)">—</span>`}</td>
              <td class="num mono">${nProj}</td>
              <td style="text-align:right"><button class="btn ghost sm" data-del-client="${c.id}">Supprimer</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`}
    </div>
  `;
}

function renderProjects() {
  const rows = state.projects.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const unmatchedKeys = [...new Set(state.usage.map(u => u.projectKey))].filter(k => !projectForKey(k));
  return `
    <div class="pagehead">
      <div><h1>Projets</h1><div class="desc">Relie tes dossiers de travail locaux à un client pour ventiler la conso</div></div>
      <button class="btn primary" id="btn-add-project">+ Nouveau projet</button>
    </div>

    ${unmatchedKeys.length ? `
    <div class="card">
      <div class="card-head"><h3>Dossiers importés non liés</h3><span class="badge-count">${unmatchedKeys.length}</span></div>
      <div class="card-body">
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${unmatchedKeys.map(k => `<span class="btn sm" data-quick-link="${escapeHtml(k)}" style="cursor:pointer">${escapeHtml(k)} +</span>`).join("")}
        </div>
      </div>
    </div>` : ""}

    <div class="card">
      ${rows.length === 0 ? `<div class="empty"><div class="big">◇</div>Aucun projet pour l'instant.</div>` : `
      <table>
        <thead><tr><th>Projet</th><th>Client</th><th>Clés liées (dossiers)</th><th>Facturation</th><th class="num">Taux $/h</th><th></th></tr></thead>
        <tbody>
          ${rows.map(p => {
            const client = state.clients.find(c => c.id === p.clientId);
            return `<tr class="clickable" data-edit-project="${p.id}">
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td>${escapeHtml(client ? client.name : "—")}</td>
              <td>${(p.projectKeys || []).map(k => `<code class="k">${escapeHtml(k)}</code>`).join(" ") || "—"}</td>
              <td>${p.billingMode === "hourly" ? "Taux horaire" : "Coût tokens"}</td>
              <td class="num mono">${p.rate ? p.rate : "—"}</td>
              <td style="text-align:right"><button class="btn ghost sm" data-del-project="${p.id}">Supprimer</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`}
    </div>
  `;
}

/* ---- factures (facturation virtuelle factice) ---- */
const INVOICE_STATUS_LABELS = { draft: "Brouillon", sent: "Envoyée", paid: "Payée" };
const INVOICE_STATUS_COLORS = { draft: "var(--ink-faint)", sent: "var(--warn)", paid: "var(--good)" };

function monthBounds(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/* periodStart/periodEnd null ou vide = pas de filtre de date (toute la conso disponible) */
function computeTokenCostForProject(project, periodStart, periodEnd) {
  const rows = allDailyRows().filter(r => (project.projectKeys || []).includes(r.projectKey) && (!periodStart || r.date >= periodStart) && (!periodEnd || r.date <= periodEnd));
  return {
    tokens: rows.reduce((s, r) => s + totalTokens(r), 0),
    cost: rows.reduce((s, r) => s + costOf(r.model, r), 0),
  };
}

function computeTokenCostForDevice(deviceId, periodStart, periodEnd) {
  const rows = allDailyRows().filter(r => r.deviceId === deviceId && (!periodStart || r.date >= periodStart) && (!periodEnd || r.date <= periodEnd));
  return {
    tokens: rows.reduce((s, r) => s + totalTokens(r), 0),
    cost: rows.reduce((s, r) => s + costOf(r.model, r), 0),
  };
}

function deviceBillingSummary(deviceId) {
  const entries = [];
  for (const inv of state.invoices) {
    const amount = (inv.lineItems || []).filter(it => it.deviceId === deviceId).reduce((s, it) => s + (it.amount || 0), 0);
    if (amount > 0) entries.push({ invoiceId: inv.id, date: inv.createdAt, amount, status: inv.status, clientId: inv.clientId });
  }
  entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const totalPaid = entries.filter(e => e.status === "paid").reduce((s, e) => s + e.amount, 0);
  return { totalPaid, entries };
}

/* montant restant a payer pour un appareil (cout total tous temps - deja paye) —
   c'est ce plafond, pas le cout total, qui doit borner une nouvelle ligne de
   facture : on ne veut pas re-facturer une part deja reglee. */
function deviceRemainingAmount(deviceId) {
  const totalCost = computeTokenCostForDevice(deviceId, null, null).cost;
  const totalPaid = deviceBillingSummary(deviceId).totalPaid;
  return Math.max(0, totalCost - totalPaid);
}

function buildDeviceBillingCard(deviceId) {
  const b = deviceBillingSummary(deviceId);
  if (b.entries.length === 0) return "";
  const deviceTotalCost = computeTokenCostForDevice(deviceId, null, null).cost;
  const remaining = deviceTotalCost - b.totalPaid;
  return `
    <div class="card">
      <div class="card-head"><h3>Facturation de cet appareil</h3></div>
      <div class="card-body">
        <div class="hint" style="color:var(--ink-faint);font-size:11.5px;margin-bottom:10px">Le restant est calculé sur le coût réel de l'appareil, pas seulement sur ce qui a été facturé — utile quand une facture ne couvre qu'une partie du coût.</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px">
          <div><div class="hint" style="color:var(--ink-faint)">Coût total (appareil)</div><div class="mono" style="font-size:18px;font-weight:650;margin-top:2px">${fmtUsd(deviceTotalCost)}</div></div>
          <div><div class="hint" style="color:var(--ink-faint)">Payé</div><div class="mono" style="font-size:18px;font-weight:650;margin-top:2px;color:var(--good)">${fmtUsd(b.totalPaid)}</div></div>
          <div><div class="hint" style="color:var(--ink-faint)">Restant</div><div class="mono" style="font-size:18px;font-weight:650;margin-top:2px;color:${remaining > 0 ? "var(--warn)" : "var(--ink-faint)"}">${fmtUsd(remaining)}</div></div>
        </div>
        <table>
          <thead><tr><th>Date</th><th>Client</th><th>Statut</th><th class="num">Montant</th><th></th></tr></thead>
          <tbody>
            ${b.entries.map(e => {
              const client = state.clients.find(c => c.id === e.clientId);
              return `<tr class="clickable" data-view-invoice="${e.invoiceId}">
                <td class="mono">${new Date(e.date).toLocaleDateString("fr-FR")}</td>
                <td>${escapeHtml(client ? client.name : "—")}</td>
                <td><span class="dot" style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${INVOICE_STATUS_COLORS[e.status]};margin-right:6px"></span>${INVOICE_STATUS_LABELS[e.status] || e.status}</td>
                <td class="num mono">${fmtUsd(e.amount)}</td>
                <td class="hint" style="color:var(--accent)">Voir →</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderInvoices() {
  const rows = state.invoices.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return `
    <div class="pagehead">
      <div><h1>Factures</h1><div class="desc">Facturation virtuelle — génère un aperçu de facture à partir de la conso ou d'un taux horaire</div></div>
      <button class="btn primary" id="btn-add-invoice">+ Nouvelle facture</button>
    </div>
    <div class="card">
      ${rows.length === 0 ? `<div class="empty"><div class="big">▥</div>Aucune facture pour l'instant.</div>` : `
      <table>
        <thead><tr><th>Client</th><th>Période</th><th class="num">Total</th><th>Statut</th><th>Créée</th><th></th></tr></thead>
        <tbody>
          ${rows.map(inv => {
            const client = state.clients.find(c => c.id === inv.clientId);
            return `<tr class="clickable" data-view-invoice="${inv.id}">
              <td><strong>${escapeHtml(client ? client.name : "Client supprimé")}</strong></td>
              <td class="mono">${inv.periodStart ? `${inv.periodStart} → ${inv.periodEnd}` : "—"}</td>
              <td class="num mono">${fmtUsd(inv.total)}</td>
              <td>
                <span class="dot" style="width:8px;height:8px;border-radius:50%;display:inline-block;background:${INVOICE_STATUS_COLORS[inv.status]};margin-right:6px"></span>
                <select data-quick-invoice-status="${inv.id}" style="border:1px solid var(--border);border-radius:6px;padding:3px 6px;background:var(--bg);color:var(--ink);font-size:12.5px">
                  ${["draft", "sent", "paid"].map(s => `<option value="${s}" ${inv.status === s ? "selected" : ""}>${INVOICE_STATUS_LABELS[s]}</option>`).join("")}
                </select>
              </td>
              <td class="hint" style="color:var(--ink-faint)">${new Date(inv.createdAt).toLocaleDateString("fr-FR")}</td>
              <td style="text-align:right"><button class="btn ghost sm" data-del-invoice="${inv.id}">Supprimer</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`}
    </div>
  `;
}

function invoiceModal() {
  const clientOptions = state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  let deviceLines = []; // {id, amount}
  let customLines = []; // {id, label, amount}
  let appliedPromo = null; // {code, divisor, name}

  openModal(`
    <div class="mh">Nouvelle facture</div>
    <div class="mb">
      <div class="row2">
        <div class="field"><label>Client</label><select id="m-inv-client"><option value="">— choisir —</option>${clientOptions}</select></div>
        <div class="field"><label>Mois <span style="color:var(--ink-faint);font-weight:400">(optionnel)</span></label><input id="m-inv-month" type="month"></div>
      </div>
      <div class="hint" style="color:var(--ink-faint);font-size:12px;margin:-8px 0 10px">Sans mois choisi, le coût tokens est calculé sur toute la conso disponible.</div>
      <div id="m-inv-lines"><div class="hint" style="color:var(--ink-faint);padding:10px 0">Choisis un client pour voir ses projets.</div></div>
      <div id="m-inv-devices"></div>
      <div id="m-inv-custom"></div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <label style="font-size:12px;font-weight:600;color:var(--ink-dim)">Code promo <span style="color:var(--ink-faint);font-weight:400">(optionnel)</span></label>
        <div id="m-inv-promo-row" style="display:flex;gap:8px;margin-top:6px">
          <input id="m-inv-promo-code" placeholder="CODE" style="flex:1;text-transform:uppercase;border:1px solid var(--border);border-radius:7px;padding:7px 10px;background:var(--bg);color:var(--ink)">
          <button class="btn sm" id="btn-apply-promo">Appliquer</button>
        </div>
        <div id="m-inv-promo-applied"></div>
      </div>
      <div style="padding-top:10px;border-top:1px solid var(--border);margin-top:6px">
        <div id="m-inv-subtotal-row" style="display:none;justify-content:space-between;color:var(--ink-dim);font-size:12.5px;padding-bottom:4px"><span>Sous-total</span><span class="mono" id="m-inv-subtotal">$0.00</span></div>
        <div id="m-inv-discount-row" style="display:none;justify-content:space-between;color:var(--good);font-size:12.5px;padding-bottom:4px"><span>Réduction</span><span class="mono" id="m-inv-discount">-$0.00</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>Total</strong><strong class="mono" id="m-inv-total">$0.00</strong>
        </div>
      </div>
    </div>
    <div class="mf"><button class="btn ghost" id="m-cancel">Annuler</button><button class="btn primary" id="m-save" disabled>Créer la facture</button></div>
  `);
  document.getElementById("m-cancel").onclick = closeModal;

  function renderPromoApplied() {
    const appliedEl = document.getElementById("m-inv-promo-applied");
    const row = document.getElementById("m-inv-promo-row");
    if (appliedPromo) {
      row.style.display = "none";
      appliedEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:7px 10px;margin-top:6px">
        <span style="font-size:12.5px"><strong class="mono">${escapeHtml(appliedPromo.code)}</strong> — ${escapeHtml(appliedPromo.name)} (÷${appliedPromo.divisor})</span>
        <button class="btn ghost sm" id="btn-remove-promo">Retirer</button>
      </div>`;
      document.getElementById("btn-remove-promo").onclick = () => { appliedPromo = null; renderPromoApplied(); updateTotal(); };
    } else {
      row.style.display = "flex";
      appliedEl.innerHTML = "";
    }
  }

  document.getElementById("btn-apply-promo").onclick = () => {
    const raw = document.getElementById("m-inv-promo-code").value.trim().toUpperCase();
    if (!raw) return;
    let match = null;
    for (const p of state.promotions) {
      const code = p.codes.find(c => c.code.toUpperCase() === raw);
      if (code) { match = { code: code.code, divisor: p.divisor, name: p.name }; break; }
    }
    if (!match) { toast("Code promo invalide"); return; }
    appliedPromo = match;
    renderPromoApplied();
    updateTotal();
  };

  function currentLines() {
    const clientId = document.getElementById("m-inv-client").value;
    const projects = state.projects.filter(p => p.clientId === clientId);
    return { clientId, projects };
  }
  function currentPeriod() {
    const val = document.getElementById("m-inv-month").value;
    return val ? monthBounds(val) : { start: null, end: null };
  }

  function renderDeviceSection() {
    const { clientId } = currentLines();
    const devicesEl = document.getElementById("m-inv-devices");
    if (!clientId) { devicesEl.innerHTML = ""; return; }
    const { start, end } = currentPeriod();
    const available = state.devices.filter(d => d.id !== "legacy" && !deviceLines.some(dl => dl.id === d.id));
    const rowsHtml = deviceLines.map(dl => {
      const device = state.devices.find(d => d.id === dl.id);
      if (!device) return "";
      const { tokens } = computeTokenCostForDevice(dl.id, start, end);
      const remaining = deviceRemainingAmount(dl.id);
      return `<tr>
        <td>${escapeHtml(device.name)}</td>
        <td class="hint">Appareil</td>
        <td class="num mono">${fmtCompact(tokens)} tok</td>
        <td>
          <input type="number" step="0.01" min="0" max="${remaining}" value="${dl.amount}" data-device-amount="${dl.id}" style="width:90px;text-align:right;border:1px solid var(--border);border-radius:5px;padding:4px 6px;background:var(--bg);color:var(--ink)">
          <div class="hint" style="color:var(--ink-faint);font-size:10.5px;margin-top:2px;text-align:right">sur ${fmtUsd(remaining)} restant</div>
        </td>
        <td style="text-align:right"><button class="btn ghost sm" data-remove-device-line="${dl.id}">✕</button></td>
      </tr>`;
    }).join("");
    devicesEl.innerHTML = `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <label style="font-size:12px;font-weight:600;color:var(--ink-dim)">Appareils facturés (conso totale, hors projets)</label>
        <div class="hint" style="color:var(--ink-faint);font-size:11.5px;margin:2px 0 8px">Le montant est pré-rempli avec le montant restant à payer sur cet appareil (coût total moins ce qui a déjà été payé) — réduis-le pour n'en facturer qu'une partie.</div>
        ${deviceLines.length ? `<table style="margin-top:8px"><thead><tr><th>Appareil</th><th>Mode</th><th class="num">Tokens</th><th class="num">Montant</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table>` : `<div class="hint" style="color:var(--ink-faint);padding:8px 0;font-size:12.5px">Aucun appareil ajouté.</div>`}
        ${available.length ? `
        <div style="display:flex;gap:8px;margin-top:8px">
          <select id="m-inv-device-select" style="flex:1;padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--ink)">
            ${available.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}
          </select>
          <button class="btn sm" id="btn-add-device-line">+ Ajouter</button>
        </div>` : ""}
      </div>`;
    devicesEl.querySelectorAll("[data-device-amount]").forEach(input => {
      input.oninput = () => {
        const dl = deviceLines.find(x => x.id === input.dataset.deviceAmount);
        if (!dl) return;
        const cap = deviceRemainingAmount(dl.id);
        let amount = parseFloat(input.value) || 0;
        if (amount > cap) { amount = cap; input.value = cap.toFixed(2); }
        dl.amount = amount;
        updateTotal();
      };
    });
    devicesEl.querySelectorAll("[data-remove-device-line]").forEach(btn => {
      btn.onclick = () => { deviceLines = deviceLines.filter(dl => dl.id !== btn.dataset.removeDeviceLine); renderDeviceSection(); updateTotal(); };
    });
    const addBtn = document.getElementById("btn-add-device-line");
    if (addBtn) addBtn.onclick = () => {
      const sel = document.getElementById("m-inv-device-select");
      if (sel.value) {
        deviceLines.push({ id: sel.value, amount: deviceRemainingAmount(sel.value) });
      }
      renderDeviceSection();
      updateTotal();
    };
  }

  function renderCustomSection() {
    const { clientId } = currentLines();
    const customEl = document.getElementById("m-inv-custom");
    if (!clientId) { customEl.innerHTML = ""; return; }
    const rowsHtml = customLines.map(line => `<tr>
      <td><input type="text" value="${escapeHtml(line.label)}" placeholder="Description" data-custom-label="${line.id}" style="width:100%;border:1px solid var(--border);border-radius:5px;padding:5px 8px;background:var(--bg);color:var(--ink)"></td>
      <td class="num"><input type="number" step="0.01" value="${line.amount}" data-custom-amount="${line.id}" style="width:90px;text-align:right;border:1px solid var(--border);border-radius:5px;padding:5px 8px;background:var(--bg);color:var(--ink)"></td>
      <td style="text-align:right"><button class="btn ghost sm" data-remove-custom-line="${line.id}">✕</button></td>
    </tr>`).join("");
    customEl.innerHTML = `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <label style="font-size:12px;font-weight:600;color:var(--ink-dim)">Montant personnalisé</label>
        <div class="hint" style="color:var(--ink-faint);font-size:11.5px;margin:2px 0 8px">Pour un montant qui ne vient ni d'un projet ni d'un appareil (forfait, ajustement…).</div>
        ${customLines.length ? `<table style="margin-top:8px"><thead><tr><th>Description</th><th class="num">Montant</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table>` : `<div class="hint" style="color:var(--ink-faint);padding:8px 0;font-size:12.5px">Aucune ligne personnalisée.</div>`}
        <button class="btn sm" id="btn-add-custom-line" style="margin-top:8px">+ Ajouter une ligne</button>
      </div>`;
    customEl.querySelectorAll("[data-custom-label]").forEach(input => {
      input.oninput = () => { const line = customLines.find(l => l.id === input.dataset.customLabel); if (line) line.label = input.value; };
    });
    customEl.querySelectorAll("[data-custom-amount]").forEach(input => {
      input.oninput = () => {
        const line = customLines.find(l => l.id === input.dataset.customAmount);
        if (line) line.amount = parseFloat(input.value) || 0;
        updateTotal();
      };
    });
    customEl.querySelectorAll("[data-remove-custom-line]").forEach(btn => {
      btn.onclick = () => { customLines = customLines.filter(l => l.id !== btn.dataset.removeCustomLine); renderCustomSection(); updateTotal(); };
    });
    const addBtn = document.getElementById("btn-add-custom-line");
    if (addBtn) addBtn.onclick = () => {
      customLines.push({ id: "c" + Date.now() + Math.random().toString(36).slice(2, 6), label: "", amount: 0 });
      renderCustomSection();
      updateTotal();
    };
  }

  function renderProjectLines() {
    const { clientId, projects } = currentLines();
    const saveBtn = document.getElementById("m-save");
    const linesEl = document.getElementById("m-inv-lines");
    if (!clientId) {
      linesEl.innerHTML = `<div class="hint" style="color:var(--ink-faint);padding:10px 0">Choisis un client pour voir ses projets.</div>`;
      document.getElementById("m-inv-devices").innerHTML = "";
      document.getElementById("m-inv-custom").innerHTML = "";
      saveBtn.disabled = true;
      document.getElementById("m-inv-total").textContent = fmtUsd(0);
      return;
    }
    const { start, end } = currentPeriod();
    if (projects.length === 0) {
      linesEl.innerHTML = `<div class="hint" style="color:var(--warn);padding:10px 0">Ce client n'a aucun projet lié — ajoute un appareil ou un montant personnalisé ci-dessous, ou relie-lui un projet.</div>`;
    } else {
      linesEl.innerHTML = `
        <table style="margin-top:10px">
          <thead><tr><th>Projet</th><th>Mode</th><th class="num">Détail</th><th class="num">Montant</th></tr></thead>
          <tbody>
            ${projects.map(p => {
              if (p.billingMode === "hourly") {
                return `<tr>
                  <td>${escapeHtml(p.name)}</td>
                  <td class="hint">Taux horaire</td>
                  <td class="num"><input type="number" step="0.5" min="0" value="0" data-hours-for="${p.id}" style="width:70px;text-align:right;border:1px solid var(--border);border-radius:5px;padding:4px 6px;background:var(--bg);color:var(--ink)"> h × $${p.rate || 0}</td>
                  <td class="num mono" id="m-line-amount-${p.id}">$0.00</td>
                </tr>`;
              }
              const { tokens, cost } = computeTokenCostForProject(p, start, end);
              return `<tr>
                <td>${escapeHtml(p.name)}</td>
                <td class="hint">Coût tokens</td>
                <td class="num mono">${fmtCompact(tokens)} tok</td>
                <td class="num mono" id="m-line-amount-${p.id}" data-fixed-amount="${cost}">${fmtUsd(cost)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>`;
      linesEl.querySelectorAll("[data-hours-for]").forEach(input => {
        input.oninput = () => {
          const pid = input.dataset.hoursFor;
          const project = projects.find(p => p.id === pid);
          const amount = (parseFloat(input.value) || 0) * (project.rate || 0);
          document.getElementById("m-line-amount-" + pid).textContent = fmtUsd(amount);
          document.getElementById("m-line-amount-" + pid).dataset.fixedAmount = amount;
          updateTotal();
        };
      });
    }
    saveBtn.disabled = false;
  }

  function updateTotal() {
    const fixed = [...document.querySelectorAll("[id^='m-line-amount-']")].map(el => parseFloat(el.dataset.fixedAmount) || 0);
    const devices = deviceLines.reduce((s, dl) => s + (dl.amount || 0), 0);
    const custom = customLines.reduce((s, l) => s + (l.amount || 0), 0);
    const subtotal = fixed.reduce((a, b) => a + b, 0) + devices + custom;
    const total = appliedPromo ? subtotal / appliedPromo.divisor : subtotal;
    document.getElementById("m-inv-subtotal-row").style.display = appliedPromo ? "flex" : "none";
    document.getElementById("m-inv-discount-row").style.display = appliedPromo ? "flex" : "none";
    if (appliedPromo) {
      document.getElementById("m-inv-subtotal").textContent = fmtUsd(subtotal);
      document.getElementById("m-inv-discount").textContent = "-" + fmtUsd(subtotal - total);
    }
    document.getElementById("m-inv-total").textContent = fmtUsd(total);
  }

  function onClientChange() {
    const { clientId } = currentLines();
    deviceLines = state.devices.filter(d => d.clientId === clientId).map(d => ({ id: d.id, amount: deviceRemainingAmount(d.id) }));
    customLines = [];
    const client = state.clients.find(c => c.id === clientId);
    const clientPromo = client && client.promoCodeId ? allPromoCodes().find(pc => pc.id === client.promoCodeId) : null;
    appliedPromo = clientPromo ? { code: clientPromo.code, divisor: clientPromo.divisor, name: clientPromo.promotionName } : null;
    renderPromoApplied();
    renderProjectLines();
    renderDeviceSection();
    renderCustomSection();
    updateTotal();
  }
  function onMonthChange() {
    deviceLines.forEach(dl => {
      const cap = deviceRemainingAmount(dl.id);
      if (dl.amount > cap) dl.amount = cap;
    });
    renderProjectLines();
    renderDeviceSection();
    renderCustomSection();
    updateTotal();
  }

  document.getElementById("m-inv-client").onchange = onClientChange;
  document.getElementById("m-inv-month").onchange = onMonthChange;

  document.getElementById("m-save").onclick = async () => {
    const { clientId, projects } = currentLines();
    const { start, end } = currentPeriod();
    const projectLines = projects.map(p => {
      const amountEl = document.getElementById("m-line-amount-" + p.id);
      const amount = parseFloat(amountEl.dataset.fixedAmount) || 0;
      if (p.billingMode === "hourly") {
        const hours = parseFloat(document.querySelector(`[data-hours-for="${p.id}"]`).value) || 0;
        return { projectId: p.id, projectName: p.name, billingMode: "hourly", hours, rate: p.rate || 0, amount };
      }
      const { tokens } = computeTokenCostForProject(p, start, end);
      return { projectId: p.id, projectName: p.name, billingMode: "tokens", tokens, amount };
    });
    const deviceLineItems = deviceLines.map(dl => {
      const device = state.devices.find(d => d.id === dl.id);
      const { tokens } = computeTokenCostForDevice(dl.id, start, end);
      const partial = dl.amount < deviceRemainingAmount(dl.id) - 0.005;
      return { deviceId: dl.id, projectName: device ? device.name : dl.id, billingMode: "device", tokens, amount: dl.amount, partial };
    });
    const manualLines = customLines.filter(l => l.amount || l.label).map(l => ({
      projectName: l.label.trim() || "Montant personnalisé", billingMode: "custom", amount: l.amount || 0,
    }));
    const lineItems = [...projectLines, ...deviceLineItems, ...manualLines];
    if (!clientId || lineItems.length === 0) { toast("Ajoute au moins un projet, un appareil ou un montant"); return; }
    const subtotal = lineItems.reduce((s, l) => s + l.amount, 0);
    const total = appliedPromo ? subtotal / appliedPromo.divisor : subtotal;
    const promoCode = appliedPromo ? appliedPromo.code : null;
    const promoDivisor = appliedPromo ? appliedPromo.divisor : null;
    try {
      await api("/api/invoices", { method: "POST", body: JSON.stringify({ clientId, periodStart: start, periodEnd: end, lineItems, subtotal, total, promoCode, promoDivisor }) });
      closeModal();
      toast("Facture créée");
      await loadState();
    } catch (e) { toast("Erreur : " + e.message); }
  };
}

const INVOICE_DUE_DAYS = 14;

function renderInvoiceDetail() {
  const inv = state.invoices.find(i => i.id === state.selectedInvoiceId);
  if (!inv) { state.view = "invoices"; return renderInvoices(); }
  const client = state.clients.find(c => c.id === inv.clientId);
  const clientName = client ? client.name : "Client supprimé";
  const subtotal = inv.subtotal ?? inv.total;

  const periodNote = inv.periodStart
    ? `Période du ${inv.periodStart} au ${inv.periodEnd}. Document généré à titre de suivi interne, sans valeur fiscale.`
    : "Période non spécifiée. Document généré à titre de suivi interne, sans valeur fiscale.";

  const issuedLabel = inv.status === "sent" ? "Envoyée le" : "Émise le";
  const issuedDate = new Date(inv.status === "sent" ? inv.updatedAt : inv.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, ".");

  const dueDate = new Date(new Date(inv.createdAt).getTime() + INVOICE_DUE_DAYS * 86400000)
    .toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, ".");

  return `
    <div class="pagehead">
      <div>
        <button class="link-arrow" data-nav="invoices" style="margin-bottom:8px;display:inline-block">← Factures</button>
      </div>
      <div style="display:flex;gap:16px;align-items:center">
        <div class="tabs">
          ${["draft", "sent", "paid"].map(s => `<button data-set-invoice-status="${s}" class="${inv.status === s ? "active" : ""}">${INVOICE_STATUS_LABELS[s]}</button>`).join("")}
        </div>
        <button class="btn" id="btn-print-invoice">Imprimer</button>
        <button class="btn ghost" data-del-invoice="${inv.id}">Supprimer</button>
      </div>
    </div>

    <div class="invoice-sheet-wrap">
      <div class="invoice-sheet" id="invoice-print-area">
        <div class="doc-label">Facture — usage interne, non fiscal</div>

        <div class="header">
          <div>
            <h1>${escapeHtml(clientName)}</h1>
            <div class="subtitle">${periodNote}</div>
          </div>
          <div class="stamp ${inv.status}">${INVOICE_STATUS_LABELS[inv.status]}</div>
        </div>

        ${inv.status === "sent" ? `
        <div class="due-banner">
          <span class="label">En attente de paiement</span>
          <span class="date">Échéance — ${dueDate}</span>
        </div>` : ""}

        <dl class="meta">
          <div><dt>Client</dt><dd>${escapeHtml(clientName)}</dd></div>
          <div><dt>Société</dt><dd>${escapeHtml((client && client.company) || "—")}</dd></div>
          <div><dt>${issuedLabel}</dt><dd>${issuedDate}</dd></div>
        </dl>

        <div class="section-label">Détail</div>
        <table>
          <thead><tr><th>Poste</th><th>Mode</th><th>Détail</th><th class="amount">Montant</th></tr></thead>
          <tbody>
            ${inv.lineItems.map(l => `<tr>
              <td class="item">${escapeHtml(l.projectName)}</td>
              <td class="muted">${l.billingMode === "hourly" ? "Taux horaire" : l.billingMode === "device" ? "Appareil" : l.billingMode === "custom" ? "Montant libre" : "Coût tokens"}</td>
              <td class="muted">${l.billingMode === "hourly" ? `${l.hours} h × $${l.rate}` : l.billingMode === "custom" ? "—" : l.partial ? "—" : `${fmtCompact(l.tokens)} tok`}</td>
              <td class="amount">${fmtUsd(l.amount)}</td>
            </tr>`).join("")}
          </tbody>
        </table>

        <div class="summary">
          ${inv.promoCode ? `
          <div class="summary-row subtotal"><span class="lbl">Sous-total</span><span class="val">${fmtUsd(subtotal)}</span></div>
          <div class="summary-row discount"><span class="lbl">Promo ${escapeHtml(inv.promoCode)} (÷${inv.promoDivisor})</span><span class="val">−${fmtUsd(subtotal - inv.total)}</span></div>
          ` : ""}
          <div class="summary-row total ${inv.status === "sent" ? "due" : ""}">
            <span class="lbl">${inv.status === "sent" ? "Total dû" : "Total"}</span>
            <span class="val">${fmtUsd(inv.total)}</span>
          </div>
        </div>

        <div class="sheet-footer">
          <div class="footer-note">N° réf. interne · non fiscal</div>
        </div>
      </div>
    </div>
  `;
}

/* ---- promotions ---- */
function renderPromotions() {
  return `
    <div class="pagehead">
      <div><h1>Promotions</h1><div class="desc">Codes promo reliés à une réduction de coût (montant divisé par un diviseur défini)</div></div>
      <button class="btn primary" id="btn-add-promotion">+ Nouvelle promotion</button>
    </div>

    <div class="card">
      ${state.promotions.length === 0 ? `<div class="empty"><div class="big">%</div>Aucune promotion pour l'instant.</div>` : `
      <table>
        <thead><tr><th>Promotion</th><th class="num">Diviseur</th><th class="num">Réduction</th><th>Codes</th><th></th></tr></thead>
        <tbody>
          ${state.promotions.map(p => `
            <tr>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td class="num mono">÷ ${p.divisor}</td>
              <td class="num mono">${p.divisor > 0 ? (100 - 100 / p.divisor).toFixed(1) : "0"}%</td>
              <td>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
                  ${p.codes.map(c => `<span class="tag mono" style="display:inline-flex;align-items:center;gap:5px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:2px 4px 2px 8px;font-size:12px">${escapeHtml(c.code)}<button data-del-promo-code="${c.id}" style="border:none;background:none;color:var(--ink-faint);cursor:pointer;font-size:12px;padding:2px">✕</button></span>`).join("")}
                  <button class="btn ghost sm" data-add-promo-code="${p.id}">+ Code</button>
                </div>
              </td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn ghost sm" data-edit-promotion="${p.id}">Modifier</button>
                <button class="btn ghost sm" data-del-promotion="${p.id}">Supprimer</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>`}
    </div>
  `;
}

function promotionModal(promotion) {
  const isNew = !promotion;
  openModal(`
    <div class="mh">${isNew ? "Nouvelle promotion" : "Modifier la promotion"}</div>
    <div class="mb">
      <div class="field"><label>Nom</label><input id="m-promo-name" value="${isNew ? "" : escapeHtml(promotion.name)}" placeholder="Ex: Réduction fidélité"></div>
      <div class="field">
        <label>Diviseur</label>
        <input id="m-promo-divisor" type="number" step="0.01" min="0.01" value="${isNew ? "2" : promotion.divisor}">
        <div class="hint" style="color:var(--ink-faint);font-size:11.5px;margin-top:4px">Le coût est divisé par cette valeur. Ex : 2 = -50%, 4 = -75%.</div>
      </div>
    </div>
    <div class="mf"><button class="btn ghost" id="m-cancel">Annuler</button><button class="btn primary" id="m-save">Enregistrer</button></div>
  `);
  document.getElementById("m-cancel").onclick = closeModal;
  document.getElementById("m-save").onclick = async () => {
    const name = document.getElementById("m-promo-name").value.trim();
    const divisor = parseFloat(document.getElementById("m-promo-divisor").value);
    if (!name) { toast("Le nom est requis"); return; }
    if (!Number.isFinite(divisor) || divisor <= 0) { toast("Le diviseur doit être un nombre supérieur à 0"); return; }
    try {
      if (isNew) await api("/api/promotions", { method: "POST", body: JSON.stringify({ name, divisor }) });
      else await api("/api/promotions/" + promotion.id, { method: "PUT", body: JSON.stringify({ name, divisor }) });
      closeModal();
      toast(isNew ? "Promotion créée" : "Promotion mise à jour");
      await loadState();
    } catch (e) { toast("Erreur : " + e.message); }
  };
}

function promoCodeModal(promotionId) {
  openModal(`
    <div class="mh">Ajouter un code promo</div>
    <div class="mb">
      <div class="field"><label>Code</label><input id="m-promo-code" placeholder="Ex: WELCOME10" style="text-transform:uppercase"></div>
    </div>
    <div class="mf"><button class="btn ghost" id="m-cancel">Annuler</button><button class="btn primary" id="m-save">Ajouter</button></div>
  `);
  document.getElementById("m-cancel").onclick = closeModal;
  const input = document.getElementById("m-promo-code");
  input.focus();
  document.getElementById("m-save").onclick = async () => {
    const code = input.value.trim();
    if (!code) { toast("Le code est requis"); return; }
    try {
      await api("/api/promotions/" + promotionId + "/codes", { method: "POST", body: JSON.stringify({ code }) });
      closeModal();
      toast("Code ajouté");
      await loadState();
    } catch (e) { toast("Erreur : " + e.message); }
  };
}

/* ---- devices ---- */
function deviceStatus(device) {
  if (!device.lastSeen) return { seen: false, historic: true, label: "Historique" };
  const secAgo = (Date.now() - new Date(device.lastSeen).getTime()) / 1000;
  return secAgo < 150
    ? { seen: true, secAgo, label: `Actif` }
    : { seen: false, secAgo, label: `Hors ligne` };
}

function renderDevices() {
  const rows = state.devices.slice().sort((a, b) => {
    if (a.id === "legacy") return 1;
    if (b.id === "legacy") return -1;
    return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
  });

  const perDevice = rows.map(d => {
    const entries = state.usage.filter(u => u.deviceId === d.id);
    const tokens = entries.reduce((s, u) => s + totalTokens(u.totals || {}), 0);
    const cost = entries.reduce((s, u) => s + costOf(u.model, u.totals || {}), 0);
    return { ...d, tokens, cost };
  });

  return `
    <div class="pagehead">
      <div><h1>Appareils</h1><div class="desc">Chaque machine qui pousse de la conso s'enregistre automatiquement ici</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Enregistrer un nouvel appareil</h3></div>
      <div class="card-body">
        <p style="margin:0 0 10px;color:var(--ink-dim)">Sur la machine à ajouter, à la racine du projet (Windows, macOS ou Linux) :</p>
        <pre class="mono" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto">python3 configure_sync.py
python3 install_autosync.py</pre>
        <p style="margin:10px 0 0;color:var(--ink-dim);font-size:12.5px">Un identifiant unique est généré au premier <code class="k">install_autosync.py</code> et réutilisé ensuite — pas besoin de le créer ici. Sur Windows, remplace <code class="k">python3</code> par <code class="k">python</code>.</p>
        <p style="margin:8px 0 0;color:var(--ink-dim);font-size:12.5px">Pas de Python installé ? Sur macOS/Linux : <code class="k">LEDGER_URL=... LEDGER_SYNC_API_KEY=... bash -c "$(curl -fsSL https://raw.githubusercontent.com/FabrichJean/c-sha/main/install.sh)"</code>. Sur Windows (PowerShell), définis <code class="k">$env:LEDGER_URL</code>/<code class="k">$env:LEDGER_SYNC_API_KEY</code> puis <code class="k">irm https://raw.githubusercontent.com/FabrichJean/c-sha/main/install.ps1 | iex</code>. Ça télécharge le binaire et lance configure+install sans prompt.</p>
      </div>
    </div>

    <div class="card">
      ${perDevice.length === 0 ? `<div class="empty"><div class="big">▧</div>Aucun appareil enregistré pour l'instant.</div>` : `
      <table>
        <thead><tr><th>Appareil</th><th>Client</th><th>Statut</th><th>Dernier contact</th><th class="num">Tokens (total)</th><th class="num">Coût est.</th><th></th></tr></thead>
        <tbody>
          ${perDevice.map(d => {
            const st = deviceStatus(d);
            const dotColor = st.historic ? "var(--ink-faint)" : st.seen ? "var(--good)" : "var(--warn)";
            const client = state.clients.find(c => c.id === d.clientId);
            return `<tr class="clickable" data-view-device="${d.id}">
              <td>
                <strong>${escapeHtml(d.name)}</strong>
                ${d.hostname && d.hostname !== d.name ? `<div class="hint" style="color:var(--ink-faint)">${escapeHtml(d.hostname)}</div>` : ""}
              </td>
              <td>${escapeHtml(client ? client.name : "—")}</td>
              <td><span class="dot" style="width:8px;height:8px;border-radius:50%;display:inline-block;background:${dotColor};margin-right:6px"></span>${st.label}</td>
              <td class="hint" style="color:var(--ink-dim)">${d.lastSeen ? timeAgo(d.lastSeen) : "—"}</td>
              <td class="num mono">${fmtCompact(d.tokens)}</td>
              <td class="num mono">${fmtUsd(d.cost)}</td>
              <td style="text-align:right;white-space:nowrap">
                ${d.id !== "legacy" ? `<button class="btn ghost sm" data-share-device="${d.id}">↗ Partager</button> <button class="btn ghost sm" data-rename-device="${d.id}">Modifier</button> <button class="btn ghost sm" data-del-device="${d.id}">Supprimer</button>` : ""}
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`}
    </div>
  `;
}

function deviceModal(device) {
  const clientOptions = state.clients.map(c => `<option value="${c.id}" ${device.clientId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
  openModal(`
    <div class="mh">Modifier l'appareil</div>
    <div class="mb">
      <div class="field"><label>Nom</label><input id="m-name" value="${escapeHtml(device.name)}" placeholder="MacBook Pro de Marc"></div>
      <div class="field">
        <label>Client</label>
        <select id="m-device-client"><option value="">— aucun —</option>${clientOptions}</select>
        <div class="hint" style="color:var(--ink-faint);font-size:11.5px;margin-top:4px">Un appareil lié à un client s'ajoute automatiquement lors de la création d'une facture pour ce client.</div>
      </div>
    </div>
    <div class="mf"><button class="btn ghost" id="m-cancel">Annuler</button><button class="btn primary" id="m-save">Enregistrer</button></div>
  `);
  document.getElementById("m-cancel").onclick = closeModal;
  document.getElementById("m-save").onclick = async () => {
    const name = document.getElementById("m-name").value.trim();
    if (!name) { toast("Le nom est requis"); return; }
    const clientId = document.getElementById("m-device-client").value || null;
    try {
      await api("/api/devices/" + device.id, { method: "PUT", body: JSON.stringify({ name, clientId }) });
      closeModal();
      toast("Appareil enregistré");
      await loadState();
    } catch (e) { toast("Erreur : " + e.message); }
  };
}

/* ---- contenu des instructions d'installation, par OS x avec/sans Python ---- */
const DOCS_REPO_RAW = "https://raw.githubusercontent.com/FabrichJean/c-sha/main/agent";

/* ---- petites icones inline (aucune dependance externe) ---- */
const DOCS_ICONS = {
  globe: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>`,
  key: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M15.5 7.5l2 2M18.5 4.5l2 2"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z"/></svg>`,
  help: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.7 2.7 0 1 1 3.8 2.4c-.9.4-1.1 1-1.1 1.9"/><circle cx="12" cy="17.2" r=".7" fill="currentColor" stroke="none"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`,
  windows: `<svg viewBox="0 0 24 24" width="15" height="15"><rect x="3" y="3" width="8" height="8" fill="currentColor"/><rect x="13" y="3" width="8" height="8" fill="currentColor"/><rect x="3" y="13" width="8" height="8" fill="currentColor"/><rect x="13" y="13" width="8" height="8" fill="currentColor"/></svg>`,
  apple: `<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M16.7 8c-1 0-2 .6-2.7.6-.7 0-1.6-.6-2.6-.6-1.4 0-2.7.8-3.4 2-1.4 2.4-.4 6.1 1 8.1.7 1 1.5 2.1 2.5 2 1-.1 1.4-.6 2.6-.6s1.5.6 2.6.6c1.1 0 1.8-1 2.5-2 .5-.7.9-1.5 1.1-2.1-1.5-.5-2.4-2-2.4-3.5 0-1.4.8-2.6 2-3.3-.6-.9-1.5-1.5-2.4-1.2z"/><path fill="currentColor" d="M14 5.9c.5-.6 1-1.3 1-2.2 0-.1 0-.2 0-.3-.9.1-1.9.7-2.4 1.3-.5.6-1 1.4-1 2.2 0 .1 0 .2 0 .3 1 .1 1.9-.5 2.4-1.3z"/></svg>`,
  linux: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15.5H17"/></svg>`,
  print: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2"/><rect x="6" y="13" width="12" height="8"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`,
};

function docsCodeBlock(code) {
  return `<div class="docs-code-wrap"><pre class="mono docs-pre">${escapeHtml(code)}</pre><button class="docs-copy-btn" data-docs-copy type="button">${DOCS_ICONS.copy}<span>Copier</span></button></div>`;
}

/* valeurs reelles (URL courante du CRM + vraie cle API), affichees directement
   dans les commandes pour qu'elles soient copiables telles quelles */
function docsRealUrl() { return location.origin; }
function docsRealKey() { return state.syncApiKey || "colle-ta-cle-ici"; }

/* renvoie une LISTE d'etapes (chaine HTML chacune), assemblees ensuite avec des puces numerotees */
function docsInstallStepList(os, pythonMode) {
  const noPython = pythonMode === "no-python";
  if (os === "windows") {
    if (noPython) {
      return [
        `Ouvre <strong>PowerShell</strong> (touche Windows → tape <code class="k">powershell</code> → Entrée).`,
        `Colle ces lignes (URL et clé déjà remplies pour ce serveur), puis Entrée :
          ${docsCodeBlock(`$env:LEDGER_URL = "${docsRealUrl()}"\n$env:LEDGER_SYNC_API_KEY = "${docsRealKey()}"\nirm ${DOCS_REPO_RAW}/install.ps1 | iex`)}`,
        `C'est tout. Le script télécharge <code class="k">ledger-agent-windows.exe</code> dans <code class="k">%USERPROFILE%\\.ledger\\bin\\</code>, l'enregistre et programme son démarrage automatique (tâche planifiée Windows).`,
      ];
    }
    return [
      `Vérifie que Python est installé : ouvre PowerShell et tape <code class="k">python --version</code>. S'il n'est pas reconnu, utilise plutôt l'onglet "Sans Python" ci-dessus.`,
      `Récupère le dossier <code class="k">agent/</code> du projet sur cette machine.`,
      `Dans PowerShell, place-toi dans le dossier <code class="k">agent</code> (<code class="k">cd chemin\\vers\\agent</code>) puis lance :
        ${docsCodeBlock(`python configure_sync.py\npython install_autosync.py`)}`,
      `<code class="k">configure_sync.py</code> te demande l'URL du serveur et la clé API (voir section 2) ; <code class="k">install_autosync.py</code> programme le démarrage automatique.`,
    ];
  }
  if (os === "macos") {
    if (noPython) {
      return [
        `Ouvre <strong>Terminal</strong> (Cmd+Espace → tape <code class="k">terminal</code> → Entrée).`,
        `Colle cette commande (URL et clé déjà remplies pour ce serveur) :
          ${docsCodeBlock(`LEDGER_URL="${docsRealUrl()}" LEDGER_SYNC_API_KEY="${docsRealKey()}" \\\n  bash -c "$(curl -fsSL ${DOCS_REPO_RAW}/install.sh)"`)}`,
        `Le script télécharge <code class="k">ledger-agent-macos</code> dans <code class="k">~/.ledger/bin/</code>, le configure et l'enregistre comme LaunchAgent (démarre tout seul, y compris après redémarrage).`,
      ];
    }
    return [
      `Ouvre Terminal, vérifie Python avec <code class="k">python3 --version</code>.`,
      `Récupère le dossier <code class="k">agent/</code> du projet sur cette machine, puis place-toi dedans (<code class="k">cd chemin/vers/agent</code>).`,
      `Lance :
        ${docsCodeBlock(`python3 configure_sync.py\npython3 install_autosync.py`)}`,
      `Installe un LaunchAgent — les fichiers sont copiés dans <code class="k">~/Library/Application Support/Ledger/</code> (contrainte macOS : launchd ne peut pas accéder à <code class="k">~/Documents</code>).`,
    ];
  }
  // linux
  if (noPython) {
    return [
      `Ouvre un terminal.`,
      `Colle cette commande (URL et clé déjà remplies pour ce serveur) :
        ${docsCodeBlock(`LEDGER_URL="${docsRealUrl()}" LEDGER_SYNC_API_KEY="${docsRealKey()}" \\\n  bash -c "$(curl -fsSL ${DOCS_REPO_RAW}/install.sh)"`)}`,
      `Le script télécharge <code class="k">ledger-agent-linux</code> dans <code class="k">~/.ledger/bin/</code> et l'enregistre comme service <code class="k">systemd --user</code> (redémarre tout seul en cas d'arrêt). Si <code class="k">systemd --user</code> n'est pas disponible (certains conteneurs/VPS minimalistes), repli automatique sur une entrée <code class="k">crontab</code>.`,
    ];
  }
  return [
    `Ouvre un terminal, vérifie Python avec <code class="k">python3 --version</code>.`,
    `Récupère le dossier <code class="k">agent/</code> du projet sur cette machine, puis place-toi dedans.`,
    `Lance :
      ${docsCodeBlock(`python3 configure_sync.py\npython3 install_autosync.py`)}`,
    `Installe un service <code class="k">systemd --user</code> (ou une entrée crontab en repli).`,
  ];
}

function docsStepsHtml(steps) {
  return `<div class="docs-steps">${steps.map((s, i) => `
    <div class="docs-step">
      <span class="docs-step-num">${i + 1}</span>
      <div class="docs-step-body">${s}</div>
    </div>`).join("")}</div>`;
}

function docsUninstallCommand(os, pythonMode) {
  if (pythonMode === "no-python") {
    return os === "windows" ? "%USERPROFILE%\\.ledger\\bin\\ledger-agent.exe uninstall" : "~/.ledger/bin/ledger-agent uninstall";
  }
  return os === "windows" ? "python uninstall_autosync.py" : "python3 uninstall_autosync.py";
}

function docsSectionHead(num, title, badge) {
  return `<div class="docs-section-head"><span class="docs-num">${num}</span><h2>${title}</h2>${badge ? `<span class="docs-pill">${badge}</span>` : ""}<span class="docs-section-rule"></span></div>`;
}

function renderImport() {
  const osIcons = { windows: DOCS_ICONS.windows, macos: DOCS_ICONS.apple, linux: DOCS_ICONS.linux };
  const osLabels = { windows: "Windows", macos: "macOS", linux: "Linux" };
  const osTabs = `<div class="tabs docs-os-tabs">${Object.keys(osLabels).map(k => `<button data-docs-os="${k}" class="${state.docsOS === k ? "active" : ""}">${osIcons[k]}${osLabels[k]}</button>`).join("")}</div>`;
  const modeTabs = `<div class="tabs">
    <button data-docs-mode="no-python" class="${state.docsPythonMode === "no-python" ? "active" : ""}">Sans Python (recommandé)</button>
    <button data-docs-mode="python" class="${state.docsPythonMode === "python" ? "active" : ""}">Avec Python installé</button>
  </div>`;

  const agent = agentStatus();

  const toc = [
    [1, "Comment ça marche"],
    [2, "Trouver l'URL et la clé API"],
    [3, "Installer l'agent"],
    [4, "Vérifier que ça marche"],
    [5, "Dépannage"],
  ];

  return `
    <div class="docs-breadcrumb">
      <span>Docs <span>›</span> Agent local</span>
      <button class="btn ghost sm docs-print-btn" id="btn-print-docs">${DOCS_ICONS.print}<span>Imprimer</span></button>
    </div>

    <div class="docs-layout" id="docs-print-area">
      <div class="docs-main">
        <h1 class="docs-title">Installation de l'agent local, synchro automatique et utilisation du CRM</h1>
        <p class="docs-subtitle">L'agent local assure une connexion permanente à ce serveur, lit tes logs Claude Code en local, et synchronise automatiquement ta consommation de tokens.</p>

        <div class="docs-callout success">
          <span class="docs-callout-icon">${DOCS_ICONS.check}</span>
          <div><strong>Une fois installé, l'agent fonctionne tout seul.</strong><div>Aucune action manuelle : le CRM se met à jour automatiquement.</div></div>
        </div>

        <section class="docs-section" id="docs-section-1">
          ${docsSectionHead(1, "Comment ça marche")}
          <p class="docs-p">Sur ta machine, un petit programme (l'« agent local ») reste connecté en permanence à ce serveur. Il lit tes logs Claude Code locaux, calcule la consommation de tokens, et l'envoie ici — automatiquement toutes les 4h, ou en moins d'une seconde quand tu cliques sur "Rafraîchir" dans le CRM.</p>
        </section>

        <section class="docs-section" id="docs-section-2">
          ${docsSectionHead(2, "Trouver l'URL et la clé API", "Nécessaire pour l'installation")}
          <div class="docs-item">
            <span class="docs-item-icon">${DOCS_ICONS.globe}</span>
            <div>
              <div class="docs-item-title">URL du serveur</div>
              <div class="docs-item-desc">L'adresse à laquelle tu accèdes à ce CRM.</div>
              <div class="docs-value-row"><code class="k mono">${escapeHtml(docsRealUrl())}</code><button class="docs-copy-btn sm" data-docs-copy-value="${escapeHtml(docsRealUrl())}" type="button">${DOCS_ICONS.copy}<span>Copier</span></button></div>
            </div>
          </div>
          <div class="docs-item">
            <span class="docs-item-icon">${DOCS_ICONS.key}</span>
            <div>
              <div class="docs-item-title">Clé API de sync</div>
              <div class="docs-item-desc">Utilisée par l'agent local pour s'authentifier auprès de ce serveur. Garde-la secrète — quiconque la possède peut pousser de la conso en ton nom.</div>
              <div class="docs-value-row"><code class="k mono">${escapeHtml(docsRealKey())}</code><button class="docs-copy-btn sm" data-docs-copy-value="${escapeHtml(docsRealKey())}" type="button">${DOCS_ICONS.copy}<span>Copier</span></button></div>
            </div>
          </div>
        </section>

        <section class="docs-section" id="docs-section-3">
          ${docsSectionHead(3, "Installer l'agent sur une machine")}
          ${osTabs}
          <div style="margin-top:10px">${modeTabs}</div>
          <div style="margin-top:16px">${docsStepsHtml(docsInstallStepList(state.docsOS, state.docsPythonMode))}</div>
          <div class="docs-callout info">
            <span class="docs-callout-icon">${DOCS_ICONS.help}</span>
            <div>Pour désinstaller : <code class="k">${docsUninstallCommand(state.docsOS, state.docsPythonMode)}</code></div>
          </div>
        </section>

        <section class="docs-section" id="docs-section-4">
          ${docsSectionHead(4, "Vérifier que ça marche")}
          <p class="docs-p">Reviens sur cette page quelques secondes après l'installation :</p>
          <div class="docs-status-pill ${agent.seen ? "on" : "off"}">
            <span class="dot"></span>
            <strong>Agent local : ${agent.seen ? "Actif" : "Non détecté"}</strong>
            <span class="docs-status-sub">${state.agentLastSeen ? `Dernier contact : ${new Date(state.agentLastSeen).toLocaleTimeString("fr-FR")}` : "Aucun contact enregistré"}</span>
          </div>
          <p class="docs-p" style="margin-top:12px">Si ce n'est pas le cas : consulte la section <a href="#docs-section-5" data-docs-scroll="5">Dépannage</a>.</p>
        </section>

        <section class="docs-section" id="docs-section-5">
          ${docsSectionHead(5, "Dépannage")}
          <ul class="docs-list">
            <li>Vérifie les logs sur la machine : <code class="k">~/.ledger/logs/sync.log</code> (<code class="k">%USERPROFILE%\\.ledger\\logs\\sync.log</code> sur Windows).</li>
            <li>Vérifie que l'URL du serveur est bien accessible depuis cette machine (essaie de l'ouvrir dans un navigateur).</li>
            <li>Vérifie que la clé API collée est bien complète, sans espace ni retour à la ligne en trop.</li>
            <li>Sur macOS, l'agent tourne via <code class="k">launchd</code> — vérifie avec <code class="k">launchctl list | grep ledger</code>.</li>
            <li>Sur Linux (avec systemd), vérifie avec <code class="k">systemctl --user status ledger-tokensync</code>.</li>
            <li>Sur Windows, vérifie avec <code class="k">schtasks /Query /TN LedgerTokenSync</code>.</li>
          </ul>
        </section>
      </div>

      <aside class="docs-aside">
        <div class="docs-aside-card">
          <div class="docs-aside-title">Sommaire</div>
          <ol class="docs-toc">
            ${toc.map(([n, label]) => `<li><a href="#docs-section-${n}" data-docs-scroll="${n}"><span>${n}</span>${label}</a></li>`).join("")}
          </ol>
        </div>
        <div class="docs-aside-card accent">
          <span class="docs-aside-icon">${DOCS_ICONS.shield}</span>
          <div class="docs-aside-title">Sécurité</div>
          <p>Ta clé API est stockée uniquement sur ta machine et utilisée pour envoyer les données à ton serveur.</p>
        </div>
        <div class="docs-aside-card">
          <span class="docs-aside-icon">${DOCS_ICONS.help}</span>
          <div class="docs-aside-title">Besoin d'aide ?</div>
          <p>Si tu rencontres un problème, consulte la section Dépannage.</p>
          <a class="docs-aside-btn" href="#docs-section-5" data-docs-scroll="5">Voir le dépannage →</a>
        </div>
      </aside>
    </div>
  `;
}

function renderSettings() {
  const pricing = state.pricing || DEFAULT_PRICING;
  const models = Object.keys(pricing.models);
  return `
    <div class="pagehead"><div><h1>Tarifs</h1><div class="desc">Prix par million de tokens, utilisés pour estimer le coût</div></div></div>
    <div class="card">
      <div class="card-body" style="padding:0">
        <table>
          <thead><tr><th>Modèle</th><th class="num">Input $/M</th><th class="num">Output $/M</th><th class="num">Cache write $/M</th><th class="num">Cache read $/M</th></tr></thead>
          <tbody>
            ${models.map(m => {
              const p = pricing.models[m];
              const inp = (field, val) => `<input class="mono" data-price="${m}" data-field="${field}" type="number" step="0.01" value="${val}" style="width:70px;text-align:right;border:1px solid var(--border);border-radius:5px;padding:4px 6px;background:var(--bg);color:var(--ink)">`;
              return `<tr>
                <td>${escapeHtml(modelLabel(m))}</td>
                <td class="num">${inp("in", p.in)}</td>
                <td class="num">${inp("out", p.out)}</td>
                <td class="num">${inp("cacheWrite", p.cacheWrite)}</td>
                <td class="num">${inp("cacheRead", p.cacheRead)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div class="mf" style="display:flex;justify-content:flex-end;padding:14px 18px;border-top:1px solid var(--border)">
        <button class="btn primary" id="btn-save-pricing">Enregistrer</button>
      </div>
    </div>
  `;
}

/* ---------------- modals ---------------- */
function openModal(html) {
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.id = "modal-backdrop";
  wrap.innerHTML = `<div class="modal">${html}</div>`;
  wrap.addEventListener("click", e => { if (e.target === wrap) closeModal(); });
  document.body.appendChild(wrap);
}
function closeModal() { const el = document.getElementById("modal-backdrop"); if (el) el.remove(); }

/* liste a plat de tous les codes promo, toutes promotions confondues */
function allPromoCodes() {
  return state.promotions.flatMap(p => p.codes.map(c => ({ id: c.id, code: c.code, promotionName: p.name, divisor: p.divisor })));
}

function clientModal(existing) {
  const c = existing || {};
  const codeOptions = allPromoCodes().map(pc => `<option value="${pc.id}" ${c.promoCodeId === pc.id ? "selected" : ""}>${escapeHtml(pc.code)} — ${escapeHtml(pc.promotionName)} (÷${pc.divisor})</option>`).join("");
  openModal(`
    <div class="mh">${existing ? "Modifier le client" : "Nouveau client"}</div>
    <div class="mb">
      <div class="field"><label>Nom</label><input id="m-name" value="${escapeHtml(c.name || "")}" placeholder="Ada Lovelace"></div>
      <div class="row2">
        <div class="field"><label>Société</label><input id="m-company" value="${escapeHtml(c.company || "")}" placeholder="Analytical Engines Inc."></div>
        <div class="field"><label>Email</label><input id="m-email" value="${escapeHtml(c.email || "")}" placeholder="ada@example.com"></div>
      </div>
      <div class="field">
        <label>Code promo <span style="color:var(--ink-faint);font-weight:400">(optionnel)</span></label>
        <select id="m-client-promo"><option value="">— aucun —</option>${codeOptions}</select>
        <div class="hint" style="color:var(--ink-faint);font-size:11.5px;margin-top:4px">Appliqué automatiquement à chaque nouvelle facture pour ce client.</div>
      </div>
      <div class="field"><label>Notes</label><textarea id="m-notes" style="min-height:80px">${escapeHtml(c.notes || "")}</textarea></div>
    </div>
    <div class="mf"><button class="btn ghost" id="m-cancel">Annuler</button><button class="btn primary" id="m-save">Enregistrer</button></div>
  `);
  document.getElementById("m-cancel").onclick = closeModal;
  document.getElementById("m-save").onclick = async () => {
    const name = document.getElementById("m-name").value.trim();
    if (!name) { toast("Le nom est requis"); return; }
    const data = {
      name,
      company: document.getElementById("m-company").value.trim(),
      email: document.getElementById("m-email").value.trim(),
      notes: document.getElementById("m-notes").value.trim(),
      promoCodeId: document.getElementById("m-client-promo").value || null,
    };
    try {
      if (existing) await api("/api/clients/" + existing.id, { method: "PUT", body: JSON.stringify(data) });
      else await api("/api/clients", { method: "POST", body: JSON.stringify(data) });
      closeModal();
      toast("Client enregistré");
      await loadState();
    } catch (e) { toast("Erreur : " + e.message); }
  };
}

function projectModal(existing, presetKey) {
  const p = existing || {};
  const clientOptions = state.clients.map(c => `<option value="${c.id}" ${p.clientId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
  openModal(`
    <div class="mh">${existing ? "Modifier le projet" : "Nouveau projet"}</div>
    <div class="mb">
      <div class="field"><label>Nom du projet</label><input id="m-name" value="${escapeHtml(p.name || presetKey || "")}" placeholder="Refonte du site vitrine"></div>
      <div class="field"><label>Client</label><select id="m-client"><option value="">— aucun —</option>${clientOptions}</select></div>
      <div class="field"><label>Clés de dossier liées (une par ligne — nom du dossier local)</label><textarea id="m-keys" style="min-height:70px;font-family:'IBM Plex Mono',monospace">${escapeHtml((p.projectKeys || (presetKey ? [presetKey] : [])).join("\n"))}</textarea></div>
      <div class="field"><label>Mode de facturation</label>
        <select id="m-billing-mode">
          <option value="tokens" ${(p.billingMode || "tokens") === "tokens" ? "selected" : ""}>Coût des tokens</option>
          <option value="hourly" ${p.billingMode === "hourly" ? "selected" : ""}>Taux horaire</option>
        </select>
      </div>
      <div class="field"><label>Taux horaire facturé ($/h, optionnel)</label><input id="m-rate" type="number" step="1" value="${p.rate || ""}" placeholder="150"></div>
    </div>
    <div class="mf"><button class="btn ghost" id="m-cancel">Annuler</button><button class="btn primary" id="m-save">Enregistrer</button></div>
  `);
  document.getElementById("m-cancel").onclick = closeModal;
  document.getElementById("m-save").onclick = async () => {
    const name = document.getElementById("m-name").value.trim();
    if (!name) { toast("Le nom est requis"); return; }
    const keys = document.getElementById("m-keys").value.split("\n").map(s => s.trim()).filter(Boolean);
    const data = {
      name,
      clientId: document.getElementById("m-client").value || null,
      projectKeys: keys,
      rate: parseFloat(document.getElementById("m-rate").value) || null,
      billingMode: document.getElementById("m-billing-mode").value,
    };
    try {
      if (existing) await api("/api/projects/" + existing.id, { method: "PUT", body: JSON.stringify(data) });
      else await api("/api/projects", { method: "POST", body: JSON.stringify(data) });
      closeModal();
      toast("Projet enregistré");
      await loadState();
    } catch (e) { toast("Erreur : " + e.message); }
  };
}

/* ---------------- on-demand refresh ---------------- */
function refreshProgressBanner() {
  if (!state.refreshing) return "";
  const elapsedSec = Math.round((Date.now() - state.refreshStartedAt) / 1000);
  const agent = agentStatus();
  const agentLine = agent.seen
    ? `Agent local détecté (vu il y a ${Math.round(agent.secAgo)}s) — en attente de son prochain passage.`
    : elapsedSec > 90
      ? `Aucun signe de l'agent local depuis le début de l'attente. Vérifie qu'il tourne (voir l'onglet Docs).`
      : `En attente d'un premier contact de l'agent local…`;
  return `
    <div class="card" style="border-color:var(--accent)">
      <div class="card-body" style="display:flex;align-items:center;gap:14px">
        <div class="mono" style="font-size:20px;color:var(--accent)">${elapsedSec}s</div>
        <div>
          <div><strong>Synchro en cours</strong> <span class="hint" style="color:var(--ink-faint)">(vérification n°${state.refreshAttempts})</span></div>
          <div class="hint" style="color:var(--ink-dim);margin-top:2px">${agentLine}</div>
        </div>
      </div>
    </div>`;
}

async function handleRefreshClick() {
  const previousSyncAt = state.lastSync ? state.lastSync.at : null;
  state.refreshing = true;
  state.refreshStartedAt = Date.now();
  state.refreshAttempts = 0;
  render();
  try {
    await api("/api/request-sync", { method: "POST" });
  } catch (e) {
    toast("Erreur : " + e.message);
    state.refreshing = false;
    render();
    return;
  }

  const deadline = Date.now() + 3 * 60 * 1000; // 3 min max
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    state.refreshAttempts++;
    try {
      const data = await api("/api/state");
      state.agentLastSeen = data.agentLastSeen || null;
      const newSyncAt = data.lastSync ? data.lastSync.at : null;
      if (newSyncAt && newSyncAt !== previousSyncAt) {
        state.clients = data.clients || [];
        state.projects = data.projects || [];
        state.usage = data.usage || [];
        state.devices = data.devices || [];
        state.pricing = data.pricing || DEFAULT_PRICING;
        state.lastSync = data.lastSync || null;
        state.refreshing = false;
        updateSidebarStatus();
        render();
        toast("Données à jour");
        return;
      }
      updateSidebarStatus();
      render(); // met a jour le compteur et le statut agent pendant l'attente
    } catch (e) { /* on reessaiera au prochain tick */ }
  }
  state.refreshing = false;
  render();
  toast(agentStatus().seen
    ? "L'agent répond mais n'a pas encore terminé — réessaie dans une minute"
    : "Aucun agent local détecté — vérifie l'installation dans l'onglet Docs");
}

/* ---------------- on-demand refresh scope a un seul appareil ---------------- */

function deviceRefreshProgressBanner(device) {
  if (!state.deviceRefreshing) return "";
  const elapsedSec = Math.round((Date.now() - state.deviceRefreshStartedAt) / 1000);
  const st = deviceStatus(device);
  const line = st.seen
    ? `Appareil détecté (vu il y a ${Math.round(st.secAgo)}s) — en attente de son prochain passage.`
    : elapsedSec > 90
      ? `Aucun signe de cet appareil depuis le début de l'attente. Vérifie que l'agent tourne dessus.`
      : `En attente d'un premier contact de cet appareil…`;
  return `
    <div class="card" style="border-color:var(--accent)">
      <div class="card-body" style="display:flex;align-items:center;gap:14px">
        <div class="mono" style="font-size:20px;color:var(--accent)">${elapsedSec}s</div>
        <div>
          <div><strong>Synchro en cours</strong> <span class="hint" style="color:var(--ink-faint)">(vérification n°${state.deviceRefreshAttempts})</span></div>
          <div class="hint" style="color:var(--ink-dim);margin-top:2px">${line}</div>
        </div>
      </div>
    </div>`;
}

async function handleDeviceRefreshClick(deviceId) {
  // on detecte la fin de la synchro via lastSync (mis a jour a CHAQUE synchro
  // reussie, meme sans nouvel enregistrement ecrit) plutot que via importedAt,
  // qui ne bouge jamais si l'appareil n'a rien de nouveau a envoyer — ce qui
  // faisait tourner l'attente jusqu'au timeout de 3 min meme apres un succes.
  // La comparaison se fait entre deux valeurs venant TOUTES LES DEUX du serveur
  // (jamais Date.now()/toISOString() du navigateur) : un decalage d'horloge
  // client/serveur (VPS distant, ex. Windows vs Linux) rendrait sinon toute
  // comparaison ">=" avec l'heure locale du navigateur fausse en permanence.
  state.deviceRefreshing = true;
  state.deviceRefreshStartedAt = Date.now();
  state.deviceRefreshAttempts = 0;
  render();

  let baseline = state.lastSync ? JSON.stringify(state.lastSync) : null;
  try {
    const initial = await api("/api/state");
    baseline = initial.lastSync ? JSON.stringify(initial.lastSync) : null;
  } catch (e) { /* on garde le baseline deja en memoire */ }

  try {
    await api("/api/devices/" + deviceId + "/request-sync", { method: "POST" });
  } catch (e) {
    toast("Erreur : " + e.message);
    state.deviceRefreshing = false;
    render();
    return;
  }

  const deadline = Date.now() + 3 * 60 * 1000; // 3 min max
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    state.deviceRefreshAttempts++;
    try {
      const data = await api("/api/state");
      state.devices = data.devices || [];
      const sync = data.lastSync;
      const snapshot = sync ? JSON.stringify(sync) : null;
      if (sync && sync.deviceId === deviceId && snapshot !== baseline) {
        state.clients = data.clients || [];
        state.projects = data.projects || [];
        state.usage = data.usage || [];
        state.pricing = data.pricing || DEFAULT_PRICING;
        state.lastSync = data.lastSync || null;
        state.deviceRefreshing = false;
        render();
        toast("Données à jour");
        return;
      }
      render(); // met a jour le compteur et le statut de l'appareil pendant l'attente
    } catch (e) { /* on reessaiera au prochain tick */ }
  }
  state.deviceRefreshing = false;
  render();
  const device = state.devices.find(d => d.id === deviceId);
  toast(device && deviceStatus(device).seen
    ? "L'appareil répond mais n'a pas encore terminé — réessaie dans une minute"
    : "Cet appareil ne répond pas — vérifie que son agent tourne toujours");
}

/* ---------------- wiring ---------------- */
function wireView() {
  document.querySelectorAll("[data-nav]").forEach(el => { el.onclick = () => { state.view = el.dataset.nav; render(); }; });

  const refreshBtn = document.getElementById("btn-refresh");
  if (refreshBtn) refreshBtn.onclick = handleRefreshClick;
  const refreshDeviceBtn = document.getElementById("btn-refresh-device");
  if (refreshDeviceBtn) refreshDeviceBtn.onclick = () => handleDeviceRefreshClick(refreshDeviceBtn.dataset.refreshDevice);

  document.querySelectorAll("[data-trend-metric]").forEach(el => {
    el.onclick = () => { state.trendMetric = el.dataset.trendMetric; render(); };
  });
  document.querySelectorAll("[data-docs-os]").forEach(el => {
    el.onclick = () => { state.docsOS = el.dataset.docsOs; render(); };
  });
  document.querySelectorAll("[data-docs-mode]").forEach(el => {
    el.onclick = () => { state.docsPythonMode = el.dataset.docsMode; render(); };
  });
  document.querySelectorAll("[data-docs-scroll]").forEach(el => {
    el.onclick = (e) => {
      e.preventDefault();
      const target = document.getElementById("docs-section-" + el.dataset.docsScroll);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
  document.querySelectorAll("[data-docs-copy]").forEach(btn => {
    btn.onclick = async () => {
      const pre = btn.previousElementSibling;
      const ok = await copyToClipboard(pre.textContent);
      if (ok) {
        const label = btn.querySelector("span");
        const original = label.textContent;
        label.textContent = "Copié !";
        setTimeout(() => { label.textContent = original; }, 1500);
      }
    };
  });
  document.querySelectorAll("[data-docs-copy-value]").forEach(btn => {
    btn.onclick = async () => {
      const ok = await copyToClipboard(btn.dataset.docsCopyValue);
      if (ok) {
        const label = btn.querySelector("span");
        const original = label.textContent;
        label.textContent = "Copié !";
        setTimeout(() => { label.textContent = original; }, 1500);
      }
    };
  });
  const printDocsBtn = document.getElementById("btn-print-docs");
  if (printDocsBtn) printDocsBtn.onclick = () => window.print();
  const periodSelect = document.getElementById("trend-period");
  if (periodSelect) periodSelect.onchange = () => { state.trendPeriod = parseInt(periodSelect.value, 10); render(); };
  const scrollDetailBtn = document.getElementById("btn-scroll-detail");
  if (scrollDetailBtn) scrollDetailBtn.onclick = () => document.getElementById("detail-table").scrollIntoView({ behavior: "smooth", block: "start" });

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

  const addClientBtn = document.getElementById("btn-add-client");
  if (addClientBtn) addClientBtn.onclick = () => clientModal(null);
  document.querySelectorAll("[data-edit-client]").forEach(el => { el.onclick = () => clientModal(state.clients.find(c => c.id === el.dataset.editClient)); });
  document.querySelectorAll("[data-del-client]").forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      try { await api("/api/clients/" + el.dataset.delClient, { method: "DELETE" }); toast("Client supprimé"); await loadState(); }
      catch (err) { toast("Erreur : " + err.message); }
    };
  });

  const addProjectBtn = document.getElementById("btn-add-project");
  if (addProjectBtn) addProjectBtn.onclick = () => projectModal(null);
  document.querySelectorAll("[data-edit-project]").forEach(el => { el.onclick = () => projectModal(state.projects.find(p => p.id === el.dataset.editProject)); });
  document.querySelectorAll("[data-del-project]").forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      try { await api("/api/projects/" + el.dataset.delProject, { method: "DELETE" }); toast("Projet supprimé"); await loadState(); }
      catch (err) { toast("Erreur : " + err.message); }
    };
  });
  document.querySelectorAll("[data-quick-link]").forEach(el => { el.onclick = () => projectModal(null, el.dataset.quickLink); });

  const addInvoiceBtn = document.getElementById("btn-add-invoice");
  if (addInvoiceBtn) addInvoiceBtn.onclick = () => invoiceModal();
  document.querySelectorAll("[data-view-invoice]").forEach(el => {
    el.onclick = () => { state.selectedInvoiceId = el.dataset.viewInvoice; state.view = "invoice-detail"; render(); };
  });
  document.querySelectorAll("[data-del-invoice]").forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      try {
        await api("/api/invoices/" + el.dataset.delInvoice, { method: "DELETE" });
        toast("Facture supprimée");
        if (state.view === "invoice-detail") state.view = "invoices";
        await loadState();
      } catch (err) { toast("Erreur : " + err.message); }
    };
  });
  document.querySelectorAll("[data-quick-invoice-status]").forEach(el => {
    el.onclick = (e) => e.stopPropagation();
    el.onchange = async (e) => {
      e.stopPropagation();
      try {
        await api("/api/invoices/" + el.dataset.quickInvoiceStatus, { method: "PUT", body: JSON.stringify({ status: el.value }) });
        toast("Statut mis à jour");
        await loadState();
      } catch (err) { toast("Erreur : " + err.message); }
    };
  });
  document.querySelectorAll("[data-set-invoice-status]").forEach(el => {
    el.onclick = async () => {
      try {
        await api("/api/invoices/" + state.selectedInvoiceId, { method: "PUT", body: JSON.stringify({ status: el.dataset.setInvoiceStatus }) });
        await loadState();
      } catch (err) { toast("Erreur : " + err.message); }
    };
  });
  const printInvoiceBtn = document.getElementById("btn-print-invoice");
  if (printInvoiceBtn) printInvoiceBtn.onclick = () => window.print();

  async function updateClientPromoCode(clientId, promoCodeId) {
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;
    try {
      await api("/api/clients/" + clientId, { method: "PUT", body: JSON.stringify({
        name: client.name, company: client.company, email: client.email, notes: client.notes, promoCodeId,
      }) });
      toast("Code promo mis à jour");
      await loadState();
    } catch (e) { toast("Erreur : " + e.message); }
  }
  const applyClientPromoBtn = document.getElementById("btn-apply-client-promo");
  if (applyClientPromoBtn) {
    applyClientPromoBtn.onclick = () => {
      const input = document.getElementById("device-client-promo-input");
      const raw = input.value.trim().toUpperCase();
      if (!raw) return;
      const match = allPromoCodes().find(pc => pc.code.toUpperCase() === raw);
      if (!match) { toast("Code promo invalide"); return; }
      updateClientPromoCode(input.dataset.clientId, match.id);
    };
  }
  document.querySelectorAll("[data-remove-client-promo]").forEach(el => {
    el.onclick = () => updateClientPromoCode(el.dataset.removeClientPromo, null);
  });

  const addPromotionBtn = document.getElementById("btn-add-promotion");
  if (addPromotionBtn) addPromotionBtn.onclick = () => promotionModal(null);
  document.querySelectorAll("[data-edit-promotion]").forEach(el => {
    el.onclick = () => promotionModal(state.promotions.find(p => p.id === el.dataset.editPromotion));
  });
  document.querySelectorAll("[data-del-promotion]").forEach(el => {
    el.onclick = async () => {
      try { await api("/api/promotions/" + el.dataset.delPromotion, { method: "DELETE" }); toast("Promotion supprimée"); await loadState(); }
      catch (err) { toast("Erreur : " + err.message); }
    };
  });
  document.querySelectorAll("[data-add-promo-code]").forEach(el => {
    el.onclick = () => promoCodeModal(el.dataset.addPromoCode);
  });
  document.querySelectorAll("[data-del-promo-code]").forEach(el => {
    el.onclick = async () => {
      try { await api("/api/promo-codes/" + el.dataset.delPromoCode, { method: "DELETE" }); toast("Code supprimé"); await loadState(); }
      catch (err) { toast("Erreur : " + err.message); }
    };
  });

  document.querySelectorAll("[data-view-device]").forEach(el => {
    el.onclick = () => { state.selectedDeviceId = el.dataset.viewDevice; state.view = "device-detail"; render(); };
  });
  document.querySelectorAll("[data-rename-device]").forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); deviceModal(state.devices.find(d => d.id === el.dataset.renameDevice)); };
  });
  document.querySelectorAll("[data-del-device]").forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      try { await api("/api/devices/" + el.dataset.delDevice, { method: "DELETE" }); toast("Appareil supprimé"); await loadState(); }
      catch (err) { toast("Erreur : " + err.message); }
    };
  });
  document.querySelectorAll("[data-share-device]").forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const device = state.devices.find(d => d.id === el.dataset.shareDevice);
      if (!device || !device.viewToken) { toast("Lien indisponible"); return; }
      const url = `${location.origin}/device.html?id=${encodeURIComponent(device.id)}&token=${encodeURIComponent(device.viewToken)}`;
      const ok = await copyToClipboard(url);
      if (ok) toast("Lien copié dans le presse-papiers");
    };
  });

  const savePricingBtn = document.getElementById("btn-save-pricing");
  if (savePricingBtn) savePricingBtn.onclick = async () => {
    const pricing = JSON.parse(JSON.stringify(state.pricing || DEFAULT_PRICING));
    document.querySelectorAll("[data-price]").forEach(input => {
      const model = input.dataset.price, field = input.dataset.field;
      if (!pricing.models[model]) pricing.models[model] = {};
      pricing.models[model][field] = parseFloat(input.value) || 0;
    });
    try { await api("/api/pricing", { method: "PUT", body: JSON.stringify(pricing) }); toast("Tarifs enregistrés"); await loadState(); }
    catch (e) { toast("Erreur : " + e.message); }
  };
}

document.querySelectorAll("nav .navitem").forEach(btn => btn.addEventListener("click", () => { state.view = btn.dataset.view; render(); }));

render();
loadState();
setInterval(loadState, 60000);
