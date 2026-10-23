-- A failed ad playbook is no longer retried by itself (each try cost an author call plus a quality check per step, and a
-- failure that repeated burned the business's balance in a loop). `failed_at` says when it failed: the ad intake tries
-- again only when a new lead arrives on the ad after that moment, or when the owner edits the ad.
alter table public.ad_playbooks add column if not exists failed_at timestamptz;

-- Playbooks that are failed right now: park them (no pending retry request), so nothing restarts the loop on deploy.
-- They come back when the next new lead arrives on their ad.
update public.ad_playbooks
   set failed_at = now(),
       regenerate_requested_at = null
 where status = 'failed';
