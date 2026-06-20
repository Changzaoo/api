// ============================================================
//  Autenticação por chave de app
// ------------------------------------------------------------
//  O chamador prova sua identidade com a própria chave de entrada,
//  via header `x-api-key` (apps server-to-server). A Bridge resolve
//  a chave -> id do app em TEMPO CONSTANTE (sha256 + timingSafeEqual)
//  e anexa req.caller = { id, ...appDef }.
//
//  O header `Authorization: Bearer <token>` passa a ser exclusivo
//  para Firebase ID tokens (usuários humanos do painel) — tratado
//  pelo authDual (ver src/auth/dual.js).
// ============================================================

import { createHash, timingSafeEqual } from "node:crypto";

/** Extrai a chave de app (somente x-api-key). */
export function extractKey(req) {
  const direct = req.get("x-api-key");
  return direct ? direct.trim() : null;
}

/** Extrai um Bearer token (Firebase ID token) do header Authorization. */
export function extractBearer(req) {
  const auth = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

const sha256 = (s) => createHash("sha256").update(String(s), "utf8").digest();

/**
 * Resolve a chave -> id do app em tempo constante.
 * Comparamos sempre o sha256 (32 bytes) da chave recebida contra cada
 * hash conhecido com timingSafeEqual. Buffers de tamanho fixo não
 * vazam o comprimento nem o conteúdo da chave real por timing.
 */
export function appIdForKey(byHash, key) {
  if (!key) return null;
  const h = sha256(key);
  let found = null;
  for (const [hashHex, id] of byHash.entries()) {
    const known = Buffer.from(hashHex, "hex");
    // timingSafeEqual exige mesmo tamanho; sha256 é sempre 32 bytes.
    if (known.length === h.length && timingSafeEqual(known, h)) found = id;
  }
  return found;
}

/** Middleware factory: exige um app autenticado por x-api-key. */
export function requireApp(getRegistry) {
  return (req, res, next) => {
    const key = extractKey(req);
    if (!key) {
      return res.status(401).json({ error: "credencial ausente: envie x-api-key", code: "unauthorized" });
    }
    const { apps, byHash } = getRegistry();
    const id = appIdForKey(byHash, key);
    if (!id) {
      return res.status(401).json({ error: "credencial inválida", code: "unauthorized" });
    }
    req.caller = apps[id];
    req.principal = { type: "app", id, name: apps[id].name, allow: apps[id].allow, data: apps[id].data };
    next();
  };
}
