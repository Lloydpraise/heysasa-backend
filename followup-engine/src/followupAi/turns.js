import { log } from '../lib/log.js'

// The decision log: one row per thing the Follow-up AI decided. This is how the owner (and we) can tell the system is
// working: what it did, for whom, and why. Never throws.
export async function logTurn(supabase, { businessId, accountId = null, contactId = null, campaignId = null, queueId = null, kind, decision = null, reason = null, stepNumber = null, details = {} }) {
  try {
    const { error } = await supabase.from('followup_ai_turns').insert({
      business_id: businessId, ...(accountId ? { account_id: accountId } : {}), contact_id: contactId, campaign_id: campaignId, queue_id: queueId,
      kind, decision, reason: reason ? String(reason).slice(0, 500) : null, step_number: stepNumber, details,
    })
    if (error) log('warn', 'followup_ai', 'followup_ai.turn_log_failed', error.message, { business_id: businessId })
  } catch (e) {
    log('warn', 'followup_ai', 'followup_ai.turn_log_failed', String(e?.message ?? e), { business_id: businessId })
  }
}
