// The feedback loop: how we know the system is working. Every reply to a follow-up teaches it something.
//   opt_out  -> logged here; the lead is already opted out of every campaign by optInClassifier (do_not_contact)
//   negative -> counted. Two negatives in a row hold the lead for two weeks so the director/owner can look
//   positive / action -> logged, and clears the negative count
// All of it is visible in followup_ai_turns and v_followup_ai_health.

import { logTurn } from './turns.js'

const HOLD_AFTER_NEGATIVES = 2
const HOLD_DAYS = 14

// lead_ai_state keeps its (business_id, contact_id) key: a contact belongs to one account anyway.
export async function recordFeedback(supabase, { businessId, accountId = null, contactId, campaignId = null, label, stepNumber = null, replyText = null }) {
  if (!businessId || !contactId || !label) return
  const { data: state } = await supabase.from('lead_ai_state').select('negative_count, hold_until')
    .eq('business_id', businessId).eq('contact_id', contactId).maybeSingle()

  const patch = { business_id: businessId, ...(accountId ? { account_id: accountId } : {}), contact_id: contactId, last_feedback: label, updated_at: new Date().toISOString() }
  let held = false
  if (label === 'negative') {
    patch.negative_count = (state?.negative_count ?? 0) + 1
    if (patch.negative_count >= HOLD_AFTER_NEGATIVES) {
      patch.hold_until = new Date(Date.now() + HOLD_DAYS * 86_400_000).toISOString()
      patch.hold_reason = 'repeated negative replies to follow-ups'
      held = true
    }
  } else if (label === 'positive' || label === 'action') {
    patch.negative_count = 0
  }
  await supabase.from('lead_ai_state').upsert(patch, { onConflict: 'business_id,contact_id' })

  await logTurn(supabase, {
    businessId, accountId, contactId, campaignId, kind: 'feedback', decision: label, stepNumber,
    reason: replyText ? String(replyText).slice(0, 200) : null, details: { held },
  })
}
