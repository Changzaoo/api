// ============================================================
//  Login Firebase (projeto garden-backup) — SOMENTE login.
//  Não há cadastro: os usuários já existem. O ID token resultante
//  é usado como Bearer nas chamadas à Bridge.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onIdTokenChanged, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";

// Configuração web do Firebase (garden-backup). A apiKey web é
// pública por design — a segurança vem da allowlist de e-mails no
// servidor (ADMIN_EMAILS) e das regras do projeto.
const firebaseConfig = {
  apiKey: "AIzaSyCPTELyhRUn4qByU68pOZsZUrkR1ZeyROo",
  authDomain: "garden-backup.firebaseapp.com",
  projectId: "garden-backup",
  storageBucket: "garden-backup.firebasestorage.app",
  messagingSenderId: "842077125369",
  appId: "1:842077125369:web:ea3bafe1cedb92cd350028",
  measurementId: "G-WJHEL52L9L",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

/**
 * Define a persistência da sessão antes do login:
 *  - remember=true  → browserLocal (sobrevive a fechar o navegador).
 *  - remember=false → browserSession (só enquanto a aba estiver aberta).
 */
export function applyPersistence(remember) {
  return setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence)
    .catch(() => {});
}

// Padrão: lembrar (mantém a sessão entre reloads).
applyPersistence(true);

export { signInWithEmailAndPassword, onIdTokenChanged, signOut };
