# Ask HeySasa (business assistant) — backend

Node module in `src/businessAi/`, mounted at `/assistant` in `src/index.js`. Frontend: `Lloydpraise/heysasareact` (`src/components/assistant`).

## Deploy
1. Run `supabase/migrations/20261006000000_business_assistant.sql` on the VVStudios project (needs the billing v2 migration first).
2. Deploy the backend (`pm2 restart`). Nothing new in `.env` is required. Optional: `BUSINESS_ASSISTANT_MODEL` (default `gpt-5-mini`), `BUSINESS_ASSISTANT_EFFORT` (default `low`).
3. If you front the API with nginx/Caddy, do not buffer `/assistant/chat` (it sets `X-Accel-Buffering: no`; Caddy needs nothing).

## How it works
- `POST /assistant/chat` streams Server-Sent Events: `conversation`, `status`, `reset`, `reply`, `draft_start`, `done`, `error`.
- Skills: `ba_default_skills` (platform, edit rows to change behaviour, 60s cache) + `ba_skills` (per business, for us to add). Surface decides which load up front (`surfaces.js`); the rest are in the skill menu and loaded with `load_skill`.
- Persona pack is loaded only for customer-facing surfaces (`campaign_message`, `product_description`).
- Memory: pinned notes (<=1500 chars, in every prompt) + vector recall (`recall_notes` tool, and once automatically on the first turn). Near-duplicate notes update instead of adding.
- Billing: runner `business_assistant` (multiplier editable in /admin), billed after every model response and embedding.
- Debugging: the protected live debug console has an `assistant` area. Filter by it to see chat started/completed/failed and assistant warnings/errors; entries include business ID and request metadata, not the chat text. Unexpected chat failures also print their stack to the backend process output (`pm2 logs`).
- Tests: `node --test src/businessAi/*.test.js`.

## Not yet verified live
The OpenAI streaming shapes were written from the Responses API docs and tested against fakes only. First live test: open any campaign message, press the sparkle, send a message, and watch for `reply` events and a draft card.

---

# Ask HeySasa as an agent (added Oct 7 2026)

On the **general** chat (the right sidebar opened from the app, not the little sparkle boxes) Ask HeySasa can now read the business and make changes for the owner. Drafting boxes keep the original 4 safe tools.

## Deploy
1. Run `supabase/migrations/20261007000000_assistant_agent.sql` on the VVStudios project (after `20261006000000_business_assistant.sql`). It adds `ba_actions`, `ba_action_prefs`, `ba_messages.action_ids`, `created_via` / `ba_action_id` on `lists`, `campaigns`, `chat_flows`, and 7 platform skills (`plain_language`, `setup_coach`, `analytics_explainer`, `audience_builder`, `campaign_planner`, `settings_advisor`, `persona_editor`). Re-running is safe.
2. **Recommended** `.env`: `SUPABASE_ANON_KEY=<the project's anon key>`. Auto-campaign activation and config use database functions written for the browser; with this key the backend runs them as the signed-in owner. Without it they run with the service key and may refuse.
3. Deploy the backend (`pm2 restart`). Nothing else is required. `PORT` must be the port the server listens on (it already is): analysis and product discovery are started by calling this server's own routes with the owner's login.
4. Tests: `npm run test:assistant` (104 tests, no network).

## The model of it
- **Read tools** run freely. **Change tools** only *prepare* a card (`ba_actions`, status `pending`). The owner taps Approve and the backend re-checks everything against fresh data before running it, once.
- **Always allow**: per kind of change, chosen on the approve tap or in Activity. **Critical** tools (anything that messages customers, spends balance, or changes how the AI talks) ignore it, enforced in `agent/engine.js`, not in the prompt.
- **Audit trail**: every change is a `ba_actions` row (actor = assistant, on behalf of, approved by / always allow, result, before-snapshot). Things it creates carry `created_via = 'assistant'` and `ba_action_id`. Notes it saves are logged too.
- **Never done by the assistant**: deleting anything, disconnecting WhatsApp, top-ups, one-to-one messages. There is no tool for them (a test asserts this); it uses `guide_user` to show where the owner does it.
- All tools live in `src/businessAi/agent/domains/*.js` and are listed in `agent/registry.js`. Adding a change tool needs: `plan` (validate + preview), `execute` (re-validate + do), optional `undo`, a risk, and an `ACTION_LABELS` entry (the registry refuses to load without it).

## Endpoints (all under `/assistant`, business-scoped)
`GET /actions/pending` · `POST /actions/:id/approve` (`{always_allow}`) · `POST /actions/:id/reject` · `POST /actions/:id/undo` · `GET /activity?before&area&limit` · `GET|PUT /action-prefs`. SSE `/chat` gains events `action`, `action_done`, `guide`; `done` gains `action_ids`.

## Billing
Unchanged and complete: every model round and embedding bills through `business_assistant`; reads are plain database queries; analysis / product discovery started by the assistant bill through their own runners. The agent chat allows up to 8 model rounds per message (was 4).

## Assumptions to check on first live run
- `persona_packs.generated_by = 'ask_heysasa'` (no constraint was visible in the repo).
- `activate_auto_campaign` / `apply_auto_campaign_config` accept `(p_business_id, p_rule_id)` and any "not allowed" comes from `auth.uid()` (hence the anon key).
- `mark_as_bought` mirrors the dashboard (updates `contacts` only), because the dashboard does not write `conversions` itself.
- Analytics "hot" uses `businesses.hot_lead_intent_threshold` (default 7 of 10).


---

# Ask HeySasa upgrade (Oct 14 2026)

## Deploy
1. Run `supabase/migrations/20261014020000_assistant_views_and_skills.sql` on the VVStudios project. It adds the view `v_assistant_leads` (v_lead_summary plus first-seen, awaiting-reply and last in/out times), tightens two platform skills (only if you have not edited them), and adds three skills: `lead_explorer`, `flow_builder`, `chat_skill_builder`. Safe to re-run. Without the view the backend still works from `v_lead_summary`, but cannot see when someone first messaged or whether they are waiting for a reply.
2. `pm2 restart`. No new `.env` values.
3. Tests: `npm run test:assistant` (104, no network).

## Fixed
- **It could not read chats.** `messages.content` is JSON; `get_lead` printed `[object Object]`. Messages now read as text, products and media as `[product: ...]`, `[image]`.
- **"Waiting for your reply"** read a column that does not exist. It now uses `awaiting_reply` (and unread count).
- **Vendors, staff and junk chats** were counted as leads. Only `personal` was left out; now all four non-customer types are, in line with the follow-up engine.
- **do_not_contact** only set `lead_state`, which the senders do not check. It now also sets `contacts.do_not_contact` and the opt-out time and takes the person out of every campaign (same as the opt-out classifier). Undo restores the flags. Someone who asked not to be contacted cannot be moved back by the assistant.
- **edit_product** is now critical (the AI quotes prices). Other product tools stay normal.
- **approve_followups** card shows every message (up to 50), not the first 6.
- **resume_campaign** checks nobody is in another running campaign and says so plainly.
- **Tool schemas** are sent with `strict: false`, so the model is no longer pushed to fill every optional field.
- **Analytics wording**: removed the invented "10 percent is good" benchmark and "for a small business like theirs".
- **Tests**: the clock bug in `integration.test.js` (expiry used the real date against a fixed one) and the hang when it failed.

## New and upgraded tools
Reading: `search_leads` (many more filters, sorting, paging, phone and text search, date ranges), `lead_breakdown` (count a group by state, quality, ad, product, worry, question, competitor, follow-up status, month), `get_lead` (full profile, lists, campaigns, up to 40 messages with paging), `get_campaign_people`, `get_flow`, `get_chat_skill`, and `get_chat_ai_setup` now lists the ads and lists a flow can be pointed at.
Analytics: every section takes a `period` (today, yesterday, this_week, last_week, this_month, last_month, last_7_days, last_30_days) in the business time zone, with the change versus the earlier period (hidden when there is nothing earlier). New sections: `funnel`, `market` (dynamic biggest worry), `health` (plain checks). `ads` shows last lead date and leaves out the unexplained quality score. `timing` adds a month view. `demand` counts people who first messaged in the period.
Changes (all with a card): `create_chat_skill` is new (critical). `save_flow` card names the ads and lists, and `enabled` alone switches a flow on or off.

## Known limits
- A multi-list launch stores only the first list on the campaign row (the table has one `list_id`); the archive and undo guards check that list only.
- Campaign steps carry no media. Funnel stages are the standard ones: the owner cannot yet configure their own.
- The funnel's possible value is an estimate from approved product prices.
- The assistant does not use the new stage mover (`lead_stage_requests`) yet; it sets `lead_state` directly, with a preview.
- Two backend tests outside Ask HeySasa fail on the pushed code too: the aiPromptCatalog catalog test and `debugConsole.test.js`.
