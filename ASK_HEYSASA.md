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
- Tests: `node --test src/businessAi/*.test.js`.

## Not yet verified live
The OpenAI streaming shapes were written from the Responses API docs and tested against fakes only. First live test: open any campaign message, press the sparkle, send a message, and watch for `reply` events and a draft card.
