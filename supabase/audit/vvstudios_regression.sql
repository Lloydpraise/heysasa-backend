-- VVStudios regression: expected vs actual for chats reviewed by hand on 2026-10-02.
-- Run after re-running the analyser with the v3 files. Every row should say PASS.
-- These expectations are the ones I could verify from the chat text itself.
with c as (select * from public.contacts where business_id = 'vvstudios-e2b2c2'),
cases(id, label, expect) as (values
  -- the owner is asking sellers for prices: owner is the buyer
  (3330, 'owner asks "you sell rings?", seller replies 100@',          'vendor_or_personal'),
  (2822, 'owner asks "do you sell rings?", reply No',                  'vendor_or_personal'),
  (3352, 'owner asks "Uko na rings?", reply Sina',                     'vendor_or_personal'),
  (3428, 'owner asks "Hii set ni ngapi", seller says 9500',            'vendor_or_personal'),
  (6331, 'owner paying rent / asking about deposit refund',            'vendor_or_personal'),
  -- church and family chats stay personal
  (3398, 'where the owner works / which floor',        'personal'),
  (3442, 'wedding day question',                       'personal'),
  (3465, 'youth service invitation broadcast',         'personal'),
  (3334, 'water bill and plumbing at home',            'personal'),
  (2399, 'long personal support chat',                 'personal'),
  -- automated replies from other businesses are not customers
  (2273, 'auto-reply from T.E.C Interiors',            'not_customer'),
  (2316, 'auto-reply from Ornyx Systems',              'not_customer'),
  (3294, 'auto-reply from M-KOPA',                     'not_customer'),
  (2368, 'free M-PESA spam link',                      'not_customer'),
  -- an emoji-only or "Okay <emoji>" reply is a human reply: never junk
  (2321, '"Okay" plus an unreadable emoji',            'not_junk'),
  (2098, 'only unreadable emoji characters',           'not_junk'),
  -- clear customers of the agency stay customers
  (3576, 'Kitchen And All paying Vvstudios 5k',        'business'),
  (3482, 'lash trainer buying marketing material',     'business'),
  (2122, 'student paying class balance',               'business'),
  -- the other person never wrote: vague owner lines must not become scored customers
  (2294, 'owner only said "Alright"',                  'not_business'),
  (2818, 'owner only sent "4900"',                     'not_business'),
  (2213, 'owner only said "Sawa sawa"',                'not_business')
)
select case when ok then 'PASS' else 'FAIL' end as result, label, id as contact_id, expect, lead_type, intent, quality_score, lead_quality
from (
  select cs.label, cs.id, cs.expect, k.lead_type, k.intent, k.quality_score, k.lead_quality,
    case cs.expect
      when 'vendor_or_personal' then k.lead_type in ('vendor','personal')
      when 'personal'           then k.lead_type = 'personal'
      when 'not_customer'       then k.lead_type in ('junk','vendor','unknown','personal')
      when 'not_junk'           then k.lead_type is distinct from 'junk'
      when 'business'           then k.lead_type = 'business'
      when 'not_business'       then k.lead_type is distinct from 'business'
    end as ok
  from cases cs left join c k on k.id = cs.id
) r
union all
select 'TOTAL', count(*) filter (where ok) || ' of ' || count(*) || ' pass', null, null, null, null, null, null
from (
  select case cs.expect
      when 'vendor_or_personal' then k.lead_type in ('vendor','personal')
      when 'personal'           then k.lead_type = 'personal'
      when 'not_customer'       then k.lead_type in ('junk','vendor','unknown','personal')
      when 'not_junk'           then k.lead_type is distinct from 'junk'
      when 'business'           then k.lead_type = 'business'
      when 'not_business'       then k.lead_type is distinct from 'business'
    end as ok
  from cases cs left join c k on k.id = cs.id
) t
order by 1 desc, 2;
