import { getConversation, getMessages } from '../lib/db.js'
import { callBot } from '../lib/ai.js'
import { OPT_IN_CLASSIFIER_FALLBACK } from './prompts.js'
import { log } from '../lib/log.js'

const BATCH_SIZE = 30

// Per-process cache of the last inbound message timestamp already
// classified for a contact, so a "neutral" reply doesn't get re-sent to
// the AI on every poll cycle. Resets on restart — same tradeoff antiban.js
// already makes for its in-memory state; worst case is one repeat
// classification right after a deploy, not a burst of API calls.
const lastClassifiedAt = new Map() // contact_id -> ISO timestamp of last-seen inbound message

// Nothing else in the codebase ever flips follow_up_opted_in from false to
// true, or sets do_not_contact from a lead's own reply — confirmed by
// reading every message-handling path in both the main backend and this
// engine. This finds three groups and classifies their latest inbound
// reply:
//  1. mid-consent — consent sent, not yet opted in (can go opt_in/opt_out)
//  2. actively enrolled in a campaign, not yet opted in (same)
//  3. ALREADY opted in and currently receiving follow-ups or a campaign —
//     checked for opt_out only ("stop disturbing me" etc. from someone
//     already subscribed), since they can't "opt in" again
export async function runOptInClassifier(supabase) {
  const { data: consentPending } = await supabase
    .from('contacts')
    .select('id, business_id, name')
    .eq('follow_up_opted_in', false)
    .eq('do_not_contact', false)
    .not('consent_message_sent_at', 'is', null)
    .limit(BATCH_SIZE)

  const { data: enrollments } = await supabase
    .from('campaign_enrollments')
    .select('lead_id')
    .in('status', ['pending', 'active', 'awaiting_opt_in'])
    .limit(BATCH_SIZE)

  const enrolledIds = [...new Set((enrollments ?? []).map(e => e.lead_id))]

  const notYetOptedIn = new Map()
  for (const c of consentPending ?? []) notYetOptedIn.set(c.id, c)

  const stillNeedLookup = enrolledIds.filter(id => !notYetOptedIn.has(id))
  if (stillNeedLookup.length) {
    const { data } = await supabase
      .from('contacts')
      .select('id, business_id, name')
      .in('id', stillNeedLookup)
      .eq('follow_up_opted_in', false)
      .eq('do_not_contact', false)
    for (const c of data ?? []) notYetOptedIn.set(c.id, c)
  }

  // Already opted in, but actively receiving campaign messages or
  // follow-ups — still worth checking for a stop-signal.
  const { data: activeOptedIn } = await supabase
    .from('contacts')
    .select('id, business_id, name')
    .eq('follow_up_opted_in', true)
    .eq('do_not_contact', false)
    .or(`id.in.(${enrolledIds.length ? enrolledIds.join(',') : '0'}),follow_up_count.gt.0`)
    .limit(BATCH_SIZE)

  const alreadyOptedIn = new Map()
  for (const c of activeOptedIn ?? []) {
    if (!notYetOptedIn.has(c.id)) alreadyOptedIn.set(c.id, c)
  }

  if (!notYetOptedIn.size && !alreadyOptedIn.size) return { classified: 0 }

  let classified = 0

  const classifyOne = async (contact, { canOptIn }) => {
    try {
      const conv = await getConversation(supabase, contact.id, contact.business_id)
      if (!conv) return

      const messages = await getMessages(supabase, conv.id)
      const lastInbound = messages.filter(m => m.direction === 'in').at(-1)
      if (!lastInbound?.content?.text) return
      if (lastClassifiedAt.get(contact.id) === lastInbound.created_at) return

      const userContent = `Lead's WhatsApp reply:\n"${lastInbound.content.text}"`
      const raw = await callBot(supabase, 'opt_in_classifier', userContent, OPT_IN_CLASSIFIER_FALLBACK, { json: true })
      lastClassifiedAt.set(contact.id, lastInbound.created_at)
      if (!raw) return

      let result
      try { result = JSON.parse(raw) } catch { return }

      const now = new Date().toISOString()
      if (result.intent === 'opt_in' && canOptIn) {
        await supabase.from('contacts').update({
          follow_up_opted_in: true,
          follow_up_opted_in_at: now
        }).eq('id', contact.id)
        await supabase.from('campaign_enrollments')
          .update({ status: 'pending', next_send_at: null })
          .eq('lead_id', contact.id)
          .eq('status', 'awaiting_opt_in')
        classified++
      } else if (result.intent === 'opt_out') {
        await supabase.from('contacts').update({
          do_not_contact: true,
          follow_up_opted_out_at: now
        }).eq('id', contact.id)

        // Stop any active campaign for this lead too — a stop-signal
        // should halt sends, not just flag the contact.
        const { data: activeEnrollments } = await supabase
          .from('campaign_enrollments')
          .select('id')
          .eq('lead_id', contact.id)
          .in('status', ['pending', 'active', 'awaiting_opt_in'])

        for (const enrollment of activeEnrollments ?? []) {
          await supabase.from('campaign_enrollments')
            .update({ status: 'completed' }).eq('id', enrollment.id)
          await supabase.from('campaign_step_events')
            .update({ opted_out_at: now })
            .eq('enrollment_id', enrollment.id)
            .is('opted_out_at', null)
        }

        classified++
      }
      // 'neutral' (or opt_in from someone who can't opt in again) — leave
      // as-is; lastClassifiedAt above still gets set so this same message
      // isn't re-classified next poll.
    } catch (e) {
      log('error', 'engine', 'opt_in_classifier.error', `Error for contact ${contact.id}: ${e.message}`, {
        contact_id: contact.id, details: { error: { name: e.name, message: e.message } }
      })
    }
  }

  for (const contact of notYetOptedIn.values()) await classifyOne(contact, { canOptIn: true })
  for (const contact of alreadyOptedIn.values()) await classifyOne(contact, { canOptIn: false })

  return { classified }
}