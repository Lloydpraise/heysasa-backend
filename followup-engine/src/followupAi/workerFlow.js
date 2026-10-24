// What happens to a queue item that belongs to the Follow-up AI, at the moment it is due:
//   - a step of an AI-managed campaign (the director may change it)
//   - a follow-up the chat AI / Follow-up AI scheduled on its own (authored_by = 'ai_scheduled')
// worker.js has already done the eligibility checks (opt-out, balance, daily cap, max per lead, quiet hours...).
// This is the "is this still relevant?" step, then quality control, then the approval route.

import { resolveMergeFields, resolveMediaMergeFields } from '../lib/mergeFields.js'
import { loadLeadContext, factsText } from './leadContext.js'
import { loadSkills } from './skills.js'
import { needsDirector } from './decision.js'
import { runDirector } from './director.js'
import { writeFollowupMessage } from './writer.js'
import { qcMessage } from './qc.js'
import { formatTimeline } from './timeline.js'
import { computeNextSend } from './scheduling.js'
import { advanceAiEnrollment } from './advance.js'
import { remainingSteps, reorderNext } from './stepPlan.js'
import { logTurn } from './turns.js'
import { requestStageChange } from './stageAsk.js'

const AI_RETRY_MS = 10 * 60_000
const STEP_COLUMNS = 'step_number, content, media, delay_hours, klt_phase, touchpoint_type'

async function stopLead(supabase, { item, contact, kind, campaignId }) {
  const now = new Date().toISOString()
  if (kind === 'opt_out') {
    // same effect as the opt-out classifier: out of every campaign, no more follow-ups
    await supabase.from('contacts').update({ do_not_contact: true, follow_up_opted_out_at: now }).eq('id', contact.id)
    const { data: open } = await supabase.from('campaign_enrollments').select('id').eq('lead_id', contact.id).in('status', ['pending', 'active', 'awaiting_opt_in'])
    for (const e of open ?? []) {
      await supabase.from('campaign_enrollments').update({ status: 'completed' }).eq('id', e.id)
      await supabase.from('campaign_step_events').update({ opted_out_at: now }).eq('enrollment_id', e.id).is('opted_out_at', null)
    }
  } else if (kind === 'handoff') {
    // a person should take over: stop talking over them for a week
    await supabase.from('lead_ai_state').upsert({
      business_id: item.business_id, ...((item.account_id ?? contact.account_id) ? { account_id: item.account_id ?? contact.account_id } : {}),
      contact_id: contact.id, hold_until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      hold_reason: 'handed to the owner by the Follow-up AI', updated_at: now,
    }, { onConflict: 'business_id,contact_id' })
  } else if (campaignId) {
    await supabase.from('campaign_enrollments').update({ status: 'exited' }).eq('campaign_id', campaignId).eq('lead_id', contact.id).in('status', ['pending', 'active'])
  }
}

// Shared tail: quality control, then the approval route. `route` = 'ready_to_send' | 'awaiting_approval'.
async function finish(supabase, h, { item, contact, business, pack, ctx, message, media, route, skipAi, why, extraUpdate = {}, campaignId = null, stepNumber = null }) {
  const qc = await qcMessage(supabase, message, {
    businessId: item.business_id, accountId: item.account_id ?? contact.account_id ?? null, pack, contextText: factsText(ctx, pack),
    previousMessages: ctx.lastFollowups, timeline: formatTimeline(ctx.messages.slice(-12)), skipAi,
  })
  if (!qc.passed) {
    await supabase.from('follow_up_queue').update({
      status: 'skipped', skip_reason: 'qc_failed', qc_passed: false, qc_notes: qc.issues.join('; ').slice(0, 500), draft_message: message,
    }).eq('id', item.id)
    await logTurn(supabase, { businessId: item.business_id, accountId: item.account_id ?? contact.account_id ?? null, contactId: contact.id, campaignId, queueId: item.id, kind: 'qc', decision: 'failed', reason: qc.issues.join('; '), stepNumber })
    // campaigns skip a failing step and carry on with the next one; the owner is asked to fix it (Home)
    if (campaignId) await advanceAiEnrollment(supabase, { campaignId, contact, business, sentStep: stepNumber, tag: 'qc_failed' })
    return { status: 'skipped', reason: 'qc_failed', issues: qc.issues }
  }

  const base = { final_message: qc.finalMessage, draft_message: qc.finalMessage, qc_passed: true, qc_notes: qc.warnings?.map(w => w.detail).join('; ') || null, media, ai_intent: why ?? null, ...extraUpdate }
  if (route === 'ready_to_send') {
    await h.updateQueueItem({ ...base, status: 'ready_to_send', channel: business.whatsapp_channel, approval_status: 'approved' })
    return { status: 'ready_to_send', step: item.sequence_step, channel: business.whatsapp_channel }
  }
  await h.updateQueueItem({ ...base, approval_status: 'awaiting_approval' })
  return { status: 'awaiting_approval', step: item.sequence_step }
}

// ── A step of an AI-managed campaign ──────────────────────────────────────────────────────────────────────────────
export async function processAiManagedItem(supabase, h, { item, contact, business, pack, conv, campaign }) {
  const ctx = await loadLeadContext(supabase, { contact, business, conv })
  const [skills, { data: steps }, { data: enrollment }] = await Promise.all([
    loadSkills(supabase, item.business_id, 'director', item.account_id ?? contact.account_id ?? null),
    supabase.from('campaign_steps').select(STEP_COLUMNS).eq('campaign_id', item.campaign_id),
    supabase.from('campaign_enrollments').select('id, current_step, step_order').eq('campaign_id', item.campaign_id).eq('lead_id', item.contact_id).maybeSingle(),
  ])
  if (!enrollment) return h.skipItem('enrollment_missing')
  const numbers = (steps ?? []).map(s => s.step_number)
  const planned = (steps ?? []).find(s => s.step_number === item.campaign_step)
  if (!planned) return h.skipItem('step_missing')
  const remaining = remainingSteps(enrollment, numbers).map(n => steps.find(s => s.step_number === n)).filter(Boolean)
  if (!remaining.some(s => s.step_number === planned.step_number)) remaining.unshift(planned)

  const need = needsDirector({ messages: ctx.messages, since: ctx.lastFollowupAt, holdUntil: ctx.state?.hold_until, lastFeedback: ctx.state?.last_feedback })
  let decision = { action: 'send', reason: need.why, message: null, stepNumber: planned.step_number }
  if (need.needed) {
    const result = await runDirector(supabase, { business, contact, pack, conv, ctx, skills, planned, remaining, why: need.why })
    if (!result.ok) return h.stallItem('ai_unavailable', AI_RETRY_MS)
    decision = result.decision
  }
  await logTurn(supabase, {
    businessId: item.business_id, accountId: item.account_id ?? contact.account_id ?? null, contactId: contact.id, campaignId: item.campaign_id, queueId: item.id, kind: 'director',
    decision: decision.action, reason: decision.reason ?? need.why, stepNumber: planned.step_number,
    details: { called: need.needed, why: need.why, chosenStep: decision.stepNumber, downgraded: decision.downgraded === true, stageAsk: decision.stageAsk?.stage ?? null },
  })
  // The director saw the customer move on: ask for the stage change. Checked, billed and audited by the stage worker.
  if (decision.stageAsk) await requestStageChange(supabase, { businessId: item.business_id, accountId: item.account_id ?? contact.account_id ?? null, contact, conv, ask: decision.stageAsk })
  const lastInboundAt = conv?.last_user_message_at ?? null

  if (decision.action === 'reschedule') {
    await supabase.from('follow_up_queue').update({ status: 'cancelled', skip_reason: 'director_rescheduled' }).eq('id', item.id)
    const plan = await computeNextSend(supabase, { business, contact, campaign, delayHours: decision.delayHours ?? 24, lastInboundAt })
    await supabase.from('campaign_enrollments').update({ next_send_at: plan.at.toISOString(), schedule_reason: `director:${plan.reason}` }).eq('id', enrollment.id)
    return { status: 'rescheduled', until: plan.at.toISOString() }
  }
  if (decision.action === 'skip') {
    await supabase.from('follow_up_queue').update({ status: 'skipped', skip_reason: 'director_skip' }).eq('id', item.id)
    await advanceAiEnrollment(supabase, { campaignId: item.campaign_id, contact, business, campaign, sentStep: planned.step_number, tag: 'director_skip' })
    return { status: 'skipped', reason: 'director_skip' }
  }
  if (decision.action === 'stop') {
    await stopLead(supabase, { item, contact, kind: decision.stopKind, campaignId: item.campaign_id })
    await supabase.from('follow_up_queue').update({ status: 'skipped', skip_reason: `director_stop_${decision.stopKind}` }).eq('id', item.id)
    return { status: 'skipped', reason: `director_stop_${decision.stopKind}` }
  }

  let stepNumber = planned.step_number
  let message = item.final_message || item.draft_message || ''
  let media = item.media
  let extraUpdate = {}
  if (decision.action === 'reorder') {
    const chosen = steps.find(s => s.step_number === decision.stepNumber)
    const order = reorderNext(enrollment, numbers, decision.stepNumber)
    if (chosen && order) {
      await supabase.from('campaign_enrollments').update({ step_order: order, schedule_reason: 'director_reorder' }).eq('id', enrollment.id)
      stepNumber = chosen.step_number
      message = decision.message || resolveMergeFields(chosen.content, contact)
      media = decision.message ? resolveMediaMergeFields(chosen.media, contact) : resolveMediaMergeFields(chosen.media, contact)
      extraUpdate = { campaign_step: chosen.step_number, sequence_step: chosen.step_number, klt_phase: chosen.klt_phase ?? 'know' }
    }
  } else if (decision.action === 'rewrite') {
    message = decision.message
  }

  // a planned message that went untouched was already reviewed when the playbook was written: code checks only
  const untouched = decision.action === 'send'
  const route = campaign?.auto_approve === false ? 'awaiting_approval' : 'ready_to_send'
  return finish(supabase, h, {
    item, contact, business, pack, ctx, message, media, route, skipAi: untouched,
    why: decision.reason, extraUpdate, campaignId: item.campaign_id, stepNumber,
  })
}

// ── A follow-up scheduled on its own (chat AI tool, or the Follow-up AI) ──────────────────────────────────────────
export async function processAiScheduledItem(supabase, h, { item, contact, business, pack, conv }) {
  const mode = business.followup_ai_scheduling
  if (!mode || mode === 'off') return h.skipItem('ai_scheduling_off')

  const ctx = await loadLeadContext(supabase, { contact, business, conv })
  let message = item.final_message || item.draft_message || ''
  let reason = item.ai_intent ?? null
  const skills = await loadSkills(supabase, item.business_id, null)

  const need = needsDirector({ messages: ctx.messages, since: item.created_at, holdUntil: ctx.state?.hold_until, lastFeedback: ctx.state?.last_feedback })
  if (need.needed) {
    const planned = { step_number: null, content: message || `(to be written) ${item.ai_intent ?? ''}`, klt_phase: null, touchpoint_type: 'ai_scheduled' }
    const result = await runDirector(supabase, { business, contact, pack, conv, ctx, skills: skills.filter(s => (s.used_by ?? []).includes('director')), planned, remaining: [], why: need.why })
    if (!result.ok) return h.stallItem('ai_unavailable', AI_RETRY_MS)
    const d = result.decision
    await logTurn(supabase, { businessId: item.business_id, accountId: item.account_id ?? contact.account_id ?? null, contactId: contact.id, queueId: item.id, kind: 'director', decision: d.action, reason: d.reason, details: { standalone: true, why: need.why, stageAsk: d.stageAsk?.stage ?? null } })
    if (d.stageAsk) await requestStageChange(supabase, { businessId: item.business_id, accountId: item.account_id ?? contact.account_id ?? null, contact, conv, ask: d.stageAsk })
    if (d.action === 'reschedule') {
      const plan = await computeNextSend(supabase, { business, contact, delayHours: d.delayHours ?? 24, lastInboundAt: conv?.last_user_message_at ?? null })
      await h.updateQueueItem({ scheduled_at: plan.at.toISOString(), skip_reason: 'director_rescheduled' })
      return { status: 'rescheduled', until: plan.at.toISOString() }
    }
    if (d.action === 'skip') return h.skipItem('director_skip')
    if (d.action === 'stop') {
      await stopLead(supabase, { item, contact, kind: d.stopKind, campaignId: null })
      return h.skipItem(`director_stop_${d.stopKind}`)
    }
    if (d.action === 'rewrite') { message = d.message; reason = d.reason ?? reason }
  }

  if (!message.trim()) {
    message = await writeFollowupMessage(supabase, {
      business, contact, pack, conv, ctx, skills: skills.filter(s => (s.used_by ?? []).includes('writer')), intent: item.ai_intent,
    })
    if (!message) return h.stallItem('ai_unavailable', AI_RETRY_MS)
  }

  return finish(supabase, h, {
    item, contact, business, pack, ctx, message, media: item.media, route: mode === 'auto' ? 'ready_to_send' : 'awaiting_approval',
    skipAi: false, why: reason,
  })
}
