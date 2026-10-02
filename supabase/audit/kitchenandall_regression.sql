-- Kitchen And All regression: expected vs actual for the chats reviewed by hand on 2026-10-01.
-- Run after the analyser has been re-run with the v3 files. Every row should say PASS.
-- Business id is set in ONE place: the params CTE.
with params as (select 'kitchenandall-020678'::text as business_id),
c as (select ct.* from public.contacts ct join params p on p.business_id = ct.business_id),
first_in as (
  select distinct on (m.contact_id) m.contact_id, coalesce(m.content->>'text','') as txt
    from public.messages m join c on c.id = m.contact_id
   where m.direction in ('in','inbound') and m.type = 'text'
   order by m.contact_id, m.created_at, m.id
),
cases(id, label, expect) as (values
  -- the owner is the buyer or is being chased: must leave the customer pipeline
  (7123, 'ads vendor reporting to the owner (Google verification, ads back on)', 'vendor'),
  (6377, 'ads / website vendor (40 products added, ad launch)',                   'vendor'),
  (6378, 'owner buying perfume on credit',                                        'vendor_or_personal'),
  (6379, 'owner sending M-PESA out to an individual',                             'vendor_or_personal'),
  (7446, 'creditor chasing the owner about a loan',                               'vendor_or_personal'),
  (6457, 'welder being vetted / asking the owner for transport',                  'staff_or_personal'),
  -- real customers must stay customers
  (6558, 'customer whose Ksh40,000 payment to the business paybill failed (real buyer)', 'business'),
  (9919, 'axial fan enquiry (was dropped as unknown)',                            'business'),
  (9632, 'shawarma machine enquiry (was dropped as unknown)',                     'business'),
  (9612, 'sink + burner buyer, goods collected',                                  'business_closed'),
  (6418, 'banner buyer who paid and got the invoice',                             'business_closed'),
  (6429, 'paid customer chasing completion of the job',                           'business_support_closed'),
  (6452, 'opener then "Tomorrow at 9am" only: must not be hot',                   'business_not_hot'),
  (6386, '3-burner buyer asking best price and delivery',                         'business_commercial'),
  -- personal stays personal
  (6383, 'school fees',        'personal'),
  (7021, 'family burial',      'personal'),
  (6374, 'church reminder',    'personal'),
  (6455, 'birthday greeting',  'personal'),
  -- prefilled opener only: every one scored the same
  (6529, 'prefilled opener only', 'opener_only'),
  (9062, 'prefilled opener only', 'opener_only'),
  (9713, 'prefilled opener only', 'opener_only'),
  (6539, 'prefilled opener x3 only', 'opener_only')
),
by_id as (
  select cs.label, cs.id::text as ref, cs.expect, k.lead_type, k.intent, k.quality_score, k.lead_quality, e.conv_stage,
    case cs.expect
      when 'vendor'                  then k.lead_type = 'vendor'
      when 'vendor_or_personal'      then k.lead_type in ('vendor','personal')
      when 'staff_or_personal'       then k.lead_type in ('staff','personal')
      when 'business'                then k.lead_type = 'business'
      when 'business_closed'         then k.lead_type = 'business' and e.conv_stage = 'Closed'
      when 'business_support_closed' then k.lead_type = 'business' and k.intent = 'support' and e.conv_stage = 'Closed'
      when 'business_not_hot'        then k.lead_type = 'business' and k.lead_quality is distinct from 'hot'
      when 'business_commercial'     then k.lead_type = 'business' and k.intent in ('buying','price_check')
      when 'personal'                then k.lead_type = 'personal'
      when 'opener_only'             then k.lead_type = 'business' and k.intent = 'browsing' and k.quality_score = 3
    end as ok
  from cases cs
  left join c k on k.id = cs.id
  left join public.conversation_enrichment e on e.contact_id = k.id
),
-- contacts whose first message shows they are not customers (suppliers pitching, notices, hiring)
patterns(label, pat, expect) as (values
  ('Chinese manufacturer pitch (Yiwu Junran)',      '%Yiwu Junran%',                          'not_customer'),
  ('Chinese manufacturer pitch (premium kitchen)',  '%premium commercial kitchen equipment manufacturer from China%', 'not_customer'),
  ('Chinese supplier pitch (Shandong Glowen)',      '%Shandong Glowen%',                      'not_customer'),
  ('maize sheller promoter',                        '%electric maize sheller%',               'not_customer'),
  ('Meta Ads Manager system notice',                '%messaging ad in Ads Manager%',          'not_customer'),
  ('electricity token notice',                      'Mtr:%Token%',                            'not_customer'),
  ('competitor broadcast (Spark Kitchen)',          '%Welcome to Spark Kitchen%',             'not_customer'),
  ('hiring message about a CV and a job',           '%kisho akupatie c.v%',                   'not_customer')
),
by_text as (
  select p.label, f.contact_id::text as ref, p.expect, k.lead_type, k.intent, k.quality_score, k.lead_quality, null::text as conv_stage,
         (k.lead_type <> 'business') as ok
  from patterns p
  join first_in f on f.txt ilike p.pat
  join c k on k.id = f.contact_id
),
all_rows as (select * from by_id union all select * from by_text)
select case when ok then 'PASS' else 'FAIL' end as result, label, ref as contact_id, expect,
       lead_type, intent, quality_score, lead_quality, conv_stage
  from all_rows
union all
select 'TOTAL', count(*) filter (where ok) || ' of ' || count(*) || ' pass', null, null, null, null, null, null, null from all_rows
order by 1 desc, 2;
