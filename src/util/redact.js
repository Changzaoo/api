// ============================================================
//  Redação de dados sensíveis
// ------------------------------------------------------------
//  Usado em logs e eventos de telemetria para nunca imprimir
//  chaves, tokens, service accounts ou cabeçalhos de credencial.
// ============================================================

// Nomes de campos cujo valor deve ser sempre mascarado.
const SENSITIVE_KEYS = new Set([
  "authorization", "x-api-key", "apikey", "api_key", "key", "password",
  "secret", "token", "id_token", "access_token", "refresh_token",
  "service_account", "serviceaccount", "private_key", "privatekey",
  "supabase_service_role_key", "upstreamkey", "inboundkey",
]);

const MASK = "«redacted»";

/** Mascara o miolo de uma string, mantendo só uma dica do começo/fim. */
export function maskValue(v) {
  const s = String(v);
  if (s.length <= 8) return MASK;
  return `${s.slice(0, 3)}…${s.slice(-2)}`;
}

/**
 * Retorna cópia rasa/profunda do objeto com campos sensíveis mascarados.
 * Protege contra recursão (profundidade máxima) e ciclos simples.
 */
export function redact(input, depth = 4, seen = new WeakSet()) {
  if (input == null || typeof input !== "object") return input;
  if (seen.has(input)) return "«circular»";
  if (depth <= 0) return "«…»";
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((v) => redact(v, depth - 1, seen));
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = typeof v === "string" ? maskValue(v) : MASK;
    } else {
      out[k] = redact(v, depth - 1, seen);
    }
  }
  return out;
}

/** Verifica se uma chave de header é sensível (para filtrar em proxy/logs). */
export function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key).toLowerCase());
}
