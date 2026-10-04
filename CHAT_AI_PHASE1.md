# Chat AI, phase 1 (foundation)

Built on top of your latest pushed `main`. Nothing here replies to customers yet. There is no AI brain until phase 2.

## Files
| Folder | File | Action |
|---|---|---|
| supabase/migrations | 20261004000000_chat_ai_foundation.sql | NEW, run it in the Supabase SQL editor |
| src/chatAi | gates.js, gates.test.js, orchestrator.js, orchestrator.test.js, store.js, index.js | NEW folder |
| src/services | webhookHandler.js | REPLACE (calls the chat AI after a customer message is saved, and stops relabelling AI/follow-up messages as "human") |

## What the migration adds (all inert)
- businesses: chat_ai_enabled (default OFF), chat_ai_daily_cap (default 0), chat_ai_model, chat_ai_human_pause_minutes (default 60), chat_ai_settings
- conversations: handover_at / urgency / source / resolved_at, plus a reply lock
- chat_ai_daily_chats table + chat_ai_claim_slot() for the daily cap (counted in the business's own timezone)
- chat_ai_acquire_lock() / chat_ai_release_lock(): one AI turn per chat at a time
- chat_ai_turns table: the record of what the AI saw, did and said, with columns for the QC reviewer

## The gates (code, not prompt)
Reply only if: the message is customer text, under 10 minutes old, not a group; the business switch is ON, the subscription is active and the daily cap is above 0; the chat is not paused or handed off; it is not a personal chat, vendor, staff or junk contact; the owner has not replied in the last 60 minutes; no other AI turn is running in that chat; and the daily cap has room (a chat already served today always continues).

## Tests
`node --test --test-force-exit src/chatAi/gates.test.js src/chatAi/orchestrator.test.js` (14 tests)
