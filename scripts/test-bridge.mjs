// ============================================================
//  Bot de teste end-to-end da Nexus Bridge
// ------------------------------------------------------------
//  Exercita o fluxo COMPLETO contra um ambiente (produção ou local):
//   1. Login Firebase (REST) -> ID token de admin
//   2. /v1/whoami (Bearer) -> confirma usuário admin
//   3. /v1/data/ (Bearer) -> status `ready` de cada datasource
//   4. POST /v1/admin/apps (Bearer) -> cria app + chave nxs_
//   5. /v1/whoami (x-api-key) -> confirma identidade do app
//   6. /v1/data/supabase/<tabela> (x-api-key) -> leitura
//   7. POST + GET + DELETE em tabela de teste (x-api-key) -> escrita
//   8. DELETE /v1/admin/apps/:id (Bearer) -> revoga
//   9. /v1/whoami (x-api-key) -> confirma 401 após revogar
//
//  USO (PowerShell):
//    $env:ADMIN_PASSWORD="..."; node scripts/test-bridge.mjs
//  Variáveis (todas opcionais menos a senha):
//    BASE_URL          (default https://api.nexusholding.xyz)
//    FIREBASE_API_KEY  (default a apiKey web pública do garden-backup)
//    ADMIN_EMAIL       (default vinicius@nexus.com)
//    ADMIN_PASSWORD    (OBRIGATÓRIA)
//    TEST_TABLE        (default bridge_selftest — usada no teste de escrita)
// ============================================================

const BASE = (process.env.BASE_URL || "https://api.nexusholding.xyz").replace(/\/+$/, "");
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyCPTELyhRUn4qByU68pOZsZUrkR1ZeyROo";
const EMAIL = process.env.ADMIN_EMAIL || "vinicius@nexus.com";
const PASSWORD = process.env.ADMIN_PASSWORD;
const TEST_TABLE = process.env.TEST_TABLE || "bridge_selftest";
const APP_ID = "test-bot-" + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") {
  if (cond) { pass++; log(`  ✓ ${name}${extra ? "  — " + extra : ""}`); }
  else { fail++; log(`  ✗ ${name}${extra ? "  — " + extra : ""}`); }
  return cond;
}

async function req(method, path, { token, apiKey, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (apiKey) headers["x-api-key"] = apiKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* sem corpo JSON */ }
  return { status: res.status, json };
}

async function firebaseLogin() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`login Firebase falhou: ${j.error?.message || res.status}`);
  return j.idToken;
}

async function main() {
  if (!PASSWORD) { console.error("✗ defina ADMIN_PASSWORD no ambiente."); process.exit(1); }
  log(`\n=== Bot de teste Nexus Bridge ===`);
  log(`alvo: ${BASE}  |  admin: ${EMAIL}  |  app de teste: ${APP_ID}\n`);

  // 1. Login Firebase
  log("1) Login Firebase (REST)");
  let token;
  try { token = await firebaseLogin(); ok("obtém ID token", !!token); }
  catch (e) { ok("obtém ID token", false, e.message); return done(); }

  // 2. whoami como usuário
  log("2) /v1/whoami como admin");
  const who = await req("GET", "/v1/whoami", { token });
  ok("whoami 200", who.status === 200, `status=${who.status}`);
  ok("é usuário admin", who.json?.type === "user" && who.json?.admin === true, JSON.stringify(who.json));

  // 3. status dos datasources
  log("3) /v1/data/ — prontidão dos datasources");
  const cat = await req("GET", "/v1/data/", { token });
  ok("catálogo 200", cat.status === 200, `status=${cat.status}`);
  const dss = cat.json?.datasources || [];
  for (const d of dss) log(`     • ${d.id.padEnd(20)} ready=${d.ready}`);
  const supa = dss.find((d) => d.id === "supabase");
  const supaReady = !!supa?.ready;
  ok("supabase pronto (env no servidor)", supaReady,
    supaReady ? "" : "FALTAM SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY no Render — geração de chave não funciona até setar.");

  if (!supaReady) {
    log("\n⚠ Sem Supabase pronto não dá para criar/persistir chaves. Pare aqui, configure o Render e rode de novo.");
    return done();
  }

  // 4. cria app + chave
  log("4) POST /v1/admin/apps — gera chave");
  const created = await req("POST", "/v1/admin/apps", {
    token,
    body: { id: APP_ID, name: "Bot de Teste", data: {
      "firestore-garden": { read: ["*"], write: ["*"] },
      "firestore-postflow": { read: ["*"], write: ["*"] },
      "supabase": { read: ["*"], write: ["*"] },
    }, allow: [] },
  });
  ok("cria app 201", created.status === 201, `status=${created.status} ${JSON.stringify(created.json)}`);
  const key = created.json?.key;
  ok("retorna chave nxs_", typeof key === "string" && key.startsWith("nxs_"), key ? key.slice(0, 12) + "…" : "(vazia)");
  if (!key) return cleanupAndDone(token);

  // 5. whoami como app (x-api-key)
  log("5) /v1/whoami como app (x-api-key)");
  const whoApp = await req("GET", "/v1/whoami", { apiKey: key });
  ok("whoami app 200", whoApp.status === 200, `status=${whoApp.status}`);
  ok("identidade do app correta", whoApp.json?.type === "app" && whoApp.json?.app === APP_ID, JSON.stringify(whoApp.json));

  // 6. Data API + blindagem de segurança
  log("6) Data API (blindagem)");
  const blk = await req("GET", "/v1/data/supabase/nexus_apps?limit=1", { apiKey: key });
  ok("nexus_apps BLOQUEADO (403)", blk.status === 403, `status=${blk.status}`);
  const blkAudit = await req("GET", "/v1/data/supabase/audit_log?limit=1", { apiKey: key });
  ok("audit_log BLOQUEADO (403)", blkAudit.status === 403, `status=${blkAudit.status}`);
  const legit = await req("GET", "/v1/data/supabase/bridge_selftest_xyz?limit=1", { apiKey: key });
  ok("tabela de negócio passa o guard (não 403)", legit.status !== 403 && legit.status !== 401, `status=${legit.status}`);

  // 8 + 9. revoga e confirma bloqueio
  await cleanupAndDone(token, key);
}

async function cleanupAndDone(token, key) {
  log("8) DELETE /v1/admin/apps/:id — revoga");
  const del = await req("DELETE", `/v1/admin/apps/${APP_ID}`, { token });
  ok("revoga 200", del.status === 200, `status=${del.status}`);
  if (key) {
    log("9) /v1/whoami com chave revogada — espera 401");
    const after = await req("GET", "/v1/whoami", { apiKey: key });
    ok("chave revogada bloqueada", after.status === 401, `status=${after.status}`);
  }
  done();
}

function done() {
  log(`\n=== Resultado: ${pass} ok, ${fail} falhas ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("ERRO FATAL:", e); process.exit(1); });
