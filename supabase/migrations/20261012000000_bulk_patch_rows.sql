-- Bulk row patcher used by the analyser (run-local.js) so it can write results for hundreds of
-- contacts/conversations in ONE request instead of one request per row.
--
-- p_rows is a JSON array of { "k": <key value>, "patch": { "<column>": <value>, ... } }.
-- Only the columns present in a patch are changed (an explicit JSON null sets the column to NULL).
-- Only the analyser's two tables and two key columns are allowed. Service role only.
--
-- Safe to run more than once. If it is not installed the analyser falls back to row-by-row writes.

create or replace function public.bulk_patch_rows(p_table text, p_key text, p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare
  v_row   jsonb;
  v_cols  text;
  v_n     integer;
  v_total integer := 0;
begin
  if p_table not in ('contacts', 'conversations') then
    raise exception 'bulk_patch_rows: table % is not allowed', p_table;
  end if;
  if p_key not in ('id', 'contact_id') then
    raise exception 'bulk_patch_rows: key column % is not allowed', p_key;
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'bulk_patch_rows: p_rows must be a JSON array';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    select string_agg(format('%I = r.%I', a.attname, a.attname), ', ')
      into v_cols
      from pg_attribute a
     where a.attrelid = format('public.%I', p_table)::regclass
       and a.attnum > 0
       and not a.attisdropped
       and a.attname <> 'id'
       and a.attname <> p_key
       and (v_row -> 'patch') ? a.attname::text;

    if v_cols is null then
      continue;
    end if;

    execute format(
      'update public.%1$I t set %2$s '
      'from jsonb_populate_record(null::public.%1$I, $1) r, '
      '     jsonb_populate_record(null::public.%1$I, $2) k '
      'where t.%3$I = k.%3$I',
      p_table, v_cols, p_key)
    using v_row -> 'patch', jsonb_build_object(p_key, v_row -> 'k');

    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;

  return v_total;
end
$fn$;

revoke all on function public.bulk_patch_rows(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.bulk_patch_rows(text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
