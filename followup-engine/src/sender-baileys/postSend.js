import { deductBalance } from '../lib/billing.js'
import { getBillingConfig } from '../lib/db.js'
import { DEFAULT_MSG_COST, DEFAULT_CONSENT_COST } from '../config.js'
import { isPermanentSendFailure } from '../lib/sendFailures.js'

const SEND_RETRY_DELAY_MS = 60 * 60_000 // retry non-permanent send failures about an hour later

export async function recordSuccessfulSend(supabase, { item, contact, business, finalMessage, whatsappMessageId }) {
  const now = new Date().toISOString()
  const messageType = item.media?.type || 'text'
  const messageContent = item.media
    ? { text: finalMessage || item.media.caption || '', type: messageType, media: item.media }
    : { text: finalMessage || '', type: 'text' }

  // Consent messages (touchpoint_type: 'consent', queued by consent.js)
  // get different bookkeeping — they're not a sequence step, so they
  // don't touch follow_up_count/current_sequence_step, and they bill
  // at the consent rate instead of the per-message follow-up rate.
  if (item.touchpoint_type === 'consent') {
    const consentCost = await getBillingConfig(supabase, 'consent_message_cost_usd', DEFAULT_CONSENT_COST)
    await Promise.all([
      supabase.from('messages').insert({
        business_id: item.business_id,
        contact_id: item.contact_id,
        conversation_id: item.conversation_id,
        whatsapp_message_id: whatsappMessageId,
        direction: 'out', role: 'ai', agent_role: 'follow_up_ai',
        type: messageType, content: messageContent, status: 'sent', created_at: now
      }),
      supabase.from('follow_up_queue').update({ status: 'sent', processed_at: now, next_step_processed: true }).eq('id', item.id),
      supabase.from('contacts').update({ consent_message_sent_at: now }).eq('id', item.contact_id),
      deductBalance(supabase, item.business_id, consentCost, 'consent_message')
    ])
    return
  }

  const currentCount = contact.follow_up_count ?? 0
  const sendDate = now.slice(0, 10)
  const messageCost = await getBillingConfig(supabase, 'followup_message_cost_usd', DEFAULT_MSG_COST)

  const [messageInsertResult] = await Promise.all([
    // Log the message — .select('id') so we can link it onto the
    // campaign_step_events row below instead of leaving message_id null.
    supabase.from('messages').insert({
      business_id: item.business_id,
      contact_id: item.contact_id,
      conversation_id: item.conversation_id,
      whatsapp_message_id: whatsappMessageId,
      direction: 'out',
      role: 'ai',
      agent_role: 'follow_up_ai',
      type: messageType,
      content: messageContent,
      status: 'sent',
      created_at: now
    }).select('id').single(),
    // Mark queue item sent
    supabase.from('follow_up_queue').update({
      status: 'sent',
      processed_at: now
    }).eq('id', item.id),
    // Log outcome
    supabase.from('follow_up_outcomes').insert({
      follow_up_queue_id: item.id,
      business_id: item.business_id,
      contact_id: item.contact_id,
      conversation_id: item.conversation_id,
      follow_up_number: item.sequence_step,
      message_sent: finalMessage,
      lead_profile_used: item.touchpoint_type,
      outcome: 'sent',
      created_at: now
    }),
    // Update contact counters
    supabase.from('contacts').update({
      follow_up_count: currentCount + 1,
      current_sequence_step: item.sequence_step,
      last_follow_up_at: now,
      lifetime_followups_sent: (contact.lifetime_followups_sent ?? 0) + 1,
      daily_followup_count: (contact.daily_followup_count ?? 0) + 1
    }).eq('id', item.contact_id),
    // Update business total sent
    supabase.from('businesses').update({
      followup_total_sent: (business.followup_total_sent ?? 0) + 1
    }).eq('business_id', item.business_id),
    // Deduct message cost
    deductBalance(supabase, item.business_id, messageCost, `followup_step_${item.sequence_step}`),
    // Daily capacity counter — v_campaign_summary and the dashboard's
    // subscribeToCapacity both read this; nothing wrote to it before.
    // Read-modify-write is fine at this volume; it's a display counter,
    // not something anything else gates on.
    supabase.from('daily_send_counters').select('sent_today')
      .eq('business_id', item.business_id).eq('send_date', sendDate).maybeSingle()
      .then(({ data }) => supabase.from('daily_send_counters').upsert({
        business_id: item.business_id, send_date: sendDate, sent_today: (data?.sent_today ?? 0) + 1
      }, { onConflict: 'business_id,send_date' }))
  ])

  if (messageInsertResult?.error) {
    console.error(`[Sender] Failed to log outbound message for ${item.id}: ${messageInsertResult.error.message}`)
  }
  const insertedMessageId = messageInsertResult?.data?.id ?? null

  // Campaign step tracking — v_campaign_summary/v_campaign_step_summary
  // (sent_count, response_rate, etc.) read from campaign_step_events;
  // nothing wrote to it before, so the dashboard would show zeros even
  // while sends succeeded. message_id links this step event to the actual
  // message row so delivery/read/reply/reaction feedback can be joined
  // back to a specific campaign step (see v_campaign_message_feedback).
  if (item.campaign_id) {
    const { data: enrollment } = await supabase
      .from('campaign_enrollments')
      .select('id')
      .eq('campaign_id', item.campaign_id)
      .eq('lead_id', item.contact_id)
      .maybeSingle()

    const { data: stepRow } = await supabase
      .from('campaign_steps')
      .select('id')
      .eq('campaign_id', item.campaign_id)
      .eq('step_number', item.campaign_step ?? item.sequence_step)
      .maybeSingle()

    if (enrollment && stepRow) {
      await supabase.from('campaign_step_events').upsert({
        enrollment_id: enrollment.id,
        step_id: stepRow.id,
        message_id: insertedMessageId,
        sent_at: now
      }, { onConflict: 'enrollment_id,step_id' })
    }
  }

  // Auto-upgrade daily cap based on lifetime sends — only ever raises,
  // never overwrites a manually-set higher cap down to a tier default.
  const newTotal = (business.followup_total_sent ?? 0) + 1
  const tier2 = 500, tier3 = 2000
  const tierCap = newTotal >= tier3 ? 100 : newTotal >= tier2 ? 80 : null
  if (tierCap !== null && tierCap > business.followup_daily_cap) {
    await supabase.from('businesses').update({ followup_daily_cap: tierCap }).eq('business_id', item.business_id)
    console.log(`[Sender] Daily cap upgraded to ${tierCap} for ${item.business_id}`)
  }

  // Campaign step advancement — separate from follow_up_count/sequence_step
  // above, and deliberately lives here rather than in reconciliation.js:
  // only the sender knows the send genuinely happened, and campaigns track
  // their own step via campaign_enrollments, not contact.follow_up_sequence_id.
  if (item.campaign_id) {
    const { data: nextStep } = await supabase
      .from('campaign_steps')
      .select('step_number, delay_hours')
      .eq('campaign_id', item.campaign_id)
      .gt('step_number', item.campaign_step ?? 0)
      .order('step_number', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (nextStep) {
      const nextSendAt = new Date(Date.now() + (nextStep.delay_hours ?? 24) * 3_600_000).toISOString()
      await supabase.from('campaign_enrollments')
        .update({ current_step: item.campaign_step, next_send_at: nextSendAt })
        .eq('campaign_id', item.campaign_id)
        .eq('lead_id', item.contact_id)
    } else {
      await supabase.from('campaign_enrollments')
        .update({ current_step: item.campaign_step, status: 'completed' })
        .eq('campaign_id', item.campaign_id)
        .eq('lead_id', item.contact_id)

      const { error: completionError } = await supabase.rpc('complete_campaign_if_finished', {
        target_campaign_id: item.campaign_id
      })
      if (completionError) {
        console.error(`[Sender] Campaign completion check failed for ${item.campaign_id}: ${completionError.message}`)
      }
    }
  }
}

// Only "number not on WhatsApp" is a permanent stop now. Everything else
// (Evolution errors, timeouts, transient network failures) is assumed
// recoverable — it stays ready_to_send and comes back up for another
// attempt in the next retry pass, indefinitely, rather than being given
// up on after a fixed attempt count.
export async function recordFailedDispatch(supabase, item, errorMessage) {
  const attempts = (item.dispatch_attempts ?? 0) + 1
  const permanent = isPermanentSendFailure(errorMessage)

  await supabase.from('follow_up_queue').update({
    status: permanent ? 'failed' : 'ready_to_send',
    scheduled_at: permanent ? item.scheduled_at : new Date(Date.now() + SEND_RETRY_DELAY_MS).toISOString(),
    dispatch_attempts: attempts,
    last_dispatch_error: errorMessage
  }).eq('id', item.id)

  console.error(`[Sender] Dispatch failed for ${item.id} (attempt ${attempts}${permanent ? ', not on WhatsApp — giving up' : ', retrying in ~1h'}): ${errorMessage}`)
}