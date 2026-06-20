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

const read = await req("GET", "/v1/data/supabase/nexus_apps?limit=1");
ok("leitura supabase 200", read.status === 200, "status=" + read.status);
ok("retorna items[]", Array.isArray(read.json?.items));

// Escrita: linha sentinela com active=false (o reload só carrega active=true,
// então nunca vira um app fantasma). Cria -> lê -> apaga.
const sid = "selftest-" + Math.random().toString(36).slice(2, 8);
const w = await req("POST", `/v1/data/supabase/nexus_apps?id=${sid}`, {
  id: sid, name: "selftest", key_hash: "selftest-" + sid, key_prefix: "selftest", data: {}, allow: [], active: false,
});
const wrote = ok("escrita (cria linha) 201", w.status === 201, "status=" + w.status + " " + JSON.stringify(w.json));
if (wrote) {
  const g = await req("GET", `/v1/data/supabase/nexus_apps/${sid}`);
  ok("lê a linha criada", g.status === 200 && g.json?.name === "selftest", "status=" + g.status);
  const d = await req("DELETE", `/v1/data/supabase/nexus_apps/${sid}`);
  ok("apaga a linha", d.status === 200, "status=" + d.status);
}

// Cleanup: remove o app de teste do banco.
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await sb.from("nexus_apps").delete().eq("id", appId);
try { unlinkSync(new URL("./.local-test.json", import.meta.url)); } catch { /* */ }
console.log(`  ✓ limpeza: app ${appId} removido`);

console.log(`\n=== Resultado LOCAL: ${pass} ok, ${fail} falhas ===`);
process.exit(fail ? 1 : 0);
