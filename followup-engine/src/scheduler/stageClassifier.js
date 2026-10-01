import { STAGE_CLASSIFIER_FALLBACK } from './prompts.js'
import { log } from '../lib/log.js'
import { shouldPauseOpenAIRequest } from '../lib/openAiGate.js'

// Activity-gated. The three-hour poll only sees conversations stamped by a
// live lead reply or owner message, then waits for DEBOUNCE_MS so a burst of
// messages costs one classification, not one per message. No activity stamp
// means no lead query and no OpenAI call.
//
// The old version re-sent the full thread of every conversation with a message
// in the last 15 minutes on EVERY tick, so a single customer message could be
// classified ~15 times.
const BATCH_SIZE = 20
export const STAGE_REVIEW_DEBOUNCE_MS = parseInt(process.env.STAGE_REVIEW_DEBOUNCE_MS ?? `${2 * 60_000}`)
const THREAD_MESSAGES = 40   // the current stage is passed in, so the tail is enough
const MESSAGE_CHARS = 300
const MAX_FAILURES = 3       // stop retrying a conversation whose calls keep failing

const failures = new Map()   // conversation id -> consecutive failed attempts

// Real dependencies are loaded lazily so the tests can inject fakes without
// pulling in config/dotenv.
async function defaultDeps() {
  const [{ getBusiness, getMessages }, { callBot }, { chargeLeadStageChange }] = await Promise.all([
    import('../lib/db.js'),
    import('../lib/ai.js'),
    import('../lib/billing.js'),
  ])
  return { getBusiness, getMessages, callBot, chargeLeadStageChange }
}

function formatThread(messages) {
  return messages.map(m => {
    const text = String(m.content?.text || `[${m.type}]`).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS)
    return `${m.direction === 'out' ? 'Business' : 'Customer'}: ${text}`
  }).join('\n')
}

export async function runStageClassifier(supabase, deps, onlyConversationId = null) {
  // While the gate is latched (credits/key), leave requests queued; they are
  // picked up automatically once OpenAI is back. Nothing is lost or re-billed.
  if (shouldPauseOpenAIRequest()) return { classified: 0 }

  const { getBusiness, getMessages, callBot, chargeLeadStageChange } = deps ?? await defaultDeps()

  const dueBefore = new Date(Date.now() - STAGE_REVIEW_DEBOUNCE_MS).toISOString()
  let dueQuery = supabase
    .from('conversations')
    .select('id, business_id, contact_id, lead_stage_ecom, lead_stage_service, is_business_chat, stage_review_requested_at')
    .not('stage_review_requested_at', 'is', null)
    .lte('stage_review_requested_at', dueBefore)
    .order('stage_review_requested_at', { ascending: true })
  if (onlyConversationId) dueQuery = dueQuery.eq('id', onlyConversationId)
  const { data: convs, error } = await dueQuery.limit(BATCH_SIZE)

  if (error) throw new Error(error.message)
  if (!convs?.length) return { classified: 0 }

  const businesses = new Map()
  let classified = 0
  let skipped = 0

  for (const conv of convs) {
    const claimed = conv.stage_review_requested_at
    // Compare-and-set: only clears the request if nothing newer arrived while
    // we were working. A newer response has a different timestamp and stays queued.
    const release = () => supabase.from('conversations')
      .update({ stage_review_requested_at: null, stage_review_reason: null })
      .eq('id', conv.id)
      .eq('stage_review_requested_at', claimed)

    try {
      // Personal / junk chats (already separated by the analyser) are never
      // stage-classified or billed.
      if (conv.is_business_chat === false) { await release(); skipped++; continue }

      if (!businesses.has(conv.business_id)) businesses.set(conv.business_id, await getBusiness(supabase, conv.business_id))
      const business = businesses.get(conv.business_id)
      if (!business) { await release(); skipped++; continue }

      const messages = await getMessages(supabase, conv.id, { limit: THREAD_MESSAGES })
      if (!messages.length) { await release(); skipped++; continue }

      const isEcom = business.business_type === 'ecommerce'
      const existing = isEcom ? conv.lead_stage_ecom : conv.lead_stage_service
      const userContent = `Business Type: ${business.business_type}\nCurrent Stage: ${existing ?? 'unknown'}\n\nConversation:\n${formatThread(messages)}`

      const raw = await callBot(supabase, 'lead_stage_classifier', userContent, STAGE_CLASSIFIER_FALLBACK, {
        json: true,
        temperature: 0,        // a classifier should give the same answer twice
        maxTokens: 80,
        cacheKey: `stage:${conv.business_id}`,
      })

      if (!raw) {
        // AI unavailable or the call failed. Keep the request queued and retry
        // next tick, unless this conversation keeps failing.
        if (shouldPauseOpenAIRequest()) break
        const n = (failures.get(conv.id) ?? 0) + 1
        failures.set(conv.id, n)
        if (n >= MAX_FAILURES) {
          failures.delete(conv.id)
          await release()
          log('warn', 'engine', 'stage_classifier.gave_up', `Gave up on conv ${conv.id} after ${n} failed AI calls`, { entity_id: conv.id })
        }
        continue
      }
      failures.delete(conv.id)

      let result
      try { result = JSON.parse(raw) } catch { await release(); skipped++; continue }
      if (!result.lead_stage || result.confidence === 'low') { await release(); skipped++; continue }

      if (result.lead_stage !== existing) {
        const field = isEcom ? 'lead_stage_ecom' : 'lead_stage_service'
        await supabase.from('conversations').update({ [field]: result.lead_stage }).eq('id', conv.id)

        // Charge for progress once per (lead, stage). Without this guard a stage
        // that flips back and forth is billed again each time it re-advances.
        const { count } = await supabase.from('followup_billing_events')
          .select('*', { count: 'exact', head: true })
          .eq('business_id', conv.business_id)
          .eq('contact_id', conv.contact_id)
          .eq('to_stage', result.lead_stage)
        if (!count) {
          await chargeLeadStageChange(
            supabase, conv.business_id, conv.contact_id,
            existing, result.lead_stage, business.business_type
          ).catch(() => {})
        }
      }

      await release()
      classified++
    } catch (e) {
      log('error', 'engine', 'stage_classifier.error', `Error for conv ${conv.id}: ${e.message}`, {
        entity_id: conv.id, details: { error: { name: e.name, message: e.message } }
      })
    }
  }

  return { classified, skipped }
}
