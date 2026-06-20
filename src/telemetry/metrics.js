// ============================================================
//  Métricas acumuladas (em memória)
// ------------------------------------------------------------
//  Contadores desde a subida do processo. O histórico persistente
//  (à prova de restart) vem do audit_log; aqui é o resumo ao vivo
//  consumido por GET /v1/metrics e pelos cartões do painel.
// ============================================================

const startedAt = Date.now();

const state = {
  totals: { requests: 0, bytesIn: 0, bytesOut: 0, errors: 0 },
  byApp: {},        // id -> { requests, bytesIn, bytesOut, errors }
  byDatasource: {}, // id -> { requests, bytesIn, bytesOut, errors }
  byStatus: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
  byKind: {},       // proxy|data|stream|other -> count
};

function bump(bucket, key, evt) {
  const b = (bucket[key] ||= { requests: 0, bytesIn: 0, bytesOut: 0, errors: 0 });
  b.requests += 1;
  b.bytesIn += evt.bytesIn || 0;
  b.bytesOut += evt.bytesOut || 0;
  if (!evt.ok) b.errors += 1;
}

/** Registra um evento de fluxo nos contadores. */
export function record(evt) {
  state.totals.requests += 1;
  state.totals.bytesIn += evt.bytesIn || 0;
  state.totals.bytesOut += evt.bytesOut || 0;
  if (!evt.ok) state.totals.errors += 1;

  const cls = `${Math.floor((evt.status || 0) / 100)}xx`;
  if (state.byStatus[cls] != null) state.byStatus[cls] += 1;

  state.byKind[evt.kind] = (state.byKind[evt.kind] || 0) + 1;

  const appKey = evt.principal?.id || "anon";
  bump(state.byApp, appKey, evt);
  if (evt.datasource) bump(state.byDatasource, evt.datasource, evt);
}

/** Snapshot serializável para o endpoint /v1/metrics. */
export function snapshot() {
  const now = Date.now();
  const uptimeMs = now - startedAt;
  const uptimeSec = Math.max(1, uptimeMs / 1000);
  return {
    startedAt,
    now,
    uptimeMs,
    reqPerSec: +(state.totals.requests / uptimeSec).toFixed(3),
    totals: { ...state.totals },
    byStatus: { ...state.byStatus },
    byKind: { ...state.byKind },
    byApp: state.byApp,
    byDatasource: state.byDatasource,
  };
}
