-- Chat AI phase 2: the tables the brain ("sasa-brain" edge function) reads.
-- Run AFTER 20261003000000_products_discovery.sql (the AI's product search needs status/ai_visible)
-- and 20261004000000_chat_ai_foundation.sql.

-- ── 1. Handoff summary and sticky flow on the conversation ──────────────────
alter table public.conversations
  add column if not exists handover_summary text,
  add column if not exists chat_ai_flow_id uuid;

-- ── 2. Skills ───────────────────────────────────────────────────────────────
-- Default library: ours, shared. Owners copy the ones they want into chat_ai_skills and edit the copy.
create table if not exists public.chat_ai_default_skills (
  key text primary key,
  title text not null,
  when_to_use text not null,
  instructions text not null,
  sort_order integer not null default 100,
  updated_at timestamptz not null default now()
);
alter table public.chat_ai_default_skills enable row level security;
drop policy if exists chat_ai_default_skills_read on public.chat_ai_default_skills;
create policy chat_ai_default_skills_read on public.chat_ai_default_skills for select to authenticated using (true);

create table if not exists public.chat_ai_skills (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  title text not null,
  when_to_use text not null,
  instructions text not null,
  enabled boolean not null default true,
  source_default_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, key)
);
create index if not exists idx_chat_ai_skills_business on public.chat_ai_skills (business_id) where enabled;
alter table public.chat_ai_skills enable row level security;

-- ── 3. Flows ────────────────────────────────────────────────────────────────
-- A flow = who it is for (trigger, checked by code) + the outcome wanted + instructions + the skills it uses.
-- skill_keys points at chat_ai_skills.key, so one flow can use many skills and one skill can serve many flows.
create table if not exists public.chat_flows (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  name text not null,
  enabled boolean not null default true,
  priority integer not null default 100,           -- higher wins when a lead matches several flows
  trigger jsonb not null default '{}'::jsonb,      -- {"ad_ids": ["..."], "list_ids": ["uuid", ...]}; a lead matches if ANY listed ad or list matches
  goal text,
  instructions text not null,
  skill_keys text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_chat_flows_business on public.chat_flows (business_id) where enabled;
alter table public.chat_flows enable row level security;

do $$
declare t text;
begin
  foreach t in array array['chat_ai_skills', 'chat_flows'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format($p$create policy %I on public.%I for all to authenticated
      using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()))
      with check (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()))$p$, t || '_owner_all', t);
  end loop;
end $$;

-- ── 4. Tool registry ────────────────────────────────────────────────────────
-- Every enabled row is shown to the AI automatically. To give the AI a new tool, insert a row here.
--   kind 'builtin' : target = a handler built into the edge function (search_products, send_products, ...)
--   kind 'rpc'     : target = a Postgres function  f(p_business_id text, p_contact_id bigint, p_conversation_id text, p_args jsonb) returns jsonb
--   kind 'http'    : target = a URL; receives POST {business_id, contact_id, conversation_id, args}, header x-sasa-secret, returns JSON
--   phase 'lookup' : read-only or harmless; runs in parallel with other lookups
--   phase 'write'  : changes our data; also runs in parallel, but is skipped in simulation
--   phase 'send'   : the customer will see it; only runs after the lookups of the same step are back
-- business_id null = every business; set it to give one business its own tool.
create table if not exists public.chat_ai_tools (
  name text not null check (name ~ '^[a-z][a-z0-9_]{1,40}$'),
  business_id text,
  description text not null,
  parameters jsonb not null default '{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
  kind text not null check (kind in ('builtin', 'rpc', 'http')),
  target text not null,
  phase text not null default 'lookup' check (phase in ('lookup', 'write', 'send')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_chat_ai_tools_name_scope on public.chat_ai_tools (name, coalesce(business_id, ''));
alter table public.chat_ai_tools enable row level security;

insert into public.chat_ai_tools (name, description, parameters, kind, target, phase) values
('search_products',
 'Find products or services in this business''s catalog. Always use this before talking about any product, price or availability. Returns up to 5 matches with id, name, price and category.',
 '{"type":"object","properties":{"query":{"type":"string","description":"What the customer wants, in plain words, e.g. \"white beaded sandals\" or \"volume lash set\"."}},"required":["query"],"additionalProperties":false}',
 'builtin', 'search_products', 'lookup'),
('search_knowledge',
 'Look up this business''s own answers (delivery, opening hours, policies, how things work). Use it before answering a question about the business itself.',
 '{"type":"object","properties":{"query":{"type":"string","description":"The question to look up."}},"required":["query"],"additionalProperties":false}',
 'builtin', 'search_knowledge', 'lookup'),
('load_skill',
 'Load the full instructions for one of this business''s skills listed in your skill menu. Call it when the situation matches a skill and you have not loaded it yet.',
 '{"type":"object","properties":{"key":{"type":"string","description":"The skill key from the menu."}},"required":["key"],"additionalProperties":false}',
 'builtin', 'load_skill', 'lookup'),
('update_profile',
 'Save something useful you learned about this customer (what they want, budget, timing, location, objections). Short and factual. Call it whenever the customer reveals something worth remembering.',
 '{"type":"object","properties":{"note":{"type":"string","description":"One short factual note."},"objection_tags":{"type":"array","items":{"type":"string"},"description":"Optional short objection labels such as price, trust, timing."}},"required":["note"],"additionalProperties":false}',
 'builtin', 'update_profile', 'write'),
('send_products',
 'Send the customer the product photos with name and price. Only use ids returned by search_products in this conversation turn. Call it after search_products has returned, never in the same step.',
 '{"type":"object","properties":{"product_ids":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":3,"description":"Ids from search_products, best match first."}},"required":["product_ids"],"additionalProperties":false}',
 'builtin', 'send_products', 'send'),
('handoff',
 'Pass this chat to the business owner. Use it when the customer asks for a human, is upset, wants a refund or a price you cannot give, needs something custom, or confirms payment, or whenever you cannot answer from your tools. Give a summary of everything you already know. After calling it, send the customer one short message saying the owner will pick up.',
 '{"type":"object","properties":{"reason":{"type":"string","description":"Why you are handing off, in a few words."},"urgency":{"type":"string","enum":["low","normal","high"]},"summary":{"type":"string","description":"What the owner needs to know: what the customer wants, products shown, price and timing, anything they said."}},"required":["reason","urgency","summary"],"additionalProperties":false}',
 'builtin', 'handoff', 'write')
on conflict do nothing;

-- ── 5. Product search for the AI ────────────────────────────────────────────
-- Same hybrid search as match_products_v7, but it only ever sees products the owner approved and left visible
-- to the AI, and it also searches aliases and category.
create or replace function public.match_products_v8(
  query_embedding vector, match_threshold double precision, match_count integer, filter_business_id text, query_text text
) returns table (
  id text, title text, price numeric, old_price numeric, category text, description_short text,
  images text[], stock_quantity integer, product_type text, similarity double precision
)
language plpgsql stable
as $function$
begin
  return query
  with eligible as (
    select p.* from products p
    where p.business_id = filter_business_id and p.status = 'approved' and p.ai_visible = true
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
revoke all on function public.match_products_v8(vector, double precision, integer, text, text) from public, anon, authenticated;

-- ── 6. Default skills (the starting library) ────────────────────────────────
insert into public.chat_ai_default_skills (key, title, when_to_use, instructions, sort_order) values
('first_reply', 'First reply', 'The customer is writing for the first time, or only said hello or a vague opener.',
$s$Do not greet like a receptionist and do not ask what they need in general terms. Acknowledge what they wrote, use the ad or product they came from if you know it, and ask the single question that moves the sale forward (what they are looking for, or which option they saw). One or two short lines.$s$, 10),
('product_enquiry', 'Product enquiry', 'The customer asks about a product, a service, what you sell, or what is available.',
$s$Search first, then show. Call search_products with what they asked for. If there are good matches, send_products with the best one to three, then reply in one or two lines that leads to a decision (for example which one suits them, or what they want it for). If nothing matches, say so plainly, name the closest category if there is one, and ask what they are trying to get. Never describe a product you have not searched for.$s$, 20),
('price_question', 'Price questions', 'The customer asks how much something costs, or whether the price can come down.',
$s$State the exact price from the search result, with currency, in the first line. Never round, estimate or invent a price. If asked for a discount or a lower price, do not agree to anything and do not invent offers: say what the price includes, and if they push, hand off with urgency normal and a summary that includes the product and the price they want.$s$, 30),
('objections', 'Objections', 'The customer hesitates: too expensive, needs to think, trust, comparing with others, timing.',
$s$Do not argue and do not repeat the price. Name what they said in a few words, give one concrete reason this is worth it using facts from the catalog or the business knowledge (never invented), and make a small next step easy. Record the objection with update_profile. If they say they will come back, accept it gracefully in one line and leave the door open with something specific.$s$, 40),
('order_details', 'Taking an order', 'The customer says they want to buy, order, or pay, or asks how to proceed.',
$s$Confirm exactly what they are buying (product and price from the catalog). Then hand off with urgency high and a summary of the product, price and anything they told you, unless this business gave you its own order steps in a flow or in this skill. Tell the customer in one line that the team will confirm and finish with them. Never say an order is placed, paid or delivered; you cannot do that.$s$, 50),
('delivery', 'Delivery and location', 'The customer asks about delivery, shipping, pickup, or where the business is.',
$s$Answer only from search_knowledge or a loaded skill. If the business has no stated answer for their area, do not guess: say you will confirm and hand off with a summary. Ask for their area only if it changes the answer.$s$, 60),
('complaints', 'Complaints and upset customers', 'The customer is angry, unhappy with something they bought, or asks for a refund.',
$s$Do not defend the business and do not promise anything. Acknowledge the problem in one calm sentence, then hand off with urgency high and a summary of the problem. Never send product photos or push a sale in this chat.$s$, 70),
('returning_customer', 'Returning customer', 'The customer has bought before or has chatted before and is coming back.',
$s$Use what the profile says about them. Pick up where it stopped instead of starting over. Mention the last thing they were interested in only if the profile or history states it.$s$, 80)
on conflict (key) do nothing;

-- ── 7. Outbox: what the chat AI wants WhatsApp to send ──────────────────────
-- The brain (an edge function) cannot reach the sender, so it writes rows here. The follow-up engine's
-- sender picks them up with the same Evolution connection and send code as follow-ups, in its own lane:
-- its own pacing, its own hourly ceiling, and its own counter (this table). Chat AI messages are never
-- counted in follow_up_queue, so they cannot use up or be held back by the follow-up daily limit or warm-up.
create table if not exists public.chat_ai_outbox (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  conversation_id text not null,
  contact_id bigint not null,
  seq integer not null default 0,
  kind text not null check (kind in ('text', 'image')),
  text text,
  media jsonb,                         -- {url, type, caption, mime_type, file_name}
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  error text,
  whatsapp_message_id text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz
);
create index if not exists idx_chat_ai_outbox_pending on public.chat_ai_outbox (created_at, seq) where status in ('queued', 'sending');
create index if not exists idx_chat_ai_outbox_sent on public.chat_ai_outbox (business_id, sent_at desc) where status = 'sent';
alter table public.chat_ai_outbox enable row level security;

-- ── 8. AI prices for the models the chat AI uses ────────────────────────────
-- bill_ai_usage prices every call from ai_model_prices (unknown models fall back to 'default'). Seeded here so the
-- chat AI is billed at the right rate from the first message. Verify against https://openai.com/api/pricing and edit
-- in admin if they differ. Skipped silently if the billing tables have not been created yet.
do $$
begin
  if to_regclass('public.ai_model_prices') is not null then
    insert into public.ai_model_prices (model, input_per_1m_usd, cached_input_per_1m_usd, output_per_1m_usd) values
      ('gpt-5-mini',             0.25,  0.025, 2.00),
      ('gpt-5-nano',             0.05,  0.005, 0.40),
      ('text-embedding-3-small', 0.02,  0.02,  0.00)
    on conflict (model) do nothing;
  end if;
end $$;
