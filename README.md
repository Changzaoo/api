# 🔌 Nexus Bridge

Gateway central da **Nexus Holding** — `https://api.nexusholding.xyz`. É o hub por onde os
apps da empresa **trocam informação** (proxy app→app) e **leem/escrevem dados**
(Firestore + Supabase) de forma autenticada, autorizada e auditada. Tem um **painel web**
embutido com **login Firebase** e um **mapa de fluxo de dados ao vivo**.

```
  CRM Nexus ─┐                                   ┌─ Firestore garden-backup
  Mídia ─────┤                                   ├─ Firestore postflow-b893f
  (futuros) ─┘──►  api.nexusholding.xyz (Bridge) ─┼─ Supabase (Postgres + Storage)
                       │ proxy app→app            └─ backends roteados (Mídia…)
                       │ Data API central
                       │ painel /panel + fluxo ao vivo (SSE)
                       └─ audit_log imutável
```

## Como funciona

A Bridge tem **duas formas de autenticação**:

| Quem | Como | Identidade |
|---|---|---|
| **Apps** (server-to-server) | header `x-api-key` (comparação em **tempo constante**) | resolvida em [`src/registry.js`](src/registry.js) |
| **Humanos** (painel) | `Authorization: Bearer <Firebase ID token>` + **allowlist de e-mails** (`ADMIN_EMAILS`) | verificada em [`src/auth/firebase.js`](src/auth/firebase.js) |

Cada app registrado tem: uma **chave de entrada**, uma lista **`allow`** (apps que pode chamar
via proxy), um **`target`** opcional (quando outros o roteiam) e um bloco **`data`**
(permissões `read`/`write` por datasource/recurso, **deny-by-default**).

### Endpoints

| Método | Rota | Auth | O quê |
|---|---|---|---|
| GET | `/health` | — | Saúde da Bridge. |
| GET | `/panel` | — (assets) | Painel web (login + fluxo ao vivo). |
| GET | `/v1/whoami` | sim | Quem é o chamador e o que pode acessar. |
| GET | `/v1/apps` | sim | Catálogo de apps. |
| GET | `/v1/data/` | sim | Catálogo de datasources visíveis ao chamador. |
| GET/POST | `/v1/data/:ds/:resource` | sim | Lista/consulta · cria. |
| GET/PUT/PATCH/DELETE | `/v1/data/:ds/:resource/:id` | sim | Lê · substitui · merge · remove. |
| GET/PUT/POST/DELETE | `/v1/data/:ds/storage/:bucket/*` | sim | Download/URL assinada · upload · remove. |
| ANY | `/v1/route/:target/*` | sim (app) | Proxy app→app (inalterado). |
| POST | `/v1/stream-ticket` | sim | Emite ticket de uso único para o stream. |
| GET | `/v1/stream?ticket=…` | ticket | Fluxo de telemetria ao vivo (SSE). |
| GET | `/v1/metrics` | admin | Métricas acumuladas (só painel). |

### Data API — exemplos

```bash
# Listar leads (CRM lê o Firestore postflow), com filtro e ordenação:
curl -H "x-api-key: $KEY_CRM" \
  "https://api.nexusholding.xyz/v1/data/firestore-postflow/leads?where=status:eq:novo&order=-criadoEm&limit=20"

# Criar um lead (idempotente via ?id= ou header Idempotency-Key):
curl -X POST -H "x-api-key: $KEY_CRM" -H "Content-Type: application/json" \
  -d '{"nome":"Acme","fonte":"site"}' \
  "https://api.nexusholding.xyz/v1/data/firestore-postflow/leads?id=acme"

# Tabela Supabase (schema.tabela; default public):
curl -H "x-api-key: $KEY_MIDIA" \
  "https://api.nexusholding.xyz/v1/data/supabase/public.bugs?where=status:eq:aberto&count=true"

# Upload no Storage (corpo binário; ?upsert=true para sobrescrever):
curl -X PUT -H "x-api-key: $KEY_MIDIA" -H "Content-Type: image/png" \
  --data-binary @arte.png \
  "https://api.nexusholding.xyz/v1/data/supabase/storage/nexus-media/midia/arte.png"
```

**Query params**: `where=campo:op:valor` (ops: `eq neq lt lte gt gte in contains containsAny like ilike`),
`order=campo` / `order=-campo`, `limit` (teto `DATA_MAX_LIMIT`), `offset`, `select=a,b`,
`cursor` (Firestore), `count=true` e `pk` (Supabase).

### Painel (`/panel`)

Login Firebase (projeto **garden-backup**, só login — sem cadastro). Após autenticar, o
e-mail precisa estar em `ADMIN_EMAILS`. Mostra:

- **Mapa de fluxo ao vivo**: consumidores → BRIDGE → fontes, com pacotes animados
  proporcionais aos **bytes reais** de cada requisição (verde = consumidor, roxo = bridge,
  laranja = fonte, vermelho = erro).
- **Cartões**: requisições, bytes de entrada/saída, vazão ao vivo (bps/Kbps/Mbps), erros, uptime.
- **Feed** dos eventos recentes e um **explorador de dados** (leitura).

A telemetria é alimentada por SSE (`/v1/stream`), medindo bytes reais em
[`src/telemetry/measure.js`](src/telemetry/measure.js).

## Registrar um novo app

Tudo em [`src/registry.js`](src/registry.js) — **nenhum segredo no código**, só nomes de env vars.

```js
meuapp: {
  name: "Meu App",
  inboundKeyEnv: "KEY_MEUAPP",        // chave de entrada (x-api-key)
  allow: ["midia"],                    // quem pode chamar via proxy
  data: {                              // permissões na Data API (deny-by-default)
    "firestore-postflow": { read: ["leads", "leads/*"], write: [] },
    supabase: { read: ["public.relatorios"], write: ["storage:nexus-media/meuapp/**"] },
  },
  target: { /* opcional, se outros o roteiam */ },
},
```

Depois defina `KEY_MEUAPP` no Render. Os globs usam `*` (um segmento) e `**` (aninhado, p/ storage).

## Variáveis de ambiente

Veja [`.env.example`](.env.example). Destaques:

| Var | Descrição |
|---|---|
| `KEY_CRM`, `KEY_MIDIA` | Chaves de entrada dos apps. |
| `MIDIA_URL`, `MIDIA_UPSTREAM_KEY` | Backend roteado da Mídia (proxy). |
| `FIREBASE_SA_GARDEN_B64` | Service account (base64) do garden-backup — Firestore **e** login do painel. |
| `FIREBASE_SA_POSTFLOW_B64` | Service account (base64) do postflow-b893f — Firestore do CRM. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase (Postgres + Storage). |
| `ADMIN_EMAILS` | Allowlist de e-mails do painel (vírgula). |
| `ADMIN_WRITE` | Permite escrita de dados pelo admin do painel (default `false`). |

> Service accounts em base64: `base64 -w0 serviceAccount.json` (ou no PowerShell
> `[Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccount.json"))`).
> **A Bridge sobe mesmo sem credenciais** — cada recurso sem credencial responde `503`
> e a pendência aparece nos warnings da subida.

## Audit log imutável

Toda troca de dados/proxy é gravada (assíncrono, best-effort) em `public.audit_log` no
Supabase (fallback Firestore). A tabela é **append-only** — rode
[`sql/audit_log.sql`](sql/audit_log.sql) uma vez no SQL Editor do Supabase
(revoga UPDATE/DELETE + trigger anti-mutação).

## Deploy no Render

1. Suba o repo no GitHub.
2. Render → **New → Blueprint** (usa [`render.yaml`](render.yaml)).
3. Defina os segredos (`KEY_*`, `MIDIA_*`, `FIREBASE_SA_*_B64`, `SUPABASE_*`, `ADMIN_EMAILS`).
4. Teste: `curl https://<servico>.onrender.com/health` e abra `/panel`.

### Subdomínio `api.nexusholding.xyz`

No serviço do Render → **Settings → Custom Domains → Add** `api.nexusholding.xyz`, crie o
**CNAME** `api` → `<servico>.onrender.com` no DNS e aguarde o TLS.

## Local

```bash
cp .env.example .env   # preencha o que tiver
npm install
npm run dev            # http://localhost:8080/health  ·  /panel
```

## Segurança ("inviolável")

- **Auth dupla**: chave de app comparada em tempo constante; humano via Firebase ID token + allowlist.
- **Deny-by-default** no proxy (allowlist de rotas) e na Data API (allowlist de recursos por app).
- Credencial de entrada **nunca** vaza para o upstream; service accounts nunca são logadas ([`src/util/redact.js`](src/util/redact.js)).
- Rate limit geral + teto agressivo para escritas; CSP/helmet; `Cache-Control: no-store` em dados.
- Validação de query e corpo (anti prototype-pollution); limites de tamanho; uploads em rota raw isolada.
- **Audit log imutável** de toda troca de dados; ticket de uso único para o SSE.
- Rotacione qualquer chave exposta e troque nos dois lados (Bridge + backend).
