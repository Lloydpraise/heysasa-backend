# Debug console — merge instructions

This zip mirrors your `heysasa-backend` repo layout. Copy it straight over your
local clone, on a fresh branch, then review the diff.

## 1. Merge

```bash
cd /path/to/heysasa-backend
git checkout -b debug-console
cp -r /path/to/unzipped/heysasa-backend/* .
git status        # confirm only the 17 files below changed
git diff          # read through it before running anything
```

Files touched (2 new top-level areas, rest are edits):

```
NEW    src/middleware/debugAuth.js
NEW    src/services/alerts.js
NEW    followup-engine/src/lib/log.js
NEW    supabase/migrations/20260922000000_add_system_logs.sql
EDIT   src/services/debugConsole.js   (full rewrite)
EDIT   src/config/supabase.js
EDIT   src/index.js
EDIT   src/services/dbService.js
EDIT   run-local.js
EDIT   public/debug.html             (full rewrite)
EDIT   followup-engine/src/lib/ai.js
EDIT   followup-engine/src/scheduler/worker.js
EDIT   followup-engine/src/scheduler/run.js
EDIT   followup-engine/src/sender-baileys/worker.js
EDIT   followup-engine/src/sender-baileys/postSend.js
EDIT   followup-engine/src/sender-baileys/run.js
EDIT   followup-engine/src/api/server.js
```

## 2. New environment variables

Add to your `.env` (both locally and on the server):

```
DEBUG_TOKEN=pick-a-long-random-string-here
```

Without it, every `/debug/*` route and the two `/instance/*` routes return
503/401 — that's intentional, not a bug.

Optional, for the WhatsApp alert feature (safe to skip for now — it just logs
a warning at boot and does nothing if unset):

```
LLOYD_PHONE=2547XXXXXXXX
PLATFORM_EVOLUTION_INSTANCE=your-dedicated-heysasa-instance-name
```

## 3. Database migration

The migration is already applied to your live Supabase project (VVStudios) —
I ran it directly so the console has somewhere to write to. You still want
the file in git so it's tracked: it's included at
`supabase/migrations/20260922000000_add_system_logs.sql`. If you ever rebuild
a Supabase project from migrations, this one's a no-op the second time
(`create table if not exists`).

## 4. Install and run locally

```bash
npm install
cd followup-engine && npm install && cd ..
node src/index.js
```

Open `http://localhost:3000/debug.html`, enter your `DEBUG_TOKEN`. You should
see the Live tab connect (green dot, "live"), a `system.boot` event, and a
heartbeat every 60s. The Evolution/queue cards will show errors until your
real `EVOLUTION_URL`/Supabase credentials are in `.env` — that's expected
against dummy config.

## 5. What to click through before trusting it

- **Live tab**: send yourself a WhatsApp test message on a connected number,
  confirm a `webhook` → `ingest` event pair shows up within a couple seconds
  with the right `business_id`.
- **Queue tab**: hit Refresh, confirm the status/skip-reason tables populate
  from real data (this reads your actual `follow_up_queue` table).
- **Businesses tab**: confirm your businesses list, don't click into one
  unless you actually want to kick off a full analysis run.
- **History tab**: search with no filters — should return whatever's landed
  in `system_logs` since you started the server.
- **Actions tab → Check connection**: confirms Evolution reachability from
  the server's perspective, useful once this is deployed.

## 6. Push once satisfied

```bash
git add -A
git commit -m "Add live debug console: logging core, password gate, new UI"
git push origin debug-console
```

Deploy between 21:00–08:00 as usual since it restarts the process (your
`.github/workflows/deploy.yml` already installs both `package.json`s? check —
if it only runs `npm install` at the repo root, add a `cd followup-engine &&
npm install` step too, since `followup-engine/src/lib/log.js` is new and
nothing in its own `package.json` changed, but worth confirming the workflow
installs both before you rely on this in production).

## 7. domain (debug.heysasa.co.ke)

Not required for this to work — `/debug.html` is already served at whatever
domain your backend already answers on (e.g. `https://api.heysasa.co.ke/debug.html`).
A dedicated subdomain is a nicety (shorter to type, feels separate from the
API), not a requirement. If you want it: point `debug.heysasa.co.ke` at the
same server/port as your API (an A/CNAME record, then a reverse-proxy
`server_name` block if you're on nginx) — no application code changes needed
either way, since the routes aren't host-specific.

## 8. Known gap, on purpose

The webhook endpoint (`/webhook/evolution`) is **not** locked down in this
delivery — that's a separate, slightly bigger change (needs a secret appended
to every existing instance's registered webhook URL, or it breaks live
messages until each one is re-registered). Flagging it so it isn't mistaken
for done. Same for the Evolution admin key still being in the frontend
bundle — also not in this delivery. Both were in the original plan under
Phase 1 (security) and are next up whenever you want to continue.
