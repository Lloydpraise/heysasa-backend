// The pre-send director. Runs at the moment a follow-up is due, never before. It catches up on everything that happened
// with the lead (their messages, what the Chat AI said, what the owner said personally, what we already sent) and asks:
// is this message still relevant? It decides send / rewrite / reorder / reschedule / skip / stop.

import { callBot } from '../lib/ai.js'
import { getZonedParts } from '../lib/timing.js'
import { DEFAULT_TIMEZONE } from '../config.js'
import { AI_PROMPT_CATALOG } from '../../../src/aiPromptCatalog.js'
import { BOTS } from './constants.js'
import { renderSkills } from './skills.js'
import { formatTimeline, digest } from './timeline.js'
import { normalizeDecision } from './decision.js'

const DIRECTOR_PROMPT = AI_PROMPT_CATALOG.followup_ai_director.prompt

const stepLine = (s) => `  step ${s.step_number} [${s.klt_phase ?? '?'} / ${s.touchpoint_type ?? 'message'}]${s.media ? ' (has media)' : ''}: ${String(s.content ?? '').replace(/\s+/g, ' ').slice(0, 220)}`

// planned: { step_number, content, klt_phase, touchpoint_type }   remaining: same shape, in this lead's order (planned first)
export async function runDirector(supabase, { business, contact, pack, conv, ctx, skills, planned, remaining, why }) {
  const timeZone = business.timezone || DEFAULT_TIMEZONE
  const nowParts = getZonedParts(new Date(), timeZone)
  const remainingNumbers = remaining.map(s => s.step_number)

  const userContent = [
    // static per business first (cache friendly), per lead last
    renderSkills(skills),
    `PERSONA (the business voice):\n${JSON.stringify(pack?.persona ?? {})}`,
    `BUSINESS CONTEXT:\n${JSON.stringify(pack?.business_context ?? {})}`,
    ctx.flow ? `CHAT FLOW FOR THIS AD (what the Chat AI is told to do with these leads):\nGoal: ${ctx.flow.goal ?? ''}\n${String(ctx.flow.instructions ?? '').slice(0, 1500)}` : '',
    ctx.adBlock,
    `NOW: ${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')} ${String(nowParts.hour).padStart(2, '0')}:${String(nowParts.minute).padStart(2, '0')} (${timeZone})`,
    `LEAD: ${contact.name ?? 'Customer'} | stage: ${conv?.lead_stage_ecom ?? conv?.lead_stage_service ?? 'unknown'} | follow-ups sent so far: ${contact.follow_up_count ?? 0}`,
    ctx.profile ? `CUSTOMER PROFILE:\n${JSON.stringify(ctx.profile)}` : '',
    ctx.state?.last_feedback ? `FEEDBACK ON OUR FOLLOW-UPS: ${ctx.state.last_feedback} (${ctx.state.negative_count ?? 0} negative so far)` : '',
    ctx.state?.hold_until && new Date(ctx.state.hold_until) > new Date() ? `HOLD: someone asked to hold follow-ups until ${ctx.state.hold_until}${ctx.state.hold_reason ? ` (${ctx.state.hold_reason})` : ''}` : '',
    `WHAT CHANGED: ${digest(ctx.messages, { lastFollowupAt: ctx.lastFollowupAt })} Reason you were called: ${why}.`,
    `TIMELINE (oldest first):\n${formatTimeline(ctx.messages)}`,
    `PLANNED NEXT MESSAGE (step ${planned.step_number}, ${planned.klt_phase ?? '?'} / ${planned.touchpoint_type ?? 'message'}):\n${planned.content}`,
    `REMAINING STEPS (you may reorder to one of these):\n${remaining.map(stepLine).join('\n')}`,
    `MINIMUM GAP BETWEEN MESSAGES: ${business.followup_min_gap_hours ?? 20}h`,
  ].filter(Boolean).join('\n\n')

  const raw = await callBot(supabase, BOTS.director, userContent, DIRECTOR_PROMPT, {
    json: true, temperature: 0.3, maxTokens: 600, businessId: business.business_id, cacheKey: `fuaidir:${business.business_id}`,
  })
  if (!raw) return { ok: false, reason: 'ai_unavailable' }
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  return { ok: true, decision: normalizeDecision(parsed, { remaining: remainingNumbers, currentStep: planned.step_number }) }
}
