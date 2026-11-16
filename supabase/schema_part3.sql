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
