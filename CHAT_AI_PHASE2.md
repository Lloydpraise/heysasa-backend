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
- Sending: brain writes `chat_ai_outbox`; the engine lane (`chatAiOutbox.js`) sends with its own pacing (2–4.5s gap, 150/hour) and its own counter, separate from follow-ups.
- Billing: `bill_ai_usage`, runner `chat_ai`, 8x chat multiplier. Empty balance pauses the AI (heysasa business type is free).
- Handoff: set on the conversation with `handover_summary`.

## Not built yet
QC reviewer AI (turns are logged `qc_status='pending'`), Playground wiring, Chat AI preferences page, skills/flows UI.

## Caveats
Tested with scripted OpenAI + in-memory DB only. OpenAI Responses API shapes were written from knowledge, not run live; Deno entry (`index.ts`) not run here. Reasoning "thoughts" are the API's summary, not raw reasoning.
