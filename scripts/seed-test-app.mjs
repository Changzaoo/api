// Semeia um app de teste direto no nexus_apps (mesma lógica de
// createDynamicApp): gera chave nxs_, hash sha256, insere a linha.
// Grava {appId, apiKey} em scripts/.local-test.json para o teste usar.
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("faltam SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false } });

const appId = "test-bot-" + randomBytes(3).toString("hex");
const apiKey = "nxs_" + randomBytes(24).toString("hex");
const keyHash = createHash("sha256").update(apiKey, "utf8").digest("hex");
const keyPrefix = apiKey.slice(0, 12);
const data = {
  "firestore-garden":   { read: ["*"], write: ["*"] },
  "firestore-postflow": { read: ["*"], write: ["*"] },
  "supabase":           { read: ["*"], write: ["*"] },
};

const { error } = await sb.from("nexus_apps").insert({
  id: appId, name: "Bot de Teste (local)", key_hash: keyHash, key_prefix: keyPrefix,
  data, allow: [], active: true, created_by: "local-e2e",
});
if (error) { console.error("ERRO insert:", JSON.stringify(error)); process.exit(1); }

writeFileSync(new URL("./.local-test.json", import.meta.url), JSON.stringify({ appId, apiKey }));
console.log(`SEEDED  app=${appId}  key=${keyPrefix}…  (hash ${keyHash.slice(0,12)}…)`);
