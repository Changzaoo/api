// ============================================================
//  Nexus Bridge — gateway central de dados da Nexus Holding
//  https://api.nexusholding.xyz
// ------------------------------------------------------------
//  Hub central por onde os apps da empresa trocam informação E
//  leem/escrevem dados (Firestore + Supabase), com:
//   - autenticação dupla (x-api-key p/ apps, Firebase ID token
//     + allowlist p/ humanos do painel);
//   - allowlist de rotas (proxy) e de recursos (Data API),
//     deny-by-default;
//   - telemetria de bytes reais ao vivo (SSE) e métricas;
//   - audit log imutável de toda troca de dados;
//   - painel web embutido em /panel.
// ============================================================

import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRegistry } from "./src/registry.js";
import { resolveDatasources } from "./src/datasources/index.js";
import { extractKey } from "./src/auth.js";
import { makeAuthDual, requireAppType } from "./src/auth/dual.js";
import { makeFirebaseVerifier } from "./src/auth/firebase.js";
import { makeProxyRouter } from "./src/proxy.js";
import { makeDataRouter } from "./src/data/router.js";
import { measure } from "./src/telemetry/measure.js";
import { snapshot } from "./src/telemetry/metrics.js";
import { sseHandler, issueTicket } from "./src/telemetry/sse.js";
import { startAudit } from "./src/telemetry/audit.js";
import { sendError, forbidden } from "./src/util/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const PROD = process.env.NODE_ENV === "production";
const SUPABASE_HOST = (process.env.SUPABASE_URL || "").replace(/\/+$/, "") || "https://*.supabase.co";

// ---- Resolução estática (env é estável em runtime) ----
const registry = resolveRegistry();
const getRegistry = () => registry;
const dsResolved = resolveDatasources();
const getDatasources = () => dsResolved;

const warnings = [...registry.warnings, ...dsResolved.warnings];
if (warnings.length) {
  console.warn("⚠️  Nexus Bridge — pendências de configuração:");
  for (const w of warnings) console.warn("   - " + w);
}

// Verificador de Firebase ID token (login humano do painel).
const verifier = makeFirebaseVerifier({
  appName: "firestore-garden", // reaproveita o app firebase-admin do garden-backup
  saB64: process.env.FIREBASE_SA_GARDEN_B64,
  adminEmails: (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean),
  checkRevoked: String(process.env.FIREBASE_CHECK_REVOKED || "") === "true",
});
if (!verifier.ready) {
  console.warn("⚠️  Login do painel indisponível: defina FIREBASE_SA_GARDEN_B64 e ADMIN_EMAILS.");
}

const authDual = makeAuthDual(getRegistry, verifier);
const dataRouter = makeDataRouter(getRegistry, getDatasources);

// Auditoria imutável escutando o bus de telemetria.
startAudit(getDatasources);

const app = express();
app.set("trust proxy", 1); // atrás do proxy do Render
app.disable("x-powered-by");

// Request id em toda requisição (rastreio fim-a-fim).
app.use((req, res, next) => {
  req.id = req.get("x-request-id") || randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
});

// Telemetria: mede bytes reais de entrada/saída (antes dos parsers).
app.use(measure);

// Segurança de cabeçalhos + CSP que libera o painel + Firebase + Supabase.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://www.gstatic.com", "https://www.googleapis.com"],
      "connect-src": [
        "'self'",
        "https://*.googleapis.com",
        "https://*.firebaseio.com",
        "https://securetoken.googleapis.com",
        "https://identitytoolkit.googleapis.com",
        SUPABASE_HOST,
      ],
      "img-src": ["'self'", "data:", "https:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "frame-src": ["https://garden-backup.firebaseapp.com"],
      "object-src": ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // permite carregar o SDK do Firebase via CDN
}));

app.use(express.json({ limit: "1mb" }));

morgan.token("appid", (req) => req.principal?.id || req.caller?.id || "-");
morgan.token("rid", (req) => req.id || "-");
app.use(morgan(PROD
  ? ':rid :appid :method :url :status :response-time ms'
  : 'dev'));

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => extractKey(req) || req.ip,
  message: { error: "limite de requisições excedido, tente novamente em instantes", code: "rate_limited" },
});

// Limite extra só para ESCRITAS na Data API (mais agressivo).
const dataWriteLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_DATA_WRITE_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.principal?.id || extractKey(req) || req.ip,
  skip: (req) => req.method === "GET" || req.method === "HEAD",
  message: { error: "limite de escritas excedido", code: "rate_limited" },
});

// ---- Endpoints públicos ----

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nexus-bridge", time: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.json({
    service: "Nexus Bridge",
    docs: "https://github.com/Changzaoo/nexus-bridge#readme",
    health: "/health",
    panel: "/panel",
    routing: "/v1/route/:target/*",
    data: "/v1/data/:datasource/:resource",
    stream: "/v1/stream",
  });
});

// Painel web embutido (estático). Assets são públicos; toda a API
// continua exigindo credencial válida.
app.use("/panel", express.static(path.join(__dirname, "public", "panel")));

// SSE: validado por TICKET (EventSource não envia headers). Fora do
// authDual de propósito; o ticket carrega o principal.
app.get("/v1/stream", (req, res) => {
  try { sseHandler(req, res); } catch (e) { sendError(res, e); }
});

// ---- Endpoints autenticados ----
const v1 = express.Router();
v1.use(limiter);
v1.use(authDual);

// Emite ticket de curta duração para abrir o /v1/stream.
v1.post("/stream-ticket", (req, res) => res.json(issueTicket(req.principal)));

// Métricas acumuladas — exclusivo de admin humano (visão global).
v1.get("/metrics", (req, res) => {
  if (req.principal?.type !== "user") return sendError(res, forbidden("métricas globais são exclusivas do painel"));
  res.json(snapshot());
});

// Quem sou eu e o que posso chamar.
v1.get("/whoami", (req, res) => {
  const p = req.principal;
  if (p.type === "user") {
    return res.json({ type: "user", email: p.email, name: p.name, admin: true });
  }
  const targets = p.allow.map((id) => {
    const t = registry.apps[id];
    return { id, name: t?.name || id, online: !!t?.target?.baseUrl };
  });
  res.json({ type: "app", app: p.id, name: p.name, canCall: targets, data: Object.keys(p.data || {}) });
});

// Catálogo de apps registrados (sem segredos).
v1.get("/apps", (_req, res) => {
  res.json({
    apps: Object.values(registry.apps).map((a) => ({
      id: a.id, name: a.name, isTarget: !!a.target?.baseUrl,
    })),
  });
});

// CORS: só em /v1 (APIs). Estáticos do painel são same-origin — não precisam.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
v1.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("origem não permitida pelo CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-request-id", "Idempotency-Key"],
  maxAge: 86400,
}));

// Data API central (leitura/escrita em Firestore + Supabase).
v1.use("/data", dataWriteLimiter, dataRouter);

// Roteamento genérico app -> app (exclusivo de apps).
v1.all("/route/:target/*", requireAppType, makeProxyRouter(getRegistry));

app.use("/v1", v1);

// 404 e handler de erro em JSON.
app.use((_req, res) => res.status(404).json({ error: "rota não encontrada", code: "not_found" }));
app.use((err, _req, res, _next) => {
  if (err?.message?.includes("CORS")) return res.status(403).json({ error: err.message, code: "cors_blocked" });
  sendError(res, err);
});

app.listen(PORT, () => {
  console.log(`🔌 Nexus Bridge ouvindo na porta ${PORT} (${PROD ? "production" : "development"})`);
});

export default app;
