-- Run after a product discovery run. Every check should return zero rows ("bad") unless noted.
-- Set the business id on the params line.
with params as (select 'lashesbyshazz'::text as business_id)

-- 1. A discovered product must never be visible to a storefront.
select 'discovered_but_storefront_visible' as problem, p.id, p.title
from public.products p, params
where p.business_id = params.business_id and p.status = 'discovered' and p.is_visible = true

union all
-- 2. Every discovered product needs at least one piece of proof.
select 'discovered_without_evidence', p.id, p.title
from public.products p, params
where p.business_id = params.business_id and p.status = 'discovered'
  and not exists (select 1 from public.product_mentions m where m.product_id = p.id)

union all
-- 3. The stored mention count must equal the real number of evidence rows (discovered products).
select 'mention_count_mismatch', p.id, p.title || ' (stored ' || p.mention_count || ', real ' || coalesce(c.n, 0) || ')'
from public.products p
left join (select product_id, count(*) n from public.product_mentions group by product_id) c on c.product_id = p.id
cross join params
where p.business_id = params.business_id and p.status = 'discovered' and p.mention_count <> coalesce(c.n, 0)

union all
-- 4. No two live (non-dismissed) products should share a normalised name.
select 'duplicate_dedupe_key', min(p.id), p.dedupe_key || ' x' || count(*)
from public.products p, params
where p.business_id = params.business_id and p.status <> 'dismissed' and p.dedupe_key is not null
group by p.dedupe_key having count(*) > 1

union all
-- 5. Approved products that were once discovered must carry an approval time.
select 'approved_without_approved_at', p.id, p.title
from public.products p, params
where p.business_id = params.business_id and p.status = 'approved' and p.approved_at is null

union all
-- 6. A price taken from chat or image must have a price source.
select 'price_without_source', p.id, p.title
from public.products p, params
where p.business_id = params.business_id and p.status = 'discovered' and p.price is not null and p.price_source is null

union all
-- 7. Private image types must never have produced items.
select 'private_image_with_items', r.image_key, r.image_type
from public.product_image_reads r, params
where r.business_id = params.business_id
  and r.image_type in ('payment_proof', 'document', 'personal', 'screenshot')
  and jsonb_array_length(r.items) > 0;

-- For information (not a check): what the images turned out to be.
-- select image_type, status, source, low_res, count(*) from public.product_image_reads
--  where business_id = 'lashesbyshazz' group by 1, 2, 3, 4 order by 5 desc;
