// Which campaign step goes next for ONE lead. Pure.
//
// Normal campaigns: steps are sent in number order and campaign_enrollments.current_step is the number of the last step
// sent. AI-managed campaigns may differ per lead: campaign_enrollments.step_order holds that lead's own order (for
// example when the Follow-up AI moves a testimonial up because the lead warmed up). current_step then means "how many
// steps of step_order have been sent", so the next step is step_order[current_step].
//
// Rule that keeps this safe: the part of step_order that has already been sent never changes.

export function orderedSteps(enrollment, stepNumbers) {
  const existing = [...new Set((stepNumbers ?? []).map(Number))].sort((a, b) => a - b)
  const order = Array.isArray(enrollment?.step_order) && enrollment.step_order.length ? enrollment.step_order.map(Number) : null
  if (!order) return existing
  const present = new Set(existing)
  const seen = new Set()
  return order.filter(n => present.has(n) && !seen.has(n) && seen.add(n))
}

export function nextStepNumber(enrollment, stepNumbers) {
  const order = orderedSteps(enrollment, stepNumbers)
  const sent = Math.max(0, Number(enrollment?.current_step) || 0)
  return order[sent] ?? null
}

export function remainingSteps(enrollment, stepNumbers) {
  const order = orderedSteps(enrollment, stepNumbers)
  return order.slice(Math.max(0, Number(enrollment?.current_step) || 0))
}

// After step `sentStep` went out: how many steps of the order are now sent, and whether anything is left.
export function afterSend(enrollment, sentStep, stepNumbers) {
  const order = orderedSteps(enrollment, stepNumbers)
  const at = order.indexOf(Number(sentStep))
  const position = at === -1 ? Math.max(0, Number(enrollment?.current_step) || 0) + 1 : at + 1
  return { position, hasMore: position < order.length, nextStep: order[position] ?? null, order }
}

// Move `chosenStep` to be the next one. Everything already sent stays where it is; the rest keeps its relative order.
export function reorderNext(enrollment, stepNumbers, chosenStep) {
  const order = orderedSteps(enrollment, stepNumbers)
  const sent = Math.max(0, Number(enrollment?.current_step) || 0)
  const chosen = Number(chosenStep)
  if (!order.slice(sent).includes(chosen)) return null
  return [...order.slice(0, sent), chosen, ...order.slice(sent).filter(n => n !== chosen)]
}
