import { getBusiness, getMessages } from '../lib/db.js'
import { callBot } from '../lib/ai.js'
import { chargeLeadStageChange } from '../lib/billing.js'
import { STAGE_CLASSIFIER_FALLBACK } from './prompts.js'
import { log } from '../lib/log.js'

const BATCH_SIZE = 30

export async function runStageClassifier(supabase) {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString()

  const { data: convs } = await supabase
    .from('conversations')
    .select('id, business_id, contact_id, lead_stage_ecom, lead_stage_service')
    .gte('last_user_message_at', cutoff)
    .eq('status', 'open')
    .limit(BATCH_SIZE)

  if (!convs?.length) return { classified: 0 }

  let classified = 0
  for (const conv of convs) {
    try {
      const business = await getBusiness(supabase, conv.business_id)
      if (!business) continue

      const messages = await getMessages(supabase, conv.id)
      if (!messages.length) continue

      const isEcom = business.business_type === 'ecommerce'
      const existing = isEcom ? conv.lead_stage_ecom : conv.lead_stage_service

      const thread = messages.map(m =>
        `${m.direction === 'out' ? 'Business' : 'Customer'}: ${m.content?.text || `[${m.type}]`}`
      ).join('\n')

      const userContent = `Business Type: ${business.business_type}\nCurrent Stage: ${existing ?? 'unknown'}\n\nConversation:\n${thread}`
      const raw = await callBot(supabase, 'lead_stage_classifier', userContent, STAGE_CLASSIFIER_FALLBACK, { json: true })
      if (!raw) continue

      const result = JSON.parse(raw)
      if (!result.lead_stage || result.confidence === 'low') continue

      const field = isEcom ? 'lead_stage_ecom' : 'lead_stage_service'
      if (result.lead_stage !== existing) {
        await supabase.from('conversations').update({ [field]: result.lead_stage }).eq('id', conv.id)

        await chargeLeadStageChange(
          supabase, conv.business_id, conv.contact_id,
          existing, result.lead_stage, business.business_type
        ).catch(() => {})
      }

      classified++
    } catch (e) {
      log('error', 'engine', 'stage_classifier.error', `Error for conv ${conv.id}: ${e.message}`, {
        entity_id: conv.id, details: { error: { name: e.name, message: e.message } }
      })
    }
  }

  return { classified }
}