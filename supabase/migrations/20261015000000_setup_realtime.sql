-- Slice 7: let the follow-up engine hear when a business's setup reaches "Home is ready" or "done",
-- so the Follow-up AI can look for work straight away. Nothing else changes. Safe to run twice.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'business_setup') then
    alter publication supabase_realtime add table public.business_setup;
  end if;
end $$;
