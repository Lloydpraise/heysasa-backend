import { getBusiness, getContactsByIds, getConversationsByContactIds } from '../lib/db.js'
import { resolveMediaMergeFields, resolveMergeFields } from '../lib/mergeFields.js'
import { isBusinessAwake } from '../lib/timing.js'
import { log } from '../lib/log.js'
import { NON_CUSTOMER_TYPES } from '../lib/leadTypes.js'
import { planAiEnrollment } from '../followupAi/campaignPlanner.js'

// Due enrollments handled per cycle. Everything a cycle needs is read in a handful of requests and the queue
// rows are written together, so this can be large without the request count growing with it.
const BATCH_SIZE = parseInt(process.env.CAMPAIGN_BATCH_SIZE ?? '500')
const IN_CHUNK = 100          // ids per .in() filter (keeps the request URL short)
const INSERT_CHUNK = 200

const chunked = (items, size) => {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function pauseCampaign(supabase, campaignId, reason) {
  await supabase.from('campaigns')
    .update({ status: 'paused', failure_reason: reason, failed_at: null })
    .eq('id', campaignId)
    .in('status', ['active', 'paused'])
}

// Nothing here fails a campaign anymore — an instance/session problem
// just means its items wait (see the whatsapp_sessions check inline
// below and in worker.js). The only thing that actively pauses a
// campaign now is the business's own follow-up toggle, see
// syncCampaignsWithFollowupToggle.
async function syncCampaignsWithFollowupToggle(supabase) {
  const { data: businesses, error } = await supabase
    .from('businesses')
    .select('business_id, followup_ai_enabled')
  if (error) {
    log('error', 'engine', 'campaign_scheduler.toggle_lookup_failed', `followup_ai_enabled lookup failed: ${error.message}`, { details: { error: error.message } })
    return
  }

  const disabledIds = (businesses ?? []).filter(b => !b.followup_ai_enabled).map(b => b.business_id)
  const enabledIds = (businesses ?? []).filter(b => b.followup_ai_enabled).map(b => b.business_id)

  if (disabledIds.length) {
    const { data: paused } = await supabase
      .from('campaigns')
      .update({ status: 'paused', failure_reason: 'followup_ai_disabled', failed_at: null })
      .in('business_id', disabledIds)
      .eq('status', 'active')
      .select('id')
    if (paused?.length) log('info', 'engine', 'campaign_scheduler.paused', `Paused ${paused.length} campaign(s) — follow-ups disabled`, { details: { count: paused.length, campaignIds: paused.map(p => p.id) } })
  }

  if (enabledIds.length) {
    const { data: resumed } = await supabase
      .from('campaigns')
      .update({ status: 'active', failure_reason: null, failed_at: null })
      .in('business_id', enabledIds)
      .eq('status', 'paused')
      .eq('failure_reason', 'followup_ai_disabled')
      .select('id')
    if (resumed?.length) log('info', 'engine', 'campaign_scheduler.resumed', `Resumed ${resumed.length} campaign(s) — follow-ups re-enabled`, { details: { count: resumed.length, campaignIds: resumed.map(r => r.id) } })
  }
}

// Retryable send failures (anything except "not on WhatsApp") are handled
// directly by postSend.js's recordFailedDispatch now — they stay
// ready_to_send with scheduled_at pushed ~1h out, so this scheduler
// doesn't need a separate sweep to bring them back.

async function seedCampaignEnrollments(supabase) {
  const { data: campaigns, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, business_id, list_id, whatsapp_instance_name, status')
    .in('status', ['active', 'paused'])
    .not('list_id', 'is', null)
    .order('created_at', { ascending: true })

  if (campaignError) throw new Error(`Active campaign lookup failed: ${campaignError.message}`)

  let enrolled = 0
  for (const campaign of campaigns ?? []) {
    if (campaign.status === 'paused') {
      continue
    }
    // whatsapp_sessions is the source of truth — no live Evolution ping.
    // No connected session yet just means wait, nothing pauses or fails
    // the campaign over it.
    if (campaign.whatsapp_instance_name) {
      const { data: connectedSession } = await supabase
        .from('whatsapp_sessions')
        .select('instance_name')
        .eq('business_id', campaign.business_id)
        .eq('instance_name', campaign.whatsapp_instance_name)
        .eq('status', 'connected')
        .maybeSingle()
      if (!connectedSession) continue
    }
    const { data: members, error: memberError } = await supabase
      .from('list_members')
      .select('lead_id')
      .eq('list_id', campaign.list_id)

    if (memberError) {
      log('error', 'engine', 'campaign_scheduler.list_lookup_failed', `List lookup failed for campaign ${campaign.id}: ${memberError.message}`, {
        entity_id: campaign.id, details: { error: memberError.message }
      })
      continue
    }

    const leadIds = [...new Set((members ?? []).map(member => member.lead_id))]
    if (!leadIds.length) continue

    const [{ data: contacts, error: contactsError }, { data: existingOpen, error: existingError }, { data: existingHere, error: hereError }] = await Promise.all([
      supabase.from('contacts').select('id, business_id, do_not_contact, wa_exists, lead_type').in('id', leadIds),
      supabase.from('campaign_enrollments').select('lead_id, campaign_id')
        .in('lead_id', leadIds).in('status', ['pending', 'active', 'awaiting_opt_in']),
      // Any status, this campaign only: a completed/exited enrollment still
      // occupies UNIQUE(campaign_id, lead_id) and would fail the whole batch insert.
      supabase.from('campaign_enrollments').select('lead_id').eq('campaign_id', campaign.id).in('lead_id', leadIds)
    ])
    const existing = [...(existingOpen ?? []), ...(existingHere ?? [])]

    if (contactsError) {
      log('error', 'engine', 'campaign_scheduler.contact_lookup_failed', `Contact lookup failed for campaign ${campaign.id}: ${contactsError.message}`, {
        entity_id: campaign.id, details: { error: contactsError.message }
      })
      continue
    }
    if (existingError || hereError) {
      log('error', 'engine', 'campaign_scheduler.enrollment_lookup_failed', `Enrollment lookup failed for campaign ${campaign.id}: ${(existingError || hereError).message}`, {
        entity_id: campaign.id, details: { error: (existingError || hereError).message }
      })
      continue
    }

    const contactsById = new Map((contacts ?? []).map(contact => [contact.id, contact]))
    const existingByLead = new Map((existing ?? []).map(enrollment => [enrollment.lead_id, enrollment]))
    const rows = []
    for (const leadId of leadIds) {
      const contact = contactsById.get(leadId)
      // Personal chats, suppliers, staff and spam are never enrolled, even if they ended up on a list.
      if (!contact || contact.business_id !== campaign.business_id || contact.do_not_contact || contact.wa_exists === false || NON_CUSTOMER_TYPES.has(contact.lead_type) || existingByLead.has(leadId)) continue
      rows.push({
        campaign_id: campaign.id,
        lead_id: leadId,
        status: 'pending',
        current_step: 0,
        next_send_at: null
      })
    }

    if (!rows.length) continue
    const { error: enrollmentError } = await supabase
      .from('campaign_enrollments')
      .insert(rows, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true })

    if (enrollmentError) {
      if (enrollmentError.code === '23505' || enrollmentError.code === 'P0001') {
        log('debug', 'engine', 'campaign_scheduler.enrollment_conflict', `Skipped conflicting enrollments for campaign ${campaign.id}: ${enrollmentError.message}`, {
          entity_id: campaign.id, details: { code: enrollmentError.code }
        })
      } else {
        log('error', 'engine', 'campaign_scheduler.enrollment_insert_failed', `Enrollment insert failed for campaign ${campaign.id}: ${enrollmentError.message}`, {
          entity_id: campaign.id, details: { error: enrollmentError.message }
        })
      }
      continue
    }

    enrolled += rows.length
    log('info', 'engine', 'campaign_scheduler.enrolled', `Enrolled ${rows.length} contacts in campaign ${campaign.id}`, {
      entity_id: campaign.id, details: { count: rows.length }
    })
  }

  return enrolled
}

// campaigns/campaign_steps/campaign_enrollments are the live, populated
// system (confirmed via Supabase — follow_up_sequences/follow_up_steps,
// which generateDraft.js and reconciliation.js already reference, are
// empty). Nothing anywhere turns a due campaign_enrollments row into an
// actual follow_up_queue item — this is that piece.
//
// Queues the next due step as a 'pending' row with final_message
// pre-filled from campaign_steps.content, so worker.js (01) skips AI
// drafting/QC for it but still applies its real eligibility, quiet-hours,
// and antiban gating before handing off to the sender (02). NOTE: this
// also means campaign sends currently go through worker.js's zone-based
// approval routing same as AI-drafted follow-ups — flag if campaigns
// should instead always auto-send regardless of zone.
export async function runCampaignScheduler(supabase, { seed = true } = {}) {
  const now = new Date().toISOString()

  // followup_ai_enabled is now an active blocker for campaigns: off
  // pauses them, back on resumes them (and their stalled items pick
  // right back up, since nothing marked them permanently dead).
  await syncCampaignsWithFollowupToggle(supabase)

  const seeded = seed ? await seedCampaignEnrollments(supabase) : 0
  if (seeded) log('info', 'engine', 'campaign_scheduler.seeded', `Seeded ${seeded} campaign enrollments`, { details: { seeded } })

  const { data: due, error } = await supabase
    .from('campaign_enrollments')
    .select('id, campaign_id, lead_id, current_step, status, step_order, schedule_reason')
    .in('status', ['pending', 'active'])
    .or(`next_send_at.is.null,next_send_at.lte.${now}`)
    .limit(BATCH_SIZE)

  if (error) {
    log('error', 'engine', 'campaign_scheduler.enrollment_fetch_failed', `Enrollment fetch failed: ${error.message}`, { details: { error: error.message } })
    return { queued: 0, error: error.message }
  }
  if (!due?.length) return { queued: 0 }

  // ── Read everything this cycle needs, once ────────────────────────────────────────
  // (previously ~6 requests per enrollment: campaign, business, session, step, contact, dedupe, conversation)
  const campaignIds = [...new Set(due.map(e => e.campaign_id))]
  const campaignsById = new Map()
  for (const ids of chunked(campaignIds, IN_CHUNK)) {
    const { data, error: campaignError } = await supabase
      .from('campaigns')
      .select('id, business_id, status, whatsapp_instance_name, ai_managed, min_gap_hours')
      .in('id', ids)
    if (campaignError) {
      log('error', 'engine', 'campaign_scheduler.campaign_lookup_failed', `Campaign lookup failed: ${campaignError.message}`, { details: { error: campaignError.message } })
      return { queued: 0, error: campaignError.message }
    }
    for (const row of data ?? []) campaignsById.set(row.id, row)
  }
  for (const id of campaignIds) {
    if (!campaignsById.has(id)) {
      log('warn', 'engine', 'campaign_scheduler.campaign_not_found', `Skipped enrollments: campaign ${id} not found`, { details: { campaignId: id } })
    }
  }

  const activeCampaigns = [...campaignsById.values()].filter(c => c.status === 'active')
  if (!activeCampaigns.length) return { queued: 0 }
  const businessIds = [...new Set(activeCampaigns.map(c => c.business_id))]

  // Sleep mode — a business in quiet hours (or on an inactive day) just has its due items left alone this cycle.
  const awakeByBusiness = new Map()
  for (const ids of chunked(businessIds, IN_CHUNK)) {
    const { data } = await supabase
      .from('businesses')
      .select('business_id, timezone, followup_quiet_start, followup_quiet_end, followup_active_days')
      .in('business_id', ids)
    for (const business of data ?? []) awakeByBusiness.set(business.business_id, isBusinessAwake(business))
  }
  const isAwake = (businessId) => awakeByBusiness.get(businessId) ?? true

  // whatsapp_sessions is the source of truth — no live Evolution ping, nothing pauses or fails the campaign over it.
  const connected = new Set()
  if (activeCampaigns.some(c => c.whatsapp_instance_name)) {
    for (const ids of chunked(businessIds, IN_CHUNK)) {
      const { data } = await supabase
        .from('whatsapp_sessions')
        .select('business_id, instance_name')
        .in('business_id', ids)
        .eq('status', 'connected')
      for (const row of data ?? []) connected.add(`${row.business_id}|${row.instance_name}`)
    }
  }

  const eligible = due.filter((enrollment) => {
    const campaign = campaignsById.get(enrollment.campaign_id)
    if (!campaign || campaign.status !== 'active') return false
    if (!isAwake(campaign.business_id)) return false
    if (campaign.whatsapp_instance_name && !connected.has(`${campaign.business_id}|${campaign.whatsapp_instance_name}`)) return false
    return true
  })
  if (!eligible.length) return { queued: 0 }

  const stepsByKey = new Map()
  for (const ids of chunked([...new Set(eligible.map(e => e.campaign_id))], IN_CHUNK)) {
    const { data, error: stepError } = await supabase
      .from('campaign_steps')
      .select('campaign_id, step_number, content, media, delay_hours')
      .in('campaign_id', ids)
    if (stepError) {
      log('error', 'engine', 'campaign_scheduler.step_lookup_failed', `Step lookup failed: ${stepError.message}`, { details: { error: stepError.message } })
      return { queued: 0, error: stepError.message }
    }
    for (const step of data ?? []) stepsByKey.set(`${step.campaign_id}|${step.step_number}`, step)
  }

  // Which enrollments have no further step (finished) and which still have one to send.
  // Follow-up AI campaigns keep their own per-lead step order and send time, so the planner decides for them.
  const finishedEnrollments = []
  const withStep = []
  const businessCache = new Map()
  for (const enrollment of eligible) {
    const campaign = campaignsById.get(enrollment.campaign_id)
    let step
    let nextStepNumber = (enrollment.current_step ?? 0) + 1
    if (campaign.ai_managed) {
      let business = businessCache.get(campaign.business_id)
      if (!business) { business = await getBusiness(supabase, campaign.business_id); businessCache.set(campaign.business_id, business) }
      if (!business) continue
      const planned = await planAiEnrollment(supabase, { enrollment, campaign, business })
      if (planned.action === 'wait') continue
      step = planned.action === 'queue' ? planned.step : null
      if (step) nextStepNumber = step.step_number
    } else {
      step = stepsByKey.get(`${enrollment.campaign_id}|${nextStepNumber}`)
    }
    if (!step) finishedEnrollments.push({ enrollment, nextStepNumber })
    else withStep.push({ enrollment, step })
  }

  if (finishedEnrollments.length) {
    const finishedCampaigns = new Map()
    for (const { enrollment, nextStepNumber } of finishedEnrollments) {
      finishedCampaigns.set(enrollment.campaign_id, nextStepNumber - 1)
    }
    for (const ids of chunked(finishedEnrollments.map(f => f.enrollment.id), IN_CHUNK)) {
      await supabase.from('campaign_enrollments').update({ status: 'completed' }).in('id', ids)
    }
    for (const [campaignId, finalStep] of finishedCampaigns) {
      log('info', 'engine', 'campaign_scheduler.enrollment_completed', `Completed enrollments for campaign ${campaignId}: no step after ${finalStep}`, {
        entity_id: campaignId, details: { campaignId, finalStep, enrollments: finishedEnrollments.filter(f => f.enrollment.campaign_id === campaignId).length }
      })
      const { error: completionError } = await supabase.rpc('complete_campaign_if_finished', { target_campaign_id: campaignId })
      if (completionError) {
        log('error', 'engine', 'campaign_scheduler.completion_check_failed', `Campaign completion check failed for ${campaignId}: ${completionError.message}`, {
          entity_id: campaignId, details: { error: completionError.message }
        })
      }
    }
  }
  if (!withStep.length) return { queued: 0 }

  const leadIds = [...new Set(withStep.map(({ enrollment }) => enrollment.lead_id))]
  const contactsById = await getContactsByIds(supabase, leadIds)

  // Dedupe — guards against a slow cycle overlapping the next one and double-queuing the same step.
  const existingQueue = new Set()
  const stepCampaignIds = [...new Set(withStep.map(({ enrollment }) => enrollment.campaign_id))]
  for (const ids of chunked(leadIds, IN_CHUNK)) {
    for (const campaignChunk of chunked(stepCampaignIds, IN_CHUNK)) {
      const { data, error: existingError } = await supabase
        .from('follow_up_queue')
        .select('campaign_id, contact_id, campaign_step')
        .in('contact_id', ids)
        .in('campaign_id', campaignChunk)
        .in('status', ['pending', 'ready_to_send', 'sending', 'sent', 'failed'])
      if (existingError) {
        log('error', 'engine', 'campaign_scheduler.dedupe_lookup_failed', `Queue dedupe lookup failed: ${existingError.message}`, { details: { error: existingError.message } })
        return { queued: 0, error: existingError.message }
      }
      for (const row of data ?? []) existingQueue.add(`${row.campaign_id}|${row.contact_id}|${row.campaign_step}`)
    }
  }

  const conversations = await getConversationsByContactIds(supabase, leadIds)

  // ── Decide per enrollment (in memory) ──────────────────────────────────────────
  const exitedIds = []
  const toQueue = []   // { enrollment, row }
  for (const { enrollment, step } of withStep) {
    const campaign = campaignsById.get(enrollment.campaign_id)
    const contact = contactsById.get(enrollment.lead_id)
    if (!contact) {
      log('warn', 'engine', 'campaign_scheduler.contact_not_found', `Skipped enrollment ${enrollment.id}: contact ${enrollment.lead_id} not found`, {
        entity_id: enrollment.id, details: { leadId: enrollment.lead_id }
      })
      continue
    }
    // Known not to be on WhatsApp: nothing will ever go, so close their spot instead of leaving it stuck.
    if (contact.wa_exists === false) { exitedIds.push(enrollment.id); continue }
    if (existingQueue.has(`${enrollment.campaign_id}|${enrollment.lead_id}|${step.step_number}`)) {
      log('debug', 'engine', 'campaign_scheduler.dedupe_skip', `Skipped enrollment ${enrollment.id}: queue item already exists for step ${step.step_number}`, {
        entity_id: enrollment.id, details: { step: step.step_number }
      })
      continue
    }
    try {
      const conv = conversations.get(`${campaign.business_id}|${enrollment.lead_id}`)
      toQueue.push({
        enrollment,
        row: {
          business_id: campaign.business_id,
          contact_id: enrollment.lead_id,
          conversation_id: conv?.id ?? null,
          campaign_id: enrollment.campaign_id,
          campaign_step: step.step_number,
          sequence_step: step.step_number,
          touchpoint_type: 'campaign',
          klt_phase: campaign.ai_managed ? (step.klt_phase ?? 'know') : 'know',
          final_message: resolveMergeFields(step.content, contact),
          media: resolveMediaMergeFields(step.media, contact),
          assigned_instance_name: campaign.whatsapp_instance_name,
          approval_status: 'approved',
          status: 'pending',
          scheduled_at: now
        }
      })
    } catch (e) {
      log('error', 'engine', 'campaign_scheduler.error', `Error for enrollment ${enrollment.id}: ${e.message}`, {
        entity_id: enrollment.id, details: { error: { name: e.name, message: e.message } }
      })
    }
  }

  for (const ids of chunked(exitedIds, IN_CHUNK)) {
    await supabase.from('campaign_enrollments').update({ status: 'exited' }).in('id', ids)
  }

  // ── Write: all queue rows together; a rejected batch is retried row by row so one bad row cannot block the rest ──
  let queued = 0
  const activated = []
  for (const part of chunked(toQueue, INSERT_CHUNK)) {
    const { error: bulkError } = await supabase.from('follow_up_queue').insert(part.map(p => p.row))
    if (!bulkError) {
      queued += part.length
      for (const { enrollment } of part) if (enrollment.status === 'pending') activated.push(enrollment.id)
      continue
    }
    log('warn', 'engine', 'campaign_scheduler.bulk_insert_retry', `Bulk queue insert of ${part.length} rows failed (${bulkError.message}); retrying row by row`, {
      details: { error: bulkError.message, code: bulkError.code, rows: part.length }
    })
    for (const { enrollment, row } of part) {
      const { error: queueError } = await supabase.from('follow_up_queue').insert(row)
      if (queueError) {
        log('error', 'engine', 'campaign_scheduler.queue_insert_failed', `Queue insert failed for enrollment ${enrollment.id}: ${queueError.message}`, {
          entity_id: enrollment.id, details: { error: queueError.message }
        })
        continue
      }
      queued++
      if (enrollment.status === 'pending') activated.push(enrollment.id)
    }
  }
  for (const ids of chunked(activated, IN_CHUNK)) {
    await supabase.from('campaign_enrollments').update({ status: 'active' }).in('id', ids)
  }

  if (queued) log('info', 'engine', 'campaign_scheduler.cycle_completed', `Cycle completed: queued ${queued}/${due.length}`, { details: { queued, total: due.length } })
  return { queued }
}
