-- Persist the canonical product IDs matched for each customer conversation.
-- This includes discovered products, even before owner approval, so analytics
-- can aggregate demand without relying on mutable product names.
alter table public.conversation_enrichment
  add column if not exists matched_products jsonb not null default '[]'::jsonb;

comment on column public.conversation_enrichment.matched_products is
  'Canonical products matched to customer interest for this conversation: [{product_id, product_name, match_status}].';
