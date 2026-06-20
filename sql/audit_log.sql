-- ============================================================
--  Nexus Bridge — audit_log (append-only / imutável)
-- ------------------------------------------------------------
--  Registra toda troca de dados que passa pela Bridge. A
--  imutabilidade é garantida no banco: a service role recebe só
--  INSERT e SELECT; sem UPDATE/DELETE ninguém reescreve o passado.
--  Rode este script uma vez no SQL Editor do Supabase.
-- ============================================================

create table if not exists public.audit_log (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  principal_type text,
  principal_id   text,
  kind         text,
  datasource   text,
  resource     text,
  mode         text,
  method       text,
  route        text,
  target       text,
  status       int,
  bytes_in     bigint,
  bytes_out    bigint,
  duration_ms  numeric,
  request_id   text,
  ip           text
);

create index if not exists audit_log_ts_idx on public.audit_log (ts desc);
create index if not exists audit_log_principal_idx on public.audit_log (principal_id, ts desc);

-- Liga RLS e impede qualquer escrita por clientes anônimos/autenticados.
alter table public.audit_log enable row level security;

-- A Bridge usa a SERVICE ROLE, que ignora RLS — então ela consegue
-- INSERT/SELECT normalmente. Para travar a imutabilidade mesmo contra
-- a service role, revogue UPDATE/DELETE explicitamente:
revoke update, delete on public.audit_log from service_role;
revoke update, delete on public.audit_log from authenticated, anon;

-- (opcional) trava extra: um trigger que bloqueia UPDATE/DELETE.
create or replace function public.audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log é imutável (append-only)';
end; $$;

drop trigger if exists audit_log_no_mutate on public.audit_log;
create trigger audit_log_no_mutate
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();
