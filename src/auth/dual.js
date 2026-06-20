// ============================================================
//  authDual — autenticação de dois modos
// ------------------------------------------------------------
//   1. x-api-key  → app server-to-server (tempo constante).
//   2. Bearer     → Firebase ID token (usuário humano do painel)
//                   + allowlist de e-mails.
//  Define req.principal = { type:"app"|"user", id, data, ... }.
//  O proxy legado (/v1/route) exige type:"app" (requireAppType).
// ============================================================

import { extractKey, extractBearer, appIdForKey } from "../auth.js";
import { adminDataPerms } from "../registry.js";
import { sendError, unauthorized, forbidden } from "../util/errors.js";

export function makeAuthDual(getRegistry, verifier) {
  const adminPerms = adminDataPerms();
  return async (req, res, next) => {
    try {
      const apiKey = extractKey(req);
      if (apiKey) {
        const { apps, byHash } = getRegistry();
        const id = appIdForKey(byHash, apiKey);
        if (!id) throw unauthorized("credencial de app inválida");
        const app = apps[id];
        req.caller = app; // compat com /v1/whoami e proxy
        req.principal = { type: "app", id, name: app.name, allow: app.allow, data: app.data || {} };
        return next();
      }

      const bearer = extractBearer(req);
      if (bearer) {
        const user = await verifier.verifyIdToken(bearer); // lança 401/403/503
        req.principal = {
          type: "user", id: user.email, email: user.email,
          uid: user.uid, name: user.name, data: adminPerms,
        };
        return next();
      }

      throw unauthorized("credencial ausente: envie x-api-key (app) ou Authorization: Bearer <Firebase ID token> (painel)");
    } catch (err) {
      sendError(res, err);
    }
  };
}

/** Exige que o principal seja um app (usado no proxy app→app). */
export function requireAppType(req, res, next) {
  if (req.principal?.type !== "app") {
    return sendError(res, forbidden("esta rota é exclusiva para apps (x-api-key), não para usuários do painel"));
  }
  next();
}
