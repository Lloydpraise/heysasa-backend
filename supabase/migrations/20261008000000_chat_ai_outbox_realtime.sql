-- Wake the Chat AI and follow-up workers when queued or source rows change.
do $$
declare
  table_name text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach table_name in array array[
    'chat_ai_outbox', 'follow_up_queue', 'campaign_enrollments', 'campaigns', 'campaign_steps',
    'list_members', 'businesses', 'whatsapp_sessions', 'conversations', 'messages', 'contacts'
  ] loop
    if to_regclass('public.' || table_name) is not null
       and not exists (
         select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name
       ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end $$;

-- Auto lists are now reconciled by the Node Realtime listener, so remove the
-- old database-side safety-net schedule if pg_cron is installed.
do $$
declare
  job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and to_regclass('cron.job') is not null then
    for job_id in execute
      'select jobid from cron.job where command ilike ''%sync_auto_lists%'''
    loop
      execute 'select cron.unschedule($1)' using job_id;
    end loop;
  end if;
end $$;
