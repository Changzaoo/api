// ============================================================
//  Apps dinâmicos — registrados via painel, persistidos no Supabase
// ------------------------------------------------------------
//  A chave real (nxs_…) é gerada aqui, exibida UMA VEZ no painel
//  e NUNCA armazenada — só o sha256 hex fica no banco.
//  O registry em memória é recarregado a cada REFRESH_MS (60s).
// ============================================================

import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "./util/errors.js";

const REFRESH_MS = 60_000;
const TABLE = "nexus_apps";

let _apps = new Map();      // id -> app object
let _byHash = new Map();    // sha256(key) hex -> id
let _adapter = null;        // supabase adapter (lazy)
let _refreshTimer = null;

// ---------- helpers internos ----------

function sha256Hex(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function generateKey() {
  return "nxs_" + randomBytes(24).toString("hex"); // nxs_ + 48 hex = 52 chars
}

function rowToApp(row) {
  return {
    id: row.id,
    name: row.name,
    _keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    allow: Array.isArray(row.allow) ? row.allow : [],
    data: row.data || {},
    dynamic: true,
  };
}

async function getAdapter() {
  return _adapter;
}

// ---------- carregamento ----------

async function reload() {
  const adapter = await getAdapter();
  if (!adapter) return;
  try {
    const { items } = await adapter.list(TABLE, {
      where: [{ field: "active", op: "eq", value: true }],
      limit: 500,
    });
    const apps = new Map();
    const byHash = new Map();
    for (const row of items) {
      const app = rowToApp(row);
      apps.set(app.id, app);
      byHash.set(app._keyHash, app.id);
    }
    _apps = apps;
    _byHash = byHash;
  } catch (e) {
    console.warn("[dynamic-apps] falha ao recarregar:", e.message);
  }
}

// ---------- API pública ----------

/**
 * Inicia o módulo: resolve o adapter Supabase e agenda refresh periódico.
 * Chamado uma vez na subida do servidor (server.js).
 */
export async function startDynamicApps(getDatasources) {
  const { datasources } = getDatasources();
  const ds = datasources?.supabase;
  if (!ds?.ready) {
    console.warn("[dynamic-apps] Supabase não configurado — apps dinâmicos indisponíveis.");
    return;
  }
  try {
    _adapter = await ds.getAdapter();
  } catch (e) {
    console.warn("[dynamic-apps] falha ao inicializar adapter Supabase:", e.message);
    return;
  }
  await reload();
  _refreshTimer = setInterval(reload, REFRESH_MS);
  console.log(`[dynamic-apps] ${_apps.size} app(s) dinâmico(s) carregado(s).`);
}

/** Retorna as adições dinâmicas para mescla com o registry estático. */
export function getDynamicRegistry() {
  return { apps: _apps, byHash: _byHash };
}

/** Força um reload imediato dos apps dinâmicos do banco (botão sincronizar). */
export async function syncDynamicApps() {
  await reload();
  return _apps.size;
}

/** Lista apps dinâmicos ativos (para o painel). */
export function listDynamicApps() {
  return [..._apps.values()].map((a) => ({
    id: a.id,
    name: a.name,
    keyPrefix: a.keyPrefix,
    allow: a.allow,
    data: a.data,
  }));
}

/**
 * Cria um novo app dinâmico.
 * Retorna { id, name, key } — a key é exibida UMA VEZ e nunca mais.
 */
export async function createDynamicApp({ id, name, data = {}, allow = [] }, createdBy = "") {
  if (!_adapter) throw new ApiError(503, "datasource_unconfigured", "Supabase não configurado — apps dinâmicos indisponíveis.");

  const slug = String(id).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!slug) throw new Error("id inválido (use letras, números, _ ou -).");
  if (_apps.has(slug)) throw new Error(`app "${slug}" já existe.`);

  const key = generateKey();
  const hash = sha256Hex(key);
  const prefix = key.slice(0, 12);

  const row = {
    id: slug,
    name: String(name).trim() || slug,
    key_hash: hash,
    key_prefix: prefix,
    data,
    allow,
    active: true,
    created_by: createdBy,
  };

  await _adapter.create(TABLE, row, { id: slug });

  // Atualiza memória imediatamente (sem esperar o próximo reload).
  const app = rowToApp({ ...row, key_hash: hash, key_prefix: prefix });
  _apps.set(slug, app);
  _byHash.set(hash, slug);

  return { id: slug, name: row.name, key };
}

/**
 * Revoga um app (soft delete: active = false).
 */
export async function revokeDynamicApp(id) {
  if (!_adapter) throw new ApiError(503, "datasource_unconfigured", "Supabase não configurado.");
  await _adapter.update(TABLE, id, { active: false });
  const app = _apps.get(id);
  if (app) {
    _apps.delete(id);
    _byHash.delete(app._keyHash);
  }
}
