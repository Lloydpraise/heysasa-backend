// Rules around an ad playbook that need no AI and no database: is the ad data good enough, and is what the AI wrote
// usable. Pure.

export const MIN_STEPS = 5
export const MAX_STEPS = 13
const KLT_RANK = { know: 0, like: 1, trust: 2 }
const MEDIA_NEEDS = new Set(['none', 'ad_image', 'testimonial'])

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

// The ad as it should be used: the owner's correction wins over what we read from Meta/WhatsApp.
export function effectiveAd(pb) {
  return {
    headline: clean(pb?.override_headline) || clean(pb?.auto_headline),
    body: clean(pb?.override_body) || clean(pb?.auto_body),
    imageUrl: clean(pb?.chosen_image_url) || clean(pb?.auto_thumbnail_url),
  }
}

// Is there enough to write a good playbook? Body is required (it says what the ad actually offered).
// A missing image only means steps that need the ad picture will wait for one.
export function assessAdData({ headline, body, imageUrl }) {
  const issues = []
  if (!clean(body)) issues.push('no_body')
  else if (clean(body).length < 15) issues.push('body_too_short')
  if (!clean(headline)) issues.push('no_headline')
  if (!clean(imageUrl)) issues.push('no_image')
  const blocking = issues.includes('no_body') || issues.includes('body_too_short')
  const quality = blocking ? 'missing' : issues.length ? 'weak' : 'good'
  return { quality, issues, canGenerate: !blocking }
}

export const stepBudget = (maxPerLead) => {
  const cap = Number.isFinite(Number(maxPerLead)) && Number(maxPerLead) > 0 ? Math.floor(Number(maxPerLead)) : MAX_STEPS
  const max = Math.min(MAX_STEPS, cap)
  return { min: Math.min(MIN_STEPS, max), max }
}

const slug = (v, fallback) => {
  const s = clean(v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)
  return s || fallback
}

// Turns the AI's raw JSON into a playbook we can store, or reports what is wrong with it.
export function validatePlaybook(raw, { maxSteps = MAX_STEPS, minSteps = MIN_STEPS, minGapHours = 20, hasTestimonial = false, hasAdImage = false } = {}) {
  const problems = []
  const flowRaw = raw?.flow ?? {}
  const flow = {
    name: clean(flowRaw.name).slice(0, 80),
    goal: clean(flowRaw.goal).slice(0, 400),
    instructions: String(flowRaw.instructions ?? '').trim().slice(0, 4000),
    skill_keys: Array.isArray(flowRaw.skill_keys) ? flowRaw.skill_keys.map(k => slug(k, '')).filter(Boolean).slice(0, 8) : [],
  }
  if (flow.instructions.length < 40) problems.push('flow_instructions_missing')
  if (!flow.goal) problems.push('flow_goal_missing')

  const rawSteps = Array.isArray(raw?.steps) ? raw.steps : []
  let steps = rawSteps
    .map(s => ({
      klt_phase: KLT_RANK[clean(s?.klt_phase).toLowerCase()] !== undefined ? clean(s.klt_phase).toLowerCase() : null,
      touchpoint_type: slug(s?.touchpoint_type, 'soft_checkin'),
      title: clean(s?.title).slice(0, 80),
      content: String(s?.content ?? '').trim().slice(0, 600),
      delay_hours: Number.isFinite(Number(s?.delay_hours)) ? Number(s.delay_hours) : minGapHours,
      media_need: MEDIA_NEEDS.has(clean(s?.media_need).toLowerCase()) ? clean(s.media_need).toLowerCase() : 'none',
      rationale: clean(s?.rationale).slice(0, 300),
    }))
    .filter(s => s.content)

  if (steps.length > maxSteps) steps = steps.slice(0, maxSteps)
  if (steps.length < minSteps) problems.push('too_few_steps')

  // KLT order: Know, then Like, then Trust. Never backwards, first step is always Know.
  let floor = 0
  steps = steps.map((s, i) => {
    let rank = s.klt_phase ? KLT_RANK[s.klt_phase] : Math.min(2, Math.floor((i / Math.max(steps.length, 1)) * 3))
    if (i === 0) rank = 0
    rank = Math.max(rank, floor)
    floor = rank
    return { ...s, klt_phase: ['know', 'like', 'trust'][rank] }
  })

  const out = steps.map((s, i) => {
    const waiting = (s.media_need === 'testimonial' && !hasTestimonial) || (s.media_need === 'ad_image' && !hasAdImage)
    return {
      ...s,
      position: i + 1,
      // the first step waits for the lead's silence, the others never sooner than the minimum gap
      delay_hours: i === 0 ? 0 : Math.min(240, Math.max(minGapHours, Math.round(s.delay_hours))),
      status: waiting ? 'needs_media' : 'draft',
      media_source: s.media_need === 'none' ? null : (s.media_need === 'ad_image' ? 'ad_image' : 'testimonial'),
    }
  })

  if (out.length >= 5 && !out.some(s => s.klt_phase === 'trust')) problems.push('no_trust_step')
  return { flow, steps: out, problems, ok: !problems.includes('flow_instructions_missing') && out.length > 0 }
}
