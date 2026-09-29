-- Event-driven lead-stage classification.
--
-- Before: a loop ran every 60s and sent the FULL thread of every conversation
-- with a customer message in the last 15 minutes to OpenAI, again and again,
-- until the 15-minute window closed (up to ~15 identical classifications per
-- customer message).
--
-- Now: when a lead responds, the webhook stamps stage_review_requested_at on
-- the conversation. The stage classifier only spends tokens on conversations
-- that carry that stamp and have been quiet for the debounce window, then
-- clears the stamp. No lead activity = no OpenAI call.
--
-- stage_review_requested_at is overwritten with now() on every new response,
-- so it doubles as a watermark: the classifier clears it with a compare-and-set
-- on the exact value it claimed, and a message that lands mid-classification
-- (new timestamp) stays queued for the next pass instead of being lost.

alter table public.conversations
  add column if not exists stage_review_requested_at timestamptz,
  add column if not exists stage_review_reason text;

create index if not exists idx_conversations_stage_review_pending
  on public.conversations (stage_review_requested_at)
  where stage_review_requested_at is not null;
