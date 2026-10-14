# Setup slice 2: switches, grouped approvals, "set up is done" message

Goes on top of slice 1 (already in the repo as "home patch 1"). No migration needed. Extract into the repo root or `git apply heysasa-backend-slice-2.patch`.

New: src/setup/defaults.js, switches.js, homeApprovals.js, homeRoutes.js, readyNotifier.js, readyNotifierRuntime.js, auth.js, slice2.test.js
Changed: src/index.js (mounts /home and /setup/defaults and /setup/switches, starts the ready-message timer), src/setup/setupRoutes.js (shared owner check, "ready to buy" counter), setupStatus.js, setupDeps.js (newest chat = contacts.last_inbound_at), answers.js (`finished` flag)

Routes: GET /setup/defaults · POST /setup/switches · GET /home/approvals · POST /home/approvals/messages/approve · GET /home/summary
Test: `node --test src/setup/setup.test.js src/setup/slice2.test.js` (22 pass).
Same notes and open points as before: tested on a fake database only; switching follow-ups on lets the follow-up AI start writing (costs money); hours and hand-off answers are saved in chat_ai_settings and the chat brain must read them.
