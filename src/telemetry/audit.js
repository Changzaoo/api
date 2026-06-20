// ============================================================
//  Audit log imutável
// ------------------------------------------------------------
//  Assina o bus de telemetria e grava cada operação de dados/proxy
//  numa tabela append-only (Supabase public.audit_log; fallback
//  Firestore garden "audit_log"). Best-effort: nunca derruba a
//  requisição nem bloqueia a resposta (já foi enviada no 'finish').
//
//  A imutabilidade é garantida no banco: a service role só recebe
//  INSERT/SELECT na tabela (sem UPDATE/DELETE). Ver sql/audit_log.sql.
// ============================================================

import { bus } from "./bus.js";

export function startAudit(getDatasources) {
  bus.on("flow", (evt) => {
    if (evt.kind !== "data" && evt.kind !== "proxy") return; // só troca de dados
    persist(getDatasources, evt).catch(() => { /* best-effort */ });
  });
}

async function persist(getDatasources, evt) {
  const row = {
    ts: new Date(evt.ts).toISOString(),
    principal_type: evt.principal?.type || null,
    principal_id: evt.principal?.id || null,
    kind: evt.kind,
    datasource: evt.datasource || null,
    resource: evt.resource || null,
    mode: evt.mode || null,
    method: evt.method,
    route: evt.route,
    target: evt.target || null,
    status: evt.status,
    bytes_in: evt.bytesIn,
    bytes_out: evt.bytesOut,
    duration_ms: evt.durationMs,
    request_id: evt.rid || null,
    ip: evt.ip || null,
  };

  const { datasources } = getDatasources();
  const sb = datasources["supabase"];
  if (sb?.ready) {
    const adapter = await sb.getAdapter();
    await adapter.create("public.audit_log", row, {});
    return;
  }
  const fb = datasources["firestore-garden"];
  if (fb?.ready) {
    const adapter = await fb.getAdapter();
    await adapter.create("audit_log", row, {});
  }
}
