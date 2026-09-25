import { getBusiness, getPersonaPack, getConversation, getMessages, getBillingConfig } from '../lib/db.js'
import { callBot } from '../lib/ai.js'
import { checkBalance, flagInsufficientFunds } from '../lib/billing.js'
import { DEFAULT_CONSENT_COST } from '../config.js'
import { CONSENT_FALLBACK } from './prompts.js'
import { log } from '../lib/log.js'

const SILENCE_HOURS = 2
const BATCH_SIZE = 30

// CHANGED from the original: instead of calling sendMessage() directly,
// this writes a follow_up_queue row marked ready_to_send with
// touchpoint_type 'consent' and lets 02/03 dispatch it like any other
// message. The consent-specific bookkeeping (consent_message_sent_at,
// consent cost deduction) happens in the reconciliation pass once the
// row flips to 'sent' — see reconciliation.js.
//
// NOTE: this assumes follow_up_queue is fine holding a sequence_step: 0
// / touchpoint_type: 'consent' row with no follow_up_sequence_id
// backing it. Flag if that doesn't fit — worth confirming before
// relying on this in production.
export async function runConsent(supabase) {
  const cutoff = new Date(Date.now() - SILENCE_HOURS * 3_600_000).toISOString()

  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, name, phone, business_id, lead_state')
    .eq('follow_up_opted_in', false)
    .eq('do_not_contact', false)
    .is('consent_message_sent_at', null)
    .neq('lead_state', 'new')
    .lt('last_seen', cutoff)
    .limit(BATCH_SIZE)

  if (!contacts?.length) return { queued: 0 }

  let queued = 0
  for (const contact of contacts) {
    try {
      const business = await getBusiness(supabase, contact.business_id)
      if (!business?.followup_ai_enabled || !business?.subscription_active) continue

      const consentCost = await getBillingConfig(supabase, 'consent_message_cost_usd', DEFAULT_CONSENT_COST)
      if (!(await checkBalance(supabase, contact.business_id, consentCost))) {
        await flagInsufficientFunds(supabase, contact.business_id)
        continue
      }

      const pack = await getPersonaPack(supabase, contact.business_id)
      if (!pack) continue

      const conv = await getConversation(supabase, contact.id, contact.business_id)
      if (!conv) continue

      const msgs = await getMessages(supabase, conv.id)
      const snippet = msgs.map(m =>
        `${m.direction === 'out' ? 'Business' : 'Customer'}: ${m.content?.text || `[${m.type}]`}`
      ).join('\n')

      const userContent = [
        `Business Persona:\n${JSON.stringify(pack.persona ?? {})}`,
        `Business Name: ${pack.business_name ?? business.name}`,
        `Lead Name: ${contact.name ?? 'there'}`,
        `Recent conversation:\n${snippet}`
      ].join('\n\n')

      const message = await callBot(supabase, 'consent_generator', userContent, CONSENT_FALLBACK)
      if (!message) continue

      await supabase.from('follow_up_queue').insert({
        business_id: contact.business_id,
        contact_id: contact.id,
        conversation_id: conv.id,
        sequence_step: 0,
        touchpoint_type: 'consent',
        klt_phase: 'know',
        status: 'ready_to_send',
        channel: business.whatsapp_channel,
        final_message: message,
        approval_status: 'approved',
        scheduled_at: new Date().toISOString()
      })

      queued++
    } catch (e) {
      log('error', 'engine', 'consent.error', `Error for ${contact.id}: ${e.message}`, {
        contact_id: contact.id, details: { error: { name: e.name, message: e.message } }
      })
    }
  }

  return { queued, checked: contacts.length }
}