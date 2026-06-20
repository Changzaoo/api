// ============================================================
//  Adapter Supabase (@supabase/supabase-js)
// ------------------------------------------------------------
//  Cobre Postgres (select/insert/update/delete) e Storage
//  (upload/download/list/remove/signUrl). Usa a service role key
//  (poder total) — por isso TODA chamada passa antes pelo
//  canAccess() no router. Interface comum à Data API.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { notFound, badRequest, upstreamError } from "../util/errors.js";

export function makeSupabaseAdapter({ url, key, bucket: defaultBucket }) {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // resource "schema.table" -> { schema, table }; sem ponto => public.
  function table(resource) {
    const i = resource.indexOf(".");
    const schema = i >= 0 ? resource.slice(0, i) : "public";
    const name = i >= 0 ? resource.slice(i + 1) : resource;
    const base = schema === "public" ? client : client.schema(schema);
    return base.from(name);
  }

  // Aplica um filtro canônico no query builder do supabase-js.
  function applyWhere(q, w) {
    switch (w.op) {
      case "eq": return q.eq(w.field, w.value);
      case "neq": return q.neq(w.field, w.value);
      case "lt": return q.lt(w.field, w.value);
      case "lte": return q.lte(w.field, w.value);
      case "gt": return q.gt(w.field, w.value);
      case "gte": return q.gte(w.field, w.value);
      case "in": return q.in(w.field, Array.isArray(w.value) ? w.value : [w.value]);
      case "like": return q.like(w.field, String(w.value));
      case "ilike": return q.ilike(w.field, String(w.value));
      case "contains": return q.contains(w.field, w.value);
      case "containsAny": return q.overlaps(w.field, Array.isArray(w.value) ? w.value : [w.value]);
      default: throw badRequest(`operador "${w.op}" não suportado no Supabase`);
    }
  }

  // ---- Postgres ----
  // Tolera queries parciais (chamadas internas como o reload de apps
  // dinâmicos passam só { where, limit }, sem order/offset).
  async function list(resource, query = {}) {
    const where = query.where || [];
    const order = query.order || [];
    const offset = Number.isFinite(query.offset) ? query.offset : 0;
    const limit = Number.isFinite(query.limit) ? query.limit : 50;
    let q = table(resource).select(
      query.select ? query.select.join(",") : "*",
      query.count ? { count: "exact" } : undefined,
    );
    for (const w of where) q = applyWhere(q, w);
    for (const o of order) q = q.order(o.field, { ascending: o.dir === "asc" });
    q = q.range(offset, offset + limit - 1);
    const { data, error, count } = await q;
    if (error) throw upstreamError(error.message);
    return { items: data || [], count: count ?? (data ? data.length : 0) };
  }

  async function get(resource, id, query = {}) {
    const { data, error } = await table(resource).select("*").eq(query.pk || "id", id).maybeSingle();
    if (error) throw upstreamError(error.message);
    if (!data) throw notFound(`registro "${id}" não encontrado em "${resource}"`);
    return data;
  }

  async function create(resource, body, query = {}) {
    const builder = table(resource);
    const op = query.upsert
      ? builder.upsert(body, query.onConflict ? { onConflict: query.onConflict } : undefined)
      : builder.insert(body);
    const { data, error } = await op.select();
    if (error) throw upstreamError(error.message);
    return Array.isArray(data) && data.length === 1 ? data[0] : data;
  }

  async function update(resource, id, body, query = {}) {
    const { data, error } = await table(resource).update(body).eq(query.pk || "id", id).select();
    if (error) throw upstreamError(error.message);
    if (!data || data.length === 0) throw notFound(`registro "${id}" não encontrado em "${resource}"`);
    return data[0];
  }

  async function remove(resource, id, query = {}) {
    const { error } = await table(resource).delete().eq(query.pk || "id", id);
    if (error) throw upstreamError(error.message);
    return { id, deleted: true };
  }

  // replace = update completo (Supabase não distingue PUT/PATCH no REST)
  const replace = update;

  // ---- Storage ----
  function bucketOf(name) {
    return client.storage.from(name || defaultBucket);
  }

  async function upload(bucket, path, buffer, { contentType, upsert } = {}) {
    const { data, error } = await bucketOf(bucket).upload(path, buffer, {
      contentType: contentType || "application/octet-stream",
      upsert: !!upsert,
    });
    if (error) throw upstreamError(error.message);
    return { bucket: bucket || defaultBucket, path: data?.path || path, uploaded: true };
  }

  async function download(bucket, path) {
    const { data, error } = await bucketOf(bucket).download(path);
    if (error) throw notFound(`objeto "${path}" não encontrado`);
    const buf = Buffer.from(await data.arrayBuffer());
    return { buffer: buf, contentType: data.type || "application/octet-stream" };
  }

  async function removeFile(bucket, path) {
    const { error } = await bucketOf(bucket).remove([path]);
    if (error) throw upstreamError(error.message);
    return { bucket: bucket || defaultBucket, path, deleted: true };
  }

  async function listFiles(bucket, prefix) {
    const { data, error } = await bucketOf(bucket).list(prefix || "");
    if (error) throw upstreamError(error.message);
    return { items: data || [] };
  }

  async function signUrl(bucket, path, expires = 3600) {
    const { data, error } = await bucketOf(bucket).createSignedUrl(path, expires);
    if (error) throw upstreamError(error.message);
    return { url: data.signedUrl, expiresIn: expires };
  }

  return {
    kind: "supabase",
    list, get, create, replace, update, remove,
    upload, download, removeFile, listFiles, signUrl,
  };
}
