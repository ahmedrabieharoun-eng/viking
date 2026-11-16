-- VIKING Miner — Supabase (Postgres) schema for the RTDB migration.
-- Idempotent: safe to run repeatedly in the Supabase SQL editor.
-- Data model: one row per RTDB "document root" (a player record, a
-- withdrawal record, or a small named doc). The server's adapter
-- resolves RTDB subpaths inside the row's jsonb `data`.
-- Access: server-only via the service_role key (bypasses RLS).
-- RLS is enabled with NO public policies, so anon/authenticated
-- keys can read or write nothing.

create table if not exists public.players (
  id text primary key,
  data jsonb not null,
  v bigint not null default 1,
  updated_at timestamptz not null default now(),
  verify_pending_at numeric generated always as (
    case when data->>'verifyPendingAt' ~ '^-?[0-9]+(\.[0-9]+)?$'
         then (data->>'verifyPendingAt')::numeric end) stored,
  wallet_verified boolean generated always as (
    case when data->>'walletVerified' in ('true','false')
         then (data->>'walletVerified')::boolean end) stored,
  invited_by text generated always as (data->>'invitedBy') stored,
  user_no numeric generated always as (
    case when data->>'userNo' ~ '^-?[0-9]+(\.[0-9]+)?$'
         then (data->>'userNo')::numeric end) stored
);
create index if not exists players_verify_pending_idx on public.players (verify_pending_at);
create index if not exists players_wallet_verified_idx on public.players (wallet_verified);
create index if not exists players_invited_by_idx on public.players (invited_by);

create table if not exists public.withdrawals (
  id text primary key,
  data jsonb not null,
  v bigint not null default 1,
  updated_at timestamptz not null default now(),
  user_id text generated always as (data->>'userId') stored
);
create index if not exists withdrawals_user_id_idx on public.withdrawals (user_id);

create table if not exists public.docs (
  path text primary key,
  data jsonb not null,
  v bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.players enable row level security;
alter table public.withdrawals enable row level security;
alter table public.docs enable row level security;

