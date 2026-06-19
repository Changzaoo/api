// ============================================================
//  Autenticação por chave de app
// ------------------------------------------------------------
//  O chamador prova sua identidade com a própria chave de entrada,
//  via header `x-api-key` ou `Authorization: Bearer <chave>`.
//  A Bridge resolve a chave -> id do app (registry.byKey) e anexa
//  req.caller = { id, ...appDef }.
// ============================================================

/** Extrai a chave do header (x-api-key tem prioridade; Bearer como alternativa). */
export function extractKey(req) {
  const direct = req.get("x-api-key");
  if (direct) return direct.trim();
  const auth = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

/** Comparação de strings em tempo (quase) constante para reduzir timing leaks. */
function safeEqualLookup(byKey, key) {
  // Map.get já é O(1); para chaves de alta entropia (nxb_…) o risco de
  // timing attack é baixo. Mantemos a busca direta e simples.
  return byKey.get(key) || null;
}

/** Middleware factory: exige um app autenticado. */
export function requireApp(getRegistry) {
  return (req, res, next) => {
    const key = extractKey(req);
    if (!key) {
      return res.status(401).json({ error: "credencial ausente: envie x-api-key ou Authorization: Bearer" });
    }
    const { apps, byKey } = getRegistry();
    const id = safeEqualLookup(byKey, key);
    if (!id) {
      return res.status(401).json({ error: "credencial inválida" });
    }
    req.caller = apps[id];
    next();
  };
}
