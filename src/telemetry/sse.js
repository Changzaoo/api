// ============================================================
//  Stream de telemetria via SSE (Server-Sent Events)
// ------------------------------------------------------------
//  GET /v1/stream?ticket=<t>  → fluxo de eventos ao vivo.
//
//  EventSource (browser) não envia headers, então a autenticação
//  usa TICKETS de uso único e curta validade, emitidos por um POST
//  já autenticado (authDual). O ticket carrega o principal, então o
//  stream sabe se filtra eventos (app vê só os seus) ou mostra tudo
//  (admin humano).
//
//  Proteções: heartbeat, replay do backlog, cleanup no close
//  (anti-leak) e teto de clientes simultâneos.
// ============================================================

import { randomUUID } from "node:crypto";
import { bus } from "./bus.js";
import { ApiError } from "../util/errors.js";

const TICKET_TTL_MS = 30_000;          // ticket vale 30s para abrir o stream
const MAX_CLIENTS = Number(process.env.SSE_MAX_CLIENTS) || 50;
const HEARTBEAT_MS = 15_000;

/** ticket -> { principal, exp } (uso único). */
const tickets = new Map();
let clientCount = 0;

/** Emite um ticket de uso único para o principal autenticado. */
export function issueTicket(principal) {
  const ticket = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  tickets.set(ticket, { principal, exp: Date.now() + TICKET_TTL_MS });
  return { ticket, expiresInMs: TICKET_TTL_MS };
}

/** Consome (valida e remove) um ticket. Retorna o principal ou null. */
function consumeTicket(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket); // uso único
  if (Date.now() > entry.exp) return null;
  return entry.principal;
}

// Limpeza periódica de tickets expirados (evita crescimento).
setInterval(() => {
  const now = Date.now();
  for (const [t, e] of tickets) if (now > e.exp) tickets.delete(t);
}, TICKET_TTL_MS).unref?.();

/** Decide se um principal pode ver um evento. */
function canSee(principal, evt) {
  if (principal.type === "user") return true; // admin humano vê tudo
  return evt.principal?.id === principal.id;   // app vê só os próprios
}

/** Handler do GET /v1/stream. */
export function sseHandler(req, res) {
  const ticket = String(req.query.ticket || "");
  const principal = consumeTicket(ticket);
  if (!principal) {
    throw new ApiError(401, "unauthorized", "ticket de stream ausente, inválido ou expirado");
  }
  if (clientCount >= MAX_CLIENTS) {
    throw new ApiError(503, "too_many_streams", "limite de streams simultâneos atingido");
  }

  clientCount += 1;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // desliga buffering de proxies (Nginx/Render)
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Replay imediato do backlog (só o que o principal pode ver).
  const backlog = bus.backlog().filter((e) => canSee(principal, e));
  send("backlog", backlog);
  send("hello", { principal: { type: principal.type, id: principal.id || principal.email }, ts: Date.now() });

  const onFlow = (evt) => {
    if (canSee(principal, evt)) send("flow", evt);
  };
  bus.on("flow", onFlow);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

  // Anti-leak: solta o listener e o timer quando o cliente desconecta.
  req.on("close", () => {
    clearInterval(heartbeat);
    bus.off("flow", onFlow);
    clientCount = Math.max(0, clientCount - 1);
    res.end();
  });
}
