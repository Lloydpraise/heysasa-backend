// The Follow-up AI can ASK for a lead's stage to move, the same way the chat AI does. It never writes the stage itself:
// the ask goes into lead_stage_requests and the engine's stage worker (scheduler/stageRequests.js) checks the rules
// (AI ceiling, real conversation, a reason), bills it once per lead and stage, and keeps an audit row.

const STAGE_PATTERN = /^[a-z_]{3,30}$/

// Pure. Reads the optional "stage" and "stage_reason" the director may add to its decision. Both are needed.
export function readStageAsk(raw) {
  if (!raw || typeof raw !== 'object') return null
  const stage = String(raw.stage ?? '').trim().toLowerCase()
  const reason = String(raw.stage_reason ?? '').trim().slice(0, 300)
  if (!STAGE_PATTERN.test(stage) || reason.length < 3) return null
  return { stage, reason }
}

// Writes the ask. Never throws and never blocks a send: a failed ask is logged by the caller and the message goes on.
// One open ask per conversation, newest wins (same as the chat AI's tool).
export async function requestStageChange(supabase, { businessId, contact, conv, ask, actor = 'followup_ai' }) {
  if (!ask || !conv?.id || !contact?.id) return { ok: false, reason: 'nothing_to_ask' }
  if (conv.is_business_chat === false) return { ok: false, reason: 'not_a_business_chat' }
  try {
    await supabase.from('lead_stage_requests').delete().eq('business_id', businessId).eq('conversation_id', String(conv.id)).eq('status', 'pending')
    const { error } = await supabase.from('lead_stage_requests').insert({
      business_id: businessId, contact_id: contact.id, conversation_id: String(conv.id),
      requested_stage: ask.stage, reason: ask.reason, actor,
    })
    return error ? { ok: false, reason: error.message } : { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) }
  }
}
