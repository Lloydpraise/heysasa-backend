import { getContact, getConversation } from '../lib/db.js'
import { resolveMediaMergeFields, resolveMergeFields } from '../lib/mergeFields.js'
import { checkInstanceStatus } from '../lib/instanceHealth.js'

const BATCH_SIZE = 30
const CAMPAIGN_SEED_INTERVAL_MS = parseInt(process.env.CAMPAIGN_SEED_INTERVAL_MS ?? `${5 * 60_000}`)
let lastCampaignSeedAt = 0

async function pauseCampaign(supabase, campaignId, reason) {
  await supabase.from('campaigns')
    .update({ status: 'paused', failure_reason: reason, failed_at: null })
    .eq('id', campaignId)
    .in('status', ['active', 'paused'])
}

async function failCampaign(supabase, campaignId, reason) {
  await supabase.from('campaigns').update({ status: 'failed', failure_reason: reason, failed_at: new Date().toISOString() }).eq('id', campaignId).eq('status', 'active')
  await supabase.from('follow_up_queue')
    .update({ status: 'failed', last_dispatch_error: reason })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'ready_to_send', 'sending'])
}

async function retryFailedCampaignItems(supabase, campaignId) {
  const { data: failedItems, error } = await supabase
    .from('follow_up_queue')
    .select('id, contact_id, campaign_step, last_dispatch_error')
    .eq('campaign_id', campaignId)
    .eq('status', 'failed')
    .order('created_at', { ascending: true })

  if (error) {
    console.error(`[CampaignScheduler] Failed queue lookup for campaign ${campaignId}: ${error.message}`)
    return
  }

  if (!failedItems?.length) return

  const idsToRetry = []
  for (const item of failedItems) {
    const msg = item.last_dispatch_error ?? ''
    if (msg.includes('exists') && msg.includes('false')) continue
    if (msg.includes('not on whatsapp') || msg.includes('not registered')) continue

    const { data: existing, error: duplicateError } = await supabase
      .from('follow_up_queue')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('contact_id', item.contact_id)
      .eq('campaign_step', item.campaign_step)
      .in('status', ['pending', 'ready_to_send', 'sending', 'sent'])
      .maybeSingle()

    if (duplicateError) {
      console.error(`[CampaignScheduler] Duplicate check failed for ${campaignId}/${item.contact_id}/${item.campaign_step}: ${duplicateError.message}`)
      continue
    }
    if (existing) continue

    idsToRetry.push(item.id)
  }

  if (!idsToRetry.length) return

  const { error: retryError } = await supabase
    .from('follow_up_queue')
    .update({
      status: 'pending',
      scheduled_at: new Date().toISOString(),
      skip_reason: null,
      last_dispatch_error: null,
      approval_status: 'approved'
    })
    .in('id', idsToRetry)

  if (retryError) {
    console.error(`[CampaignScheduler] Could not requeue failed campaign items for ${campaignId}: ${retryError.message}`)
    return
  }

  console.log(`[CampaignScheduler] Requeued ${idsToRetry.length} recoverable failed items for campaign ${campaignId}`)
}

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
    const instanceStatus = await checkInstanceStatus(supabase, campaign)
    if (instanceStatus === 'retry') continue
    if (instanceStatus === 'paused') {
      console.warn(`[CampaignScheduler] Campaign ${campaign.id} paused: selected WhatsApp instance unavailable after grace window`)
      await pauseCampaign(supabase, campaign.id, 'campaign_instance_unavailable')
      continue
    }
    if (instanceStatus === 'failed') {
      console.error(`[CampaignScheduler] Campaign ${campaign.id} failed: selected WhatsApp instance remained unavailable after pause/retry grace period`)
      await failCampaign(supabase, campaign.id, 'campaign_instance_unavailable')
      continue
    }
    if (campaign.status === 'paused') {
      continue
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

  const activeCampaignIds = new Set((due ?? []).map(item => item.campaign_id))
  for (const campaignId of activeCampaignIds) {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, status')
      .eq('id', campaignId)
      .single()

    if (campaign?.status === 'active') {
      await retryFailedCampaignItems(supabase, campaignId)
    }
  }

  let queued = 0
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
      const instanceStatus = await checkInstanceStatus(supabase, campaign)
      if (instanceStatus === 'retry') continue
      if (instanceStatus === 'paused') {
        await pauseCampaign(supabase, campaign.id, 'campaign_instance_unavailable')
        continue
      }
      if (instanceStatus === 'failed') {
        await failCampaign(supabase, campaign.id, 'campaign_instance_unavailable')
        continue
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