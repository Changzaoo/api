// ============================================================
//  Orquestrador do painel
// ------------------------------------------------------------
//  Login Firebase -> ID token -> abre o stream SSE e alimenta o
//  mapa de fluxo, os cartões de métricas e o feed de eventos.
// ============================================================

import { auth, signInWithEmailAndPassword, onIdTokenChanged, signOut } from "./firebase-login.js";
import { setToken, openStream, getJSON, humanBytes, humanBits } from "./api.js";
import { FlowMap } from "./flow-map.js";
import { GeoMap } from "./geo-map.js";
import { initExplorer } from "./data-explorer.js";
import { initAppsManager } from "./apps-manager.js";

const $ = (id) => document.getElementById(id);
const loginView = $("login");
const panelView = $("panel");

let stream = null;
let flow = null;
let geo = null;
let geoServers = null;
const recentEvents = []; // buffer p/ popular o mapa quando aberto
let metricsTimer = null;
let liveRateTimer = null;
let explorerReady = false;
let appsReady = false;

// Janela deslizante de bytes para a "vazão ao vivo".
const rateWindow = []; // { ts, bytes }

// ---------------- Login ----------------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("login-error");
  err.hidden = true;
  $("login-btn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    // onIdTokenChanged cuida da transição de tela.
  } catch (ex) {
    err.textContent = traduzErro(ex?.code || ex?.message || "falha no login");
    err.hidden = false;
  } finally {
    $("login-btn").disabled = false;
  }
});

$("logout-btn").addEventListener("click", () => signOut(auth));

// Alterna entre o grafo de fluxo e o mapa geográfico.
$("view-flow").addEventListener("click", () => switchView("flow"));
$("view-geo").addEventListener("click", () => switchView("geo"));

// Re-login forçado se a Bridge recusar o token (allowlist/expiração).
window.addEventListener("nexus-unauth", () => { /* deixa o onIdTokenChanged revalidar */ });

// ---------------- Sessão ----------------
onIdTokenChanged(auth, async (user) => {
  if (!user) { showLogin(); return; }
  const token = await user.getIdToken();
  setToken(token);
  // Renova o token periodicamente (Firebase troca a cada ~1h).
  await openPanel(user);
});

async function openPanel(user) {
  // Valida acesso na Bridge (allowlist de e-mails).
  try {
    await getJSON("/v1/whoami");
  } catch (e) {
    showLogin(`acesso negado: ${e.message}`);
    await signOut(auth);
    return;
  }

  $("me-email").textContent = user.email;
  loginView.hidden = true;
  panelView.hidden = false;

  if (!flow) flow = new FlowMap($("flow"));
  if (!explorerReady) { initExplorer(); explorerReady = true; }
  if (!appsReady) { initAppsManager(); appsReady = true; }

  startStream();
  startMetrics();
}

function showLogin(msg) {
  panelView.hidden = true;
  loginView.hidden = false;
  if (stream) { stream.close(); stream = null; }
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
  if (msg) { const e = $("login-error"); e.textContent = msg; e.hidden = false; }
}

// ---------------- Stream ao vivo ----------------
function startStream() {
  if (stream) stream.close();
  stream = openStream({
    onState: (s) => setConn(s),
    onBacklog: (events) => { events.forEach(handleEvent); },
    onFlow: (evt) => handleEvent(evt),
  });
}

function handleEvent(evt) {
  flow?.push(evt);
  geo?.push(evt);
  pushFeed(evt);
  recentEvents.push(evt);
  if (recentEvents.length > 200) recentEvents.shift();
  const bytes = (evt.bytesIn || 0) + (evt.bytesOut || 0);
  rateWindow.push({ ts: Date.now(), bytes });
}

// ---------------- Alternância de visão (fluxo / mapa) ----------------
function switchView(v) {
  const isGeo = v === "geo";
  $("flow").hidden = isGeo;
  $("geo").hidden = !isGeo;
  $("view-flow").classList.toggle("active", !isGeo);
  $("view-geo").classList.toggle("active", isGeo);
  if (isGeo) ensureGeo();
}

async function ensureGeo() {
  if (!geo) {
    if (typeof L === "undefined") {
      $("geo").innerHTML = '<div class="geo-fallback">mapa indisponível (Leaflet não carregou)</div>';
      return;
    }
    try { const r = await getJSON("/v1/geo"); geoServers = r.servers || {}; }
    catch { geoServers = {}; }
    geo = new GeoMap($("geo"));
    geo.init(geoServers);
    recentEvents.forEach((e) => geo.push(e)); // popula com o histórico recente
  }
  setTimeout(() => geo && geo.refresh(), 60);
}

function setConn(state) {
  $("conn-dot").className = "dot " + (state === "on" ? "on" : "off");
  $("conn-label").textContent = state === "on" ? "ao vivo" : "reconectando…";
}

// ---------------- Feed lateral ----------------
function pushFeed(evt) {
  const feed = $("feed");
  const li = document.createElement("li");
  if (evt.ok === false) li.className = "bad";
  const kind = evt.kind === "data" ? "data" : (evt.kind === "proxy" ? "proxy" : "·");
  const who = evt.principal?.id || "anon";
  const dest = evt.datasource || evt.target || evt.route?.replace("/v1", "") || "";
  const bytes = (evt.bytesIn || 0) + (evt.bytesOut || 0);
  li.innerHTML =
    `<span class="badge ${kind}">${kind}</span>` +
    `<span class="who">${esc(who)} <small>→ ${esc(dest)} · ${evt.method} ${evt.status}</small></span>` +
    `<span class="bytes">${humanBytes(bytes)}</span>`;
  feed.prepend(li);
  while (feed.children.length > 60) feed.lastChild.remove();
}

// ---------------- Métricas ----------------
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
    } catch { /* ignora; o stream segue */ }
    updateLiveRate();
  };
  refresh();
  metricsTimer = setInterval(refresh, 4000);
  // Atualiza a vazão ao vivo com mais frequência (timer único).
  if (!liveRateTimer) liveRateTimer = setInterval(updateLiveRate, 1000);
}

function updateLiveRate() {
  const now = Date.now();
  while (rateWindow.length && now - rateWindow[0].ts > 3000) rateWindow.shift();
  const bytes = rateWindow.reduce((s, x) => s + x.bytes, 0);
  $("m-rate").textContent = humanBits(bytes / 3);
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
