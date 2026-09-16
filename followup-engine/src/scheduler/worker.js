import {
  DEFAULT_DAILY_CAP, DEFAULT_MSG_COST, DEFAULT_ZONE_RECENT,
  DEFAULT_ZONE_MEDIUM, DEFAULT_QUIET_START, DEFAULT_QUIET_END, DEFAULT_MAX_PER_LEAD
} from '../config.js'
import {
  getBusiness, getContact, getPersonaPack, getConversation, getMessages, getBillingConfig, getDailyCount
} from '../lib/db.js'
import { checkBalance, flagInsufficientFunds } from '../lib/billing.js'
import { DEFAULT_TIMEZONE } from '../config.js'
import { calculateSendTime, getZonedParts, leadAgeDays, hoursSince, nextActiveDayDate } from '../lib/timing.js'
import { generateFollowupDraft, rewriteSuggestedMessage } from './generateDraft.js'
import { normalizeOutboundMedia } from '../lib/media.js'

export async function runWorker(supabase, queueItemId) {
  if (!queueItemId) throw new Error('queue_item_id required')

  const updateQueueItem = async (updates) => {
    const { error } = await supabase.from('follow_up_queue').update(updates).eq('id', queueItemId)
    if (error) throw new Error(`queue update failed: ${error.message}`)
  }

  const skipItem = async (reason) => {
    await updateQueueItem({ status: 'skipped', skip_reason: reason })
    console.log(`[Worker] Skipped ${queueItemId} — ${reason}`)
    return { status: 'skipped', reason }
  }

  // ── 1. Get queue item ────────────────────────────────────────
  const { data: item, error: itemErr } = await supabase
    .from('follow_up_queue').select('*').eq('id', queueItemId).single()

  if (itemErr || !item) return skipItem('item_not_found')
  if (item.status !== 'pending') return skipItem('already_processed')
  if (item.approval_status === 'rejected') return skipItem('rejected_by_owner')
  try {
    item.media = normalizeOutboundMedia(item.media)
  } catch (error) {
    return skipItem(error.message)
  }

  if (item.campaign_id) {
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns').select('status').eq('id', item.campaign_id).maybeSingle()
    if (campaignError) throw new Error(`campaign status lookup failed: ${campaignError.message}`)
    if (!campaign || campaign.status !== 'active') return skipItem('campaign_inactive')
  }

  // ── 2. Load contact + business ───────────────────────────────
  const [contact, business] = await Promise.all([
    getContact(supabase, item.contact_id),
    getBusiness(supabase, item.business_id)
  ])

  if (!contact) return skipItem('contact_not_found')
  if (!business) return skipItem('business_not_found')
  if (!contact.phone) return skipItem('no_phone')
  if (contact.do_not_contact) return skipItem('do_not_contact')
  if (!contact.follow_up_opted_in) {
    if (item.campaign_id) {
      const { error } = await supabase.from('campaign_enrollments')
        .update({ status: 'awaiting_opt_in', next_send_at: null })
        .eq('campaign_id', item.campaign_id)
        .eq('lead_id', item.contact_id)
      if (error) throw new Error(`opt-in enrollment update failed: ${error.message}`)
    }
    return skipItem('not_opted_in')
  }
  if (!business.followup_ai_enabled) return skipItem('followup_disabled')
  if (!business.subscription_active) return skipItem('subscription_inactive')
  if (['won', 'lost'].includes(contact.lead_state ?? '')) return skipItem(`lead_${contact.lead_state}`)

  // Stop at stage check
  const stopAtStage = business.followup_stop_at_stage
  if (stopAtStage) {
    const conv0 = await getConversation(supabase, item.contact_id, item.business_id)
    const isEcom0 = business.business_type === 'ecommerce'
    const currStage = isEcom0 ? conv0?.lead_stage_ecom : conv0?.lead_stage_service
    if (currStage === stopAtStage) return skipItem(`stopped_at_stage_${stopAtStage}`)
  }

  // ── 3. Max follow-ups check ───────────────────────────────────
  const maxPerLead = business.followup_max_per_lead ?? DEFAULT_MAX_PER_LEAD
  if ((contact.follow_up_count ?? 0) >= maxPerLead) return skipItem('max_followups_reached')

  // ── 4. Billing check ─────────────────────────────────────────
  const msgCost = await getBillingConfig(supabase, 'followup_message_cost_usd', DEFAULT_MSG_COST)
  const hasBalance = await checkBalance(supabase, item.business_id, msgCost)
  if (!hasBalance) {
    await flagInsufficientFunds(supabase, item.business_id)
    return skipItem('insufficient_balance')
  }

  // ── 5. Daily cap check ───────────────────────────────────────
  const dailyCap = business.followup_daily_cap ?? DEFAULT_DAILY_CAP
  const dailyCount = await getDailyCount(supabase, item.business_id)
  if (dailyCount >= dailyCap) return skipItem('daily_cap_reached')

  // ── 6. Load persona pack (Optional) ──────────────────────────
  const pack = await getPersonaPack(supabase, item.business_id)

  // Quiet hours now come from the business's own Follow-up preferences
  // tab first (followup_quiet_start/end), falling back to the persona
  // pack's rules (older source), then hardcoded defaults.
  const rules = pack?.follow_up_rules ?? {}
  const timeZone = business.timezone || DEFAULT_TIMEZONE
  const quietStart = business.followup_quiet_start
    ?? parseInt(rules.quiet_hours_start ?? String(DEFAULT_QUIET_START))
  const quietEnd = business.followup_quiet_end
    ?? parseInt(rules.quiet_hours_end ?? String(DEFAULT_QUIET_END))

  // ── 6b. Active sending days check ─────────────────────────────
  // 0=Sun..6=Sat, evaluated in the business's local timezone.
  const activeDays = business.followup_active_days ?? [0, 1, 2, 3, 4, 5, 6]
  const now = new Date()
  if (!activeDays.includes(getZonedParts(now, timeZone).weekday)) {
    const nextDate = nextActiveDayDate(now, activeDays, timeZone, quietEnd)
    await supabase.from('follow_up_queue').update({ scheduled_at: nextDate.toISOString() }).eq('id', queueItemId)
    return { status: 'rescheduled', reason: 'inactive_day', next: nextDate.toISOString() }
  }

  // ── 7. Quiet hours check ─────────────────────────────────────
  function isQuiet(h) {
    return quietStart > quietEnd ? (h >= quietStart || h < quietEnd) : (h >= quietStart && h < quietEnd)
  }

  const nowHour = getZonedParts(new Date(), timeZone).hour
  if (isQuiet(nowHour)) {
    const next = calculateSendTime(1, contact.optimal_contact_hour, quietStart, quietEnd, timeZone)
    await supabase.from('follow_up_queue').update({ scheduled_at: next.toISOString() }).eq('id', queueItemId)
    return { status: 'rescheduled', reason: 'quiet_hours', next: next.toISOString() }
  }

  // ── 8. Don't interrupt active conversation ───────────────────
  const conv = await getConversation(supabase, item.contact_id, item.business_id)
  if (conv?.last_user_message_at && hoursSince(conv.last_user_message_at) < 2) {
    return skipItem('lead_recently_active')
  }

  // Sentiment check — don't send if last reply was aggressive/negative.
  // Applies to campaign items too — this is a safety gate, not part of
  // the AI zone-approval system the campaign/owner-written bypasses skip.
  if (conv) {
    const recentMessages = await getMessages(supabase, conv.id)
    const lastInbound = recentMessages.filter(m => m.direction === 'in').at(-1)
    if (['aggressive', 'negative'].includes(lastInbound?.sentiment_score ?? '')) {
      return skipItem(`bad_sentiment_${lastInbound.sentiment_score}`)
    }
  }

  // ── 9. Campaign items: own toggles, no AI zone system ──────────
  if (item.campaign_id) {
    const { data: campaign } = await supabase
      .from('campaigns').select('ai_rewrite_enabled, auto_approve').eq('id', item.campaign_id).single()

    let finalMessage = item.final_message
    let draft = item.draft_message
    let qcPassed = item.qc_passed ?? true
    let qcNotes = item.qc_notes ?? null

    if (campaign?.ai_rewrite_enabled) {
      const result = await rewriteSuggestedMessage(supabase, item.final_message, contact, business, pack, conv)
      if (!result.ok) {
        if (result.reason === 'qc_failed') {
          await supabase.from('follow_up_queue').update({
            status: 'skipped', skip_reason: 'qc_failed', qc_passed: false,
            qc_notes: result.issues.join(', '), draft_message: result.draft
          }).eq('id', queueItemId)
          return { status: 'skipped', reason: 'qc_failed', issues: result.issues }
        }
        return skipItem(result.reason)
      }
      finalMessage = result.finalMessage
      draft = result.draft
      qcPassed = result.qcPassed
      qcNotes = result.qcNotes
    }

    const autoApprove = campaign?.auto_approve ?? true
    if (autoApprove) {
      await updateQueueItem({
        status: 'ready_to_send', channel: business.whatsapp_channel,
        final_message: finalMessage, draft_message: draft, qc_passed: qcPassed,
        approval_status: 'approved', media: item.media
      })
      console.log(`[Worker] Campaign ready to send — campaign:${item.campaign_id} | step:${item.campaign_step} | contact:${item.contact_id}`)
      return { status: 'ready_to_send', step: item.sequence_step, channel: business.whatsapp_channel }
    }

    await supabase.from('follow_up_queue').update({
      approval_status: 'awaiting_approval', draft_message: finalMessage, qc_passed: qcPassed, qc_notes: qcNotes
    }).eq('id', queueItemId)
    console.log(`[Worker] Campaign draft awaiting approval — campaign:${item.campaign_id} | step:${item.campaign_step} | contact:${item.contact_id}`)
    return { status: 'awaiting_approval', step: item.sequence_step }
  }

  // ── 10-16. Standalone items: resolve the message first ─────────
  let finalMessage = item.final_message || item.draft_message
  let draft = item.draft_message
  let qcPassed = item.qc_passed ?? true
  let qcNotes = item.qc_notes ?? null
  const preWritten = !!(item.final_message || item.draft_message || item.media)

  if (preWritten && item.ai_rewrite_enabled) {
    // Owner wrote it but asked AI to expand/personalize — treat as a
    // suggestion, not final copy.
    const result = await rewriteSuggestedMessage(supabase, finalMessage, contact, business, pack, conv)
    if (!result.ok) {
      if (result.reason === 'qc_failed') {
        await supabase.from('follow_up_queue').update({
          status: 'skipped', skip_reason: 'qc_failed', qc_passed: false,
          qc_notes: result.issues.join(', '), draft_message: result.draft
        }).eq('id', queueItemId)
        return { status: 'skipped', reason: 'qc_failed', issues: result.issues }
      }
      return skipItem(result.reason)
    }
    finalMessage = result.finalMessage
    draft = result.draft
    qcPassed = result.qcPassed
    qcNotes = result.qcNotes
  } else if (!preWritten) {
    const result = await generateFollowupDraft(supabase, item, contact, business, pack, conv)
    if (!result.ok) {
      if (result.reason === 'qc_failed') {
        await supabase.from('follow_up_queue').update({
          status: 'skipped',
          skip_reason: 'qc_failed',
          qc_passed: false,
          qc_notes: result.issues.join(', '),
          draft_message: result.draft
        }).eq('id', queueItemId)
        return { status: 'skipped', reason: 'qc_failed', issues: result.issues }
      }
      return skipItem(result.reason)
    }
    finalMessage = result.finalMessage
    draft = result.draft
    qcPassed = result.qcPassed
    qcNotes = result.qcNotes
  }
  // else: preWritten && !ai_rewrite_enabled — owner wrote it verbatim, used as-is below

  // ── 17a. Owner-written bypass ───────────────────────────────────
  // "If I wrote a follow-up message myself, let it go through" — a
  // message the owner authored directly, with AI rewrite off, skips the
  // AI zone-approval system entirely.
  if (item.authored_by === 'human' && !item.ai_rewrite_enabled) {
    await updateQueueItem({
      status: 'ready_to_send',
      channel: business.whatsapp_channel,
      final_message: finalMessage,
      draft_message: draft,
      qc_passed: qcPassed,
      approval_status: 'approved',
      media: item.media
    })

    console.log(`[Worker] Owner-written message ready to send — step:${item.sequence_step} | contact:${item.contact_id}`)
    return { status: 'ready_to_send', step: item.sequence_step, channel: business.whatsapp_channel }
  }

  // ── 17b. Determine approval zone ─────────────────────────────
  // AI-drafted or AI-rewritten content only — the owner's own zone-mode
  // preferences from the Follow-up tab's per-zone dropdowns.
  const ageDays = leadAgeDays(contact.created_at)
  const zoneRecent = business.followup_zone_recent ?? DEFAULT_ZONE_RECENT
  const zoneMedium = business.followup_zone_medium ?? DEFAULT_ZONE_MEDIUM

  const zoneRecentMode = business.followup_zone_recent_mode ?? 'approval'
  const zoneMediumMode = business.followup_zone_medium_mode ?? 'manual'
  const zoneOldMode = business.followup_zone_old_mode ?? 'auto'

  const zone = ageDays > zoneMedium ? zoneOldMode : ageDays > zoneRecent ? zoneMediumMode : zoneRecentMode

  // ── 18. Route based on approval zone ─────────────────────────
  if (zone === 'auto') {
    await updateQueueItem({
      status: 'ready_to_send',
      channel: business.whatsapp_channel,
      final_message: finalMessage,
      draft_message: draft,
      qc_passed: qcPassed,
      approval_status: 'approved',
      media: item.media
    })

    console.log(`[Worker] Ready to send — channel:${business.whatsapp_channel} | step:${item.sequence_step} | contact:${item.contact_id}`)
    return { status: 'ready_to_send', step: item.sequence_step, zone: 'auto', channel: business.whatsapp_channel }
  }

  // Approval or manual zone — save as draft for owner
  await supabase.from('follow_up_queue').update({
    approval_status: 'awaiting_approval',
    draft_message: finalMessage,
    qc_passed: qcPassed,
    qc_notes: qcNotes
  }).eq('id', queueItemId)

  console.log(`[Worker] Draft saved — zone:${zone} | step:${item.sequence_step} | contact:${item.contact_id}`)
  return { status: 'awaiting_approval', zone, step: item.sequence_step }
}