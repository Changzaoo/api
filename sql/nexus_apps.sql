-- ============================================================
--  Nexus Bridge — nexus_apps (apps registrados dinamicamente)
-- ------------------------------------------------------------
--  Cada linha representa um app externo com sua chave nxs_ hashed.
--  A chave real nunca é armazenada; só o sha256 hex e os primeiros
--  12 chars (para exibição no painel).
--  Rode este script uma vez no SQL Editor do Supabase.
-- ============================================================

create table if not exists public.nexus_apps (
  id           text primary key,            -- slug único, ex.: "meuapp"
  name         text not null,               -- nome legível
  key_hash     text not null unique,        -- sha256(chave) em hex
  key_prefix   text not null,               -- primeiros 12 chars, ex.: "nxs_a1b2c3d4"
  data         jsonb not null default '{}', -- {dsId: {read:["*"], write:["*"]}}
  allow        jsonb not null default '[]', -- ids de apps que pode chamar via proxy
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   text                         -- e-mail do admin que criou
);

create index if not exists nexus_apps_active_idx on public.nexus_apps (active, id);

-- RLS: a service role da Bridge acessa normalmente.
-- Nenhum cliente anon/authenticated acessa esta tabela.
alter table public.nexus_apps enable row level security;

-- Sem policies = nenhum acesso externo (service role ignora RLS).
