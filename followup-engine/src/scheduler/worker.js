import {
  DEFAULT_DAILY_CAP, DEFAULT_MSG_COST, DEFAULT_ZONE_RECENT, DEFAULT_ZONE_MEDIUM, DEFAULT_MAX_PER_LEAD
} from '../config.js'
import {
  getBusiness, getContact, getPersonaPack, getConversation, getMessages, getBillingConfig, getDailyCount
} from '../lib/db.js'
import { checkBalance, flagInsufficientFunds } from '../lib/billing.js'
import { leadAgeDays, hoursSince } from '../lib/timing.js'
import { generateFollowupDraft, rewriteSuggestedMessage } from './generateDraft.js'
import { normalizeOutboundMedia } from '../lib/media.js'
import { resolveMediaMergeFields, resolveMergeFields } from '../lib/mergeFields.js'
import { log } from '../lib/log.js'

const STALL_RETRY_MS = 5 * 60_000

export async function runWorker(supabase, queueItemId) {
  if (!queueItemId) throw new Error('queue_item_id required')

  // `item` is assigned below, once loaded — declared here so the two
  // helpers below (defined before it's loaded, but only ever called
  // after most of the time) can log business_id/contact_id via closure
  // when it's available, and fall back to nulls for the handful of
  // very early checks (item_not_found, already_processed) where it isn't.
  let item

  const updateQueueItem = async (updates) => {
    const { error } = await supabase.from('follow_up_queue').update(updates).eq('id', queueItemId)
    if (error) throw new Error(`queue update failed: ${error.message}`)
  }

  // Permanent stop — will never be reconsidered (do-not-contact, deal
  // already closed, bad sentiment, structural queue-item problems).
  const skipItem = async (reason) => {
    await updateQueueItem({ status: 'skipped', skip_reason: reason })
    console.log(`[Worker] Skipped ${queueItemId} — ${reason}`)
    log('info', 'scheduler', 'scheduler.skip', `Skipped — ${reason}`, {
      business_id: item?.business_id ?? null, contact_id: item?.contact_id ?? null, entity_id: queueItemId,
      details: { reason, campaignId: item?.campaign_id ?? null }
    })
    return { status: 'skipped', reason }
  }

  // Temporary block — stays 'pending' and is retried automatically once
  // scheduled_at comes back due, instead of dying as a permanent skip.
  const stallItem = async (reason, retryInMs = STALL_RETRY_MS) => {
    await updateQueueItem({
      skip_reason: reason,
      scheduled_at: new Date(Date.now() + retryInMs).toISOString()
    })
    console.log(`[Worker] Stalled ${queueItemId} — ${reason} (retry in ${Math.round(retryInMs / 60_000)}m)`)
    log('debug', 'scheduler', 'scheduler.stall', `Stalled — ${reason}, retry in ${Math.round(retryInMs / 60_000)}m`, {
      business_id: item?.business_id ?? null, contact_id: item?.contact_id ?? null, entity_id: queueItemId,
      details: { reason, retryInMs, campaignId: item?.campaign_id ?? null }
    })
    return { status: 'stalled', reason }
  }

  // ── 1. Get queue item ────────────────────────────────────────
  const { data: loadedItem, error: itemErr } = await supabase
    .from('follow_up_queue').select('*').eq('id', queueItemId).single()
  item = loadedItem

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
      .from('campaigns').select('id, status, business_id, whatsapp_instance_name').eq('id', item.campaign_id).maybeSingle()
    if (campaignError) throw new Error(`campaign status lookup failed: ${campaignError.message}`)
    // Campaign not active right now (e.g. paused because follow-ups are
    // toggled off) — nothing here fails or pauses it further, just wait.
    if (!campaign || campaign.status !== 'active') return stallItem('campaign_inactive')
    const selectedInstance = item.assigned_instance_name || campaign.whatsapp_instance_name
    if (!selectedInstance) return stallItem('campaign_instance_unassigned')

    // whatsapp_sessions is the single source of truth for connection
    // state — a connected row is trusted as-is, no extra live ping. If
    // it's genuinely stale, the actual send attempt downstream will
    // fail for real and that gets retried on its own schedule.
    const { data: connectedSession } = await supabase
      .from('whatsapp_sessions')
      .select('instance_name')
      .eq('business_id', item.business_id)
      .eq('instance_name', selectedInstance)
      .eq('status', 'connected')
      .maybeSingle()
    if (!connectedSession) return stallItem('instance_not_connected')
    item.assigned_instance_name = selectedInstance
  }

  // ── 2. Load contact + business ───────────────────────────────
  const [contact, business] = await Promise.all([
    getContact(supabase, item.contact_id),
    getBusiness(supabase, item.business_id)
  ])

  // Structural/data problems — not eligibility rules, so still a
  // permanent skip: a deleted contact/business or a phone-less contact
  // won't fix itself by waiting.
  if (!contact) return skipItem('contact_not_found')
  if (!business) return skipItem('business_not_found')
  if (!contact.phone) return skipItem('no_phone')

  // Opt-out is the only permanent stop here. There's no separate
  // opt-in gate anymore — leads are treated as opted in by default;
  // opting a lead out happens explicitly from the lead detail panel
  // and is what sets do_not_contact.
  if (contact.do_not_contact) return skipItem('do_not_contact')

  // Business-level pause: this is now an active blocker (campaigns for
  // this business get paused at the scheduler level too — see
  // campaignScheduler.js), but a standalone follow-up just waits rather
  // than dying, so nothing is lost while the toggle is off.
  if (!business.followup_ai_enabled) return stallItem('followup_disabled')
  if (!business.subscription_active) return stallItem('subscription_inactive')

  // Deal already closed either way — more follow-ups are just noise/risk.
  if (['won', 'lost'].includes(contact.lead_state ?? '')) return skipItem(`lead_${contact.lead_state}`)

  // Stop at stage check
  const stopAtStage = business.followup_stop_at_stage
  if (stopAtStage) {
    const conv0 = await getConversation(supabase, item.contact_id, item.business_id)
    const isEcom0 = business.business_type === 'ecommerce'
    const currStage = isEcom0 ? conv0?.lead_stage_ecom : conv0?.lead_stage_service
    if (currStage === stopAtStage) return stallItem(`stopped_at_stage_${stopAtStage}`)
  }

  // ── 3. Max follow-ups check ───────────────────────────────────
  const maxPerLead = business.followup_max_per_lead ?? DEFAULT_MAX_PER_LEAD
  if ((contact.follow_up_count ?? 0) >= maxPerLead) return stallItem('max_followups_reached')

  // ── 4. Billing check ─────────────────────────────────────────
  const msgCost = await getBillingConfig(supabase, 'followup_message_cost_usd', DEFAULT_MSG_COST)
  const hasBalance = await checkBalance(supabase, item.business_id, msgCost)
  if (!hasBalance) {
    await flagInsufficientFunds(supabase, item.business_id)
    return stallItem('insufficient_balance')
  }

  // ── 5. Daily cap check ───────────────────────────────────────
  const dailyCap = business.followup_daily_cap ?? DEFAULT_DAILY_CAP
  const dailyCount = await getDailyCount(supabase, item.business_id)
  if (dailyCount >= dailyCap) return stallItem('daily_cap_reached')

  // ── 6. Load persona pack (Optional) ──────────────────────────
  const pack = await getPersonaPack(supabase, item.business_id)

  // Quiet hours / inactive days are no longer handled per item here —
  // the scheduler (scheduler.js / campaignScheduler.js) now checks
  // whether the business is awake at all *before* calling this worker,
  // so a business in quiet hours just doesn't have its items touched —
  // no per-item reschedule noise, everything picks back up together the
  // moment active hours return.

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
    finalMessage = resolveMergeFields(finalMessage, contact)
    item.media = resolveMediaMergeFields(item.media, contact)

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