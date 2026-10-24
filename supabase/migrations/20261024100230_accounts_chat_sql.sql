-- Accounts: chat AI SQL. Product search for the chat AI (sasa-brain) and the business assistant reads one WhatsApp
-- number's products plus the business catalog (account_id null). See ACCOUNTS.md rule 6.
-- Idempotent. The new argument is optional and last, so callers that pass named arguments without it keep working
-- (they search the whole business, as before).

drop function if exists public.match_products_v8(vector, double precision, integer, text, text);
drop function if exists public.match_products_v8(vector, double precision, integer, text, text, uuid);
create or replace function public.match_products_v8(
  query_embedding vector, match_threshold double precision, match_count integer, filter_business_id text, query_text text,
  filter_account_id uuid default null
) returns table (
  id text, title text, price numeric, old_price numeric, category text, description_short text,
  images text[], stock_quantity integer, product_type text, similarity double precision
)
language plpgsql stable
set search_path = public, extensions
as $function$
begin
  return query
  with eligible as (
    select p.* from products p
    where p.business_id = filter_business_id and p.status = 'approved' and p.ai_visible = true
      and (filter_account_id is null or p.account_id is null or p.account_id = filter_account_id)
  ),
  vector_matches as (
    select e.id, 1.0 / (60 + row_number() over (order by e.text_embedding <=> query_embedding)) as score
    from eligible e
    where e.text_embedding is not null and 1 - (e.text_embedding <=> query_embedding) > match_threshold
    limit match_count * 2
  ),
  text_matches as (
    select e.id, 1.0 / (60 + row_number() over (order by ts_rank(
      to_tsvector('english', e.title || ' ' || coalesce(e.description_short, '') || ' ' || coalesce(e.category, '') || ' ' || coalesce(array_to_string(e.aliases, ' '), '')),
      websearch_to_tsquery('english', query_text)) desc)) as score
    from eligible e
    where to_tsvector('english', e.title || ' ' || coalesce(e.description_short, '') || ' ' || coalesce(e.category, '') || ' ' || coalesce(array_to_string(e.aliases, ' '), ''))
      @@ websearch_to_tsquery('english', query_text)
    limit match_count * 2
  ),
  fused as (
    select m.id, sum(m.score) as final_score
    from (select * from vector_matches union all select * from text_matches) m
    group by m.id order by final_score desc limit match_count
  )
  select p.id, p.title, p.price, p.old_price, p.category, p.description_short, p.images, p.stock_quantity,
         p.type::text, case when p.text_embedding is null then null else 1 - (p.text_embedding <=> query_embedding) end
  from fused f join eligible p on p.id = f.id
  order by f.final_score desc;
end;
$function$;

-- As before: backend only (the dashboard never calls it directly).
revoke all on function public.match_products_v8(vector, double precision, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.match_products_v8(vector, double precision, integer, text, text, uuid) to service_role;
