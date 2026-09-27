# Persona Pack Generator — install instructions

## Files in this zip

| file | action | goes to |
|---|---|---|
| `generate-persona-pack.js` | **NEW** — add this file | repo root, same level as `run-local.js` |
| `src/personaRoutes.js` | **NEW** — add this file | `src/personaRoutes.js` |
| `INDEX_JS_PATCH.md` | read only, not a code file | — |

No database migration needed — `persona_packs`, `enrichment_runs`, `enrichment_errors`, `ai_usage_log`, and `businesses.persona_pack_status` all already exist and are reused as-is.

## 1. Add the two new files
Copy `generate-persona-pack.js` into your repo root (next to `run-local.js`), and `src/personaRoutes.js` into your `src/` folder. Nothing else needs to change in either file — no imports elsewhere reference them yet, which is what step 2 fixes.

## 2. Wire the route into `src/index.js` — one import + one line
Open `src/index.js` and add, near the other imports at the top:

```js
import personaRoutes from './personaRoutes.js';
```

Then, anywhere after `const app = express();` and after `app.use(express.json(...))` (i.e. anywhere alongside your other `app.post(...)`/`app.get(...)` route registrations — right after the `/analysis/start` and `/analysis/status` block is the natural spot since it's the same pattern), add:

```js
app.use(personaRoutes);
```

That's the entire integration. `personaRoutes.js` is self-contained — it imports `supabase` from `./config/supabase.js` and `logEvent` from `./services/debugConsole.js`, both of which already exist, so it plugs into your existing debug console the same way the analyser does.

See `INDEX_JS_PATCH.md` in this zip for the exact two lines with a bit more context if you want to double check placement before saving.

## 3. Environment variables
All already required by `run-local.js`, nothing new to add:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional, defaults to `gpt-4.1-mini`, same as the analyser)

## 4. How it's called

**HTTP** (same shape as `/analysis/start`):
```
POST /persona/generate
Authorization: Bearer <supabase auth jwt>
X-Business-Id: lashesbyshazz
Content-Type: application/json

{ "force": false }
```
`X-Business-Id` is checked first; if you'd rather send it in the body, `{"businessId": "lashesbyshazz"}` works too. The route verifies the token belongs to that business's `owner_email` before spawning anything — same ownership check `/analysis/start` already does.

Status check (same convention):
```
GET /persona/status
Authorization: Bearer <supabase auth jwt>
X-Business-Id: lashesbyshazz
```

**Local/manual run**, no HTTP at all, useful for exactly the local preview you mentioned:
```bash
BUSINESS_ID=lashesbyshazz node generate-persona-pack.js
```
Watch stdout — it logs `@@LOG {...}` lines just like `run-local.js` does, same `area` convention (`area: "persona"` instead of `"analysis"`), so if you've got the debug console open it'll show up there when run through the HTTP route.

## 5. What it actually does, in order
1. Loads the business, flips `persona_pack_status` to `running`.
2. Pulls messages already cleaned by the analyser: `contacts.lead_type = 'business'`, `conversations.is_business_chat = true`, `messages.direction = 'out'`, `agent_role = 'human'`. **This is why it must run after `run-local.js`** — those three fields are what separate signal from noise.
3. If fewer than 150 qualifying messages or 25 conversations exist, it stops there, sets `persona_pack_status` back to `pending` (not `failed` — the DB constraint on that column only allows `pending/running/ready/failed`, and "not enough data yet" isn't a failure, it's a retry-later state), and exits. Nothing gets written to `persona_packs`.
4. Otherwise, evenly samples up to 500 messages across the full time range and mines voice/tone in batches (map), then merges into one `persona` object (reduce).
5. Builds `business_context` from `businesses` + `products` tables directly (facts, not chat-mined), with a light grounding pass over messages just for recurring value-prop phrasing.
6. Builds `objection_playbook` and `customer_profiles` from `conversation_enrichment` (`objection_tags`, `price_objection`, `pre_purchase_questions`, `customer_intent`, `psychology`, `vibe_check`) — reusing what the analyser already wrote instead of re-reading raw transcripts.
7. Builds `sentiment_response_map`, `closing_triggers`, `human_handoff_triggers`.
8. Normalizes the whole thing to the exact shape `PersonaPackEditor.jsx` expects (fills any key an LLM call might have skipped, so the editor never crashes on `undefined`), deactivates the old `persona_packs` row for this business, inserts the new one as `version = old + 1, is_active = true`, and sets `persona_pack_status = 'ready'`.

## 6. Known thin spots — worth knowing before you look at the output
- **`closing_triggers`**: only ~5 conversations across the whole DB are currently tagged `Closed`/`Closing` in `conversation_enrichment`. It'll still generate something, but treat it as low-confidence until more closes accumulate.
- **`human_handoff_triggers`**: `handover_flag`/`handover_reason` on `conversations` are 0% populated anywhere right now, so this section is generated from negative-sentiment conversations if any exist, or general best practice if not — not real handoff examples. Revisit once handover data actually exists.
- **Internal-vs-customer-facing filtering isn't applied yet** — the analyser doesn't write a message-level "is this actually a customer reply" flag yet. Once it does, add `.eq('is_internal', false)` to the messages query in `fetchVoiceMessages()` (it's marked with a comment at that exact spot in the file).
- **`business_dna` is deliberately untouched** — confirmed nothing in either repo reads or writes it; it's dead code from an earlier design, superseded by `persona_packs.pack`. Nothing in this generator references it.
- Thresholds (`MIN_VOICE_MESSAGES`, `VOICE_SAMPLE_CAP`, `MAX_OBJECTION_CONVOS`, etc.) are all named constants at the top of `generate-persona-pack.js` — tune them there as real volume grows across more businesses.
