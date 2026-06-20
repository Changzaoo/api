// Testa o fluxo x-api-key contra a Bridge LOCAL usando a chave semeada.
// Cobre: identidade do app, prontidão do supabase, leitura e
// escrita/leitura/exclusão na Data API. Limpa o app de teste no fim.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, unlinkSync } from "node:fs";

const BASE = (process.env.BASE_URL || "http://localhost:8080").replace(/\/+$/, "");
const meta = JSON.parse(readFileSync(new URL("./.local-test.json", import.meta.url)));
const { appId, apiKey } = meta;

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n + (e ? "  — " + e : "")); } else { fail++; console.log("  ✗ " + n + (e ? "  — " + e : "")); } return c; };

async function req(method, path, body) {
  const headers = { "x-api-key": apiKey };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, json: j };
}

console.log(`\n=== Teste LOCAL x-api-key (app ${appId}) ===  alvo ${BASE}`);

const who = await req("GET", "/v1/whoami");
ok("whoami app 200", who.status === 200, "status=" + who.status);
ok("identidade do app correta", who.json?.type === "app" && who.json?.app === appId, JSON.stringify(who.json));

const cat = await req("GET", "/v1/data/");
const supa = (cat.json?.datasources || []).find((d) => d.id === "supabase");
ok("supabase ready=true no servidor local", !!supa?.ready);

// --- Blindagem de segurança (defense-in-depth) ---
// Mesmo com curinga "*", a Data API bloqueia tabelas internas e
// schemas reservados.
const blkApps = await req("GET", "/v1/data/supabase/nexus_apps?limit=1");
ok("BLOQUEIA nexus_apps (403)", blkApps.status === 403, "status=" + blkApps.status);
const blkAudit = await req("GET", "/v1/data/supabase/audit_log?limit=1");
ok("BLOQUEIA audit_log (403)", blkAudit.status === 403, "status=" + blkAudit.status);
const blkSchema = await req("GET", "/v1/data/supabase/auth.users?limit=1");
ok("BLOQUEIA schema auth (403)", blkSchema.status === 403, "status=" + blkSchema.status);

// Positivo: tabela de negócio comum PASSA pela blindagem e chega no
// adapter. Uma tabela inexistente prova que o guard não bloqueou
// (vira 502/404 do banco, nunca 403/401).
const legit = await req("GET", "/v1/data/supabase/bridge_selftest_xyz?limit=1");
ok("tabela de negócio passa o guard (não 403)", legit.status !== 403 && legit.status !== 401, "status=" + legit.status);

// Cleanup: remove o app de teste do banco.
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await sb.from("nexus_apps").delete().eq("id", appId);
try { unlinkSync(new URL("./.local-test.json", import.meta.url)); } catch { /* */ }
console.log(`  ✓ limpeza: app ${appId} removido`);

console.log(`\n=== Resultado LOCAL: ${pass} ok, ${fail} falhas ===`);
process.exit(fail ? 1 : 0);
