import { OPENAI_KEY, OPENAI_MODEL } from '../config.js'
import { getBotConfig } from './db.js'
import { log } from './log.js'

export async function callOpenAI(options) {
  const body = {
    model: options.model ?? OPENAI_MODEL,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 500,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userContent }
    ]
  }
  if (options.json) body.response_format = { type: 'json_object' }

  const startedAt = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    clearTimeout(timeout)
    const durationMs = Date.now() - startedAt

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      log('error', 'ai', 'ai.call_failed', `OpenAI returned ${res.status}`, {
        duration_ms: durationMs,
        details: { purpose: options.purpose ?? null, model: body.model, status: res.status, error: errText.slice(0, 500) }
      })
      return null
    }
    const data = await res.json()
    log('info', 'ai', 'ai.call', `OpenAI call (${options.purpose ?? 'unspecified'})`, {
      business_id: options.businessId ?? null,
      duration_ms: durationMs,
      details: {
        purpose: options.purpose ?? null,
        model: body.model,
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
      }
    })
    return data.choices[0].message.content.trim()
  } catch (e) {
    log('error', 'ai', 'ai.call_error', e.message, { duration_ms: Date.now() - startedAt, details: { purpose: options.purpose ?? null } })
    return null
  }
}

// Fetches prompt from ai_bots_config — falls back to hardcoded if missing.
// Precedence for model: an admin override saved in ai_bots_config always
// wins, then the caller's own default (e.g. a classifier that wants a
// cheaper model than the platform default), then OPENAI_MODEL.
export async function callBot(supabase, botId, userContent, fallbackPrompt, options = {}) {
  const config = await getBotConfig(supabase, botId)
  return callOpenAI({
    systemPrompt: config?.prompt ?? fallbackPrompt,
    userContent,
    model: config?.model ?? options.model ?? OPENAI_MODEL,
    temperature: config?.temperature ?? options.temperature ?? 0.7,
    maxTokens: options.maxTokens ?? config?.max_tokens ?? 500,
    json: options.json,
    purpose: options.purpose ?? botId,
    businessId: options.businessId ?? null
  })
}
