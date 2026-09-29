import { callBot } from './ai.js'
import { AI_PROMPT_CATALOG } from '../../../src/aiPromptCatalog.js'

export const QC_FALLBACK = AI_PROMPT_CATALOG.followup_qc.prompt

export async function runQC(supabase, message, personaPack, previousMessages, { businessId = null } = {}) {
  const prevText = previousMessages
    .map(m => m.content?.text ?? '')
    .filter(Boolean)
    .join(' | ')

  // Static-per-business content first, per-lead content last: keeps the
  // shared prefix identical across requests so OpenAI can cache it.
  const userContent = [
    `PERSONA (language mix + tone):\n${JSON.stringify(personaPack?.persona ?? {})}`,
    `PREVIOUS 3 MESSAGES TO THIS LEAD:\n${prevText || 'None yet'}`,
    `MESSAGE TO CHECK:\n${message}`
  ].join('\n\n')
  const aiOptions = { json: true, temperature: 0, maxTokens: 300, cacheKey: businessId ? `qc:${businessId}` : null }

  // First attempt
  const raw = await callBot(supabase, 'followup_qc', userContent, QC_FALLBACK, aiOptions)
  if (!raw) return { passed: true, issues: [], suggested_fix: null, final_message: message, attempts: 1 }

  let result
  try { result = JSON.parse(raw) } catch { return { passed: true, issues: [], suggested_fix: null, final_message: message, attempts: 1 } }

  if (result.passed) {
    return { passed: true, issues: [], suggested_fix: null, final_message: message, attempts: 1 }
  }

  // Failed — try the suggested fix
  const fix = result.suggested_fix
  if (!fix) {
    return { passed: false, issues: result.issues ?? [], suggested_fix: null, final_message: message, attempts: 1 }
  }

  // Second pass on the fix
  const fixContent = [
    `PERSONA (language mix + tone):\n${JSON.stringify(personaPack?.persona ?? {})}`,
    `PREVIOUS 3 MESSAGES TO THIS LEAD:\n${prevText || 'None yet'}`,
    `MESSAGE TO CHECK:\n${fix}`
  ].join('\n\n')

  const raw2 = await callBot(supabase, 'followup_qc', fixContent, QC_FALLBACK, aiOptions)
  if (!raw2) return { passed: true, issues: [], suggested_fix: fix, final_message: fix, attempts: 2 }

  let result2
  try { result2 = JSON.parse(raw2) } catch { return { passed: true, issues: [], suggested_fix: fix, final_message: fix, attempts: 2 } }

  return {
    passed: result2.passed,
    issues: result2.issues ?? [],
    suggested_fix: fix,
    final_message: result2.passed ? fix : message, // if fix still fails, return original (caller will skip)
    attempts: 2
  }
}