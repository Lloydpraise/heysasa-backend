# HeySasa chat AI – phase 2 (the brain: `sasa-brain`)

## Deploy order
1. Run `supabase/migrations/20261004010000_chat_ai_brain.sql` (after the products, foundation and billing migrations).
   It also seeds prices for gpt-5-mini, gpt-5-nano, text-embedding-3-small into `ai_model_prices` — VERIFY them against OpenAI pricing.
2. `supabase functions deploy sasa-brain` (needs OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in function secrets; optional SASA_TOOL_SECRET for http tools).
3. Restart the backend and the follow-up engine (the engine now runs a second 1s loop that sends `chat_ai_outbox`).
4. Nothing replies until a business has `chat_ai_enabled = true` AND `chat_ai_daily_cap > 0`.

The function handles browser CORS preflight requests, but its service-role authentication is intended for server-to-server calls. Never put the service-role key in browser code; have the browser call your backend instead.

## First live check
Call `sasa-brain` with `{business_id, simulate:true, message:"hi how much is the volume set"}` (service key as Bearer).
You get reply, thoughts, steps, skills loaded, usage. Nothing is sent. Do this before enabling any business.

## How things work
- Tools: rows in `chat_ai_tools` (kind builtin | rpc | http, phase lookup | write | send). A business row overrides a global one of the same name.
  New rpc/http tool = insert a row, no deploy; it shows in the prompt next turn. A coded builtin needs a handler in `core/builtin.ts` + redeploy.
- Skills: `chat_ai_default_skills` (library) → copy into `chat_ai_skills` per business. The AI has `load_skill`.
- Flows: `chat_flows` (trigger `{ad_ids, list_ids}`, goal, instructions, `skill_keys`). Chosen by code, loaded up front, remembered on the conversation.
- Sending: brain writes `chat_ai_outbox`; the engine lane (`chatAiOutbox.js`) sends with its own pacing (2–4.5s gap between different customers, 0.6–1.3s between messages in the same chat, 150/hour) and its own counter, separate from follow-ups.
- Billing: `bill_ai_usage`, runner `chat_ai`, 8x chat multiplier. Empty balance pauses the AI (heysasa business type is free).
- Handoff: set on the conversation with `handover_summary`.

## Not built yet
QC reviewer AI (turns are logged `qc_status='pending'`), Playground wiring, Chat AI preferences page, skills/flows UI.

## Caveats
Tested with scripted OpenAI + in-memory DB only. OpenAI Responses API shapes were written from knowledge, not run live; Deno entry (`index.ts`) not run here. Reasoning "thoughts" are the API's summary, not raw reasoning.

## Speed (what makes a reply slow, and what was done)
A reply is: wait for the customer to finish typing -> read context -> a few model calls -> send photos -> send the message.
- **Photos are sent while the AI writes.** `send_products` queues the photos and returns at once; the reply is held back only until they have landed (and if one failed, the AI writes the reply again knowing which, and can retry). The AI still never claims a customer saw something they did not.
- **Waiting for a burst** (`settle_ms`, default 3000) now counts from the customer's newest message instead of starting fresh, and stretches (up to twice) only while they keep writing.
- **Reasoning effort defaults to `low`** (`chat_ai_settings.effort`: `low` | `medium` | `high`). Raise it per business if replies need more thinking. Reasoning models only; any other model is sent no reasoning setting.
- **Business-level data is cached for 30 seconds** in a warm function (persona, skills, tools, flows) and **product categories for 5 minutes**. The Playground never uses the cache. The customer, conversation and history are always read fresh.
- **Billing no longer blocks a model call.** It is still finished before the turn is logged, so `cost_usd` stays complete.
- **Sender lane:** one lane per business, running side by side; messages in the same chat go out 0.6-1.3 s apart (typing time still applies), a different customer waits the usual 2-4.5 s. Poll every 0.5 s. Env: `CHAT_AI_POLL_INTERVAL_MS`, `CHAT_AI_SAME_CHAT_GAP_MS`, `CHAT_AI_SAME_CHAT_JITTER_MS`, `CHAT_AI_MIN_GAP_MS`, `CHAT_AI_GAP_JITTER_MS`.

## Token use and prompt caching
- Prompt order is: tools, instructions, flow and skills, chat history, customer file, clock. Everything that changes goes last, so a changed profile or a new minute never invalidates the history.
- The cache key is `sasa:<business_id>`. OpenAI advises about 15 requests a minute per key; a business doing more than ~5 live chats a minute may see cache misses (watch `cache_hit_pct` below).
- `prompt_cache_retention` is NOT set: gpt-5-mini is not on OpenAI's list of models that accept `24h`, and an unsupported value can be rejected.
- Keep the persona pack short. Each persona section is capped at 3000 characters, so a full pack can add about 4,500 tokens to every turn. Anything long or situational belongs in a skill, which is only loaded when needed.

## Watching it
Every live turn saves where its time went in `chat_ai_turns.input -> 'timings'`: `prep_ms` (wallet + settings), `settle_ms` (waiting for a burst), `context_ms`, `delivery_wait_ms` (time spent only waiting for photos). Total is `duration_ms`.

```sql
select date_trunc('day', created_at) as day, count(*) as turns,
  round(percentile_cont(0.5) within group (order by duration_ms) / 1000.0, 1) as p50_s,
  round(percentile_cont(0.9) within group (order by duration_ms) / 1000.0, 1) as p90_s,
  round(100.0 * sum(tokens_cached) / nullif(sum(tokens_in), 0)) as cache_hit_pct,
  round(avg(tokens_in)) as avg_in, round(avg(tokens_out)) as avg_out,
  round(avg((input -> 'timings' ->> 'settle_ms')::numeric)) as avg_settle_ms,
  round(avg((input -> 'timings' ->> 'delivery_wait_ms')::numeric)) as avg_delivery_wait_ms
from public.chat_ai_turns
where mode = 'live' and status in ('replied', 'handoff')
group by 1 order by 1 desc limit 14;
```
