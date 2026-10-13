import test from 'node:test'
import assert from 'node:assert/strict'
import { pickSendTime } from '../src/followupAi/sendWindow.js'
import { orderedSteps, nextStepNumber, remainingSteps, afterSend, reorderNext } from '../src/followupAi/stepPlan.js'
import { checkServiceStandard } from '../src/followupAi/serviceStandard.js'
import { assessAdData, validatePlaybook, stepBudget } from '../src/followupAi/playbookRules.js'
import { normalizeDecision, needsDirector } from '../src/followupAi/decision.js'
import { mergeSkills } from '../src/followupAi/skills.js'
import { getZonedParts } from '../src/lib/timing.js'

const TZ = 'Africa/Nairobi'
const hourOf = (d) => getZonedParts(d, TZ).hour

test('send time uses the lead active hours and avoids quiet hours', () => {
  const r = pickSendTime({ earliest: new Date('2026-10-13T05:00:00Z'), timeZone: TZ, leadHours: [3, 14, 22], quietStart: 21, quietEnd: 8 })
  assert.equal(hourOf(r.at), 14)
  assert.match(r.reason, /^lead_active_hours/)
})

test('falls back to business busy hours, then default hour', () => {
  const biz = pickSendTime({ earliest: new Date('2026-10-13T05:00:00Z'), timeZone: TZ, businessHours: [11] })
  assert.equal(hourOf(biz.at), 11)
  const def = pickSendTime({ earliest: new Date('2026-10-13T05:00:00Z'), timeZone: TZ })
  assert.equal(hourOf(def.at), 10)
  assert.match(def.reason, /^default_hour/)
})

test('never sooner than earliest (minimum gap is respected)', () => {
  const earliest = new Date('2026-10-13T13:00:00Z') // 16:00 Nairobi
  const r = pickSendTime({ earliest, timeZone: TZ, leadHours: [10] })
  assert.ok(r.at >= earliest)
  assert.equal(hourOf(r.at), 10)
})

test('inactive days are skipped', () => {
  // 2026-10-13 is a Tuesday; only Thursday (4) allowed
  const r = pickSendTime({ earliest: new Date('2026-10-13T05:00:00Z'), timeZone: TZ, activeDays: [4], leadHours: [10] })
  assert.equal(getZonedParts(r.at, TZ).weekday, 4)
})

test('same clock time is not repeated on consecutive days', () => {
  const sends = []
  let earliest = new Date('2026-10-13T05:00:00Z')
  for (let i = 0; i < 6; i++) {
    const r = pickSendTime({ earliest, timeZone: TZ, leadHours: [10, 11, 12, 15], previousSends: sends, minuteSeed: 7 })
    const prev = sends.at(-1)
    if (prev) {
      const a = getZonedParts(prev, TZ); const b = getZonedParts(r.at, TZ)
      const dayGap = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000)
      if (dayGap <= 1) assert.ok(Math.abs((a.hour * 60 + a.minute) - (b.hour * 60 + b.minute)) >= 60)
    }
    sends.push(r.at)
    earliest = new Date(r.at.getTime() + 20 * 3_600_000)
  }
  assert.equal(new Set(sends.map(d => d.toISOString().slice(11, 16))).size > 1, true)
})

test('step order: default, custom, next, remaining, after send', () => {
  const nums = [1, 2, 3, 4]
  assert.deepEqual(orderedSteps({}, nums), [1, 2, 3, 4])
  const e = { current_step: 1, step_order: [1, 3, 2, 4] }
  assert.equal(nextStepNumber(e, nums), 3)
  assert.deepEqual(remainingSteps(e, nums), [3, 2, 4])
  assert.deepEqual(afterSend(e, 3, nums), { position: 2, hasMore: true, nextStep: 2, order: [1, 3, 2, 4] })
  assert.equal(afterSend({ current_step: 3, step_order: [1, 2, 3, 4] }, 4, nums).hasMore, false)
  assert.equal(nextStepNumber({ current_step: 4 }, nums), null)
})

test('reorder keeps the sent part and moves the chosen step next', () => {
  const nums = [1, 2, 3, 4]
  assert.deepEqual(reorderNext({ current_step: 1 }, nums, 4), [1, 4, 2, 3])
  assert.equal(reorderNext({ current_step: 2 }, nums, 1), null) // already sent
  assert.deepEqual(orderedSteps({ step_order: [1, 9, 2, 2] }, nums), [1, 2])
})

test('service standard catches the things that hurt customers', () => {
  const ok = checkServiceStandard('Hi {{first_name}}, did you get a chance to look at the kitchen sink options? Happy to help.', {})
  assert.equal(ok.passed, true)
  const bad = checkServiceStandard('LAST CHANCE!!! BUY NOW!!! Only KES 5000 left, hurry up!!!', { contextText: 'Kitchen sink 12,000' })
  const rules = bad.issues.map(i => i.rule)
  for (const r of ['CAPS', 'EXCLAMATIONS', 'PRESSURE', 'UNSUPPORTED_PRICE']) assert.ok(rules.includes(r), r)
  assert.equal(checkServiceStandard('Our sink is KES 12,000, want one?', { contextText: 'Kitchen sink KES 12,000' }).passed, true)
  assert.ok(checkServiceStandard('Hello [NAME], welcome', {}).issues.some(i => i.rule === 'PLACEHOLDER'))
  assert.ok(checkServiceStandard('Hi, are you still interested in the kitchen sink?', { previousMessages: ['Hi, are you still interested in the kitchen sink?'] }).issues.some(i => i.rule === 'REPEAT'))
  assert.ok(checkServiceStandard('x'.repeat(700), {}).issues.some(i => i.rule === 'TOO_LONG'))
})

test('ad data: body is required, image optional', () => {
  assert.equal(assessAdData({ headline: 'Sinks', body: '', imageUrl: 'x' }).canGenerate, false)
  assert.equal(assessAdData({ headline: 'Sinks', body: 'Stainless steel kitchen sinks, delivered', imageUrl: '' }).quality, 'weak')
  assert.equal(assessAdData({ headline: 'Sinks', body: 'Stainless steel kitchen sinks, delivered', imageUrl: 'u' }).quality, 'good')
})

test('step budget respects max follow-ups per lead', () => {
  assert.deepEqual(stepBudget(12), { min: 5, max: 12 })
  assert.deepEqual(stepBudget(30), { min: 5, max: 13 })
  assert.deepEqual(stepBudget(3), { min: 3, max: 3 })
})

test('playbook validation: KLT order, delays, media needs, step cap', () => {
  const raw = {
    flow: { name: 'f', goal: 'sell sinks', instructions: 'x'.repeat(60) },
    steps: [
      { klt_phase: 'trust', content: 'one', delay_hours: 0 },
      { klt_phase: 'know', content: 'two', delay_hours: 5, media_need: 'testimonial' },
      { klt_phase: 'like', content: 'three', delay_hours: 30, media_need: 'ad_image' },
      { content: 'four' }, { content: 'five' }, { content: 'six' },
    ],
  }
  const v = validatePlaybook(raw, { maxSteps: 5, minGapHours: 20, hasTestimonial: false, hasAdImage: true })
  assert.equal(v.steps.length, 5)
  assert.equal(v.steps[0].klt_phase, 'know')
  const ranks = v.steps.map(s => ['know', 'like', 'trust'].indexOf(s.klt_phase))
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
  assert.equal(v.steps[0].delay_hours, 0)
  assert.ok(v.steps.slice(1).every(s => s.delay_hours >= 20))
  assert.equal(v.steps[1].status, 'needs_media')
  assert.equal(v.steps[2].status, 'draft')
  assert.equal(validatePlaybook({ flow: {}, steps: [] }).ok, false)
})

test('director decisions are normalised safely', () => {
  const ctx = { remaining: [2, 3, 4], currentStep: 2 }
  assert.equal(normalizeDecision(null, ctx).action, 'send')
  assert.equal(normalizeDecision({ decision: 'rewrite' }, ctx).action, 'send')
  assert.equal(normalizeDecision({ decision: 'rewrite', message: 'hi' }, ctx).action, 'rewrite')
  assert.equal(normalizeDecision({ decision: 'reorder', step_number: 4 }, ctx).stepNumber, 4)
  assert.equal(normalizeDecision({ decision: 'reorder', step_number: 9 }, ctx).action, 'send')
  assert.equal(normalizeDecision({ decision: 'reorder', step_number: 2 }, ctx).action, 'send')
  assert.equal(normalizeDecision({ decision: 'reschedule', delay_hours: 1000 }, ctx).delayHours, 168)
  assert.equal(normalizeDecision({ decision: 'stop', stop_kind: 'opt_out' }, ctx).stopKind, 'opt_out')
  assert.equal(normalizeDecision({ decision: 'stop', stop_kind: 'weird' }, ctx).stopKind, 'exit')
})

test('director is only called when the world moved', () => {
  const now = Date.parse('2026-10-13T12:00:00Z')
  const since = '2026-10-12T08:00:00Z'
  const quiet = [{ direction: 'out', agent_role: 'follow_up_ai', created_at: '2026-10-12T08:00:00Z' }]
  assert.equal(needsDirector({ messages: quiet, since, now }).needed, false)
  assert.equal(needsDirector({ messages: [...quiet, { direction: 'in', created_at: '2026-10-12T20:00:00Z' }], since, now }).needed, true)
  assert.equal(needsDirector({ messages: [...quiet, { direction: 'out', agent_role: 'chat_ai', created_at: '2026-10-12T20:00:00Z' }], since, now }).needed, true)
  assert.equal(needsDirector({ messages: quiet, since, lastFeedback: 'negative', now }).needed, true)
})

test('skills: business rows override defaults and can switch them off', () => {
  const defaults = [{ key: 'a', title: 'A', sort_order: 2 }, { key: 'b', title: 'B', sort_order: 1 }]
  assert.deepEqual(mergeSkills(defaults, []).map(s => s.key), ['b', 'a'])
  assert.equal(mergeSkills(defaults, [{ key: 'a', title: 'Mine', sort_order: 2 }]).find(s => s.key === 'a').title, 'Mine')
  assert.deepEqual(mergeSkills(defaults, [{ key: 'b', enabled: false }]).map(s => s.key), ['a'])
})
