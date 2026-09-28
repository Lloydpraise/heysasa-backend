import { OPENAI_KEY, OPENAI_MODEL } from '../config.js'
import { getBotConfig } from './db.js'
import { log } from './log.js'
import { getOpenAIAvailabilityState, setOpenAIUnavailable, shouldPauseOpenAIRequest } from './openAiGate.js'

export async function callOpenAI(options) {
  if (shouldPauseOpenAIRequest()) {
    const state = getOpenAIAvailabilityState();
    log('warn', 'ai', 'ai.paused', state.message || 'OpenAI Unavailable', { details: { purpose: options.purpose ?? null, status: state.status } })
    return null
  }
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
      if (res.status === 401 || res.status === 429 || /insufficient_quota|rate limit|invalid_api_key|billing/i.test(errText)) {
        setOpenAIUnavailable({ status: res.status, reason: errText.slice(0, 500) || 'OpenAI rejected the request', message: "cant call ai on debug 'openai 429 or 401 error'" })
        log('error', 'ai', 'ai.call_failed', `OpenAI Unavailable: ${res.status}`, {
          duration_ms: durationMs,
          details: { purpose: options.purpose ?? null, model: body.model, status: res.status, error: errText.slice(0, 500) }
        })
        return null
      }
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
    const message = String(e?.message || '')
    if (/401|429|rate limit|quota|api key|billing|insufficient/i.test(message)) {
      setOpenAIUnavailable({ status: /429/.test(message) ? 429 : /401/.test(message) ? 401 : null, reason: message, message: "cant call ai on debug 'openai 429 or 401 error'" })
    }
    log('error', 'ai', 'ai.call_error', message || 'OpenAI request failed', { duration_ms: Date.now() - startedAt, details: { purpose: options.purpose ?? null } })
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
