import { getConversation, getMessages } from '../lib/db.js'
import { log } from '../lib/log.js'

const THREE_DAYS_MS = 3 * 24 * 60 * 60_000
const FIVE_DAYS_MS = 5 * 24 * 60 * 60_000
const BATCH_SIZE = 500
const CLOSED_STATES = new Set(['won', 'lost', 'do_not_contact'])

export async function runLeadTemperatureReview(supabase) {
  const now = Date.now()
  const warmCutoff = new Date(now - THREE_DAYS_MS).toISOString()
  const coldCutoff = new Date(now - FIVE_DAYS_MS).toISOString()
  const [warmResult, coldResult] = await Promise.all([
    supabase.from('contacts')
      .select('id, business_id, lead_state, lead_quality, last_seen')
      .eq('lead_type', 'business')
      .gte('last_seen', warmCutoff)
      .or('lead_quality.is.null,lead_quality.neq.warm')
      .limit(BATCH_SIZE),
    supabase.from('contacts')
      .select('id, business_id, lead_state, lead_quality, last_seen')
      .eq('lead_type', 'business')
      .lte('last_seen', coldCutoff)
      .or('lead_quality.is.null,lead_quality.neq.cold')
      .limit(BATCH_SIZE),
  ])

  if (warmResult.error || coldResult.error) {
    throw new Error(`Lead temperature lookup failed: ${(warmResult.error || coldResult.error).message}`)
  }
  const contacts = [...new Map([...(warmResult.data ?? []), ...(coldResult.data ?? [])].map(c => [c.id, c])).values()]
  if (!contacts?.length) return { updated: 0 }

  let updated = 0
  for (const contact of contacts) {
    const lastSeen = new Date(contact.last_seen).getTime()
    const isWarmCandidate = lastSeen >= now - THREE_DAYS_MS && contact.lead_quality !== 'warm'
    const isColdCandidate = lastSeen <= now - FIVE_DAYS_MS && contact.lead_quality !== 'cold'
    if (!isWarmCandidate && !isColdCandidate) continue
    if (CLOSED_STATES.has(contact.lead_state)) continue

    try {
      const conversation = await getConversation(supabase, contact.id, contact.business_id)
      if (!conversation) continue
      const messages = await getMessages(supabase, conversation.id, { limit: 5 })
      const latestAt = messages.at(-1)?.created_at
      if (!latestAt) continue

      const ageMs = now - new Date(latestAt).getTime()
      const leadQuality = ageMs < THREE_DAYS_MS ? 'warm' : ageMs >= FIVE_DAYS_MS ? 'cold' : null
      if (!leadQuality || leadQuality === contact.lead_quality) continue

      const { error: updateError } = await supabase.from('contacts')
        .update({ lead_quality: leadQuality })
        .eq('id', contact.id)
      if (updateError) throw updateError
      updated++
    } catch (e) {
      log('error', 'engine', 'lead_temperature.error', `Error for contact ${contact.id}: ${e.message}`, {
        entity_id: contact.id, details: { error: { name: e.name, message: e.message } }
      })
    }
  }

  return { updated }
}
