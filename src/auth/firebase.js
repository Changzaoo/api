// ============================================================
//  Verificação de Firebase ID token (usuários humanos do painel)
// ------------------------------------------------------------
//  Verifica o ID token emitido pelo Firebase Auth do projeto
//  garden-backup, exige e-mail verificado E presente na allowlist
//  ADMIN_EMAILS. Resultado é cacheado (sha256 do token -> decoded)
//  até pouco antes do exp, para custo ~zero por requisição.
//
//  Lazy: o app firebase-admin só sobe no primeiro verify. Se a
//  service account não estiver configurada, ready=false e qualquer
//  tentativa de login humano responde 503.
// ============================================================

import { createHash } from "node:crypto";
import { ApiError } from "../util/errors.js";

const CACHE_MAX = 500;
const SKEW_MS = 30_000; // revalida 30s antes de expirar

/**
 * @param {object} opts
 * @param {string} opts.appName     nome do app firebase-admin (= id do datasource garden)
 * @param {string} opts.saB64       service account base64 (FIREBASE_SA_GARDEN_B64)
 * @param {string[]} opts.adminEmails allowlist de e-mails
 * @param {boolean} opts.checkRevoked verifica revogação (round-trip; default false)
 */
export function makeFirebaseVerifier({ appName, saB64, adminEmails, checkRevoked = false }) {
  const allow = new Set((adminEmails || []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const ready = Boolean(saB64) && allow.size > 0;
  /** @type {Map<string, {decoded:object, exp:number}>} */
  const cache = new Map();
  let auth = null;

  const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

  async function ensureAuth() {
    if (auth) return auth;
    if (!saB64) throw new ApiError(503, "auth_unconfigured", "login de usuário indisponível: FIREBASE_SA_GARDEN_B64 não configurada");
    try {
      const { getFirebaseApp } = await import("../datasources/firebaseApp.js");
      auth = getFirebaseApp(appName, saB64).auth();
      return auth;
    } catch (e) {
      throw new ApiError(503, "auth_init_failed", "falha ao inicializar firebase-admin: " + e.message);
    }
  }

  /** Verifica o token e devolve { uid, email, name } ou lança ApiError. */
  async function verifyIdToken(token) {
    if (!token) throw new ApiError(401, "unauthorized", "ID token ausente");
    const key = sha(token);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now < hit.exp - SKEW_MS) return hit.decoded;

    let a;
    try {
      a = await ensureAuth();
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError(503, "auth_unavailable", e.message);
    }

    let decoded;
    try {
      decoded = await a.verifyIdToken(token, checkRevoked);
    } catch (e) {
      throw new ApiError(401, "unauthorized", "ID token inválido ou expirado: " + (e.code || e.message));
    }

    const email = String(decoded.email || "").toLowerCase();
    // email_verified: exige verificação só se o e-mail não estiver na allowlist
    // (permite usuários criados via Admin SDK sem verificação de e-mail).
    if (!decoded.email_verified && !allow.has(email)) {
      throw new ApiError(403, "email_unverified", "e-mail não verificado no Firebase");
    }
    if (!allow.has(email)) {
      throw new ApiError(403, "forbidden", "e-mail não autorizado a acessar o painel");
    }

    const principalUser = {
      uid: decoded.uid,
      email,
      name: decoded.name || email,
    };
    // exp do token vem em segundos; cacheia o resultado já validado.
    cache.set(key, { decoded: principalUser, exp: (decoded.exp || 0) * 1000 });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return principalUser;
  }

  return { ready, verifyIdToken, adminEmails: [...allow] };
}
