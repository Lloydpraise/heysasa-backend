# Home summary (backend)

Built on top of `4bd527d` ("updates", Oct 16). Extract the zip into the repo root (heysasa-backend). No migration needed.

| Folder | File | Action |
|---|---|---|
| src/setup | homeRoutes.js | **REPLACE** (only `GET /home/summary` and one import changed) |
| src/setup | homeSummary.js | NEW |
| src/setup | homeSummary.test.js | NEW |

`GET /home/summary` keeps its four old fields (`sent_24h`, `ready_to_buy`, `waiting_messages`, `waiting_plans`) and adds:
- `live`: `followups_on`, `chat_on`, `persona_ready`, `queued_now`, `next_send_at`, `chat_replies_24h`, `chat_chats_24h`, `new_leads_24h`, `handoffs_open`, `balance_kes`, `messages_left` (about 2 messages per KES, rounded down)
- `opportunities`: `ad_leads_untouched`, `waiting_for_reply` (12h+), `dormant_leads` (intent 40+, no message for 14 days), `products_without_price`

A failed count becomes 0, so one slow query never breaks Home. Same signed-in-owner check as before.

## Checked
`node --test src/setup/homeSummary.test.js`: 5 pass. Syntax check passes. Against the full suite, 4 tests in `followup-engine/test` fail both with and without this change (campaignSchedulerBatch, chatAiOutbox, followupAi, sendTarget), so they were already failing in the latest code.
NOT done: calling the endpoint against your real database.
