-- Analyser accuracy audit. Run after a full analyser run.
-- Every row in the "must_be_zero" group should be 0. Change the business id as needed.
with c as (select * from public.contacts where business_id = 'vvstudios-e2b2c2')
select 'must_be_zero' as grp, 'hot lead_quality without commercial intent or evidence' as check_name, count(*) as n
  from c where lead_type = 'business' and lead_quality = 'hot'
   and (intent not in ('buying','price_check') or intent is null or intent_evidence is null) and lead_state <> 'won'
union all
select 'must_be_zero', 'non-business contact still carrying scores', count(*)
  from c where lead_type <> 'business' and (lead_quality is not null or intent_score is not null or follow_up_urgency is not null or quality_score is not null)
union all
select 'must_be_zero', 'conversation flag disagrees with contact type', count(*)
  from public.conversations v join c on c.id = v.contact_id
 where (c.lead_type = 'business' and v.is_business_chat is distinct from true)
    or (c.lead_type in ('personal','junk') and v.is_business_chat is distinct from false)
union all
select 'must_be_zero', 'awaiting reply <=7d with buying/price intent but not hot', count(*)
  from c where lead_type = 'business' and awaiting_reply and intent in ('buying','price_check')
   and awaiting_since > now() - interval '7 days' and follow_up_urgency is distinct from 'hot' and lead_state not in ('won','lost','do_not_contact')
union all
select 'must_be_zero', 'business contact analysed under an old/no analysis version', count(*)
  from c where lead_type = 'business' and analysis_version is distinct from 2
     and exists (select 1 from public.messages m where m.contact_id = c.id)
union all
select 'review', 'contacts left unknown (need a human look)', count(*) from c where lead_type = 'unknown' and lead_type_classified_at is not null
union all
select 'info', 'never classified (no messages or not reached yet)', count(*) from c where lead_type_classified_at is null
union all
select 'info', 'business / personal / junk', count(*) filter (where lead_type = 'business') from c
order by 1, 2;

-- Spot-check sample: the 25 lowest-confidence decisions, to read against the actual chats.
select id, name, lead_type, round(lead_type_confidence, 2) as confidence, lead_type_source, lead_type_reason
  from public.contacts
 where business_id = 'vvstudios-e2b2c2' and lead_type_source = 'llm'
 order by lead_type_confidence asc
 limit 25;
