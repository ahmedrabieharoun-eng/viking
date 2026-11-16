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

-- jsonb_set only creates the FINAL path component; this recursive
-- helper creates intermediate objects too (RTDB path semantics).
create or replace function public._set_deep(data jsonb, path text[], value jsonb)
returns jsonb
language plpgsql
immutable
as $$
begin
  if coalesce(array_length(path, 1), 0) = 0 then return value; end if;
  if jsonb_typeof(coalesce(data, '{}'::jsonb)) <> 'object' then data := '{}'::jsonb; end if;
  return jsonb_set(data, path[1:1],
    public._set_deep(coalesce(data -> path[1], '{}'::jsonb), path[2:array_length(path, 1)], value), true);
end;
$$;

-- One write inside one document root, atomically, under a row lock.
-- p_mode: 'set' | 'update' | 'remove'. p_value is SQL NULL to delete
-- at the subpath (RTDB semantics). p_expect_v: optimistic version
-- check for transactions; NULL means "do not care". Returns the new
-- version, 0 when the row was deleted, or -1 on a version conflict.
create or replace function public._apply_write(
  p_table text, p_key text, p_subpath text[], p_value jsonb,
  p_mode text, p_expect_v bigint
) returns bigint
language plpgsql
as $$
declare
  cur_data jsonb;
  cur_v bigint;
  new_data jsonb;
  sub jsonb;
  merged jsonb;
  k text;
begin
  if p_table = 'players' then
    select data, v into cur_data, cur_v from public.players where id = p_key for update;
  elsif p_table = 'withdrawals' then
    select data, v into cur_data, cur_v from public.withdrawals where id = p_key for update;
  else
    select data, v into cur_data, cur_v from public.docs where path = p_key for update;
  end if;

  if cur_v is not null and p_expect_v is not null and p_expect_v <> cur_v then
    return -1;
  end if;

  if p_mode = 'remove' and coalesce(array_length(p_subpath, 1), 0) = 0 then
    if cur_v is null then return 0; end if;
    if p_table = 'players' then delete from public.players where id = p_key;
    elsif p_table = 'withdrawals' then delete from public.withdrawals where id = p_key;
    else delete from public.docs where path = p_key; end if;
    return 0;
  end if;

  if p_mode = 'set' then
    if coalesce(array_length(p_subpath, 1), 0) = 0 then
      if p_value is null then
        if cur_v is null then return 0; end if;
        if p_table = 'players' then delete from public.players where id = p_key;
        elsif p_table = 'withdrawals' then delete from public.withdrawals where id = p_key;
        else delete from public.docs where path = p_key; end if;
        return 0;
      end if;
      new_data := p_value;
    elsif p_value is null then
      new_data := coalesce(cur_data, '{}'::jsonb) #- p_subpath;
    else
      new_data := public._set_deep(coalesce(cur_data, '{}'::jsonb), p_subpath, p_value);
    end if;
  elsif p_mode = 'update' then
    sub := case when coalesce(array_length(p_subpath, 1), 0) = 0
                then coalesce(cur_data, '{}'::jsonb)
                else coalesce(cur_data #> p_subpath, '{}'::jsonb) end;
    if jsonb_typeof(sub) <> 'object' then sub := '{}'::jsonb; end if;
    merged := sub;
    for k in select jsonb_object_keys(coalesce(p_value, '{}'::jsonb)) loop
      if (p_value -> k) = 'null'::jsonb then merged := merged - k;
      elsif jsonb_typeof(p_value -> k) = 'object' and (p_value -> k) ? '__increment' then
        -- adapter translation of RTDB ServerValue.increment(n)
        merged := jsonb_set(merged, array[k], to_jsonb(
          (case when (sub ->> k) ~ '^-?[0-9]+(\.[0-9]+)?$' then (sub ->> k)::numeric else 0 end)
          + ((p_value -> k) ->> '__increment')::numeric), true);
      else merged := jsonb_set(merged, array[k], p_value -> k, true); end if;
    end loop;
    if coalesce(array_length(p_subpath, 1), 0) = 0 then new_data := merged;
    else new_data := public._set_deep(coalesce(cur_data, '{}'::jsonb), p_subpath, merged); end if;
  elsif p_mode = 'remove' then
    new_data := coalesce(cur_data, '{}'::jsonb) #- p_subpath;
  else
    raise exception 'unknown mode %', p_mode;
  end if;

  if cur_v is null then
    if p_table = 'players' then insert into public.players (id, data, v) values (p_key, new_data, 1);
    elsif p_table = 'withdrawals' then insert into public.withdrawals (id, data, v) values (p_key, new_data, 1);
    else insert into public.docs (path, data, v) values (p_key, new_data, 1); end if;
    return 1;
  else
    if p_table = 'players' then update public.players set data = new_data, v = cur_v + 1, updated_at = now() where id = p_key;
    elsif p_table = 'withdrawals' then update public.withdrawals set data = new_data, v = cur_v + 1, updated_at = now() where id = p_key;
    else update public.docs set data = new_data, v = cur_v + 1, updated_at = now() where path = p_key; end if;
    return cur_v + 1;
  end if;
end;
$$;

create or replace function public.doc_write(
  p_table text, p_key text, p_subpath text[], p_value jsonb,
  p_mode text, p_expect_v bigint
) returns bigint
language sql
as $$ select public._apply_write(p_table, p_key, p_subpath, p_value, p_mode, p_expect_v); $$;

-- Several document writes in ONE transaction (the adapter's
-- equivalent of an RTDB root multi-path update). p_ops is a jsonb
-- array of {table, key, subpath, mode, value} objects.
create or replace function public.multi_write(p_ops jsonb)
returns void
language plpgsql
as $$
declare op jsonb; ignored bigint;
begin
  for op in select value from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) loop
    ignored := public._apply_write(
      op ->> 'table', op ->> 'key',
      coalesce((select array_agg(x order by ord) from jsonb_array_elements_text(coalesce(op -> 'subpath', '[]'::jsonb)) with ordinality as t(x, ord)), '{}'::text[]),
      case when op ? 'value' then op -> 'value' else null end,
      coalesce(op ->> 'mode', 'set'), null);
  end loop;
end;
$$;

-- Bulk import helper for the one-time copy: insert many rows at
-- once (jsonb array of {id|path, data}); existing keys are replaced.
create or replace function public.bulk_put(p_table text, p_rows jsonb)
returns integer
language plpgsql
as $$
declare r jsonb; n integer := 0;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if p_table = 'players' then
      insert into public.players (id, data) values (r ->> 'id', r -> 'data')
      on conflict (id) do update set data = excluded.data, v = public.players.v + 1, updated_at = now();
    elsif p_table = 'withdrawals' then
      insert into public.withdrawals (id, data) values (r ->> 'id', r -> 'data')
      on conflict (id) do update set data = excluded.data, v = public.withdrawals.v + 1, updated_at = now();
    else
      insert into public.docs (path, data) values (r ->> 'path', r -> 'data')
      on conflict (path) do update set data = excluded.data, v = public.docs.v + 1, updated_at = now();
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;
