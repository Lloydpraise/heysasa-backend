# HeySasa analyser v3

Extract this zip straight into the repo root (heysasa-backend). Every file lands in its correct folder and replaces the old copy where one exists.

| File | Action |
|---|---|
| run-local.js | REPLACE |
| src/leadClassification.js | REPLACE |
| src/aiPromptCatalog.js | REPLACE |
| src/leadClassification.test.js | REPLACE |
| src/services/webhookHandler.js | REPLACE (live code: redeploy the backend) |
| supabase/migrations/20261001000000_analyser_roles.sql | NEW (run in Supabase BEFORE the analyser) |
| supabase/migrations/20261002000000_repair_contact_names.sql | NEW (optional, run once; check its owner_names list first) |
| supabase/audit/analyser_invariants.sql | REPLACE (set the business id on the params line) |
| supabase/audit/kitchenandall_regression.sql | NEW |
| supabase/audit/vvstudios_regression.sql | NEW |

## Order
1. Run 20261001000000_analyser_roles.sql in the Supabase SQL editor.
2. Extract the zip into the repo root and redeploy.
3. `node --test src/leadClassification.test.js` (44 tests pass).
4. Run the analyser per business, then the matching regression file and analyser_invariants.sql.
