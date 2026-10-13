// Moves an AI-managed enrollment forward after a step was sent (or deliberately skipped) and plans the next send.

import { getConversation } from '../lib/db.js'
import { computeNextSend } from './scheduling.js'
import { afterSend } from './stepPlan.js'
import { log } from '../lib/log.js'

export async function advanceAiEnrollment(supabase, { campaignId, contact, business, campaign = null, sentStep, tag = 'after_send' }) {
  const { data: enrollment } = await supabase.from('campaign_enrollments')
    .select('id, current_step, step_order').eq('campaign_id', campaignId).eq('lead_id', contact.id).maybeSingle()
  if (!enrollment) return { ok: false, reason: 'no_enrollment' }

  const { data: steps } = await supabase.from('campaign_steps').select('step_number, delay_hours').eq('campaign_id', campaignId)
  const numbers = (steps ?? []).map(s => s.step_number)
  const { position, hasMore, nextStep } = afterSend(enrollment, sentStep, numbers)

  if (!hasMore) {
    await supabase.from('campaign_enrollments').update({ current_step: position, status: 'completed' }).eq('id', enrollment.id)
    const { error } = await supabase.rpc('complete_campaign_if_finished', { target_campaign_id: campaignId })
    if (error) log('error', 'sender', 'sender.completion_check_failed', `Campaign completion check failed for ${campaignId}: ${error.message}`, { business_id: business.business_id, entity_id: campaignId })
    return { ok: true, completed: true }
  }

  const conv = await getConversation(supabase, contact.id, business.business_id)
  const delay = Number(steps.find(s => s.step_number === nextStep)?.delay_hours ?? 24)
  const plan = await computeNextSend(supabase, { business, contact, campaign: campaign ?? { min_gap_hours: null }, delayHours: delay, lastInboundAt: conv?.last_user_message_at ?? null })
  await supabase.from('campaign_enrollments')
    .update({ current_step: position, next_send_at: plan.at.toISOString(), schedule_reason: `${tag}:${plan.reason}` })
    .eq('id', enrollment.id)
  return { ok: true, nextSendAt: plan.at, nextStep }
}
