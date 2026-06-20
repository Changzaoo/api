// ============================================================
//  Registro de datasources (Firebase / Supabase)
// ------------------------------------------------------------
//  Fonte única da verdade sobre quais bancos a Bridge conhece.
//  REGRA DE OURO (igual ao registry de apps): nenhum segredo no
//  código — só o NOME da env var. O valor é resolvido em runtime.
//
//  Cada datasource tem:
//   - kind        : "firestore" | "supabase"
//   - (firestore) projectId + saB64Env (service account em base64)
//   - (supabase)  urlEnv + keyEnv (service role) + bucket padrão
//
//  Os clientes pesados (firebase-admin / supabase-js) sobem em
//  LAZY INIT: só no primeiro uso real, memoizados. Se a credencial
//  faltar, o datasource fica `ready:false` e qualquer operação
//  nele responde 503 (datasource_unconfigured).
// ============================================================

import { datasourceUnconfigured } from "../util/errors.js";

/** @type {Record<string, object>} */
export const DATASOURCES = {
  "firestore-garden": {
    kind: "firestore",
    projectId: "garden-backup",
    saB64Env: "FIREBASE_SA_GARDEN_B64",
    label: "Firestore · garden-backup (Mídia)",
  },
  "firestore-postflow": {
    kind: "firestore",
    projectId: "postflow-b893f",
    saB64Env: "FIREBASE_SA_POSTFLOW_B64",
    label: "Firestore · postflow-b893f (CRM)",
  },
  supabase: {
    kind: "supabase",
    urlEnv: "SUPABASE_URL",
    keyEnv: "SUPABASE_SERVICE_ROLE_KEY",
    bucketEnv: "SUPABASE_STORAGE_BUCKET",
    defaultBucket: "nexus-media",
    label: "Supabase · Postgres + Storage",
  },
};

/**
 * Resolve o registro de datasources contra process.env, produzindo:
 *  - datasources : id -> { id, kind, label, ready, getAdapter() }
 *  - warnings    : pendências (credenciais faltando)
 *
 * getAdapter() faz lazy init memoizado; lança 503 se !ready.
 */
export function resolveDatasources(env = process.env) {
  const datasources = {};
  const warnings = [];

  for (const [id, def] of Object.entries(DATASOURCES)) {
    let ready = false;
    let config = null;

    if (def.kind === "firestore") {
      const saB64 = env[def.saB64Env];
      if (!saB64) {
        warnings.push(`datasource "${id}": env ${def.saB64Env} (service account base64) não definida — operações nele responderão 503.`);
      } else {
        ready = true;
        config = { projectId: def.projectId, saB64, name: id };
      }
    } else if (def.kind === "supabase") {
      const url = env[def.urlEnv];
      const key = env[def.keyEnv];
      const bucket = env[def.bucketEnv] || def.defaultBucket;
      if (!url) warnings.push(`datasource "${id}": env ${def.urlEnv} não definida — operações nele responderão 503.`);
      if (!key) warnings.push(`datasource "${id}": env ${def.keyEnv} (service role) não definida — operações nele responderão 503.`);
      if (url && key) {
        ready = true;
        config = { url, key, bucket };
      }
    }

    let adapter = null; // memoização do lazy init
    const getAdapter = async () => {
      if (!ready) throw datasourceUnconfigured(id);
      if (adapter) return adapter;
      if (def.kind === "firestore") {
        const { makeFirestoreAdapter } = await import("./firestore.js");
        adapter = makeFirestoreAdapter(config);
      } else {
        const { makeSupabaseAdapter } = await import("./supabase.js");
        adapter = makeSupabaseAdapter(config);
      }
      return adapter;
    };

    datasources[id] = { id, kind: def.kind, label: def.label, ready, getAdapter };
  }

  return { datasources, warnings };
}
