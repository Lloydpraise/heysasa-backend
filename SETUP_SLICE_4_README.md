# Slice 4: follow-up AI starts when switched on, and empty-wallet warnings

Goes on top of slice 2. No migration. Extract into the repo root or `git apply heysasa-backend-slice-4.patch`. The follow-up engine (not just the main backend) must be restarted.

- followup-engine/src/followupAi/switchWatch.js (+ test) and followup-engine/src/scheduler/run.js: when a business switches the Follow-up AI ON, the ad intake runs within about 2 seconds, so plans for the ads already found are written now instead of at the next 5-minute check.
- src/setup/switches.js, homeRoutes.js: `balance_empty` warning when the wallet has nothing (the AI cannot write or answer without balance), `wallet.has_balance` in GET /setup/defaults, and "plan inactive" only when subscription_active is explicitly false (the chat AI and the assistant already read it that way).
- Tests: `node --test src/setup/setup.test.js src/setup/slice2.test.js followup-engine/src/followupAi/switchWatch.test.js` (25 pass).
