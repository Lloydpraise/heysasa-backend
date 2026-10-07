-- Ask HeySasa: the business assistant (phase 1 backend).
--
-- Everything here is written by the Node backend with the service key; the dashboard never writes these tables
-- directly. Owners can READ their own conversations/notes/preferences (RLS below). Platform skills are not readable by
-- owners at all: only their titles are exposed, through the backend.
--
-- Run after the billing v2 migration (it registers the `business_assistant` billing runner).

create extension if not exists vector;

-- ── 1. Conversations: every one is kept ─────────────────────────────────────
create table if not exists public.ba_conversations (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  user_id uuid,
  surface text not null default 'general',          -- campaign_message | auto_campaign_playbook | flow | product_description | general
  context_key text,                                  -- stable key of the box it was opened from, so reopening the same box resumes it
  context jsonb not null default '{}'::jsonb,        -- what the owner was working on (campaign, step, flow...), sanitized
  title text,
  loaded_skills text[] not null default '{}',        -- skills the AI loaded itself (surface skills are loaded by code every turn)
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ba_conversations_biz_updated on public.ba_conversations (business_id, updated_at desc);
create index if not exists idx_ba_conversations_biz_ctx on public.ba_conversations (business_id, context_key, updated_at desc) where context_key is not null;

create table if not exists public.ba_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ba_conversations(id) on delete cascade,
  business_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',                  -- what was said in the chat
  draft jsonb,                                       -- the copy it proposed: {type:'text', text} or {type:'flow', name, goal, instructions, skill_keys}
  approved boolean not null default false,           -- the owner pressed Approve on this draft
  approved_at timestamptz,
  final_text text,                                   -- what actually got pasted, if the owner edited it before approving
  model text,
  usage jsonb,                                       -- {input, cached, output, rounds}
  tools_used text[],
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists idx_ba_messages_convo on public.ba_messages (conversation_id, created_at);

-- ── 2. Notes: the owner's memory ────────────────────────────────────────────
-- Pinned notes (a small, capped set of stable core facts) ride in every prompt. Every note, pinned or not, is
-- embedded so the AI can find it again with the recall_notes tool.
create table if not exists public.ba_notes (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  text text not null check (char_length(text) between 3 and 600),
  pinned boolean not null default false,
  embedding vector(1536),                            -- null when embedding failed; recall falls back to recency
  source text not null default 'ai',                 -- ai | owner
  source_conversation_id uuid,
  use_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ba_notes_business on public.ba_notes (business_id, updated_at desc);

create or replace function public.ba_match_notes(
  p_business_id text, p_embedding vector(1536), p_count integer default 6, p_threshold double precision default 0.3
) returns table (id uuid, text text, pinned boolean, similarity double precision, updated_at timestamptz)
language sql stable as $$
  select n.id, n.text, n.pinned, 1 - (n.embedding <=> p_embedding) as similarity, n.updated_at
  from public.ba_notes n
  where n.business_id = p_business_id
    and n.embedding is not null
    and 1 - (n.embedding <=> p_embedding) > p_threshold
  order by n.embedding <=> p_embedding
  limit greatest(1, least(p_count, 20));
$$;

-- ── 3. Owner preferences for Ask HeySasa ────────────────────────────────────
create table if not exists public.ba_preferences (
  business_id text primary key,
  personalization text not null default '' check (char_length(personalization) <= 1500),
  language text not null default 'auto' check (language in ('auto', 'english', 'swahili', 'mixed')),
  emoji_level text not null default 'light' check (emoji_level in ('none', 'light', 'normal')),
  message_length text not null default 'short' check (message_length in ('short', 'medium')),
  updated_at timestamptz not null default now()
);

-- ── 4. Skills ───────────────────────────────────────────────────────────────
-- Platform skills: ours. Edit the rows to change how Ask HeySasa behaves for every business; no deploy needed
-- (cached for 60 seconds). Owners never see the instructions, only the titles.
create table if not exists public.ba_default_skills (
  key text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  title text not null,
  when_to_use text not null,
  instructions text not null,
  sort_order integer not null default 100,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Business-level skills: extra skills for ONE business, added by us for now (no owner UI yet). Keys must not
-- collide with a platform skill key.
create table if not exists public.ba_skills (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  title text not null,
  when_to_use text not null,
  instructions text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, key)
);

-- ── 5. Row-level security: owners read their own; the backend (service key) writes ──
alter table public.ba_conversations enable row level security;
alter table public.ba_messages enable row level security;
alter table public.ba_notes enable row level security;
alter table public.ba_preferences enable row level security;
alter table public.ba_default_skills enable row level security;   -- no policy: service key only
alter table public.ba_skills enable row level security;           -- no policy: service key only

do $$
declare t text;
begin
  foreach t in array array['ba_conversations', 'ba_messages', 'ba_notes', 'ba_preferences'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()))$p$, t || '_owner_read', t);
  end loop;
end $$;

-- ── 6. Billing: its own runner so it shows in /admin and its multiplier can be changed there ──
insert into public.billing_runners (runner_id, label, user_label, multiplier_key) values
  ('business_assistant', 'Ask HeySasa (business assistant)', 'Ask HeySasa', 'ai_multiplier_default')
on conflict (runner_id) do nothing;

do $$
begin
  if to_regclass('public.ai_model_prices') is not null then
    insert into public.ai_model_prices (model, input_per_1m_usd, cached_input_per_1m_usd, output_per_1m_usd) values
      ('gpt-5-mini',             0.25,  0.025, 2.00),
      ('text-embedding-3-small', 0.02,  0.02,  0.00)
    on conflict (model) do nothing;
  end if;
end $$;

-- ── 7. The platform skills (v1). Re-running never overwrites edits you made. ──
insert into public.ba_default_skills (key, title, when_to_use, instructions, sort_order) values

('copywriting', 'Copywriting', 'Writing any WhatsApp message a customer will read.',
$s$A WhatsApp message is a chat, not an email.
- Length: one to three short lines for follow-ups; up to about five for a first message or an announcement. Plain text only: no headings, no bullet lists, no markdown. At most one emoji, and only if the owner's voice uses them.
- Shape: a hook that shows you know their situation or interest, one concrete reason to care, then ONE easy next step. The best next step is a question they can answer in one word or a tap.
- Lead with what the customer gets, not with the business. Specific beats generic: use real details you were given (the product, the size, the area, the price).
- One message, one ask. Never stack two questions.
- Never invent prices, discounts, stock, deadlines, delivery times, guarantees or testimonials. If a needed fact is missing, use a merge field if one exists, or a [bracketed placeholder], and say in your reply what the owner must fill in.
- Urgency must be true. No fake deadlines, no fake scarcity.
- Avoid: "Dear customer", "Kindly", "We are pleased to inform you", ALL CAPS, strings of exclamation marks, begging ("please reply"), and greeting-only openers like "Hello, how can I help you?".
- Keep merge fields exactly as written, for example {{first_name}}.
- The draft block must hold only the message, ready to paste: no quotation marks around it, no label, no explanation inside it.$s$, 10),

('campaign_message_writing', 'Campaign messages', 'Writing or improving messages in a campaign or follow-up sequence, including re-engaging cold leads and broadcasts.',
$s$A campaign is a sequence. Each step has a different job, so never send the same message in new words.
- Step 1 re-opens the conversation softly and refers to what the lead was interested in. Step 2 adds something new: a benefit, proof, a photo, a reason to act. Step 3 makes the decision easy: one clear offer or question. A final step is a polite last call that leaves the door open. If other steps of this campaign are shown, stay consistent with them and do not repeat their content.
- Match the list type. Hot inquiries asked recently: be fast and remove friction. Cold or dormant: no pressure, give a fresh reason to talk. Cart abandoners: name the item and make finishing easy. Post-purchase and repeat buyers: thank them, check they are happy, invite a reorder or a referral. Low intent: value first, no hard sell.
- Voice: this is customer-facing, so write exactly like the business owner, using the PERSONA section: their greeting style, vocabulary, language mix, sentence length and emoji habits. Reuse their real phrases and their objection playbook where it fits. Do not describe the persona, just sound like it.
- Merge fields: use only the ones listed as available. Put {{first_name}} where a person would naturally use a name. Write the sentence so it still reads correctly if a field turns out empty.
- Respect the gap: a message sent a day later can lean on the earlier one; one sent a week later should stand on its own.
- When the owner gives a rough idea, write the draft straight away. Ask a question only if the draft would otherwise be guesswork, and ask only one.$s$, 20),

('message_safety', 'Message safety', 'Any customer-facing message, and always for bulk sends, cold contacts or follow-ups on WhatsApp.',
$s$WhatsApp restricts numbers that look like spam, and customers report pushy messages.
- Avoid spam patterns: "click here", "free", "guaranteed", "100%", "act now", "winner", shortened links, several links, ALL CAPS, long identical blasts. Use at most one link, and only one the owner gave you.
- Never write claims that are misleading or that the owner has not confirmed: miracle results, health or income promises, fake testimonials, fake scarcity, "everyone is buying".
- Do not imply the customer already agreed to something they did not.
- For messages to cold or dormant contacts, a light opt-out line is good practice, for example "Reply STOP if you would rather not hear from us." Include it in the first message of a cold sequence, not in every step.
- Never include another customer's personal details.
- If the owner asks for something risky (fake urgency, invented reviews), do not write that part. Say so in one sentence and offer an honest version that still works.$s$, 30),

('swahili_sheng_register', 'Swahili, Sheng and Kenyan English', 'The message should be in Swahili, Sheng or a Kenyan English-Swahili mix, or the owner asks to translate or localise.',
$s$- Match the audience. Nairobi retail customers often read an English and Swahili mix. Use more formal Swahili for older or professional customers. Use Sheng only when the owner's own voice uses it and the audience is young, and never force it.
- Write the way people actually text, not a literal translation of English. Prefer simple, common words. If you are not sure a phrase sounds natural, choose simpler Swahili or plain English instead of risking an awkward line.
- Keep product names, sizes and prices as customers see them, and use the business currency format already in use (for example Ksh 2,500).
- When the owner writes to you in Swahili, reply to them in Swahili.
- For an important send in a language you are not fully sure of, tell the owner in one short sentence to have a native speaker glance at it.$s$, 40),

('offers_and_promotions', 'Offers and promotions', 'Writing a promo, discount, restock, new arrival or limited offer announcement.',
$s$You need five facts: what is on offer, the price or discount, who it is for, the real deadline (if any) and how to claim it. If any is missing, ask for it in ONE message (at most three items), or draft with [placeholders] and list what to fill in. Never invent any of them.
- Structure: what it is and the benefit in the first two lines, then the price or saving, then the real deadline, then one next step such as "Reply YES and I will reserve yours".
- One concrete offer per message. Do not stack discounts, bonuses and deadlines.
- For a restock, name the product that is back. For a new arrival, say who it suits.
- If the owner wants variants for different groups (new leads, past buyers), write each as its own draft only when asked.$s$, 50),

('objection_replies', 'Handling objections', 'Writing a reply or a follow-up angle for an objection: too expensive, need to think, trust, comparing options, timing.',
$s$- Acknowledge the objection in a few words. Do not argue and do not repeat the price.
- Give one concrete reason, from facts the owner told you or the catalog, never invented.
- Too expensive: do not offer a discount the owner did not authorise. Offer what the price includes, or a cheaper option from the catalog.
- Need to think: make coming back easy ("I will check in on Thursday") rather than pushing.
- Trust: use proof the owner really has (reviews, photos of past work, location, years in business). If you do not have any, ask the owner for it instead of making it up.
- Comparing: say what is different about this business, calmly, without naming or criticising competitors.
- End with a small next step. If the PERSONA section includes an objection playbook, follow it.$s$, 60),

('flow_instructions_writing', 'Chat AI flows', 'Writing or improving a chat AI flow: the instructions that tell the WhatsApp sales AI how to handle one kind of customer.',
$s$A flow has a name, a goal, instructions and optional skills. The chat AI reads the instructions at every turn of a conversation, so you write for the AI, not for customers.
- Goal: one measurable sentence, for example "Get the customer to confirm the product and send their delivery location."
- Instructions: short imperative steps in order, with conditions ("If they ask the price, ..."). Cover: what to find out first (at most two or three questions), when to show products, when to hand off to the owner (payment claimed, custom request, upset customer), what never to promise, and one line on tone. Under about 250 words.
- Tell it to take facts from the catalog and loaded skills. Never paste prices or stock into instructions; they change.
- Do not rewrite the business voice; the chat AI already has the persona.
- The draft block for a flow has these tags: <name>, <goal>, <instructions> and <skills> (comma-separated keys chosen only from the available skills in the context, or empty).
- If you do not know which customers this flow is for or what counts as success, ask both in one message. If this is the owner's first flow, ask that one question, then propose a sensible flow rather than asking more.$s$, 70),

('auto_campaign_playbook', 'Auto-campaign playbooks', 'Writing or improving the "how to follow up" playbook for an auto-campaign (hot, cold, abandoned cart, repeat buyer, low intent).',
$s$A playbook guides the AI that writes follow-up messages for one kind of lead. It is read by the AI, not by customers.
- Describe the approach in under 150 words: the situation of this lead type, the angle to take, the tone, what to reference from the earlier chat, and when to stop pushing.
- Use short dos and don'ts. Include at least two things never to say and one concrete example of a good opening line.
- Fit the lead type. Hot: speed and a single clear next step. Cold: warmth, no guilt, a fresh reason to talk. Abandoned cart: the exact item and an easy way to finish. Repeat buyer: gratitude and a relevant reorder. Low intent: useful information, no pressure.
- Keep it general enough to work for every lead of that type; do not mention one product or one price.$s$, 80),

('product_description_writing', 'Product descriptions', 'Writing or improving a product title or description for the catalog.',
$s$- Title: the plain name a customer would search for, with the one or two details that tell variants apart (type, colour, size, material). No clickbait, no ALL CAPS.
- Short description: one or two lines. What it is, the main benefit, and the key detail (size, material, use). Only facts you were given; never invent specs, materials, sizes or claims.
- If sizes, colours or variants were given, include them. If something important is missing (size, material), ask for it in one message.
- Customer-facing, so follow the PERSONA section for tone, without making the description chatty.$s$, 90),

('owner_discovery', 'Learning your business', 'The owner is describing their business, asks for advice, is unsure what to write, or the saved notes about the business are thin.',
$s$Your goal is to understand the owner's business well enough to help without being told twice.
- If they want a draft, give the draft first and ask afterwards. Do not make them answer questions before getting help.
- Ask short, concrete questions, one at a time: what sells best, who usually buys, why customers choose them over others, what customers usually ask or object to, where they deliver, price range, how they like to sound.
- When the owner tells you something durable, save it with save_note. Pin it only if it is a core, stable fact: what they sell, who buys, their tone, a standing rule. Keep each note to one fact in plain words.
- Never save guesses, passwords, payment details, or personal details of their customers.
- Reflect back what you understood in one sentence now and then, so they can correct you.$s$, 100)

on conflict (key) do nothing;

-- ── 8. Small helper: count and date every note the AI reads back ────────────
create or replace function public.ba_touch_notes(p_ids uuid[]) returns void
language sql as $$
  update public.ba_notes set use_count = use_count + 1, last_used_at = now() where id = any(p_ids);
$$;
