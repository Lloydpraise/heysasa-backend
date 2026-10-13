// What the pre-send director decided, checked and normalised. Pure.

const ACTIONS = new Set(['send', 'rewrite', 'reorder', 'reschedule', 'skip', 'stop'])
const clean = (v) => String(v ?? '').trim()

export function normalizeDecision(raw, { remaining = [], currentStep = null } = {}) {
  const fallback = (reason) => ({ action: 'send', reason, message: null, stepNumber: currentStep, delayHours: null, stopKind: null, downgraded: true })
  if (!raw || typeof raw !== 'object') return fallback('director_unreadable')

  const action = clean(raw.decision ?? raw.action).toLowerCase()
  const reason = clean(raw.reason).slice(0, 400) || null
  const message = clean(raw.message) || null
  if (!ACTIONS.has(action)) return fallback('director_unknown_action')

  if (action === 'send') return { action, reason, message: null, stepNumber: currentStep, delayHours: null, stopKind: null }

  if (action === 'rewrite') {
    return message
      ? { action, reason, message, stepNumber: currentStep, delayHours: null, stopKind: null }
      : fallback('rewrite_without_message')
  }

  if (action === 'reorder') {
    const step = Number(raw.step_number)
    if (!Number.isInteger(step) || !remaining.includes(step)) return fallback('reorder_invalid_step')
    // chosen step is already next: that is just a send
    if (step === currentStep) return { action: 'send', reason, message: null, stepNumber: currentStep, delayHours: null, stopKind: null }
    return { action, reason, message, stepNumber: step, delayHours: null, stopKind: null }
  }

  if (action === 'reschedule') {
    const hours = Number(raw.delay_hours)
    const delayHours = Number.isFinite(hours) ? Math.min(168, Math.max(2, Math.round(hours))) : 24
    return { action, reason, message: null, stepNumber: currentStep, delayHours, stopKind: null }
  }

  if (action === 'skip') return { action, reason, message: null, stepNumber: currentStep, delayHours: null, stopKind: null }

  const kind = clean(raw.stop_kind).toLowerCase()
  return { action: 'stop', reason, message: null, stepNumber: currentStep, delayHours: null, stopKind: ['opt_out', 'handoff', 'exit'].includes(kind) ? kind : 'exit' }
}

// Does the lead's situation need the (billed) director at all? A follow-up to someone who has been silent since our
// last message, with nobody else having spoken to them, can go as planned. Anything else means the world moved on.
export function needsDirector({ messages = [], since = null, holdUntil = null, lastFeedback = null, now = Date.now() } = {}) {
  const baseline = since ? new Date(since).getTime() : now - 7 * 86_400_000
  const moved = messages.filter(m => {
    if (new Date(m.created_at).getTime() <= baseline) return false
    if (m.direction === 'in') return true
    return ['human', 'chat_ai', 'legacy_ai'].includes(m.agent_role)
  })
  if (moved.length) return { needed: true, why: 'activity_since_last_followup', activity: moved.length }
  if (lastFeedback === 'negative') return { needed: true, why: 'negative_feedback' }
  if (holdUntil && new Date(holdUntil).getTime() > now) return { needed: true, why: 'on_hold' }
  return { needed: false, why: 'silent_since_last_followup' }
}
