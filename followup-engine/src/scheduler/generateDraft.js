import { getMessages, getMaterialsForTouchpoint, getLastSentFollowups, getSequenceStep } from '../lib/db.js'
import { callBot } from '../lib/ai.js'
import { runQC } from '../lib/qc.js'
import { FOLLOWUP_FALLBACK, SUMMARISER_FALLBACK, SUGGESTION_REWRITE_FALLBACK } from './prompts.js'

// Builds and QCs one follow-up draft for a queue item. Used by:
//  - worker.js, during normal scheduled processing
//  - the /regenerate route, when an owner asks for a fresh draft
// Does NOT do skip-checks, zone routing, or writing back to the row —
// callers own that, since regenerate shouldn't re-run eligibility
// checks on a row the scheduler already accepted.
export async function generateFollowupDraft(supabase, item, contact, business, pack, conv) {
  const [messages, materials, previousFollowups] = await Promise.all([
    conv ? getMessages(supabase, conv.id) : Promise.resolve([]),
    getMaterialsForTouchpoint(supabase, item.business_id, item.touchpoint_type ?? 'product_reminder'),
    getLastSentFollowups(supabase, item.contact_id, 3)
  ])

  const inbound = messages.filter(m => m.direction === 'in')
  const lastInbound = inbound.at(-1)

  let promptHint = ''
  if (contact.follow_up_sequence_id) {
    const step = await getSequenceStep(supabase, contact.follow_up_sequence_id, item.sequence_step)
    promptHint = step?.prompt_hint ?? ''
  }

  let convSummary = ''
  if (!messages.length) {
    convSummary = 'No conversation history yet.'
  } else if (messages.length <= 8) {
    convSummary = messages.map(m =>
      `${m.direction === 'out' ? 'Business' : 'Customer'}: ${m.content?.text || `[${m.type}]`}`
    ).join('\n')
  } else {
    const thread = messages.map(m =>
      `${m.direction === 'out' ? 'Business' : 'Customer'}: ${m.content?.text || `[${m.type}]`}`
    ).join('\n')
    convSummary = await callBot(supabase, 'conversation_summariser', thread, SUMMARISER_FALLBACK)
      ?? thread
  }

  const isEcom = business.business_type === 'ecommerce'
  const leadStage = isEcom ? (conv?.lead_stage_ecom ?? 'discovery') : (conv?.lead_stage_service ?? 'discovery')

  const materialsBlock = materials.length
    ? '\n\nBUSINESS MATERIALS (use to enrich this message):\n' +
      materials.map(m => `[${m.material_type.toUpperCase()}] ${m.title}\n${m.content.slice(0, 400)}`).join('\n\n')
    : ''

  const sentimentBlock = lastInbound?.sentiment_score
    ? `\n\nLAST LEAD SENTIMENT: ${lastInbound.sentiment_score} | Intent: ${lastInbound.intent_level ?? '?'}/10\nAdjust tone accordingly.`
    : ''

  const userContent = [
    `PERSONA:\n${JSON.stringify(pack.persona ?? {})}`,
    `BUSINESS CONTEXT:\n${JSON.stringify(pack.business_context ?? {})}`,
    `OBJECTION PLAYBOOK:\n${JSON.stringify(pack.objection_playbook ?? [])}`,
    `CUSTOMER PROFILES:\n${JSON.stringify(pack.customer_profiles ?? [])}`,
    `CONVERSATION SUMMARY:\n${convSummary}`,
    `LEAD NAME: ${contact.name ?? 'Customer'}`,
    `LEAD STAGE: ${leadStage}`,
    `FOLLOW-UP NUMBER: ${item.sequence_step}`,
    `TOUCHPOINT TYPE: ${item.touchpoint_type}`,
    `KLT PHASE: ${item.klt_phase}`,
    `STEP INSTRUCTIONS: ${promptHint || 'Follow the touchpoint type guidelines.'}`,
    sentimentBlock,
    materialsBlock
  ].filter(Boolean).join('\n\n')

  const draft = await callBot(supabase, 'follow_up_generator', userContent, FOLLOWUP_FALLBACK)
  if (!draft) return { ok: false, reason: 'generation_failed' }

  const qc = await runQC(supabase, draft, pack, previousFollowups)
  if (!qc.passed && qc.attempts >= 2) {
    return { ok: false, reason: 'qc_failed', issues: qc.issues, draft }
  }

  return { ok: true, draft, finalMessage: qc.final_message, qcPassed: qc.passed, qcNotes: qc.issues.join(', ') || null }
}

// Used when a campaign step or standalone item has ai_rewrite_enabled: the
// owner's written content is treated as their intent/brief rather than
// final copy. AI expands and personalizes it for this specific lead, then
// it goes through the same QC pass as a fully AI-drafted message. Kept
// separate from generateFollowupDraft — this doesn't touch touchpoint
// type, KLT phase, or materials, just the owner's own suggestion plus
// conversation context.
export async function rewriteSuggestedMessage(supabase, suggestion, contact, business, pack, conv) {
  const messages = conv ? await getMessages(supabase, conv.id) : []

  let convSummary = 'No conversation history yet.'
  if (messages.length) {
    const thread = messages.map(m =>
      `${m.direction === 'out' ? 'Business' : 'Customer'}: ${m.content?.text || `[${m.type}]`}`
    ).join('\n')
    convSummary = messages.length <= 8
      ? thread
      : (await callBot(supabase, 'conversation_summariser', thread, SUMMARISER_FALLBACK) ?? thread)
  }

  const userContent = [
    `PERSONA:\n${JSON.stringify(pack?.persona ?? {})}`,
    `OWNER'S SUGGESTED MESSAGE (treat as intent, not final copy):\n${suggestion}`,
    `CONVERSATION SUMMARY:\n${convSummary}`,
    `LEAD NAME: ${contact.name ?? 'Customer'}`
  ].join('\n\n')

  const draft = await callBot(supabase, 'suggestion_rewriter', userContent, SUGGESTION_REWRITE_FALLBACK)
  if (!draft) return { ok: false, reason: 'generation_failed' }

  const previousFollowups = await getLastSentFollowups(supabase, contact.id, 3)
  const qc = await runQC(supabase, draft, pack, previousFollowups)
  if (!qc.passed && qc.attempts >= 2) {
    return { ok: false, reason: 'qc_failed', issues: qc.issues, draft }
  }

  return { ok: true, draft, finalMessage: qc.final_message, qcPassed: qc.passed, qcNotes: qc.issues.join(', ') || null }
}