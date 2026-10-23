-- Campaign hardening for large sends.
-- 1. follow_up_queue.claimed_at: when the sender took a row. Stale-claim recovery used scheduled_at, which for a campaign
--    row can be days old, so every row in flight looked abandoned.
alter table public.follow_up_queue add column if not exists claimed_at timestamptz;

-- 2. 'exited' is written by the sender, the reply handler and the scheduler; make sure the check allows it.
alter table public.campaign_enrollments drop constraint if exists campaign_enrollments_status_check;
alter table public.campaign_enrollments
  add constraint campaign_enrollments_status_check
  check (status in ('pending', 'active', 'awaiting_opt_in', 'completed', 'opted_out', 'exited')) not valid;

-- 3. The sender now reads each business's due rows and counts its sends; keep both cheap with a big queue.
create index if not exists idx_follow_up_queue_ready_by_business
  on public.follow_up_queue (business_id, scheduled_at) where status = 'ready_to_send';
create index if not exists idx_follow_up_queue_sent_by_business
  on public.follow_up_queue (business_id, processed_at) where status = 'sent';
