-- One person, one contact. Imports used to add a second copy of a person who already chatted on WhatsApp (and
-- WhatsApp's two ids for one person, phone and LID, sometimes became two contacts too). The owner then saw one empty
-- chat and one full chat for the same customer, and replies landed on the copy the follow-ups were not using.
--
-- merge_duplicate_contacts() folds every group of contacts of one business with the same number (phone_key, the last
-- 9 digits) into one: the copy with the most messages is kept, everything that pointed at the others is moved onto
-- it, their WhatsApp ids are remembered in alt_social_ids (so a later message under either id finds the kept
-- contact), and the others are deleted. A copy of every deleted row is kept in archive.contacts_merged.
--
--   select public.merge_duplicate_contacts();                     -- dry run: what would change, nothing written
--   select public.merge_duplicate_contacts(null, false);          -- merge every business
--   select public.merge_duplicate_contacts('lashesbyshazz', false);

alter table public.contacts add column if not exists alt_social_ids text[] not null default '{}';
create index if not exists idx_contacts_alt_social_ids on public.contacts using gin (alt_social_ids);

create schema if not exists archive;
revoke all on schema archive from anon, authenticated, public;
create table if not exists archive.contacts_merged (
  merged_at   timestamptz not null default now(),
  business_id text        not null,
  keep_id     bigint      not null,
  drop_id     bigint      not null,
  contact     jsonb       not null
);

create or replace function public.merge_duplicate_contacts(p_business_id text default null, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Tables that point at a contact, with the other columns of their unique key (null = no unique key on it).
  refs constant text[][] := array[
    ['messages','contact_id',null], ['sales','contact_id',null], ['deals','contact_id',null],
    ['meetings','contact_id',null], ['reviews','contact_id',null], ['referrals','referrer_contact_id',null],
    ['referrals','referred_contact_id',null], ['user_followups','contact_id',null],
    ['followup_feedback','contact_id',null], ['call_logs','contact_id',null], ['deal_followups','contact_id',null],
    ['session_carts','contact_id',null], ['ai_orders','contact_id',null], ['follow_up_queue','contact_id',null],
    ['follow_up_outcomes','contact_id',null], ['followup_billing_events','contact_id',null],
    ['followup_nudge_log','contact_id',null], ['conversation_enrichment','contact_id',null],
    ['conversions','contact_id',null], ['sentiment_snapshots','contact_id',null],
    ['follow_up_send_events','contact_id',null], ['waitlist_leads','contact_id',null],
    ['lead_timeline','contact_id',null], ['lead_calls','contact_id',null], ['lead_tasks','contact_id',null],
    ['lead_meetings','contact_id',null], ['lead_meeting_reminders','contact_id',null],
    ['ai_deal_followups','contact_id',null], ['ai_learning','contact_id',null], ['businessmeetings','lead_id',null],
    ['chat_ai_outbox','contact_id',null], ['chat_ai_turns','contact_id',null],
    ['feedback_analysis_queue','contact_id',null], ['followup_ai_turns','contact_id',null],
    ['handoff_events','contact_id',null], ['lead_activity_log','contact_id',null],
    ['lead_stage_changes','contact_id',null], ['lead_stage_requests','contact_id',null],
    ['product_mentions','contact_id',null], ['special_followups','contact_id',null], ['system_logs','contact_id',null],
    ['contact_enrichment','contact_id',''], ['customer_profiles','contact_id',''],
    ['ad_attribution_checks','contact_id',''], ['contact_activity_patterns','contact_id','business_id'],
    ['followup_campaign_enrollments','contact_id','campaign_id'], ['campaign_enrollments','lead_id','campaign_id'],
    ['list_members','lead_id','list_id'], ['contact_whatsapp_sessions','contact_id','whatsapp_session_id'],
    ['lead_ai_state','contact_id','business_id']];
  text_refs constant text[][] := array[['pending_messages','contact_id'], ['runner_logs','contact_id']];
  conv_refs constant text[][] := array[
    ['messages',null], ['admin_alerts',null], ['ai_orders',null], ['chat_ai_outbox',null], ['chat_ai_turns',null],
    ['chat_test_feedback',null], ['conversation_summaries',null], ['conversions',null], ['follow_up_outcomes',null],
    ['follow_up_queue',null], ['handoff_events',null], ['lead_activity_log',null], ['lead_stage_changes',null],
    ['lead_stage_requests',null], ['livechat_logs',null], ['manual_trainings',null], ['pending_messages',null],
    ['pending_outbound',null], ['sentiment_snapshots',null], ['tech_logs',null], ['thinking_logs',null],
    ['follow_up_sequences',''], ['conversation_enrichment',''], ['chat_ai_daily_chats','business_id, day']];
  r text[];
  part text;
  n bigint;
  moved jsonb := '{}'::jsonb;
  summary jsonb;
  cols text;
begin
  drop table if exists _merge_map, _merge_conv, _merge_patch;

  -- Who is kept: most messages, then a WhatsApp id, then the oldest.
  create temp table _merge_map on commit drop as
  with dup as (
    select business_id, phone_key from contacts
     where phone_key is not null and (p_business_id is null or business_id = p_business_id)
     group by 1, 2 having count(*) > 1
  ), ranked as (
    select c.id, c.business_id, c.phone_key,
           row_number() over (partition by c.business_id, c.phone_key
                              order by (select count(*) from messages m where m.contact_id = c.id) desc,
                                       (c.social_id is not null) desc, c.id) as rn
      from contacts c join dup using (business_id, phone_key)
  )
  select d.id as drop_id, k.id as keep_id, d.business_id
    from ranked d join ranked k on k.business_id = d.business_id and k.phone_key = d.phone_key and k.rn = 1
   where d.rn > 1;
  create index on _merge_map (drop_id);

  summary := jsonb_build_object(
    'groups', (select count(distinct keep_id) from _merge_map),
    'contacts_removed', (select count(*) from _merge_map),
    'by_business', coalesce((select jsonb_object_agg(business_id, cnt) from (select business_id, count(*) cnt from _merge_map group by 1) b), '{}'::jsonb),
    'messages_moved', (select count(*) from messages m join _merge_map x on x.drop_id = m.contact_id));
  if p_dry_run or not exists (select 1 from _merge_map) then
    return summary || jsonb_build_object('dry_run', p_dry_run);
  end if;

  insert into archive.contacts_merged (business_id, keep_id, drop_id, contact)
  select x.business_id, x.keep_id, x.drop_id, to_jsonb(c) from contacts c join _merge_map x on x.drop_id = c.id;

  -- 1. The kept contact's new values, worked out before anything moves. Its own values win; a gap is filled from the
  --    most recently seen copy. A few fields are combined instead.
  create temp table _merge_patch on commit drop as
  with grp as (
    select k.keep_id, c.*, (c.id = k.keep_id) as is_keep
      from (select distinct keep_id from _merge_map) k
      join contacts c on c.id = k.keep_id or c.id in (select drop_id from _merge_map x where x.keep_id = k.keep_id)
  ), biz as (
    select business_id, lower(trim(name)) as name, count(*) as uses from contacts
     where business_id in (select business_id from _merge_map) and name is not null group by 1, 2
  ), named as (
    select g.keep_id, g.name,
           row_number() over (partition by g.keep_id order by
             (g.social_id is null) desc,  -- a name the owner typed beats a WhatsApp profile name
             g.is_keep desc, g.last_seen desc nulls last) as rn
      from grp g
      left join businesses b on b.business_id = g.business_id
      left join biz on biz.business_id = g.business_id and biz.name = lower(trim(g.name))
     where nullif(trim(g.name), '') is not null
       and lower(trim(g.name)) not in ('unknown', 'new lead', 'lead', 'customer')
       and g.name !~ '^\+?[\d\s\-().]+$'
       and lower(trim(g.name)) is distinct from lower(trim(b.name))
       and coalesce(biz.uses, 0) <= 5      -- the same "name" on many contacts is the owner's own profile name
  )
  select k.keep_id,
         (
           -- each field: the kept contact's value, else the most recently seen copy's
           (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from (
              select distinct on (kv.key) kv.key, kv.value
                from grp g2, jsonb_each(jsonb_strip_nulls(to_jsonb(g2) - 'keep_id' - 'is_keep')) kv
               where g2.keep_id = k.keep_id
               order by kv.key, g2.is_keep desc, g2.last_seen desc nulls last) e)
           || jsonb_strip_nulls(jsonb_build_object(
             'name', (select name from named n where n.keep_id = k.keep_id and n.rn = 1),
             'notes', (select string_agg(distinct notes, E'\n') from grp g2 where g2.keep_id = k.keep_id and nullif(trim(notes), '') is not null),
             'social_id', coalesce((select social_id from grp g2 where g2.keep_id = k.keep_id and g2.is_keep),
                                   (select social_id from grp g2 where g2.keep_id = k.keep_id and social_id is not null
                                     order by (social_id like '%@lid') desc, last_seen desc nulls last limit 1)),
             'lead_state', coalesce((select nullif(lead_state, 'new') from grp g2 where g2.keep_id = k.keep_id and g2.is_keep),
                                    (select lead_state from grp g2 where g2.keep_id = k.keep_id and coalesce(lead_state, 'new') <> 'new'
                                      order by last_seen desc nulls last limit 1)),
             'lead_type', coalesce((select nullif(lead_type, 'pending_analysis') from grp g2 where g2.keep_id = k.keep_id and g2.is_keep),
                                   (select lead_type from grp g2 where g2.keep_id = k.keep_id and coalesce(lead_type, 'pending_analysis') <> 'pending_analysis'
                                     order by last_seen desc nulls last limit 1))))
           || jsonb_build_object(
             'do_not_contact', (select bool_or(coalesce(do_not_contact, false)) from grp g2 where g2.keep_id = k.keep_id),
             'is_ad_lead', (select bool_or(coalesce(is_ad_lead, false)) from grp g2 where g2.keep_id = k.keep_id),
             'intent_score', (select max(intent_score) from grp g2 where g2.keep_id = k.keep_id),
             'last_seen', (select max(last_seen) from grp g2 where g2.keep_id = k.keep_id),
             'last_inbound_at', (select max(last_inbound_at) from grp g2 where g2.keep_id = k.keep_id),
             'last_outbound_at', (select max(last_outbound_at) from grp g2 where g2.keep_id = k.keep_id),
             'last_follow_up_at', (select max(last_follow_up_at) from grp g2 where g2.keep_id = k.keep_id),
             'follow_up_opted_out_at', (select max(follow_up_opted_out_at) from grp g2 where g2.keep_id = k.keep_id),
             'created_at', (select min(created_at) from grp g2 where g2.keep_id = k.keep_id),
             'follow_up_count', (select sum(coalesce(follow_up_count, 0)) from grp g2 where g2.keep_id = k.keep_id),
             'lifetime_followups_sent', (select sum(coalesce(lifetime_followups_sent, 0)) from grp g2 where g2.keep_id = k.keep_id),
             'product_interests', (select coalesce(array_agg(distinct v), '{}') from grp g2, unnest(g2.product_interests) v where g2.keep_id = k.keep_id),
             'objection_tags', (select coalesce(array_agg(distinct v), '{}') from grp g2, unnest(g2.objection_tags) v where g2.keep_id = k.keep_id),
             'alt_social_ids', (select coalesce(array_agg(distinct v), '{}') from (
                 select social_id v from grp g2 where g2.keep_id = k.keep_id and social_id is not null
                 union select unnest(alt_social_ids) from grp g2 where g2.keep_id = k.keep_id) a)
           )
         ) as patch
    from (select distinct keep_id from _merge_map) k;
  -- the kept social_id is not an "alternative" of itself
  update _merge_patch set patch = jsonb_set(patch, '{alt_social_ids}',
    coalesce((select jsonb_agg(v) from jsonb_array_elements_text(patch->'alt_social_ids') v where v is distinct from patch->>'social_id'), '[]'::jsonb));

  -- 2. Conversations: one per kept contact. Prefer the kept contact's own, else the copy's with the most messages.
  create temp table _merge_conv on commit drop as
  with mine as (
    select cv.id, cv.business_id, coalesce(x.keep_id, cv.contact_id) as keep_id, (x.drop_id is null) as is_keep,
           (select count(*) from messages m where m.conversation_id = cv.id) as msgs
      from conversations cv left join _merge_map x on x.drop_id = cv.contact_id
     where cv.contact_id in (select keep_id from _merge_map union select drop_id from _merge_map)
  ), target as (
    select distinct on (business_id, keep_id) business_id, keep_id, id as target_id
      from mine order by business_id, keep_id, is_keep desc, msgs desc, id
  )
  select m.id as drop_conv, t.target_id as keep_conv, t.keep_id
    from mine m join target t using (business_id, keep_id) where m.id <> t.target_id;

  foreach r slice 1 in array conv_refs loop
    if to_regclass('public.' || r[1]) is null then continue; end if;
    if r[2] is not null then
      part := 'coalesce(c.keep_conv, t2.conversation_id)'
              || coalesce((select string_agg(', t2.' || trim(x), '') from unnest(string_to_array(nullif(r[2], ''), ',')) x), '');
      execute format(
        'delete from public.%1$I t using (
           select t2.ctid as tid, row_number() over (partition by %2$s order by (c.drop_conv is null) desc) as rn
             from public.%1$I t2 left join _merge_conv c on c.drop_conv = t2.conversation_id
            where t2.conversation_id in (select drop_conv from _merge_conv union select keep_conv from _merge_conv)) d
          where t.ctid = d.tid and d.rn > 1', r[1], part);
    end if;
    execute format('update public.%1$I t set conversation_id = c.keep_conv from _merge_conv c where t.conversation_id = c.drop_conv', r[1]);
    get diagnostics n = row_count;
    if n > 0 then moved := moved || jsonb_build_object(r[1] || '.conversation_id', n); end if;
  end loop;

  update conversations k set
         unread_count = coalesce(k.unread_count, 0) + coalesce(s.unread, 0),
         last_user_message_at = greatest(k.last_user_message_at, s.last_user)
    from (select c.keep_conv, sum(coalesce(cv.unread_count, 0)) unread, max(cv.last_user_message_at) last_user
            from _merge_conv c join conversations cv on cv.id = c.drop_conv group by 1) s
   where k.id = s.keep_conv;
  delete from conversations where id in (select drop_conv from _merge_conv);
  -- a conversation that belonged to a copy now belongs to the kept contact
  update conversations cv set contact_id = x.keep_id from _merge_map x where cv.contact_id = x.drop_id;

  -- 3. Only one active campaign and one open follow-up per person: the copies' extra ones are closed, not sent twice.
  with exited as (
    update campaign_enrollments ce set status = 'exited'
      from (select ce2.id, row_number() over (partition by coalesce(x.keep_id, ce2.lead_id)
                                              order by (x.drop_id is null) desc, ce2.enrolled_at nulls last) rn
              from campaign_enrollments ce2
              left join _merge_map x on x.drop_id = ce2.lead_id
             where ce2.status in ('pending', 'active', 'awaiting_opt_in')
               and ce2.lead_id in (select keep_id from _merge_map union select drop_id from _merge_map)) d
     where ce.id = d.id and d.rn > 1
    returning ce.campaign_id, ce.lead_id
  )
  -- and the messages that campaign still had queued for them
  update follow_up_queue q set status = 'cancelled', skip_reason = 'merged_duplicate'
    from exited e
   where q.campaign_id = e.campaign_id and q.contact_id = e.lead_id and q.status in ('pending', 'ready_to_send');

  -- A campaign step that went to both copies (the same person got it twice) keeps one "sent"; the second is marked
  -- skipped so the one-message-per-step rule holds for the merged contact.
  update follow_up_queue q set status = case when q.status = 'sent' then 'skipped' else 'cancelled' end,
                               skip_reason = case when q.status = 'sent' then 'merged_duplicate_was_sent' else 'merged_duplicate' end
    from (select q2.id, (x.drop_id is not null) as of_copy,
                 row_number() over (partition by coalesce(x.keep_id, q2.contact_id), coalesce(q2.campaign_id::text, '-'),
                                                 case when q2.campaign_id is null then 0 else coalesce(q2.campaign_step, 0) end
                                    order by (q2.status = 'sent') desc, (x.drop_id is null) desc, q2.scheduled_at nulls last) rn
            from follow_up_queue q2 left join _merge_map x on x.drop_id = q2.contact_id
           where (q2.status in ('pending', 'ready_to_send') or (q2.status = 'sent' and q2.campaign_id is not null))
             and q2.contact_id in (select keep_id from _merge_map union select drop_id from _merge_map)) d
   where q.id = d.id and d.rn > 1
     -- a campaign step is one message per person; other follow-ups of the kept contact are left alone
     and (q.campaign_id is not null or d.of_copy);

  -- 4. Move everything else onto the kept contact. Where a table allows one row per person, the kept one's row stays.
  foreach r slice 1 in array refs loop
    if to_regclass('public.' || r[1]) is null then continue; end if;
    if r[3] is not null then
      part := format('coalesce(x.keep_id, t2.%I)', r[2]) || case when r[3] <> '' then ', t2.' || r[3] else '' end;
      execute format(
        'delete from public.%1$I t using (
           select t2.ctid as tid, row_number() over (partition by %3$s order by (x.drop_id is null) desc) as rn
             from public.%1$I t2 left join _merge_map x on x.drop_id = t2.%2$I
            where t2.%2$I in (select drop_id from _merge_map union select keep_id from _merge_map)) d
          where t.ctid = d.tid and d.rn > 1', r[1], r[2], part);
    end if;
    execute format('update public.%1$I t set %2$I = x.keep_id from _merge_map x where t.%2$I = x.drop_id', r[1], r[2]);
    get diagnostics n = row_count;
    if n > 0 then moved := moved || jsonb_build_object(r[1] || '.' || r[2], n); end if;
  end loop;
  foreach r slice 1 in array text_refs loop
    if to_regclass('public.' || r[1]) is null then continue; end if;
    execute format('update public.%1$I t set %2$I = x.keep_id::text from _merge_map x where t.%2$I = x.drop_id::text', r[1], r[2]);
  end loop;

  -- 5. Remove the copies, then give the kept contact its combined details.
  delete from contacts where id in (select drop_id from _merge_map);

  select string_agg(format('%1$I = (p.r).%1$I', column_name), ', ') into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'contacts' and column_name not in ('id', 'phone_key', 'business_id')
     and is_generated = 'NEVER';
  execute format(
    'update public.contacts c set %s
       from (select k.keep_id, jsonb_populate_record(c0, k.patch - ''id'' - ''phone_key'' - ''business_id'') r
               from _merge_patch k join public.contacts c0 on c0.id = k.keep_id) p
      where c.id = p.keep_id', cols);
  update contacts c set social_platform = 'whatsapp'
   where c.id in (select keep_id from _merge_patch) and c.social_id is not null and c.social_platform is null;

  return summary || jsonb_build_object('dry_run', false, 'moved', moved);
end;
$$;

revoke execute on function public.merge_duplicate_contacts(text, boolean) from anon, authenticated, public;
grant execute on function public.merge_duplicate_contacts(text, boolean) to service_role;
