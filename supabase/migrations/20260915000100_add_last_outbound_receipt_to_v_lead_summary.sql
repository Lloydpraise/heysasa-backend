create or replace view public.v_lead_summary as
select
  c.id,
  c.business_id,
  c.name,
  c.phone,
  c.social_id,
  c.lead_state,
  c.lead_type,
  coalesce(cv.lead_quality, c.lead_quality) as lead_quality,
  c.is_ad_lead,
  c.last_seen,
  c.follow_up_count,
  c.do_not_contact,
  c.ad_id,
  c.ad_platform,
  c.ad_headline,
  c.ad_body,
  c.ad_thumbnail_url,
  c.ad_id as original_ad_id,
  cv.unread_count,
  cv.is_business_chat,
  cv.context_summary,
  cv.customer_intent,
  ce.conv_stage,
  ce.next_action_plan,
  cv.cart_state,
  cv.psychology,
  cv.vibe_check,
  ce.competitor_mentions,
  ce.objection_tags,
  ce.pre_purchase_questions,
  ce.last_enriched_at as nlp_enriched_at,
  null::jsonb as trust_markers,
  null::text as product_sold,
  null::numeric as deal_value,
  null::timestamp without time zone as purchase_date,
  c.follow_up_opted_in,
  c.follow_up_opted_in_at,
  c.follow_up_opted_out_at,
  c.consent_message_sent_at,
  c.read_receipt,
  c.last_seen_online,
  c.sent_voice_note,
  c.sent_media,
  c.sent_reaction,
  c.intent_score,
  c.structural_enriched_at,
  c.product_interests,
  fq.status as followup_status,
  fq.sequence_step as followup_current_step,
  fq.follow_up_number as followup_sent_steps,
  fq.is_pending_approval as followup_pending_approval,
  fq.draft_message as followup_draft,
  fq.scheduled_at as followup_next_due,
  c.ad_attributed_at,
  lm.whatsapp_message_id as last_outbound_message_id,
  lm.status as last_outbound_message_raw_status,
  case upper(coalesce(lm.status, 'SENT'))
    when 'READ' then 'read'
    when 'DELIVERY_ACK' then 'delivered'
    when 'SERVER_ACK' then 'delivered'
    when 'DELIVERED' then 'delivered'
    when 'ERROR' then 'failed'
    else 'sent'
  end as last_outbound_receipt_status,
  coalesce(lm.is_read, false) as last_outbound_message_is_read,
  lm.created_at as last_outbound_message_at
from public.contacts c
left join public.conversations cv on cv.contact_id = c.id
  and cv.business_id = c.business_id
left join public.conversation_enrichment ce on ce.conversation_id = cv.id
left join lateral (
  select
    m.whatsapp_message_id,
    m.status,
    m.is_read,
    m.created_at
  from public.messages m
  where m.contact_id = c.id
    and m.business_id = c.business_id
    and m.direction in ('out', 'outbound')
  order by m.created_at desc, m.id desc
  limit 1
) lm on true
left join lateral (
  select
    fqi.status,
    fqi.sequence_step,
    fqi.follow_up_number,
    fqi.draft_message,
    fqi.scheduled_at,
    fqi.approval_status = 'awaiting_approval'::text as is_pending_approval
  from public.follow_up_queue fqi
  where fqi.contact_id = c.id
    and (
      fqi.status = 'pending'::text
      or fqi.approval_status = 'awaiting_approval'::text
    )
  order by
    (fqi.approval_status = 'awaiting_approval'::text) desc,
    fqi.scheduled_at
  limit 1
) fq on true
order by
  c.intent_score desc nulls last,
  c.is_ad_lead desc,
  c.last_seen desc;