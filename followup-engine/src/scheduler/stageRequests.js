// Lets the AIs move a lead's stage without being able to do damage.
//
// An AI (today the chat AI, through its "move_lead_stage" tool) writes a row in lead_stage_requests. This worker checks
// the rules, applies the change with the SAME billing the stage classifier uses (once per lead and stage), and keeps an
// audit row so the owner can see who moved what and why. The AI never writes the stage itself.

export const STAGES = {
  ecommerce: ['discovery', 'browsing', 'selection', 'intent', 'checkout', 'awaiting_payment', 'paid', 'fulfilled', 'post_purchase'],
  service: ['discovery', 'qualified', 'proposal', 'negotiation', 'committed', 'active', 'completed', 'retention'],
}
// The furthest an AI may take a lead. Anything after this needs a real payment, a delivery, or the owner.
export const AI_CEILING = { ecommerce: 'awaiting_payment', service: 'committed' }

export const stageField = (businessType) => (businessType === 'ecommerce' ? 'lead_stage_ecom' : 'lead_stage_service')
const kind = (businessType) => (businessType === 'ecommerce' ? 'ecommerce' : 'service')

// Pure. Decides what to do with one request.
export function planStageChange({ businessType, current, requested }) {
  const list = STAGES[kind(businessType)]
  const want = String(requested || '').trim().toLowerCase()
  if (!list.includes(want)) return { action: 'reject', reason: 'unknown_stage' }
  if (list.indexOf(want) > list.indexOf(AI_CEILING[kind(businessType)])) return { action: 'reject', reason: 'needs_real_event' }
  if (want === current) return { action: 'unchanged', stage: want }
  return { action: 'apply', stage: want }
}

// deps: getBusiness, getConversation, setStage, billedBefore, charge, audit, finish
export async function applyStageRequest(request, deps) {
  const reject = (reason) => deps.finish(request.id, { status: 'rejected', reject_reason: reason })

  const [business, conversation] = await Promise.all([deps.getBusiness(request.business_id), deps.getConversation(request.conversation_id)])
  if (!business || !conversation || conversation.business_id !== request.business_id || String(conversation.contact_id) !== String(request.contact_id)) return reject('not_found')
  if (conversation.is_business_chat === false) return reject('not_a_business_chat')

  const field = stageField(business.business_type)
  const current = conversation[field] ?? null
  const plan = planStageChange({ businessType: business.business_type, current, requested: request.requested_stage })

  if (plan.action === 'reject') return reject(plan.reason)
  if (plan.action === 'unchanged') return deps.finish(request.id, { status: 'unchanged', from_stage: current })

  await deps.setStage(conversation.id, field, plan.stage)
  // Same rule as the stage classifier: progress is charged once per lead and stage, so flipping back and forth is free.
  if (!(await deps.billedBefore(request.business_id, request.contact_id, plan.stage))) {
    await Promise.resolve(deps.charge(request.business_id, request.contact_id, current, plan.stage, business.business_type)).catch(() => {})
  }
  await deps.audit({
    business_id: request.business_id, contact_id: request.contact_id, conversation_id: String(conversation.id),
    from_stage: current, to_stage: plan.stage, actor: request.actor, reason: request.reason, request_id: request.id,
  })
  return deps.finish(request.id, { status: 'applied', from_stage: current })
}

async function defaultDeps(supabase) {
  const [{ getBusiness }, { chargeLeadStageChange }] = await Promise.all([import('../lib/db.js'), import('../lib/billing.js')])
  return {
    getBusiness: (id) => getBusiness(supabase, id),
    async getConversation(id) {
      const { data } = await supabase.from('conversations')
        .select('id, business_id, contact_id, lead_stage_ecom, lead_stage_service, is_business_chat').eq('id', id).maybeSingle()
      return data
    },
    async setStage(id, field, stage) {
      const { error } = await supabase.from('conversations').update({ [field]: stage }).eq('id', id)
      if (error) throw new Error(error.message)
    },
    async billedBefore(businessId, contactId, stage) {
      const { count } = await supabase.from('followup_billing_events').select('*', { count: 'exact', head: true })
        .eq('business_id', businessId).eq('contact_id', contactId).eq('to_stage', stage)
      return Boolean(count)
    },
    charge: (businessId, contactId, from, to, type) => chargeLeadStageChange(supabase, businessId, contactId, from, to, type),
    async audit(row) { await supabase.from('lead_stage_changes').insert(row) },
    async finish(id, patch) { await supabase.from('lead_stage_requests').update({ ...patch, processed_at: new Date().toISOString() }).eq('id', id) },
  }
}

export async function runStageRequests(supabase, deps = null) {
  const { data: pending, error } = await supabase.from('lead_stage_requests').select('*')
    .eq('status', 'pending').order('created_at', { ascending: true }).limit(50)
  if (error) throw new Error(error.message)
  if (!pending?.length) return { handled: 0 }
  const d = deps ?? await defaultDeps(supabase)
  let handled = 0
  for (const request of pending) {
    try { await applyStageRequest(request, d); handled++ }
    catch (e) { await d.finish(request.id, { status: 'rejected', reject_reason: `error: ${String(e.message).slice(0, 120)}` }).catch(() => {}) }
  }
  return { handled }
}
