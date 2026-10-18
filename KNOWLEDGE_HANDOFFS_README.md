# Knowledge (file search) and Handoffs

## Deploy, in this order
1. Run `supabase/migrations/20261017000000_knowledge_and_handoffs.sql` (SQL editor or `supabase db push`). It creates
   `knowledge_sources`, `knowledge_chunks`, `match_knowledge_chunks()`, `handoff_events`, the private `business-knowledge`
   storage bucket (with owner policies), the `knowledge_analysis` billing runner and the two new chat AI tools. It was
   syntax-checked locally but NOT applied to any database.
2. Backend: `npm install` (adds `mammoth` and `pdf-parse`), then `pm2 restart` the API.
   Optional env: `APP_URL` (link added to handoff WhatsApp alerts) and `PLATFORM_EVOLUTION_INSTANCE` (already used for platform DMs).
3. Redeploy the edge function: `supabase functions deploy sasa-brain`.
4. Restart the follow-up engine (it now reads the same files).
5. Frontend: deploy as usual. No new env vars.

## What it does
- **Knowledge tab** (Playground, persona pack): the owner names a file or note ("what is this?"), says when the AI should use it,
  who uses it (Chat AI, Follow-up AI, or both) and uploads it. The file is saved first, then analysed by type
  (PDF text, scanned PDF and images through vision, voice and video through transcription, Word, plain text),
  cut into pieces and stored as vectors. Billed to the business under runner `knowledge_analysis`.
- **Chat AI**: its instructions list each file with its use case, and it has `file_search` (and `send_knowledge_image` for image files).
  The Playground shows photos and images the AI sends.
- **Follow-up AI**: gets the list of files meant for it, plus the pieces that best match the lead's situation (it has no tool loop).
- **Handoffs** (Handoff & Closing tab): people, cases ("refund goes to Wanjiru"), urgency, default is the owner's number.
  A handoff always shows on Home ("Needs you") and, if on, sends a WhatsApp DM from the HeySasa number
  (`handoff_events` row, sent by the backend within ~8 seconds, 3 tries). "Send test alert" checks the whole path.

## Tests
`npm run test:knowledge` (backend), `node --test followup-engine/test/knowledge.test.js`,
and the edge function tests: `node --experimental-strip-types --test supabase/functions/sasa-brain/core/*.test.ts`.

## Known limits
- Video or audio over 25 MB cannot be transcribed (the owner is told in plain words).
- Only images can be sent to a customer from the files; PDFs are searched, not sent.
- `src/services/aiPromptConfig.test.js` has one failing test that was already failing before this work.
