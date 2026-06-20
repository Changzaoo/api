// ============================================================
//  Medição de tráfego (bytes reais in/out) por requisição
// ------------------------------------------------------------
//  Middleware que DEVE rodar antes de tudo. Mede:
//   - bytesIn  : tamanho do corpo recebido (Content-Length ou
//                contagem do stream quando chunked).
//   - bytesOut : soma dos chunks escritos na resposta, envolvendo
//                res.write/res.end SEM alterar nem bufferizar o
//                conteúdo (preserva proxy binário e downloads).
//   - durationMs, status, rota, app, datasource, etc.
//  No 'finish' monta o evento e o publica no bus + métricas.
// ============================================================

import { randomUUID } from "node:crypto";
import { bus } from "./bus.js";
import { record } from "./metrics.js";

/** Classifica a requisição em proxy | data | stream | other. */
function classify(p) {
  if (p.startsWith("/v1/route/")) return "proxy";
  if (p.startsWith("/v1/data/")) return "data";
  if (p.startsWith("/v1/stream")) return "stream";
  return "other";
}

/** Extrai o id do destino/datasource a partir da rota completa. */
function routeContext(p, kind) {
  const parts = p.split("/").filter(Boolean); // ["v1","route","midia",...]
  if (kind === "proxy") return { target: parts[2] || null, datasource: null };
  if (kind === "data") return { target: null, datasource: parts[2] || null };
  return { target: null, datasource: null };
}

export function measure(req, res, next) {
  const start = process.hrtime.bigint();
  // originalUrl é preservado mesmo dentro de sub-routers (req.url é reescrito).
  const fullPath = (req.originalUrl || req.url || "").split("?")[0];

  // ---- bytesIn ----
  let bytesIn = 0;
  const lenHeader = Number(req.get("content-length"));
  if (Number.isFinite(lenHeader) && lenHeader > 0) {
    bytesIn = lenHeader; // caminho comum: confiamos no Content-Length
  } else if (req.method !== "GET" && req.method !== "HEAD") {
    // Corpo chunked sem Content-Length: conta os chunks sem consumi-los.
    req.on("data", (c) => { bytesIn += c.length; });
  }

  // ---- bytesOut ----  (envolve write/end sem tocar no conteúdo)
  let bytesOut = 0;
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = (chunk, enc, cb) => {
    if (chunk) bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof enc === "string" ? enc : "utf8");
    return origWrite(chunk, enc, cb);
  };
  res.end = (chunk, enc, cb) => {
    if (chunk && typeof chunk !== "function") {
      bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof enc === "string" ? enc : "utf8");
    }
    return origEnd(chunk, enc, cb);
  };

  res.on("finish", () => {
    const kind = classify(fullPath);
    const { target, datasource } = routeContext(fullPath, kind);
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    const ok = status < 400;
    const bytesPerSec = durationMs > 0 ? Math.round((bytesOut / durationMs) * 1000) : 0;

    const evt = {
      id: randomUUID(),
      ts: Date.now(),
      rid: req.id || null,
      principal: req.principal
        ? { type: req.principal.type, id: req.principal.id || req.principal.email || "anon" }
        : { type: "anon", id: "anon" },
      kind,
      datasource: req.dataMeta?.datasource || datasource,
      resource: req.dataMeta?.resource || null,
      mode: req.dataMeta?.mode || null,
      method: req.method,
      route: fullPath,
      target,
      status,
      bytesIn,
      bytesOut,
      durationMs: +durationMs.toFixed(2),
      bytesPerSec,
      ok,
      ip: req.ip,
    };

    try {
      record(evt);
      bus.publish(evt);
    } catch {
      // telemetria nunca pode derrubar a requisição
    }
  });

  next();
}
