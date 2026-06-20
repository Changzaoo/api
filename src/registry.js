// ============================================================
//  Registro de apps da Nexus Holding
// ------------------------------------------------------------
//  Fonte única da verdade sobre quem pode falar com quem.
//  REGRA DE OURO: nenhum segredo mora aqui. Guardamos só o NOME
//  da env var; o valor é resolvido em runtime (resolveRegistry).
//
//  Cada app pode ter:
//   - inboundKeyEnv : env com a chave que o app usa para se
//                     autenticar NA Bridge (identidade do chamador).
//   - allow         : ids de apps que ele tem permissão de chamar.
//   - target        : config de upstream, presente quando outros
//                     apps podem ser ROTEADOS para este app:
//        baseUrlEnv      env com a URL base do backend
//        basePath        prefixo fixo das rotas de integração
//        upstreamHeader  header onde a Bridge injeta a chave upstream
//        upstreamKeyEnv  env com a chave aceita pelo backend
//        routes          allowlist de paths (glob simples com *)
//   - data          : permissões na Data API central, deny-by-default.
//        Mapa datasourceId -> { read:[globs], write:[globs] }.
//        Os globs usam o mesmo casamento de routeAllowed().
//        Recursos: coleção/tabela ("clientes", "public.bugs") ou
//        objeto de storage ("storage:nexus-media/midia/*").
// ============================================================

import { createHash } from "node:crypto";
import { DATASOURCES } from "./datasources/index.js";

/** @type {Record<string, AppDef>} */
export const APPS = {
  crm: {
    name: "CRM Nexus",
    inboundKeyEnv: "KEY_CRM",
    allow: ["midia"],
    // Sem `target`: o CRM (Firebase, client-side) ainda não expõe
    // um backend HTTP para a Bridge rotear. Quando expuser, defina
    // CRM_URL / CRM_UPSTREAM_KEY e descomente o bloco abaixo.
    // target: {
    //   baseUrlEnv: "CRM_URL",
    //   basePath: "/api/integration",
    //   upstreamHeader: "x-api-key",
    //   upstreamKeyEnv: "CRM_UPSTREAM_KEY",
    //   routes: ["health", "leads", "leads/*", "clients", "clients/*"],
    // },
    data: {
      "firestore-postflow": {
        read: ["leads", "leads/*", "clientes", "clientes/*", "campanhas", "campanhas/*"],
        write: ["leads", "leads/*", "clientes", "clientes/*"],
      },
    },
  },

  midia: {
    name: "Nexus Digital 90 (Mídia)",
    inboundKeyEnv: "KEY_MIDIA",
    allow: ["crm"],
    target: {
      baseUrlEnv: "MIDIA_URL",
      basePath: "/api/integration",
      upstreamHeader: "x-api-key",
      upstreamKeyEnv: "MIDIA_UPSTREAM_KEY",
      routes: ["health", "clients", "client", "client/*", "client/*/raw", "client/*/doc-html", "client/*/bundle"],
    },
    data: {
      "firestore-garden": {
        read: ["clients", "clients/*", "files", "files/*"],
        write: ["files", "files/*"],
      },
      supabase: {
        read: ["public.bugs", "public.notifications", "storage:nexus-media/**"],
        write: ["public.bugs", "public.notifications", "storage:nexus-media/midia/**"],
      },
    },
  },
};

// Permissões de dados de um administrador humano (login Firebase +
// allowlist de e-mails). Lê tudo; escreve só se ADMIN_WRITE=true.
export function adminDataPerms(env = process.env) {
  const canWrite = String(env.ADMIN_WRITE || "").toLowerCase() === "true";
  const all = { read: ["*"], write: canWrite ? ["*"] : [] };
  // Mesmo objeto para todos os datasources conhecidos.
  return new Proxy({}, { get: () => all, has: () => true });
}

/**
 * Resolve o registro estático contra process.env, produzindo:
 *  - apps    : id -> { name, allow, data, target? } com valores concretos
 *  - byKey   : valor-da-chave-de-entrada -> id do app (para auth)
 *  - byHash  : sha256(chave) (hex) -> id do app (para comparação
 *              em tempo constante; ver src/auth.js)
 *  - warnings: pendências de configuração (envs faltando)
 */
export function resolveRegistry(env = process.env) {
  const apps = {};
  const byKey = new Map();
  const byHash = new Map();
  const warnings = [];
  const knownDatasources = new Set(Object.keys(DATASOURCES));

  for (const [id, def] of Object.entries(APPS)) {
    const inboundKey = def.inboundKeyEnv ? env[def.inboundKeyEnv] : undefined;
    if (def.inboundKeyEnv && !inboundKey) {
      warnings.push(`app "${id}": env ${def.inboundKeyEnv} não definida — o app não conseguirá autenticar.`);
    }
    if (inboundKey) {
      if (byKey.has(inboundKey)) {
        warnings.push(`app "${id}": chave de entrada colide com "${byKey.get(inboundKey)}" — use valores únicos.`);
      }
      byKey.set(inboundKey, id);
      byHash.set(sha256Hex(inboundKey), id);
    }

    let target;
    if (def.target) {
      const baseUrl = env[def.target.baseUrlEnv];
      const upstreamKey = env[def.target.upstreamKeyEnv];
      if (!baseUrl) warnings.push(`app "${id}": env ${def.target.baseUrlEnv} (URL do backend) não definida.`);
      if (!upstreamKey) warnings.push(`app "${id}": env ${def.target.upstreamKeyEnv} (chave upstream) não definida.`);
      target = {
        baseUrl: (baseUrl || "").replace(/\/+$/, ""),
        basePath: def.target.basePath || "",
        upstreamHeader: def.target.upstreamHeader || "x-api-key",
        upstreamKey: upstreamKey || "",
        routes: def.target.routes || ["*"],
      };
    }

    // Valida que cada datasource referenciado no bloco `data` existe.
    const data = def.data || {};
    for (const dsId of Object.keys(data)) {
      if (!knownDatasources.has(dsId)) {
        warnings.push(`app "${id}": bloco data referencia datasource desconhecido "${dsId}".`);
      }
    }

    apps[id] = { id, name: def.name, allow: def.allow || [], data, target };
  }

  return { apps, byKey, byHash, warnings };
}

/** sha256 em hex de uma string (chave de entrada). */
function sha256Hex(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

/**
 * Verifica se um principal pode acessar (datasource, resource) no modo
 * dado ("read"|"write"). Deny-by-default: sem entrada para o datasource
 * ou modo, nega. `principal.data` é o mapa datasourceId -> {read,write}.
 */
export function canAccess(principal, datasourceId, resource, mode) {
  const perms = principal?.data?.[datasourceId];
  if (!perms) return false;
  const patterns = perms[mode];
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return routeAllowed(resource, patterns);
}

/**
 * Casa um path contra uma allowlist de globs simples.
 *  - "*"  casa um único segmento (não cruza "/").
 *  - "**" casa qualquer coisa, inclusive "/" (paths aninhados de storage).
 *  - sem curinga: match exato.
 * Ex.: "client/*" casa "client/42"; "storage:b/**" casa "storage:b/a/x.png".
 */
export function routeAllowed(path, patterns) {
  const clean = String(path).replace(/^\/+|\/+$/g, "");
  return patterns.some((p) => {
    if (p === "*" || p === "**") return true;
    // Tokeniza preservando "**" e "*"; tudo o mais é literal escapado.
    const rx = p
      .split(/(\*\*|\*)/)
      .map((tok) => {
        if (tok === "**") return ".*";
        if (tok === "*") return "[^/]+";
        return tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return new RegExp("^" + rx + "$").test(clean);
  });
}
