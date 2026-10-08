# heysasa-backend: Ask HeySasa agent

Unzip over the repo root (paths are repo-relative), then:

1. Run `supabase/migrations/20261007000000_assistant_agent.sql` on the VVStudios project.
2. Add `SUPABASE_ANON_KEY` to `.env` (recommended, see ASK_HEYSASA.md).
3. `npm run test:assistant` (77 tests) then `pm2 restart`.

Full notes: `ASK_HEYSASA.md`, section "Ask HeySasa as an agent".
