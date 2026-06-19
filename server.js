// ============================================================
//  Nexus Bridge — gateway de integração da Nexus Holding
//  https://api.nexusholding.xyz
// ------------------------------------------------------------
//  Hub central por onde os apps da empresa trocam informação,
//  com autenticação por app, allowlist de rotas, rate limit e log.
//  Stateless: nenhum dado de negócio é persistido aqui.
// ============================================================

import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";

import { resolveRegistry } from "./src/registry.js";
import { requireApp, extractKey } from "./src/auth.js";
import { makeProxyRouter } from "./src/proxy.js";

const PORT = process.env.PORT || 8080;
const PROD = process.env.NODE_ENV === "production";

// Registro resolvido uma vez na subida (env é estável em runtime).
let registry = resolveRegistry();
const getRegistry = () => registry;
if (registry.warnings.length) {
  console.warn("⚠️  Nexus Bridge — pendências de configuração:");
  for (const w of registry.warnings) console.warn("   - " + w);
}

const app = express();
app.set("trust proxy", 1); // atrás do proxy do Render
app.disable("x-powered-by");

// Request id em toda requisição (rastreio fim-a-fim).
app.use((req, res, next) => {
  req.id = req.get("x-request-id") || randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
});

app.use(helmet());

// CORS: só libera browsers das origens configuradas. Server-to-server
// (sem header Origin) passa direto.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("origem não permitida pelo CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-request-id"],
  maxAge: 86400,
}));

app.use(express.json({ limit: "1mb" }));

morgan.token("appid", (req) => req.caller?.id || "-");
morgan.token("rid", (req) => req.id || "-");
app.use(morgan(PROD
  ? ':rid :appid :method :url :status :response-time ms'
  : 'dev'));

// Rate limit por chave de entrada (cai para IP se não houver chave).
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => extractKey(req) || req.ip,
  message: { error: "limite de requisições excedido, tente novamente em instantes" },
});

// ---- Endpoints públicos ----

// Health da própria Bridge (usado pelo Render e por monitores).
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nexus-bridge", time: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.json({
    service: "Nexus Bridge",
    docs: "https://github.com/Changzaoo/nexus-bridge#readme",
    health: "/health",
    routing: "/v1/route/:target/*",
  });
});

// ---- Endpoints autenticados ----
const v1 = express.Router();
v1.use(limiter);
v1.use(requireApp(getRegistry));

// Quem sou eu e o que posso chamar.
v1.get("/whoami", (req, res) => {
  const targets = req.caller.allow.map((id) => {
    const t = registry.apps[id];
    return { id, name: t?.name || id, online: !!t?.target?.baseUrl };
  });
  res.json({ app: req.caller.id, name: req.caller.name, canCall: targets });
});

// Catálogo de apps registrados (sem segredos).
v1.get("/apps", (_req, res) => {
  res.json({
    apps: Object.values(registry.apps).map((a) => ({
      id: a.id, name: a.name, isTarget: !!a.target?.baseUrl,
    })),
  });
});

// Roteamento genérico app -> app.
v1.all("/route/:target/*", makeProxyRouter(getRegistry));

app.use("/v1", v1);

// 404 e handler de erro em JSON.
app.use((_req, res) => res.status(404).json({ error: "rota não encontrada" }));
app.use((err, _req, res, _next) => {
  const code = err.message?.includes("CORS") ? 403 : 500;
  res.status(code).json({ error: err.message || "erro interno" });
});

app.listen(PORT, () => {
  console.log(`🔌 Nexus Bridge ouvindo na porta ${PORT} (${PROD ? "production" : "development"})`);
});

export default app;
