// Quality control for Follow-up AI messages. Two layers, so the business voice can never excuse bad service:
//   1. the service standard, in code (serviceStandard.js): length, caps, placeholders, invented prices, repeats...
//   2. an AI reviewer for what code cannot see: relevance to the lead, voice, unsupported claims
// A message that fails both is not sent. The caller skips it (as campaigns do) and the owner is asked to fix it.

import { callBot } from '../lib/ai.js'
import { AI_PROMPT_CATALOG } from '../../../src/aiPromptCatalog.js'
import { BOTS } from './constants.js'
import { checkServiceStandard } from './serviceStandard.js'

const QC_PROMPT = AI_PROMPT_CATALOG.followup_ai_qc.prompt

const fmtIssues = (issues) => issues.map(i => (typeof i === 'string' ? i : `${i.rule}: ${i.detail}`))

// contextText: the ad text + business facts the message is allowed to draw on (used for the price check).
// timeline: short text of the conversation (so the reviewer can judge relevance). skipAi: reuse an earlier review.
export async function qcMessage(supabase, message, { businessId, accountId = null, pack = null, contextText = '', previousMessages = [], timeline = '', skipAi = false } = {}) {
  const first = checkServiceStandard(message, { contextText, previousMessages })
  if (first.passed && skipAi) return { passed: true, finalMessage: message, issues: [], warnings: first.warnings, usedAi: false }

  const raw = await callBot(supabase, BOTS.qc, [
    `PERSONA (language mix + tone):\n${JSON.stringify(pack?.persona ?? {})}`,
    `BUSINESS AND AD FACTS:\n${String(contextText).slice(0, 3000) || 'None given'}`,
    timeline ? `CONVERSATION SO FAR:\n${timeline}` : '',
    `PREVIOUS MESSAGES WE SENT:\n${previousMessages.map(m => (typeof m === 'string' ? m : m?.content?.text ?? '')).filter(Boolean).join(' | ') || 'None yet'}`,
    first.issues.length ? `CODE CHECKS ALREADY FAILED: ${fmtIssues(first.issues).join('; ')}. Fix them in suggested_fix.` : '',
    `MESSAGE TO CHECK:\n${message}`,
  ].filter(Boolean).join('\n\n'), QC_PROMPT, { json: true, temperature: 0, maxTokens: 350, businessId, accountId, cacheKey: `fuaiqc:${businessId}` })

  // AI reviewer unavailable: code checks alone decide (never block a message only because the reviewer was down).
  let verdict = null
  try { verdict = raw ? JSON.parse(raw) : null } catch { verdict = null }
  if (!verdict) {
    return first.passed
      ? { passed: true, finalMessage: message, issues: [], warnings: first.warnings, usedAi: false, reviewerDown: true }
      : { passed: false, finalMessage: message, issues: fmtIssues(first.issues), warnings: first.warnings, usedAi: false, reviewerDown: true }
  }

  if (verdict.passed && first.passed) return { passed: true, finalMessage: message, issues: [], warnings: first.warnings, usedAi: true }

  const fix = typeof verdict.suggested_fix === 'string' ? verdict.suggested_fix.trim() : ''
  if (fix) {
    const again = checkServiceStandard(fix, { contextText, previousMessages })
    if (again.passed) return { passed: true, finalMessage: fix, issues: [], warnings: again.warnings, usedAi: true, fixed: true }
  }
  return {
    passed: false, finalMessage: message, usedAi: true, warnings: first.warnings,
    issues: [...fmtIssues(first.issues), ...((verdict.issues ?? []).map(String))],
  }
}
