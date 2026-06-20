// ============================================================
//  Data API central  —  /v1/data/:datasource/...
// ------------------------------------------------------------
//  Roteia leitura/escrita para os adapters de datasource. Ordem
//  de verificação (importante p/ não vazar informação):
//    1. datasource existe?            -> 404 unknown_datasource
//    2. principal tem permissão?      -> 403 forbidden (deny-by-default)
//    3. adapter configurado?          -> 503 datasource_unconfigured
//  Marca req.dataMeta para a telemetria e devolve erros JSON.
//
//  Firestore / Supabase Postgres:
//    GET/POST             /:ds/:resource
//    GET/PUT/PATCH/DELETE /:ds/:resource/:id
//  Supabase Storage:
//    GET    /:ds/storage/:bucket/*        download | ?signed=true
//    GET    /:ds/storage/:bucket?list=pfx lista por prefixo
//    PUT|POST /:ds/storage/:bucket/*      upload (corpo binário)
//    DELETE /:ds/storage/:bucket/*        remove objeto
// ============================================================

import express from "express";
import { canAccess } from "../registry.js";
import { parseQuery, assertSafeBody } from "./query.js";
import { sendError, forbidden, badRequest, unknownDatasource } from "../util/errors.js";

const UPLOAD_MAX = Number(process.env.DATA_UPLOAD_MAX) || 26_214_400; // 25 MiB

// Envolve handler async: erros viram resposta JSON padronizada.
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => sendError(res, e));

export function makeDataRouter(getRegistry, getDatasources) {
  const router = express.Router();

  // Toda resposta de dados é sensível: nunca cacheia.
  router.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // 1) existe? 2) autoriza (marca telemetria)? 3) adapter (lazy, 503 se sem credencial).
  async function prepare(req, dsId, resource, mode) {
    const { datasources } = getDatasources();
    const ds = datasources[dsId];
    if (!ds) throw unknownDatasource(dsId);
    if (!canAccess(req.principal, dsId, resource, mode)) {
      throw forbidden(`sem permissão de ${mode} em "${dsId}:${resource}"`);
    }
    req.dataMeta = { datasource: dsId, resource, mode };
    return ds.getAdapter();
  }

  function ensureStorage(adapter) {
    if (adapter.kind !== "supabase" || typeof adapter.upload !== "function") {
      throw badRequest("storage só está disponível no datasource supabase");
    }
  }

  // ---------------- Storage (antes das rotas genéricas) ----------------

  // Lista por prefixo: /:ds/storage/:bucket?list=prefix
  router.get("/:datasource/storage/:bucket", h(async (req, res) => {
    const { datasource, bucket } = req.params;
    const prefix = String(req.query.list || "");
    const adapter = await prepare(req, datasource, `storage:${bucket}/${prefix}`, "read");
    ensureStorage(adapter);
    res.json(await adapter.listFiles(bucket, prefix));
  }));

  // Download (ou URL assinada): /:ds/storage/:bucket/<path>
  router.get("/:datasource/storage/:bucket/*", h(async (req, res) => {
    const { datasource, bucket } = req.params;
    const path = req.params[0];
    const adapter = await prepare(req, datasource, `storage:${bucket}/${path}`, "read");
    ensureStorage(adapter);
    if (String(req.query.signed) === "true") {
      const expires = Math.min(Number(req.query.expires) || 3600, 86400);
      return res.json(await adapter.signUrl(bucket, path, expires));
    }
    const { buffer, contentType } = await adapter.download(bucket, path);
    res.setHeader("Content-Type", contentType);
    res.send(buffer);
  }));

  // Upload (corpo binário): /:ds/storage/:bucket/<path>
  const rawUpload = express.raw({ type: () => true, limit: UPLOAD_MAX });
  const uploadHandler = h(async (req, res) => {
    const { datasource, bucket } = req.params;
    const path = req.params[0];
    const adapter = await prepare(req, datasource, `storage:${bucket}/${path}`, "write");
    ensureStorage(adapter);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw badRequest("corpo do upload vazio ou não-binário");
    }
    const out = await adapter.upload(bucket, path, req.body, {
      contentType: req.get("content-type"),
      upsert: String(req.query.upsert) === "true",
    });
    res.status(201).json(out);
  });
  router.put("/:datasource/storage/:bucket/*", rawUpload, uploadHandler);
  router.post("/:datasource/storage/:bucket/*", rawUpload, uploadHandler);

  // Remove objeto: /:ds/storage/:bucket/<path>
  router.delete("/:datasource/storage/:bucket/*", h(async (req, res) => {
    const { datasource, bucket } = req.params;
    const path = req.params[0];
    const adapter = await prepare(req, datasource, `storage:${bucket}/${path}`, "write");
    ensureStorage(adapter);
    res.json(await adapter.removeFile(bucket, path));
  }));

  // ---------------- Documento / registro por id ----------------

  router.get("/:datasource/:resource/:id", h(async (req, res) => {
    const { datasource, resource, id } = req.params;
    const adapter = await prepare(req, datasource, resource, "read");
    res.json(await adapter.get(resource, id, parseQuery(req.query)));
  }));

  router.put("/:datasource/:resource/:id", h(async (req, res) => {
    const { datasource, resource, id } = req.params;
    const adapter = await prepare(req, datasource, resource, "write");
    const body = assertSafeBody(req.body || {});
    res.json(await adapter.replace(resource, id, body, parseQuery(req.query)));
  }));

  router.patch("/:datasource/:resource/:id", h(async (req, res) => {
    const { datasource, resource, id } = req.params;
    const adapter = await prepare(req, datasource, resource, "write");
    const body = assertSafeBody(req.body || {});
    res.json(await adapter.update(resource, id, body, parseQuery(req.query)));
  }));

  router.delete("/:datasource/:resource/:id", h(async (req, res) => {
    const { datasource, resource, id } = req.params;
    const adapter = await prepare(req, datasource, resource, "write");
    res.json(await adapter.remove(resource, id, parseQuery(req.query)));
  }));

  // ---------------- Coleção / tabela ----------------

  router.get("/:datasource/:resource", h(async (req, res) => {
    const { datasource, resource } = req.params;
    const adapter = await prepare(req, datasource, resource, "read");
    res.json(await adapter.list(resource, parseQuery(req.query)));
  }));

  router.post("/:datasource/:resource", h(async (req, res) => {
    const { datasource, resource } = req.params;
    const adapter = await prepare(req, datasource, resource, "write");
    const body = assertSafeBody(req.body || {});
    const query = parseQuery(req.query);
    const id = req.query.id ? String(req.query.id) : (req.get("idempotency-key") || undefined);
    res.status(201).json(await adapter.create(resource, body, { ...query, id }));
  }));

  // Catálogo de datasources visíveis ao principal (sem segredos).
  router.get("/", (req, res) => {
    const { datasources } = getDatasources();
    const perms = req.principal?.data || {};
    res.json({
      datasources: Object.values(datasources).map((d) => ({
        id: d.id, kind: d.kind, label: d.label, ready: d.ready,
        access: req.principal?.type === "user" ? "admin" : (perms[d.id] ? "scoped" : "none"),
      })),
    });
  });

  return router;
}
