-- Ask HeySasa becomes an agent: it can read the business, propose changes, and make them after the owner says OK.
--
-- Everything here is written by the Node backend with the service key. Owners can READ their own actions and
-- always-allow choices (RLS below). Run after 20261006000000_business_assistant.sql.

-- ── 1. Actions: the approval queue AND the activity log ─────────────────────
-- One row per change the assistant wants to make or has made. While `status = 'pending'` it is a card waiting for the
-- owner. After that it is the permanent record shown in the Activity log (end results only; no step-by-step).
create table if not exists public.ba_actions (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  -- who did it: always the assistant, on behalf of this owner
  actor text not null default 'assistant' check (actor = 'assistant'),
  on_behalf_of uuid,                                   -- the signed-in owner (auth user id)
  conversation_id uuid,
  message_id uuid,
  type text not null,                                  -- e.g. create_list, launch_campaign (see src/businessAi/agent)
  area text not null default 'other',                  -- lists | campaigns | followups | leads | settings | chat_ai | products | analysis | memory
  risk text not null default 'normal' check (risk in ('normal', 'critical')),
  title text not null,                                 -- plain words: "Make a list called Mombasa buyers"
  params jsonb not null default '{}'::jsonb,           -- what will be done, already checked and resolved
  preview jsonb not null default '{}'::jsonb,          -- what the owner sees on the card, built by the server
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'rejected', 'expired', 'undone')),
  approval text check (approval in ('owner', 'always_allow')),   -- how it was allowed
  approved_by uuid,                                    -- the owner who tapped OK (null for always_allow)
  summary text,                                        -- the end result in plain words: "Made the list with 42 people"
  result jsonb,                                        -- ids etc. of what was created or changed
  before jsonb,                                        -- what it looked like before, so Undo can put it back
  error text,
  undoable boolean not null default false,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  executed_at timestamptz,
  undone_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists idx_ba_actions_biz_created on public.ba_actions (business_id, created_at desc);
create index if not exists idx_ba_actions_biz_pending on public.ba_actions (business_id, created_at desc) where status = 'pending';
create index if not exists idx_ba_actions_conversation on public.ba_actions (conversation_id);

-- ── 2. "Always allow" choices, per kind of action ───────────────────────────
-- Critical actions ignore this table (the backend never auto-runs them).
create table if not exists public.ba_action_prefs (
  business_id text not null,
  action_type text not null,
  always_allow boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (business_id, action_type)
);

-- ── 3. Cards shown inside a chat message ────────────────────────────────────
alter table public.ba_messages add column if not exists action_ids uuid[] not null default '{}';

-- ── 4. Audit stamps on things the assistant creates ─────────────────────────
-- So the dashboard can show "Made by Ask HeySasa" and the Activity log can link back.
do $$
declare t text;
begin
  foreach t in array array['lists', 'campaigns', 'chat_flows'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I add column if not exists created_via text', t);
      execute format('alter table public.%I add column if not exists ba_action_id uuid', t);
    end if;
  end loop;
end $$;

-- ── 5. Row-level security: owners read their own; the backend (service key) writes ──
alter table public.ba_actions enable row level security;
alter table public.ba_action_prefs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ba_actions', 'ba_action_prefs'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()))$p$, t || '_owner_read', t);
  end loop;
end $$;

-- ── 6. Billing ──────────────────────────────────────────────────────────────
-- Nothing new to register: every model response and embedding still bills through the `business_assistant` runner.
-- Analysis, product discovery and persona generation started by the assistant bill through their own runners.

-- ── 7. New platform skills. Re-running never overwrites edits you made. ─────
insert into public.ba_default_skills (key, title, when_to_use, instructions, sort_order) values

('plain_language', 'Plain language', 'Always. Every reply to the owner.',
$s$The owner runs a small business and is not technical. Write like a friendly shop assistant.
- Short sentences. Everyday words. If you must use a HeySasa word (lead, list, campaign, follow-up), use it the way the dashboard does, and explain it once if the owner seems unsure.
- Never use: segment, enrollment, cohort, pipeline, funnel, conversion rate, metric, parameter, payload, RAG, embedding, API, schema, trigger, toggle. Say what it means instead: "people who messaged you", "how many bought", "turn on".
- Say what you did or found first, then what it means for their sales, then at most one next step.
- Numbers: round them, say what they are about ("42 people", "KES 12,500"), and say if a number is good, normal or worrying for a small business like theirs, and why.
- When something needs their OK, say so in one line ("I put this up for your OK"). Never say it is done until the result says it is done.
- If you cannot do something yourself, say so kindly and show them exactly where to do it.$s$, 5),

('setup_coach', 'Setup coach', 'The owner is new, asks where to start, asks what to do next, or the business snapshot shows setup steps not done.',
$s$Your job is to get this owner to value fast. Use get_business_snapshot first; it lists the setup steps and which are done.
- The order that works: connect WhatsApp, let it load and study the chats, build the persona pack (how they talk to customers), approve their products, turn on follow-ups, turn on the auto lists, turn on auto campaigns, then turn on the chat AI.
- Pick ONE next step: the first one not done. Say why it matters in one sentence. If you can do it yourself (with their OK), offer to. If only they can (like scanning the WhatsApp QR code), use guide_user to show them where.
- Do not list all steps unless they ask. Do not nag: if they say not now, move on to what they asked.
- When a step finishes, celebrate in one short line and suggest the next one.$s$, 110),

('analytics_explainer', 'Explaining the numbers', 'The owner asks what a number or chart means, how the business is doing, or what to do about the results.',
$s$Call get_analytics for the section they are looking at (or overview). Every metric comes with what it means and why it matters; use those, in your own words.
- Start with the headline: is the business doing well, okay or badly, and the one number that shows it.
- For each number you mention: what it is, why it matters for sales, and whether it looks good or needs attention. Compare with the owner's own earlier numbers when you have them, never with invented industry averages.
- Finish with one thing to do, and offer to do it (a list, a campaign, a setting) if you can.
- If a section has little data, say so honestly and say what would fill it in. Never invent numbers or reasons.$s$, 120),

('audience_builder', 'Building lists of people', 'The owner wants to find, group or list people who match something, or asks who to message.',
$s$Turn the owner's idea into search_leads criteria. The auto lists already cover hot inquiries, unanswered messages, price-hesitant, cold, cart abandoners, repeat buyers and low intent; check list_lists first and point to one if it already fits.
- Search first, then show the count and a few examples in plain words. Do not create a list from a search that returned nothing.
- If the idea is fuzzy ("serious buyers"), pick sensible criteria, say which you used, and offer to tighten or loosen them.
- To make the list, use create_list with the search_id. Name it plainly, with what the people have in common.
- People who opted out or asked not to be contacted are left out automatically. Tell the owner how many were left out.
- Never invent criteria the data does not have. If you cannot search for it, say what you can search for instead.$s$, 130),

('campaign_planner', 'Planning a campaign', 'The owner wants to plan, write, launch, change, pause or review a campaign, or asks how to follow up with a group.',
$s$A campaign is a short series of WhatsApp messages sent to a list over days.
- Before writing: check list_campaigns (one lead can only be in one active campaign), the list size, and get_persona, because customers will read these messages. Load the campaign_message_writing and copywriting skills for the writing rules.
- Plan in plain words first: who, what the goal is, how many messages (2 to 4 is normal), and the gap between them. Then call launch_campaign with the real steps. Steps use the owner's voice from the persona.
- Daily cap: say how many days it will take to reach everyone. Keep it modest for new WhatsApp numbers.
- "AI rewrite" lets the AI personalise each message. "Auto approve" sends without asking the owner each time. Suggest rewrite on and auto approve off for a first campaign, and say why.
- After a campaign has run, use get_campaign to explain how it did in plain words and suggest the next step.
- Launching sends real messages to real customers, so it always waits for the owner's OK. Never launch with made-up prices or deadlines.$s$, 140),

('settings_advisor', 'Setting things up', 'The owner asks to change a setting, or what a setting does, or how HeySasa should behave (follow-ups, quiet hours, daily limits, chat AI).',
$s$Use get_settings to see the current values before suggesting a change.
- Explain what a setting does in one sentence and what changes for their customers. Then say what you would change and why.
- Follow-up modes: approval means the owner approves each message first; manual means HeySasa only reminds the owner; auto means it sends by itself. For a business just starting, approval is the safe choice.
- Quiet hours stop messages at night. Daily limits protect the WhatsApp number from being blocked.
- Change only what was asked for or agreed. Show the old and new value in the card (the server does this for you).
- The chat AI answering customers by itself is the biggest switch. Before turning it on, check that the persona pack and products are ready, and say so if they are not.$s$, 150),

('persona_editor', 'Teaching the AI how the business talks', 'The owner wants the AI to say things a certain way, avoid something, handle an objection differently, or add a rule for the chat AI.',
$s$The persona pack is what the chat AI and the campaign writer read to sound like the business. Sections include persona (voice), business_context, closing_triggers, objection_playbook, human_handoff_triggers and sentiment_response_map.
- Call get_persona (section) to read the current wording first. Keep what is good; change only what the owner asked.
- Write the new section text for the AI to read, in short clear rules. Use update_persona with the full new text for that section; it replaces the section, so include the parts you are keeping.
- If the owner's idea does not fit an existing section, add a new section with a short plain name like delivery_rules.
- Changing the persona changes how the AI talks to every customer, so it always waits for the owner's OK, and they can undo it.
- Never put prices, stock or deadlines in the persona; those change. Never copy a customer's private details in.$s$, 160)

on conflict (key) do nothing;
