// ============================================================
//  Inicialização compartilhada do firebase-admin
// ------------------------------------------------------------
//  Um app nomeado por projeto, memoizado. Usado tanto pela
//  verificação de ID token (auth) quanto pelo adapter Firestore.
//  O garden-backup serve aos dois — daí a memoização evitar um
//  segundo initializeApp para o mesmo projeto.
//
//  A service account chega em base64 (env) — JSON.parse + nunca logada.
// ============================================================

import admin from "firebase-admin";

/** @type {Map<string, import("firebase-admin").app.App>} */
const apps = new Map();

/** Retorna (criando uma vez) o app firebase-admin para um datasource. */
export function getFirebaseApp(name, saB64) {
  if (apps.has(name)) return apps.get(name);
  let sa;
  try {
    sa = JSON.parse(Buffer.from(String(saB64), "base64").toString("utf8"));
  } catch {
    throw new Error(`service account inválida para "${name}" (esperado JSON em base64)`);
  }
  const app = admin.initializeApp({ credential: admin.credential.cert(sa) }, name);
  apps.set(name, app);
  return app;
}

export { admin };
