// The Follow-up AI's part of the campaign scheduler. For an AI-managed campaign, the scheduler asks this for every due
// enrollment instead of simply taking "current step + 1":
//   * the first time, it plans WHEN the lead's first step goes (their active hours, after the silence gate)
//   * every time, it checks the lead is ready (silent long enough, minimum gap kept, nobody asked for a hold)
//     and if not, moves the send to a proper time instead of queueing a message that would only be skipped
//   * it picks the step from the lead's own order (the director may have reordered it)

import { getContact, getConversation } from '../lib/db.js'
import { computeNextSend, checkSendReady } from './scheduling.js'
import { nextStepNumber } from './stepPlan.js'
import { logTurn } from './turns.js'

const stepsCache = new Map() // campaign_id -> { at, steps }
const STEPS_TTL_MS = 15_000

export async function loadCampaignSteps(supabase, campaignId) {
  const hit = stepsCache.get(campaignId)
  if (hit && Date.now() - hit.at < STEPS_TTL_MS) return hit.steps
  const { data } = await supabase.from('campaign_steps')
    .select('step_number, content, media, delay_hours, klt_phase, touchpoint_type')
    .eq('campaign_id', campaignId).order('step_number', { ascending: true })
  const steps = data ?? []
  stepsCache.set(campaignId, { at: Date.now(), steps })
  return steps
}

async function replan(supabase, { enrollment, campaign, business, contact, lastInboundAt, delayHours, reasonPrefix }) {
  const plan = await computeNextSend(supabase, { business, contact, campaign, delayHours, lastInboundAt })
  await supabase.from('campaign_enrollments')
    .update({ next_send_at: plan.at.toISOString(), schedule_reason: `${reasonPrefix}:${plan.reason}` })
    .eq('id', enrollment.id)
  await logTurn(supabase, {
    businessId: business.business_id, contactId: contact.id, campaignId: campaign.id, kind: 'schedule',
    decision: reasonPrefix === 'first_plan' ? 'planned' : 'deferred', reason: plan.reason,
    details: { at: plan.at.toISOString(), gapHours: plan.gapHours, silenceHours: plan.silenceHours },
  })
  return plan
}

// -> { action: 'wait' } | { action: 'complete' } | { action: 'queue', step }
export async function planAiEnrollment(supabase, { enrollment, campaign, business }) {
  const contact = await getContact(supabase, enrollment.lead_id)
  if (!contact) return { action: 'wait' }
  const conv = await getConversation(supabase, enrollment.lead_id, campaign.business_id)
  const lastInboundAt = conv?.last_user_message_at ?? null

  const steps = await loadCampaignSteps(supabase, campaign.id)
  const next = nextStepNumber(enrollment, steps.map(s => s.step_number))
  if (next == null) return { action: 'complete' }
  const step = steps.find(s => s.step_number === next)

  // never planned by the Follow-up AI yet: choose the first send time
  if (!enrollment.schedule_reason) {
    await replan(supabase, { enrollment, campaign, business, contact, lastInboundAt, delayHours: Number(step.delay_hours ?? 0), reasonPrefix: 'first_plan' })
    return { action: 'wait' }
  }

  const ready = await checkSendReady(supabase, { business, contact, campaign, lastInboundAt })
  if (!ready.ready) {
    await replan(supabase, { enrollment, campaign, business, contact, lastInboundAt, delayHours: 0, reasonPrefix: ready.why })
    return { action: 'wait' }
  }
  return { action: 'queue', step }
}
