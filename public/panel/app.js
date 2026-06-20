// ============================================================
//  Orquestrador do painel — dashboard de tela única
// ------------------------------------------------------------
//  Login Firebase -> ID token -> stream SSE alimentando o globo 3D,
//  os KPIs, os analytics (quem pede / fontes / status) e o feed ao
//  vivo. Gestão de apps, servidores e explorador de dados.
// ============================================================

import { auth, signInWithEmailAndPassword, onIdTokenChanged, signOut, applyPersistence } from "./firebase-login.js";
import { apiFetch, setToken, openStream, getJSON, humanBytes, humanBits } from "./api.js";
import { GeoMap } from "./geo-map.js";
import { initExplorer } from "./data-explorer.js";
import { initAppsManager } from "./apps-manager.js";

const $ = (id) => document.getElementById(id);
const loginView = $("login");
const panelView = $("panel");

let stream = null;
let geo = null;
let geoServers = null;
const recentEvents = [];
let metricsTimer = null;
let liveRateTimer = null;
let explorerReady = false;
let appsReady = false;

const rateWindow = []; // { ts, bytes } — janela de vazão ao vivo

// Logo: mostra a imagem se existir em assets/logo.png; senão mantém o 🔌.
for (const id of ["login-logo", "brand-logo"]) {
  const img = $(id);
  if (!img) continue;
  img.addEventListener("load", () => {
    img.style.display = "inline-block";
    const plug = img.parentElement?.querySelector(".plug");
    if (plug) plug.style.display = "none";
  });
}

// ---------------- Login ----------------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("login-error");
  err.hidden = true;
  $("login-btn").disabled = true;
  try {
    await applyPersistence($("remember").checked);
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch (ex) {
    err.textContent = traduzErro(ex?.code || ex?.message || "falha no login");
    err.hidden = false;
  } finally {
    $("login-btn").disabled = false;
  }
});

$("logout-btn").addEventListener("click", () => signOut(auth));
$("sync-btn").addEventListener("click", doSync);
$("add-ds-btn").addEventListener("click", () => { $("ds-modal").hidden = false; });
$("ds-close").addEventListener("click", () => { $("ds-modal").hidden = true; });
$("ds-modal").addEventListener("click", (e) => { if (e.target === $("ds-modal")) $("ds-modal").hidden = true; });

window.addEventListener("nexus-unauth", () => {});

// ---------------- Sessão ----------------
onIdTokenChanged(auth, async (user) => {
  if (!user) { showLogin(); return; }
  const token = await user.getIdToken();
  setToken(token);
  await openPanel(user);
});

async function openPanel(user) {
  try { await getJSON("/v1/whoami"); }
  catch (e) { showLogin(`acesso negado: ${e.message}`); await signOut(auth); return; }

  $("me-email").textContent = user.email;
  loginView.hidden = true;
  panelView.hidden = false;

  if (!explorerReady) { initExplorer(); explorerReady = true; }
  if (!appsReady) { initAppsManager(); appsReady = true; }

  await ensureGeo();
  startStream();
  startMetrics();
  loadDatasources();
}

function showLogin(msg) {
  panelView.hidden = true;
  loginView.hidden = false;
  if (stream) { stream.close(); stream = null; }
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
  if (msg) { const e = $("login-error"); e.textContent = msg; e.hidden = false; }
}

// ---------------- Globo 3D ----------------
async function ensureGeo() {
  if (geo) { geo.refresh(); return; }
  let tries = 0;
  while (typeof Globe === "undefined" && tries++ < 40) { await new Promise((r) => setTimeout(r, 100)); }
  if (typeof Globe === "undefined") {
    $("geo").innerHTML = '<div class="geo-fallback">globo indisponível (CDN bloqueada)</div>';
    return;
  }
  try { const r = await getJSON("/v1/geo"); geoServers = r.servers || {}; } catch { geoServers = {}; }
  geo = new GeoMap($("geo"));
  geo.init(geoServers);
  recentEvents.forEach((e) => geo.push(e));
  setTimeout(() => geo && geo.refresh(), 80);
}

// ---------------- Stream ao vivo ----------------
function startStream() {
  if (stream) stream.close();
  stream = openStream({
    onState: (s) => setConn(s),
    onBacklog: (events) => events.forEach(handleEvent),
    onFlow: (evt) => handleEvent(evt),
  });
}

function handleEvent(evt) {
  geo?.push(evt);
  pushFeed(evt);
  recentEvents.push(evt);
  if (recentEvents.length > 200) recentEvents.shift();
  const bytes = (evt.bytesIn || 0) + (evt.bytesOut || 0);
  rateWindow.push({ ts: Date.now(), bytes });
}

function setConn(state) {
  $("conn-dot").className = "dot " + (state === "on" ? "on" : "off");
  $("conn-label").textContent = state === "on" ? "ao vivo" : "reconectando…";
}

// ---------------- Feed: quem → de onde → pra onde ----------------
function pushFeed(evt) {
  const feed = $("feed");
  const li = document.createElement("li");
  if (evt.ok === false) li.className = "bad";
  const kind = evt.kind === "data" ? "data" : (evt.kind === "proxy" ? "proxy" : "·");
  const who = evt.principal?.id || "anon";
  const place = evt.geo && !evt.geo.private ? [evt.geo.city, evt.geo.country].filter(Boolean).join(", ") : "";
  const dest = evt.datasource || evt.target || evt.route?.replace("/v1", "") || "";
  const bytes = (evt.bytesIn || 0) + (evt.bytesOut || 0);
  li.innerHTML =
    `<span class="badge ${kind}">${kind}</span>` +
    `<span class="who">${esc(who)}${place ? ` <small>(${esc(place)})</small>` : ""} <small>→ ${esc(dest)} · ${evt.method} ${evt.status}</small></span>` +
    `<span class="bytes">${humanBytes(bytes)}</span>`;
  feed.prepend(li);
  while (feed.children.length > 80) feed.lastChild.remove();
}

// ---------------- Métricas + analytics ----------------
function startMetrics() {
  if (metricsTimer) clearInterval(metricsTimer);
  const refresh = async () => {
    try {
      const m = await getJSON("/v1/metrics");
      $("m-req").textContent = m.totals.requests.toLocaleString("pt-BR");
      $("m-rps").textContent = m.reqPerSec.toFixed(2) + "/s";
      $("m-in").textContent = humanBytes(m.totals.bytesIn);
      $("m-out").textContent = humanBytes(m.totals.bytesOut);
      $("m-err").textContent = m.totals.errors.toLocaleString("pt-BR");
      $("m-up").textContent = "uptime " + fmtUptime(m.uptimeMs);
      renderBars("ana-apps", m.byApp, "app");
      renderBars("ana-ds", m.byDatasource, "src");
      renderStatus("ana-status", m.byStatus);
    } catch { /* o stream segue */ }
    updateLiveRate();
  };
  refresh();
  metricsTimer = setInterval(refresh, 4000);
  if (!liveRateTimer) liveRateTimer = setInterval(updateLiveRate, 1000);
}

function renderBars(elId, bucket, cls) {
  const el = $(elId);
  const rows = Object.entries(bucket || {})
    .map(([k, v]) => ({ k, n: v.requests || 0 }))
    .sort((a, b) => b.n - a.n).slice(0, 6);
  if (!rows.length) { el.className = "bars muted"; el.textContent = "—"; return; }
  const max = Math.max(...rows.map((r) => r.n), 1);
  el.className = "bars";
  el.innerHTML = rows.map((r) =>
    `<div class="bar-row"><span class="lbl">${esc(r.k)}</span><span class="cnt">${r.n}</span>` +
    `<span class="bar-track"><span class="bar-fill ${cls}" style="width:${Math.round((r.n / max) * 100)}%"></span></span></div>`
  ).join("");
}

function renderStatus(elId, byStatus) {
  const el = $(elId);
  const order = [["2xx", "ok"], ["3xx", "app"], ["4xx", "src"], ["5xx", "err"]];
  const total = Object.values(byStatus || {}).reduce((s, n) => s + n, 0) || 1;
  el.className = "bars";
  el.innerHTML = order.map(([k, cls]) => {
    const n = (byStatus && byStatus[k]) || 0;
    return `<div class="bar-row"><span class="lbl">${k}</span><span class="cnt">${n}</span>` +
      `<span class="bar-track"><span class="bar-fill ${cls}" style="width:${Math.round((n / total) * 100)}%"></span></span></div>`;
  }).join("");
}

function updateLiveRate() {
  const now = Date.now();
  while (rateWindow.length && now - rateWindow[0].ts > 3000) rateWindow.shift();
  const bytes = rateWindow.reduce((s, x) => s + x.bytes, 0);
  $("m-rate").textContent = humanBits(bytes / 3);
}

// ---------------- Servidores / fontes ----------------
async function loadDatasources() {
  const el = $("ds-list");
  try {
    const r = await getJSON("/v1/data/");
    const dss = r.datasources || [];
    if (!dss.length) { el.className = "ds-list muted"; el.textContent = "nenhum datasource."; return; }
    el.className = "ds-list";
    el.innerHTML = dss.map((d) =>
      `<div class="ds-row"><span class="ds-dot ${d.ready ? "on" : "off"}"></span>` +
      `<span class="ds-name">${esc(d.label || d.id)}<small>${esc(d.kind)} · ${esc(d.id)}</small></span>` +
      `<span class="ds-state">${d.ready ? "pronto" : "off"}</span></div>`
    ).join("");
  } catch (e) {
    el.className = "ds-list muted"; el.textContent = "erro: " + e.message;
  }
}

async function doSync() {
  const btn = $("sync-btn");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "⟳ Sincronizando…";
  try {
    const r = await apiFetch("/v1/sync", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    btn.textContent = r.ok ? `✓ ${j.apps ?? 0} apps` : "✗ falhou";
    loadDatasources();
  } catch {
    btn.textContent = "✗ erro";
  }
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1800);
}

// ---------------- Utils ----------------
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function esc(v) {
  return String(v == null ? "" : v).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

function traduzErro(code) {
  const map = {
    "auth/invalid-credential": "e-mail ou senha inválidos.",
    "auth/invalid-email": "e-mail inválido.",
    "auth/user-not-found": "usuário não encontrado.",
    "auth/wrong-password": "senha incorreta.",
    "auth/too-many-requests": "muitas tentativas. Tente mais tarde.",
    "auth/network-request-failed": "falha de rede.",
  };
  return map[code] || ("não foi possível entrar (" + code + ")");
}
