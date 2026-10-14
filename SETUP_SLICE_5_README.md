# Slice 5: AIs can move a lead's stage, owner rules reach the chat AI, setup timings, optional starter credit

Goes on top of slices 2 and 4. Run the migration in Supabase, restart the follow-up engine, and redeploy the chat brain (`supabase functions deploy sasa-brain`). Extract into the repo root or `git apply heysasa-backend-slice-5.patch`.

## 1. The chat AI can move a lead's stage (safely)
- supabase/migrations/20261014010000_ai_stage_changes.sql: tables lead_stage_requests (the queue) and lead_stage_changes (audit: who, from, to, why), the chat tool `move_lead_stage`, and the realtime hookup.
- followup-engine/src/scheduler/stageRequests.js (+ test) and run.js: the engine checks each request and applies it through the same billing the stage classifier uses (charged once per lead and stage). The AI never writes the stage itself.
- Rules: online shops up to awaiting_payment, services up to committed. paid, fulfilled, completed and later need a real payment or the owner. Moving back is allowed. A reason is required. Personal chats and other businesses' chats are refused. Change the limits in stageRequests.js (AI_CEILING).
- The tool works as soon as the migration has run. Test chat (simulate) does not write anything.

## 2. Owner rules reach the chat AI
- supabase/functions/sasa-brain/core/ownerRules.ts (+ test), prompt.ts, turn.ts, context.ts: the opening hours and hand-off reasons the owner gave during setup (saved in chat_ai_settings) now appear in the chat AI's instructions as "OWNER RULES". Needs a redeploy of sasa-brain.

## 3. Where setup time goes
- setupOrchestrator.js and setupStatus.js: GET /setup/status now returns `timings`: history_wait_ms, each bundle's size and milliseconds, home_ready_ms, total_ms. Run a real setup and read it to see which stage is slow. Stored in business_setup.timings (the migration adds the column).

## 4. Optional starter credit for new owners (OFF)
- src/setup/starterCredit.js + setupDeps.js: set SETUP_STARTER_CREDIT_USD (for example 1) and a new owner whose wallet is empty gets that once when setup starts, using your admin_credit_wallet function. Capped at 50. Unset or 0 means off. Recorded in business_setup.starter_credit_at.

## Checked
- JS: whole backend suite runs; the only failures are the same 2 that failed before my changes (businessAi integration approvals test, aiPromptCatalog catalog test).
- sasa-brain under Node: ownerRules 3/3, core 14/14, turn 24/24, support 19/19. integration.test.ts has 3 failures that are the same on your pushed code.
- NOT run: the SQL migration (no Postgres here), so run it on a copy first. The engine worker is tested with fakes only.

## Not done
- The follow-up AI and the business assistant do not use the stage mover yet (the assistant already sets lead state with a preview). The same worker accepts actor "followup_ai" and "assistant" when you want them wired.
- Chat AI building its own skills at setup.
