// ============================================================
//  Parser de query params da Data API
// ------------------------------------------------------------
//  Traduz a query string REST numa estrutura canônica que cada
//  adapter (Firestore/Supabase) sabe aplicar. Validação rígida e
//  com tetos — entrada inválida vira 400 (bad_request).
//
//  Suportado:
//   ?where=campo:op:valor   (repetível)
//   ?order=campo  /  ?order=-campo   (repetível; - = desc)
//   ?limit=50  ?offset=0  ?cursor=<token>
//   ?select=a,b,c
//   ?count=true
//   ?pk=id   (chave primária para Supabase; default "id")
//   ?upsert=true  ?onConflict=col   (Supabase insert)
// ============================================================

import { badRequest } from "../util/errors.js";

const MAX_LIMIT = Number(process.env.DATA_MAX_LIMIT) || 200;

// Operadores canônicos aceitos em ?where=campo:op:valor.
const OPS = new Set([
  "eq", "neq", "lt", "lte", "gt", "gte",
  "in", "contains", "containsAny", "like", "ilike",
]);

/** Coage um valor textual para number/boolean/null quando claro. */
function coerce(raw) {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** Garante que um nome de campo é seguro (sem injeção). */
function safeField(f) {
  if (!/^[A-Za-z0-9_.]+$/.test(f)) throw badRequest(`campo inválido: "${f}"`);
  return f;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Faz o parse + validação dos query params. */
export function parseQuery(q = {}) {
  // ---- where ----
  const where = [];
  for (const clause of asArray(q.where)) {
    const idx1 = String(clause).indexOf(":");
    const idx2 = String(clause).indexOf(":", idx1 + 1);
    if (idx1 < 0 || idx2 < 0) throw badRequest(`where malformado: "${clause}" (use campo:op:valor)`);
    const field = safeField(String(clause).slice(0, idx1));
    const op = String(clause).slice(idx1 + 1, idx2);
    const rawVal = String(clause).slice(idx2 + 1);
    if (!OPS.has(op)) throw badRequest(`operador inválido: "${op}" (use ${[...OPS].join(", ")})`);
    const value = (op === "in" || op === "containsAny")
      ? rawVal.split(",").map(coerce)
      : coerce(rawVal);
    where.push({ field, op, value });
  }

  // ---- order ----
  const order = [];
  for (const o of asArray(q.order)) {
    const desc = String(o).startsWith("-");
    const field = safeField(desc ? String(o).slice(1) : String(o));
    order.push({ field, dir: desc ? "desc" : "asc" });
  }

  // ---- limit / offset ----
  let limit = q.limit != null ? Number(q.limit) : 50;
  if (!Number.isFinite(limit) || limit < 1) throw badRequest("limit inválido");
  limit = Math.min(limit, MAX_LIMIT);
  let offset = q.offset != null ? Number(q.offset) : 0;
  if (!Number.isFinite(offset) || offset < 0) throw badRequest("offset inválido");

  // ---- select ----
  const select = q.select
    ? String(q.select).split(",").map((s) => safeField(s.trim())).filter(Boolean)
    : null;

  return {
    where,
    order,
    limit,
    offset,
    select,
    cursor: q.cursor ? String(q.cursor) : null,
    count: String(q.count || "") === "true",
    pk: q.pk ? safeField(String(q.pk)) : "id",
    upsert: String(q.upsert || "") === "true",
    onConflict: q.onConflict ? safeField(String(q.onConflict)) : null,
  };
}

/** Rejeita corpos com chaves perigosas (prototype pollution). */
export function assertSafeBody(body) {
  const seen = new Set();
  const walk = (o, depth) => {
    if (depth > 8) throw badRequest("corpo muito profundo");
    if (o == null || typeof o !== "object") return;
    if (seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        throw badRequest(`chave proibida no corpo: "${k}"`);
      }
      walk(o[k], depth + 1);
    }
  };
  walk(body, 0);
  return body;
}
