import { callBot } from './ai.js'

const QC_FALLBACK = `
You are a quality control system for WhatsApp follow-up messages sent by Kenyan businesses.
Check the message against these rules:
1. LENGTH: Soft warn over 300 chars, hard fail over 500
2. LANGUAGE: Matches business language mix
3. NO_COMPETITOR: No competitor brand mentions
4. PRICE_ACCURACY: Any prices match the persona pack context
5. NO_REPEAT: Not repeating the same point as previous messages
6. NO_SPAM: No ALL CAPS words, max 2 exclamation marks
7. ONE_CTA: Exactly one call to action
8. APPROPRIATE: Professional and culturally appropriate for Kenya
Return ONLY valid JSON: {"passed":true,"issues":[],"suggested_fix":null}
or {"passed":false,"issues":["RULE: reason"],"suggested_fix":"fixed message"}
`

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