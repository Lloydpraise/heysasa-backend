import { getMessages, getMaterialsForTouchpoint, getLastSentFollowups, getSequenceStep } from '../lib/db.js'
import { callBot } from '../lib/ai.js'
import { runQC } from '../lib/qc.js'
import { FOLLOWUP_FALLBACK, SUMMARISER_FALLBACK, SUGGESTION_REWRITE_FALLBACK } from './prompts.js'

// Caps how much thread is sent to the model: the latest messages carry the
// current state, and each is trimmed. Older context is what the summariser
// (and the persona pack) are for.
const THREAD_MESSAGES = 60
const MESSAGE_CHARS = 300

function formatThread(messages) {
  return messages.map(m => {
    const text = String(m.content?.text || `[${m.type}]`).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS)
    return `${m.direction === 'out' ? 'Business' : 'Customer'}: ${text}`
  }).join('\n')
}

// A follow-up sequence drafts several steps for the SAME silent lead, so the
// thread is usually identical from one step to the next. Summarising it again
// each time paid for the same call repeatedly. The summary is reused until a
// new message lands (keyed on the last message timestamp). In-memory: a
// restart costs at most one repeat summary per lead, never a burst.
const SUMMARY_CACHE_MAX = 500
const summaryCache = new Map() // `${conversationId}:${lastMessageAt}` -> summary

async function summariseThread(supabase, conv, messages, businessId) {
  const thread = formatThread(messages)
  const key = conv?.id ? `${conv.id}:${messages.at(-1)?.created_at ?? ''}` : null
  if (key && summaryCache.has(key)) return summaryCache.get(key)

  const summary = await callBot(supabase, 'conversation_summariser', thread, SUMMARISER_FALLBACK, {
    temperature: 0.2, maxTokens: 300, cacheKey: `summary:${businessId}`
  })
  if (!summary) return thread // AI unavailable: fall back to the raw thread, and do not cache it

  if (key) {
    if (summaryCache.size >= SUMMARY_CACHE_MAX) summaryCache.delete(summaryCache.keys().next().value)
    summaryCache.set(key, summary)
  }
  return summary
}

// Builds and QCs one follow-up draft for a queue item. Used by:
//  - worker.js, during normal scheduled processing
//  - the /regenerate route, when an owner asks for a fresh draft
// Does NOT do skip-checks, zone routing, or writing back to the row —
// callers own that, since regenerate shouldn't re-run eligibility
// checks on a row the scheduler already accepted.
export async function generateFollowupDraft(supabase, item, contact, business, pack, conv) {
  const [messages, materials, previousFollowups] = await Promise.all([
    conv ? getMessages(supabase, conv.id, { limit: THREAD_MESSAGES }) : Promise.resolve([]),
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
    convSummary = formatThread(messages)
  } else {
    convSummary = await summariseThread(supabase, conv, messages, item.business_id)
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

  const draft = await callBot(supabase, 'follow_up_generator', userContent, FOLLOWUP_FALLBACK, { cacheKey: `draft:${item.business_id}` })
  if (!draft) return { ok: false, reason: 'generation_failed' }

  const qc = await runQC(supabase, draft, pack, previousFollowups, { businessId: item.business_id })
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
// extra (optional): { objective, playbook, profile } — used by auto-campaigns so the
// example message is rewritten toward the campaign's goal, following its playbook,
// and matched to this specific lead's customer profile.
export async function rewriteSuggestedMessage(supabase, suggestion, contact, business, pack, conv, extra = {}) {
  const messages = conv ? await getMessages(supabase, conv.id, { limit: THREAD_MESSAGES }) : []

  let convSummary = 'No conversation history yet.'
  if (messages.length) {
    convSummary = messages.length <= 8
      ? formatThread(messages)
      : await summariseThread(supabase, conv, messages, contact.business_id)
  }

  const parts = [
    `PERSONA:\n${JSON.stringify(pack?.persona ?? {})}`,
    `OWNER'S SUGGESTED MESSAGE (treat as intent, not final copy):\n${suggestion}`,
    `CONVERSATION SUMMARY:\n${convSummary}`,
    `LEAD NAME: ${contact.name ?? 'Customer'}`
  ]
  if (extra.objective) parts.push(`CAMPAIGN OBJECTIVE:\n${extra.objective}`)
  if (extra.playbook) parts.push(`HOW TO FOLLOW UP (playbook):\n${extra.playbook}`)
  if (extra.profile) parts.push(`CUSTOMER PROFILE (this lead):\n${JSON.stringify(extra.profile)}`)
  if (extra.objective || extra.playbook || extra.profile) {
    parts.push('HOW TO USE THIS CONTEXT: the owner message is an EXAMPLE of the message for this step. Rewrite it for this exact lead: keep the step\'s intent, serve the campaign objective, follow the playbook, use the lead\'s real product interest and objections from the profile, and match the persona voice. Fill any {{placeholder}} tokens from the lead data. Never invent prices, discounts or facts not present in the context.')
  }
  const userContent = parts.join('\n\n')

  const draft = await callBot(supabase, 'suggestion_rewriter', userContent, SUGGESTION_REWRITE_FALLBACK, { cacheKey: `rewrite:${contact.business_id}` })
  if (!draft) return { ok: false, reason: 'generation_failed' }

  const previousFollowups = await getLastSentFollowups(supabase, contact.id, 3)
  const qc = await runQC(supabase, draft, pack, previousFollowups, { businessId: contact.business_id })
  if (!qc.passed && qc.attempts >= 2) {
    return { ok: false, reason: 'qc_failed', issues: qc.issues, draft }
  }

  return { ok: true, draft, finalMessage: qc.final_message, qcPassed: qc.passed, qcNotes: qc.issues.join(', ') || null }
}