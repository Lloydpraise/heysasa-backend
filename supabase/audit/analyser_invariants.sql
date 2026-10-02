-- Analyser accuracy audit. Run after a full analyser run.
-- Every row in the "must_be_zero" group should be 0.
-- Change the business id in ONE place: the value in the params CTE below.
with params as (select 'kitchenandall-020678'::text as business_id),
c as (select ct.* from public.contacts ct join params p on p.business_id = ct.business_id)
select 'must_be_zero' as grp, 'hot lead_quality without commercial intent or evidence' as check_name, count(*) as n
  from c where lead_type = 'business' and lead_quality = 'hot'
   and (intent not in ('buying','price_check') or intent is null or intent_evidence is null) and lead_state <> 'won'
union all
select 'must_be_zero', 'non-customer contact (personal/junk/vendor/staff/unknown) still carrying scores', count(*)
  from c where lead_type <> 'business' and lead_type_classified_at is not null and (lead_quality is not null or intent_score is not null or follow_up_urgency is not null or quality_score is not null or intent is not null or lead_summary is not null)
union all
select 'must_be_zero', 'conversation flag disagrees with contact type', count(*)
  from public.conversations v join c on c.id = v.contact_id
 where (c.lead_type = 'business' and v.is_business_chat is distinct from true)
    or (c.lead_type in ('personal','junk','vendor','staff') and v.is_business_chat is distinct from false)
union all
select 'must_be_zero', 'enrichment or sentiment rows left behind for a non-customer contact', (
    (select count(*) from public.conversation_enrichment e join c on c.id = e.contact_id where c.lead_type <> 'business')
  + (select count(*) from public.sentiment_snapshots s join c on c.id = s.contact_id where c.lead_type <> 'business'))
union all
select 'must_be_zero', 'awaiting reply <=7d with buying/price intent but not hot', count(*)
  from c where lead_type = 'business' and awaiting_reply and intent in ('buying','price_check')
   and awaiting_since > now() - interval '7 days' and follow_up_urgency is distinct from 'hot' and lead_state not in ('won','lost','do_not_contact')
union all
select 'must_be_zero', 'business contact analysed under an old/no analysis version', count(*)
  from c where lead_type = 'business' and analysis_version is distinct from 3
     and exists (select 1 from public.messages m where m.contact_id = c.id)
union all
select 'must_be_zero', 'classified by the model under an old classifier version', count(*)
  from c where lead_type_source in ('llm','nlp') and classifier_version is distinct from 2
union all
select 'must_be_zero', 'conversation stage outside the allowed list (incl. "Closing")', count(*)
  from public.conversation_enrichment e join c on c.id = e.contact_id
 where e.conv_stage is not null and e.conv_stage not in ('Awareness','Consideration','Product interest','Negotiation','Stalled','Closed','Ghosted')
union all
select 'must_be_zero', 'support intent (already ordered/paid) not in stage Closed', count(*)
  from public.conversation_enrichment e join c on c.id = e.contact_id
 where c.lead_type = 'business' and c.intent = 'support' and e.conv_stage is distinct from 'Closed'
union all
select 'must_be_zero', 'prefilled-opener-only chat not scored browsing / quality 3', count(*) from (
  select c.id, c.intent, c.quality_score
    from c
    join lateral (select lower(regexp_replace(coalesce(m.content->>'text',''), '[^[:alnum:]]+', ' ', 'g')) as norm
                    from public.messages m
                   where m.contact_id = c.id and m.direction in ('in','inbound') and m.type = 'text'
                   order by m.created_at, m.id limit 1) f on true
   where c.lead_type = 'business'
     and (select count(*) from c c2 join lateral (select lower(regexp_replace(coalesce(m.content->>'text',''), '[^[:alnum:]]+', ' ', 'g')) as norm
                    from public.messages m where m.contact_id = c2.id and m.direction in ('in','inbound') and m.type = 'text'
                    order by m.created_at, m.id limit 1) f2 on true where f2.norm = f.norm) >= 5
     and array_length(string_to_array(trim(f.norm), ' '), 1) >= 4
     and not exists (select 1 from public.messages m
                      where m.contact_id = c.id and m.direction in ('in','inbound') and m.type = 'text'
                        and coalesce(m.content->>'text','') <> ''
                        and lower(regexp_replace(coalesce(m.content->>'text',''), '[^[:alnum:]]+', ' ', 'g')) <> f.norm)
) opener_only where intent is distinct from 'browsing' or quality_score is distinct from 3
union all
select 'review', 'contacts left unknown (need a human look)', count(*) from c where lead_type = 'unknown' and lead_type_classified_at is not null
union all
select 'info', 'never classified (no messages or not reached yet)', count(*) from c where lead_type_classified_at is null
union all
select 'info', 'customers (business)', count(*) filter (where lead_type = 'business') from c
union all
select 'info', 'vendors', count(*) filter (where lead_type = 'vendor') from c
union all
select 'info', 'staff', count(*) filter (where lead_type = 'staff') from c
union all
select 'info', 'personal', count(*) filter (where lead_type = 'personal') from c
union all
select 'info', 'junk', count(*) filter (where lead_type = 'junk') from c
order by 1, 2;

-- Spot-check sample: the 25 lowest-confidence decisions, to read against the actual chats.
select id, name, lead_type, round(lead_type_confidence, 2) as confidence, lead_type_source, lead_type_reason
  from public.contacts
 where business_id = 'kitchenandall-020678' and lead_type_source in ('llm','nlp')
 order by lead_type_confidence asc
 limit 25;
