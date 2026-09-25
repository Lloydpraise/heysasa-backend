import { getConversation, getMessages } from '../lib/db.js'
import { callBot } from '../lib/ai.js'
import { CAMPAIGN_REPLY_INTENT_FALLBACK } from './prompts.js'
import { log } from '../lib/log.js'

const BATCH_SIZE = 30
const VALID_LABELS = ['action', 'opt_out', 'positive', 'negative', 'neutral']

// Classifies TEXT replies to campaign steps: action / opt_out / positive /
// negative / neutral. Reactions are excluded (reaction_emoji is not null)
// — those are classified instantly and locally in dbService.js
// (recordCampaignStepReaction) via an emoji map, no AI needed.
//
// "action" is deliberately judged against the actual message that was
// sent, not the reply in isolation — the same "yes" means something
// different after "reply YES to book" versus after "how's your day
// going?" — so this fetches each step's content and includes it in the
// prompt. When action is detected, the lead is marked engaged so it
// surfaces in the normal Leads view without a separate alert system.
//
// opt_out here is informational only (see the migration comment) — it
// does not touch do_not_contact or the campaign enrollment. That stays
// optInClassifier.js's job alone, so only one place ever flips
// subscription state.
export async function runCampaignReplyIntentClassifier(supabase) {
  const { data: pendingEvents, error } = await supabase
    .from('campaign_step_events')
    .select('id, enrollment_id, step_id, replied_at')
    .not('replied_at', 'is', null)
    .is('reply_intent', null)
    .is('reaction_emoji', null)
    .order('replied_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) {
    log('error', 'engine', 'campaign_reply_intent.fetch_failed', `Fetch failed: ${error.message}`, { details: { error: error.message } })
    return { classified: 0 }
  }
  if (!pendingEvents?.length) return { classified: 0 }

  const enrollmentIds = [...new Set(pendingEvents.map(e => e.enrollment_id))]
  const { data: enrollments } = await supabase
    .from('campaign_enrollments')
    .select('id, lead_id, campaign_id')
    .in('id', enrollmentIds)
  const enrollmentById = new Map((enrollments ?? []).map(e => [e.id, e]))

  const campaignIds = [...new Set((enrollments ?? []).map(e => e.campaign_id))]
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, business_id')
    .in('id', campaignIds)
  const businessIdByCampaign = new Map((campaigns ?? []).map(c => [c.id, c.business_id]))

  const stepIds = [...new Set(pendingEvents.map(e => e.step_id))]
  const { data: steps } = await supabase
    .from('campaign_steps')
    .select('id, content')
    .in('id', stepIds)
  const stepContentById = new Map((steps ?? []).map(s => [s.id, s.content]))

  let classified = 0

  for (const event of pendingEvents) {
    try {
      const enrollment = enrollmentById.get(event.enrollment_id)
      const businessId = enrollment && businessIdByCampaign.get(enrollment.campaign_id)
      const stepContent = stepContentById.get(event.step_id)
      if (!enrollment || !businessId || !stepContent) continue

      const conv = await getConversation(supabase, enrollment.lead_id, businessId)
      if (!conv) continue

      const messages = await getMessages(supabase, conv.id)
      const repliedAtMs = new Date(event.replied_at).getTime()

      // The inbound message closest to this step event's replied_at —
      // not just "the lead's latest inbound" — since the same conversation
      // can carry replies to several steps over time, and we want the one
      // that actually earned this stamp.
      let candidate = null
      let smallestDiff = Infinity
      for (const m of messages) {
        if (m.direction !== 'in' || !m.content?.text) continue
        const diff = Math.abs(new Date(m.created_at).getTime() - repliedAtMs)
        if (diff < smallestDiff) {
          smallestDiff = diff
          candidate = m
        }
      }
      if (!candidate?.content?.text) continue

      const userContent = `Message sent to the lead:\n"${stepContent}"\n\nLead's reply:\n"${candidate.content.text}"`
      const raw = await callBot(supabase, 'campaign_reply_intent_classifier', userContent, CAMPAIGN_REPLY_INTENT_FALLBACK, {
        json: true,
        model: 'gpt-4o-mini',
        maxTokens: 40
      })
      if (!raw) continue

      let result
      try { result = JSON.parse(raw) } catch { continue }
      const label = VALID_LABELS.includes(result.label) ? result.label : 'neutral'

      const { error: updateError } = await supabase
        .from('campaign_step_events')
        .update({ reply_intent: label })
        .eq('id', event.id)
      if (updateError) throw updateError

      // The one real side effect here — surface it in the normal Leads
      // view the same way any other engaged lead would be, no new
      // "attention" mechanism needed.
      if (label === 'action') {
        await supabase.from('contacts').update({ lead_state: 'engaged' }).eq('id', enrollment.lead_id)
      }

      classified++
    } catch (e) {
      log('error', 'engine', 'campaign_reply_intent.error', `Error for step event ${event.id}: ${e.message}`, {
        entity_id: event.id, details: { error: { name: e.name, message: e.message } }
      })
    }
  }

  return { classified }
}
