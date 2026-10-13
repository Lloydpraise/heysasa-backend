# Setup slice 1: one button, bundles, live status

Extract this zip straight into the repo root (heysasa-backend). Or: `git apply heysasa-setup-slice-1.patch`.

| File | Action |
|---|---|
| supabase/migrations/20261014000000_business_setup.sql | NEW (run in Supabase BEFORE redeploying) |
| src/setup/bundlePlan.js | NEW (splits chats into bundles: newest 100, then 500s) |
| src/setup/setupStatus.js | NEW (what Home shows: percent, plain message, counters) |
| src/setup/setupOrchestrator.js | NEW (the runner) |
| src/setup/setupDeps.js | NEW (real database and analyser calls) |
| src/setup/answers.js | NEW (checks the onboarding answers) |
| src/setup/setupRoutes.js | NEW (the three routes below) |
| src/setup/setup.test.js | NEW (11 tests) |
| run-local.js | REPLACE (2 small edits: a setup bundle may run product discovery, text only) |
| src/services/productDiscoveryRunner.js | REPLACE (1 edit: `textOnly` skips image reading) |
| src/index.js | REPLACE (forwards the two bundle flags, mounts the routes, resumes setups after a restart) |

## What it does
1. `POST /setup/start`: the one button. Waits for WhatsApp history to land (contact count steady for 15 s, never more than 5 min), then runs the analyser on the **newest 100 chats**: sort customers from personal chats, find products from text, analyse. When that bundle ends, `home_ready` is true.
2. In the background: persona pack, product image reading, then the remaining chats in bundles of 500. A persona refresh runs after the last bundle when there was more than one.
3. `GET /setup/status`: percent, a plain-words message, counters (chats, customers, filtered out, analysed, products), `home_ready`, bundle progress, answers, error.
4. `POST /setup/answers`: opening hours, hand-off reasons, and product ticks and crosses (approves or dismisses discovered products).

Edge cases handled: no chats at all (marked `thin`, no failure), another analysis already running (waits and retries), a later bundle failing (Home stays ready), a server restart (setups that went quiet for 3 min resume from the next bundle).

## Check it
1. Run the migration, extract, redeploy.
2. `node --test src/setup/setup.test.js` (11 tests pass).
3. With a test business that has history: `POST /setup/start`, then poll `GET /setup/status`. Watch the live console for area "setup".

## Not in this slice (next)
- Applying the hours and hand-off answers to follow-up and chat AI settings.
- The "Aha! set up is done" WhatsApp message (needs the first follow-up drafts to exist; `ready_message_sent_at` is reserved).
- Switching on the follow-up AI and chat AI with defaults.
- The Home screen in the frontend.

## Decisions I need from you
1. **Newest chat order.** The runner tries `last_inbound_at` on conversations, then contacts, then `last_message_at`, then falls back to newest-created contacts. Tell me the real column and I will remove the guessing.
2. **Counters.** "Ready to buy" is not a counter yet because I did not find the one field that means it. Which field or flag does the Leads screen use?
3. **Cost.** Setup analyses real chats with the AI. Check the wallet rules for a new owner before this goes live to customers.
