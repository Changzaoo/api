// ============================================================
//  Roteamento genérico app -> app
// ------------------------------------------------------------
//  Contrato:  ANY /v1/route/:target/<path...>
//    - O chamador (req.caller) precisa ter :target no seu `allow`.
//    - :target precisa ter `target` (backend) configurado.
//    - <path...> precisa casar com a allowlist de rotas do destino.
//  A Bridge repassa método, query e body, injetando a chave upstream
//  no header configurado. NUNCA repassa a chave de entrada do chamador.
// ============================================================

import { routeAllowed } from "./registry.js";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  "x-api-key", "authorization", // nunca vazar credencial de entrada para o upstream
]);

export function makeProxyRouter(getRegistry, { timeoutMs = 15000 } = {}) {
  return async function proxy(req, res) {
    const targetId = req.params.target;
    const path = req.params[0] || ""; // tudo depois de /:target/
    const { apps } = getRegistry();
    const caller = req.caller;
    const target = apps[targetId];

    if (!target) {
      return res.status(404).json({ error: `destino desconhecido: "${targetId}"` });
    }
    if (!caller.allow.includes(targetId)) {
      return res.status(403).json({ error: `"${caller.id}" não tem permissão para chamar "${targetId}"` });
    }
    if (!target.target) {
      return res.status(502).json({ error: `destino "${targetId}" não tem backend configurado na Bridge` });
    }
    const t = target.target;
    if (!t.baseUrl || !t.upstreamKey) {
      return res.status(503).json({ error: `destino "${targetId}" mal configurado (URL ou chave upstream ausente)` });
    }
    // bloqueia travessia de caminho ANTES de casar a allowlist: "client/../x"
    // casaria um glob "client/*/x" e o fetch normalizaria escapando do target.
    if (path.includes("..") || path.includes("\\") || path.includes("//") || path.includes("%2e") || path.includes("%2f")) {
      return res.status(400).json({ error: "caminho inválido" });
    }
    if (!routeAllowed(path, t.routes)) {
      return res.status(403).json({ error: `rota "${path}" não liberada para "${targetId}"` });
    }

    const qs = req._parsedUrl?.search || "";
    const url = `${t.baseUrl}${t.basePath}/${path}`.replace(/([^:])\/{2,}/g, "$1/") + qs;

    // Repassa headers seguros do chamador.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    headers[t.upstreamHeader] = t.upstreamKey;
    headers["x-nexus-caller"] = caller.id;
    if (req.id) headers["x-request-id"] = req.id;

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const init = {
      method: req.method,
      headers,
      redirect: "manual", // não seguir redirects do upstream (reduz superfície SSRF)
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (hasBody) {
      init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }

    const MAX_BYTES = 25 * 1024 * 1024; // teto p/ evitar exaustão de memória
    try {
      const upstream = await fetch(url, init);
      const declared = Number(upstream.headers.get("content-length") || 0);
      if (declared > MAX_BYTES) return res.status(502).json({ error: "resposta do upstream excede o limite" });
      const ab = await upstream.arrayBuffer();
      if (ab.byteLength > MAX_BYTES) return res.status(502).json({ error: "resposta do upstream excede o limite" });
      const buf = Buffer.from(ab);
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);
      // preserva o nome/anexo de downloads (raw com ?download, bundle zip/md)
      const cd = upstream.headers.get("content-disposition");
      if (cd) res.setHeader("content-disposition", cd);
      res.setHeader("x-nexus-target", targetId);
      res.send(buf);
    } catch (e) {
      const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      if (!isTimeout) console.error(`[proxy] falha ao contatar "${targetId}":`, e?.message);
      res.status(isTimeout ? 504 : 502).json({
        error: isTimeout
          ? `tempo esgotado ao contatar "${targetId}"`
          : `falha ao contatar "${targetId}"`,
      });
    }
  };
}
