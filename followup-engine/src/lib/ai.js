import { OPENAI_KEY, OPENAI_MODEL } from '../config.js'
import { getBotConfig } from './db.js'

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

    if (!res.ok) { console.error(`[AI] ${res.status}`); return null }
    const data = await res.json()
    return data.choices[0].message.content.trim()
  } catch (e) {
    console.error(`[AI] ${e.message}`)
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
    json: options.json
  })
}