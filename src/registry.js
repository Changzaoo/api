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
// ============================================================

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
  },
};

/**
 * Resolve o registro estático contra process.env, produzindo:
 *  - apps    : id -> { name, allow, target? } com valores concretos
 *  - byKey   : valor-da-chave-de-entrada -> id do app (para auth)
 *  - warnings: pendências de configuração (envs faltando)
 */
export function resolveRegistry(env = process.env) {
  const apps = {};
  const byKey = new Map();
  const warnings = [];

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

    apps[id] = { id, name: def.name, allow: def.allow || [], target };
  }

  return { apps, byKey, warnings };
}

/**
 * Casa um path contra uma allowlist de globs simples.
 * "*" casa um segmento; padrão sem "*" exige match exato do primeiro segmento.
 * Ex.: "client/*" casa "client/42"; "client" casa "client".
 */
export function routeAllowed(path, patterns) {
  const clean = String(path).replace(/^\/+|\/+$/g, "");
  return patterns.some((p) => {
    if (p === "*") return true;
    const rx = new RegExp(
      "^" + p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$",
    );
    return rx.test(clean);
  });
}
