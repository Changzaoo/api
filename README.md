# 🔌 Nexus Bridge

Gateway de integração da **Nexus Holding**. É o hub central — `https://api.nexusholding.xyz` —
por onde qualquer app da empresa troca informação com outro, de forma autenticada,
autorizada, com rate limit e log. **Stateless**: a Bridge não guarda dado de negócio,
só roteia.

```
   CRM Nexus ──┐                              ┌── Nexus Digital 90 (Mídia)
               ├──►  api.nexusholding.xyz  ──►┤
  (futuros)  ──┘        (Nexus Bridge)        └── (futuros backends)
```

## Como funciona

Cada app registrado tem:

- uma **chave de entrada** (`x-api-key`) com que se autentica *na* Bridge — define sua identidade;
- uma lista **`allow`** dos apps que ele pode chamar;
- opcionalmente um **`target`** (URL do backend + chave upstream + allowlist de rotas),
  presente quando outros apps podem ser roteados *para* ele.

A Bridge resolve a chave → identidade do chamador, confere a permissão, valida a rota
contra a allowlist do destino e repassa a requisição **injetando a chave upstream do
destino** (a chave de entrada do chamador nunca vaza para o backend).

### Contrato de roteamento

```
ANY https://api.nexusholding.xyz/v1/route/:target/<path...>
Header: x-api-key: <chave de entrada do app chamador>
```

Exemplo — o CRM listando clientes na Mídia:

```bash
curl -H "x-api-key: $KEY_CRM" \
  https://api.nexusholding.xyz/v1/route/midia/clients
```

A Bridge encaminha para `MIDIA_URL/api/integration/clients` com `x-api-key: MIDIA_UPSTREAM_KEY`.

### Endpoints

| Método | Rota | Auth | O quê |
|---|---|---|---|
| GET | `/health` | — | Saúde da Bridge (usado pelo Render). |
| GET | `/v1/whoami` | sim | Quem é o chamador e quais apps pode chamar. |
| GET | `/v1/apps` | sim | Catálogo de apps registrados (sem segredos). |
| ANY | `/v1/route/:target/*` | sim | Roteamento genérico app → app. |

## Registrar um novo app

Tudo em [`src/registry.js`](src/registry.js) — **nenhum segredo no código**, só nomes de env vars.

1. Adicione a entrada:

```js
meuapp: {
  name: "Meu App",
  inboundKeyEnv: "KEY_MEUAPP",     // chave de entrada
  allow: ["midia"],                 // quem ele pode chamar
  target: {                         // opcional: se outros podem chamá-lo
    baseUrlEnv: "MEUAPP_URL",
    basePath: "/api/integration",
    upstreamHeader: "x-api-key",
    upstreamKeyEnv: "MEUAPP_UPSTREAM_KEY",
    routes: ["health", "recurso", "recurso/*"],
  },
},
```

2. Defina as env vars correspondentes no Render (`KEY_MEUAPP`, etc.).
3. Para liberar que **outro** app chame o seu, adicione `"meuapp"` no `allow` dele.

## Variáveis de ambiente

Veja [`.env.example`](.env.example). Resumo:

| Var | Obrigatória | Descrição |
|---|---|---|
| `PORT` | (Render injeta) | Porta do servidor. |
| `NODE_ENV` | recomendado | `production` em produção. |
| `ALLOWED_ORIGINS` | sim p/ browsers | Origens liberadas no CORS (vírgula). |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | não | Janela e teto do rate limit. |
| `KEY_CRM`, `KEY_MIDIA` | sim | Chaves de entrada de cada app. |
| `MIDIA_URL` | sim | Backend da Mídia (Render). |
| `MIDIA_UPSTREAM_KEY` | sim | `INTEGRATION_KEY` aceita pelo backend da Mídia. |

> Gere chaves fortes: `openssl rand -hex 32` (prefixo sugerido `nxb_`).
> Nunca versione valores reais.

## Deploy no Render

1. Suba este repo no GitHub.
2. Render → **New → Blueprint** apontando para o repo (usa o [`render.yaml`](render.yaml)).
3. Defina os segredos (`KEY_*`, `MIDIA_URL`, `MIDIA_UPSTREAM_KEY`) no painel.
4. Após o deploy, teste: `curl https://<servico>.onrender.com/health`.

### Subdomínio `api.nexusholding.xyz`

1. No serviço do Render → **Settings → Custom Domains → Add** `api.nexusholding.xyz`.
2. No DNS do `nexusholding.xyz`, crie o registro que o Render indicar:
   - **CNAME** `api` → `<servico>.onrender.com` (valor exato mostrado pelo Render).
3. Aguarde a validação e o certificado TLS (automático).
4. Confirme: `curl https://api.nexusholding.xyz/health`.

## Local

```bash
cp .env.example .env   # preencha as chaves
npm install
npm run dev            # http://localhost:8080/health
```

## Segurança

- Chave de entrada do chamador **nunca** é repassada ao upstream (lista hop-by-hop).
- Roteamento só para destinos no `allow` do chamador e rotas na allowlist do destino.
- Sem operações destrutivas implícitas — o que o backend não expõe, a Bridge não inventa.
- Rotacione qualquer chave exposta e troque nos dois lados (Bridge + backend).
