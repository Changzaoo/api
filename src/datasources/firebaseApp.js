// ============================================================
//  Inicialização compartilhada do firebase-admin (SDK v14)
// ------------------------------------------------------------
//  Um app nomeado por projeto, memoizado. Usado tanto pela
//  verificação de ID token (auth) quanto pelo adapter Firestore.
//  O garden-backup serve aos dois — daí a memoização evitar um
//  segundo initializeApp para o mesmo projeto.
//
//  A service account chega em base64 (env) — JSON.parse + nunca logada.
//
//  v14 removeu a API namespaced (admin.credential.cert, app.auth(),
//  app.firestore()). Usamos a API modular e expomos auth()/firestore()
//  num wrapper para preservar a interface dos consumidores.
// ============================================================

import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

/** @type {Map<string, {app: object, auth: () => object, firestore: () => object}>} */
const apps = new Map();

/** Retorna (criando uma vez) o wrapper do app firebase-admin para um datasource. */
export function getFirebaseApp(name, saB64) {
  if (apps.has(name)) return apps.get(name);
  let sa;
  try {
    sa = JSON.parse(Buffer.from(String(saB64), "base64").toString("utf8"));
  } catch {
    throw new Error(`service account inválida para "${name}" (esperado JSON em base64)`);
  }
  const app = initializeApp({ credential: cert(sa) }, name);
  const wrapper = {
    app,
    auth: () => getAuth(app),
    firestore: () => getFirestore(app),
  };
  apps.set(name, wrapper);
  return wrapper;
}
