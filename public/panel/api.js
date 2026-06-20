// ============================================================
//  Cliente HTTP do painel — injeta o Bearer (Firebase ID token)
//  e gerencia o stream SSE (com ticket de uso único + reconexão).
// ============================================================

let currentToken = null;

/** Atualiza o ID token usado nas chamadas (chamado pelo onIdTokenChanged). */
export function setToken(token) { currentToken = token; }

/** fetch autenticado. Dispara evento "nexus-unauth" em 401. */
export async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (currentToken) headers.Authorization = "Bearer " + currentToken;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) window.dispatchEvent(new Event("nexus-unauth"));
  return res;
}

/** GET helper que já desserializa JSON e lança em erro. */
export async function getJSON(path) {
  const res = await apiFetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * Abre o stream de telemetria. Como EventSource não envia headers,
 * pegamos um TICKET de uso único via POST autenticado e o passamos
 * na query. Gerencia reconexão (cada reconexão usa um novo ticket).
 *
 * @returns {{ close: () => void }}
 */
export function openStream({ onFlow, onBacklog, onState }) {
  let es = null;
  let closed = false;
  let retry = 0;

  async function connect() {
    if (closed) return;
    try {
      const res = await apiFetch("/v1/stream-ticket", { method: "POST" });
      if (!res.ok) throw new Error("ticket");
      const { ticket } = await res.json();
      es = new EventSource(`/v1/stream?ticket=${encodeURIComponent(ticket)}`);

      es.addEventListener("backlog", (e) => { onBacklog?.(JSON.parse(e.data)); });
      es.addEventListener("flow", (e) => { onFlow?.(JSON.parse(e.data)); });
      es.addEventListener("hello", () => { retry = 0; onState?.("on"); });

      es.onerror = () => {
        onState?.("off");
        es.close();
        if (closed) return;
        // Backoff progressivo (ticket é de uso único; reconectar pega outro).
        retry = Math.min(retry + 1, 6);
        setTimeout(connect, 500 * retry);
      };
    } catch {
      onState?.("off");
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 800 * retry);
    }
  }

  connect();
  return { close() { closed = true; es?.close(); } };
}

/** Formata bytes em B/KB/MB/GB. */
export function humanBytes(n) {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Formata uma taxa de bits por segundo (bps/Kbps/Mbps/Gbps). */
export function humanBits(bytesPerSec) {
  let bits = (Number(bytesPerSec) || 0) * 8;
  const u = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let i = 0;
  while (bits >= 1000 && i < u.length - 1) { bits /= 1000; i++; }
  return `${bits.toFixed(i ? 1 : 0)} ${u[i]}`;
}
