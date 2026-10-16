# Slice 7 (backend): chat AI starts with skills, follow-up AI wakes when setup ends, follow-up AI can ask for a stage move

Goes on top of slices 1 to 6. Run the migration in Supabase, then restart the backend AND the follow-up engine. Extract the zip into the repo root.

| Folder | File | Action |
|---|---|---|
| supabase/migrations | 20261015000000_setup_realtime.sql | NEW (run in Supabase first) |
| src/setup | chatAiSkills.js | NEW |
| src/setup | slice7.test.js | NEW |
| src/setup | setupOrchestrator.js | REPLACE (one added block after bundle 1) |
| src/setup | setupDeps.js | REPLACE (imports and exposes the skill seeder) |
| src | aiPromptCatalog.js | REPLACE (director prompt gets two optional fields) |
| followup-engine/src/followupAi | setupWatch.js | NEW |
| followup-engine/src/followupAi | stageAsk.js | NEW |
| followup-engine/src/followupAi | decision.js | REPLACE |
| followup-engine/src/followupAi | workerFlow.js | REPLACE |
| followup-engine/src/scheduler | run.js | REPLACE |
| followup-engine/test | slice7.test.js | NEW |

## 1. The chat AI starts with its skills
The chat AI only reads a business's OWN skill rows (`chat_ai_skills`). A new business had none, so the AI had nothing to load until someone copied the library across. Now, when bundle 1 finishes, setup copies the shared library (`chat_ai_default_skills`: first reply, product enquiry, price questions, objections, taking an order, delivery, complaints, returning customer) into the business.
- Free: no AI call, no wallet cost. It is a copy, not AI-written skills.
- Never touches a skill the owner already has, edited, or switched off (a key that exists is skipped). Safe to run twice.
- A failure here never fails setup (it is logged as `setup.chat_skills_failed`).

## 2. The follow-up AI wakes when setup ends
Before, switching follow-ups on started the ad intake (slice 4), but nothing started it when setup reached "Home is ready" or "done". A business that switched follow-ups on while its chats were still being checked waited for the next 5-minute check. Now the engine watches `business_setup` and runs the ad intake 2 seconds after status becomes `home_ready` and again at `done` (once each per business).
- Needs the migration (it adds `business_setup` to the realtime feed) and an engine restart.
- If the realtime feed is missing, nothing breaks: the 5-minute check still runs as before.

## 3. The follow-up AI can ask for a stage move
The pre-send director may now add two optional fields, `stage` and `stage_reason`, when the customer's own words show they moved on (chose a product, asked how to pay, agreed the price). The ask goes into `lead_stage_requests` as actor `followup_ai`. The same worker as the chat AI checks it: shops up to `awaiting_payment`, services up to `committed`, a reason is required, billed once per lead and stage, audited in `lead_stage_changes`. The director never writes a stage itself, and a failed ask never blocks a send.
- The business assistant is NOT wired to this. It already changes a lead's state through a preview the owner approves, so a second, stricter path would add nothing.

## Checked
- New tests: 9 in `src/setup/slice7.test.js`, 6 in `followup-engine/test/slice7.test.js`.
- Engine suite: 82 of 82 pass (`cd followup-engine && npm ci`, then `node --test --test-force-exit test/*.test.js src/followupAi/*.test.js src/scheduler/*.test.js`).
- Backend suite: 280 of 281 pass. The one failure ("catalog entries have a system, display name, and built-in prompt" in `src/services/aiPromptConfig.test.js`) fails the same way on the code before this slice.
- NOT run: the SQL migration (no Postgres here), the realtime wake-up against a live Supabase, and a real setup end to end.

## Paste into the plan's build log
Slice 7 (15 Oct 2026), built:
- The chat AI starts with its skills. When bundle 1 finishes, setup copies the starting skill library into the business, free and without touching the owner's own.
- The follow-up AI wakes when setup ends. The engine now hears "Home is ready" and "done" and looks for ads straight away. This closes item 5.
- The follow-up AI can ask for a stage move, through the same safe worker as the chat AI. The business assistant keeps its own owner-approved path.
Still open: real timings from a real setup, and how the AI-written follow-up plans read for a real business.
