// ============================================================
//  Erros padronizados da Bridge
// ------------------------------------------------------------
//  ApiError carrega status HTTP + código estável (string) +
//  mensagem segura para o cliente. sendError serializa em JSON
//  sem nunca vazar stack/segredo em produção.
// ============================================================

const PROD = process.env.NODE_ENV === "production";

/** Erro de aplicação com status HTTP e código estável. */
export class ApiError extends Error {
  /**
   * @param {number} status  código HTTP (400, 403, 404, 502...)
   * @param {string} code    código estável (snake_case) para o cliente
   * @param {string} message mensagem segura (sem segredo)
   * @param {object} [meta]  detalhes extras opcionais (já redigidos)
   */
  constructor(status, code, message, meta) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

// Atalhos para os erros mais comuns da Data API.
export const badRequest = (msg, meta) => new ApiError(400, "bad_request", msg, meta);
export const unauthorized = (msg = "credencial ausente ou inválida") => new ApiError(401, "unauthorized", msg);
export const forbidden = (msg = "acesso negado") => new ApiError(403, "forbidden", msg);
export const notFound = (msg = "recurso não encontrado") => new ApiError(404, "not_found", msg);
export const unknownDatasource = (id) => new ApiError(404, "unknown_datasource", `datasource desconhecido: "${id}"`);
export const datasourceUnconfigured = (id) => new ApiError(503, "datasource_unconfigured", `datasource "${id}" não está configurado (credencial ausente)`);
export const upstreamError = (msg = "falha no backend de dados") => new ApiError(502, "upstream_error", msg);
export const timeout = (msg = "tempo esgotado") => new ApiError(504, "timeout", msg);

/**
 * Envia um erro como JSON. Aceita ApiError (preserva status/code) ou
 * qualquer Error (vira 500 genérico). Nunca expõe stack em produção.
 */
export function sendError(res, err) {
  const isApi = err instanceof ApiError;
  const status = isApi ? err.status : 500;
  const code = isApi ? err.code : "internal_error";
  const message = isApi ? err.message : (PROD ? "erro interno" : String(err?.message || err));
  const body = { error: message, code };
  if (isApi && err.meta) body.details = err.meta;
  if (!PROD && !isApi && err?.stack) body.stack = err.stack;
  if (res.headersSent) return; // resposta já iniciada (ex.: stream/SSE)
  res.status(status).json(body);
}
