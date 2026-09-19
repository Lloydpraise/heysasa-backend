import { getContact, getConversation } from '../lib/db.js'
import { resolveMediaMergeFields, resolveMergeFields } from '../lib/mergeFields.js'
import { isBusinessAwake } from '../lib/timing.js'

const BATCH_SIZE = 30
const CAMPAIGN_SEED_INTERVAL_MS = parseInt(process.env.CAMPAIGN_SEED_INTERVAL_MS ?? `${5 * 60_000}`)
let lastCampaignSeedAt = 0

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
    console.error(`[CampaignScheduler] followup_ai_enabled lookup failed: ${error.message}`)
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
    if (paused?.length) console.log(`[CampaignScheduler] Paused ${paused.length} campaign(s) — follow-ups disabled`)
  }

  if (enabledIds.length) {
    const { data: resumed } = await supabase
      .from('campaigns')
      .update({ status: 'active', failure_reason: null, failed_at: null })
      .in('business_id', enabledIds)
      .eq('status', 'paused')
      .eq('failure_reason', 'followup_ai_disabled')
      .select('id')
    if (resumed?.length) console.log(`[CampaignScheduler] Resumed ${resumed.length} campaign(s) — follow-ups re-enabled`)
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
      console.error(`[CampaignScheduler] List lookup failed for campaign ${campaign.id}: ${memberError.message}`)
      continue
    }

    const leadIds = [...new Set((members ?? []).map(member => member.lead_id))]
    if (!leadIds.length) continue

    const [{ data: contacts, error: contactsError }, { data: existing, error: existingError }] = await Promise.all([
      supabase.from('contacts').select('id, business_id').in('id', leadIds),
      supabase.from('campaign_enrollments').select('lead_id, campaign_id')
        .in('lead_id', leadIds).in('status', ['pending', 'active', 'awaiting_opt_in'])
    ])

    if (contactsError) {
      console.error(`[CampaignScheduler] Contact lookup failed for campaign ${campaign.id}: ${contactsError.message}`)
      continue
    }
    if (existingError) {
      console.error(`[CampaignScheduler] Enrollment lookup failed for campaign ${campaign.id}: ${existingError.message}`)
      continue
    }

    const contactsById = new Map((contacts ?? []).map(contact => [contact.id, contact]))
    const existingByLead = new Map((existing ?? []).map(enrollment => [enrollment.lead_id, enrollment]))
    const rows = []
    for (const leadId of leadIds) {
      const contact = contactsById.get(leadId)
      if (!contact || contact.business_id !== campaign.business_id || existingByLead.has(leadId)) continue
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
        console.log(`[CampaignScheduler] Skipped conflicting enrollments for campaign ${campaign.id}: ${enrollmentError.message}`)
      } else {
        console.error(`[CampaignScheduler] Enrollment insert failed for campaign ${campaign.id}: ${enrollmentError.message}`)
      }
      continue
    }

    enrolled += rows.length
    console.log(`[CampaignScheduler] Enrolled ${rows.length} contacts in campaign ${campaign.id}`)
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
export async function runCampaignScheduler(supabase) {
  const now = new Date().toISOString()
  console.log(`[CampaignScheduler] Cycle started at ${now}`)

  // followup_ai_enabled is now an active blocker for campaigns: off
  // pauses them, back on resumes them (and their stalled items pick
  // right back up, since nothing marked them permanently dead).
  await syncCampaignsWithFollowupToggle(supabase)

  let seeded = 0
  if (Date.now() - lastCampaignSeedAt >= CAMPAIGN_SEED_INTERVAL_MS) {
    seeded = await seedCampaignEnrollments(supabase)
    lastCampaignSeedAt = Date.now()
    if (seeded) console.log(`[CampaignScheduler] Seeded ${seeded} campaign enrollments`)
  }

  const { data: due, error } = await supabase
    .from('campaign_enrollments')
    .select('id, campaign_id, lead_id, current_step, status')
    .in('status', ['pending', 'active'])
    .or(`next_send_at.is.null,next_send_at.lte.${now}`)
    .limit(BATCH_SIZE)

  if (error) {
    console.error(`[CampaignScheduler] Enrollment fetch failed: ${error.message}`)
    return { queued: 0, error: error.message }
  }
  console.log(`[CampaignScheduler] Due enrollments found: ${due?.length ?? 0}`)
  if (!due?.length) return { queued: 0 }

  let queued = 0
  // Cache business-awake checks per cycle so a batch spanning many
  // enrollments for the same business only looks it up once.
  const awakeCache = new Map()
  for (const enrollment of due) {
    try {
      console.log(`[CampaignScheduler] Checking enrollment ${enrollment.id} campaign:${enrollment.campaign_id} lead:${enrollment.lead_id} step:${(enrollment.current_step ?? 0) + 1}`)
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('id, business_id, status, whatsapp_instance_name')
        .eq('id', enrollment.campaign_id)
        .single()
      if (!campaign) {
        console.warn(`[CampaignScheduler] Skipped enrollment ${enrollment.id}: campaign not found`)
        continue
      }
      if (campaign.status !== 'active') {
        console.warn(`[CampaignScheduler] Skipped enrollment ${enrollment.id}: campaign status is ${campaign.status}`)
        continue
      }

      // Sleep mode — a business in quiet hours (or on an inactive day)
      // just has its due items left alone this cycle, no per-item writes.
      if (!awakeCache.has(campaign.business_id)) {
        const { data: business } = await supabase
          .from('businesses')
          .select('timezone, followup_quiet_start, followup_quiet_end, followup_active_days')
          .eq('business_id', campaign.business_id)
          .maybeSingle()
        awakeCache.set(campaign.business_id, business ? isBusinessAwake(business) : true)
      }
      if (!awakeCache.get(campaign.business_id)) continue

      // whatsapp_sessions is the source of truth — no live Evolution
      // ping, and nothing here pauses or fails the campaign over it.
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

      const nextStepNumber = (enrollment.current_step ?? 0) + 1
      const { data: step } = await supabase
        .from('campaign_steps')
        .select('step_number, content, media, delay_hours')
        .eq('campaign_id', enrollment.campaign_id)
        .eq('step_number', nextStepNumber)
        .maybeSingle()

      if (!step) {
        // No more steps defined — campaign finished for this lead
        console.warn(`[CampaignScheduler] Completed enrollment ${enrollment.id}: step ${nextStepNumber} not found`)
        await supabase.from('campaign_enrollments').update({ status: 'completed' }).eq('id', enrollment.id)
        const { error: completionError } = await supabase.rpc('complete_campaign_if_finished', {
          target_campaign_id: enrollment.campaign_id
        })
        if (completionError) {
          console.error(`[CampaignScheduler] Campaign completion check failed for ${enrollment.campaign_id}: ${completionError.message}`)
        }
        continue
      }

      const contact = await getContact(supabase, enrollment.lead_id)
      if (!contact) {
        console.warn(`[CampaignScheduler] Skipped enrollment ${enrollment.id}: contact ${enrollment.lead_id} not found`)
        continue
      }

      // Dedupe — guards against a slow poll cycle overlapping the next one
      // and double-queuing the same step.
      const { data: existing } = await supabase
        .from('follow_up_queue')
        .select('id')
        .eq('campaign_id', enrollment.campaign_id)
        .eq('contact_id', enrollment.lead_id)
        .eq('campaign_step', step.step_number)
        .in('status', ['pending', 'ready_to_send', 'sending', 'sent', 'failed'])
        .maybeSingle()
      if (existing) {
        console.log(`[CampaignScheduler] Skipped enrollment ${enrollment.id}: queue item already exists for step ${step.step_number}`)
        continue
      }

      const conv = await getConversation(supabase, enrollment.lead_id, campaign.business_id)

      const { data: queueItem, error: queueError } = await supabase.from('follow_up_queue').insert({
        business_id: campaign.business_id,
        contact_id: enrollment.lead_id,
        conversation_id: conv?.id ?? null,
        campaign_id: enrollment.campaign_id,
        campaign_step: step.step_number,
        sequence_step: step.step_number,
        touchpoint_type: 'campaign',
        klt_phase: 'know',
        final_message: resolveMergeFields(step.content, contact),
        media: resolveMediaMergeFields(step.media, contact),
        assigned_instance_name: campaign.whatsapp_instance_name,
        approval_status: 'approved',
        status: 'pending',
        scheduled_at: now
      }).select('id').single()

      if (queueError) {
        console.error(`[CampaignScheduler] Queue insert failed for enrollment ${enrollment.id}: ${queueError.message}`)
        continue
      }

      queued++
      console.log(`[CampaignScheduler] Queue item created ${queueItem.id} for enrollment ${enrollment.id} step ${step.step_number}`)

      if (enrollment.status === 'pending') {
        await supabase.from('campaign_enrollments').update({ status: 'active' }).eq('id', enrollment.id)
      }
    } catch (e) {
      console.error(`[CampaignScheduler] Error for enrollment ${enrollment.id}: ${e.message}`)
    }
  }

  console.log(`[CampaignScheduler] Cycle completed: queued ${queued}/${due.length}`)
  return { queued }
}