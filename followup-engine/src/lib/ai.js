import { OPENAI_KEY, OPENAI_MODEL } from '../config.js'
import { getBotConfig } from './db.js'
import { billAiUsage } from './billing.js'
import { supabase as billingClient } from '../supabaseClient.js'
import { log } from './log.js'
import {
  classifyOpenAIFailure,
  getOpenAIAvailabilityState,
  getOpenAICooldownMs,
  noteOpenAIRateLimited,
  setOpenAIUnavailable,
  shouldPauseOpenAIRequest,
} from './openAiGate.js'

// Rate limits (429 rate_limit_exceeded) are waited out and retried; they never
// latch the gate. Only quota exhaustion / a bad key does (see openAiGate.js).
const MAX_RATE_LIMIT_RETRIES = 2
const MAX_WAIT_MS = 20_000
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

export async function callOpenAI(options) {
  if (shouldPauseOpenAIRequest()) {
    const state = getOpenAIAvailabilityState()
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
  // Routes requests that share a prefix (same business) to the same cache.
  // Keep keys low-cardinality: OpenAI advises ~15 requests/min per key.
  if (options.cacheKey) body.prompt_cache_key = String(options.cacheKey).slice(0, 64)

  const startedAt = Date.now()

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    // Another caller may have just been rate limited: back off together.
    const cooldown = getOpenAICooldownMs()
    if (cooldown > 0) await sleep(Math.min(cooldown, MAX_WAIT_MS))
    if (shouldPauseOpenAIRequest()) return null // latched while we waited

    let res
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      try {
        res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } finally {
        clearTimeout(timeout)
      }
    } catch (e) {
      // Network error / timeout: says nothing about credits, so never latch.
      log('error', 'ai', 'ai.call_error', String(e?.message || 'OpenAI request failed'), { duration_ms: Date.now() - startedAt, details: { purpose: options.purpose ?? null } })
      return null
    }

    const durationMs = Date.now() - startedAt

    if (res.ok) {
      const data = await res.json()
      const usage = data.usage ?? {}
      // Every OpenAI response is billed here, in the one function all follow-up AI goes through.
      // options.skipBilling is ONLY for admin previews; anything else without a businessId is
      // logged loudly (ai.unbilled) so it cannot go unnoticed.
      if (!options.skipBilling) {
        if (!options.businessId) {
          log('error', 'ai', 'ai.unbilled', `OpenAI call without a business id was NOT billed (${options.purpose ?? 'unspecified'})`, { details: { purpose: options.purpose ?? null, promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null } })
        } else {
          await billAiUsage(billingClient, {
            businessId: options.businessId, runner: options.purpose ?? 'unspecified', model: body.model,
            promptTokens: usage.prompt_tokens ?? 0, cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0
          })
        }
      }
      log('info', 'ai', 'ai.call', `OpenAI call (${options.purpose ?? 'unspecified'})`, {
        business_id: options.businessId ?? null,
        duration_ms: durationMs,
        details: {
          purpose: options.purpose ?? null,
          model: body.model,
          promptTokens: usage.prompt_tokens ?? null,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? null,
        }
      })
      return data.choices[0].message.content.trim()
    }

    const errText = await res.text().catch(() => '')
    const failure = classifyOpenAIFailure({ status: res.status, bodyText: errText, headers: res.headers })
    const errDetails = { purpose: options.purpose ?? null, model: body.model, status: res.status, kind: failure.kind, code: failure.code, error: errText.slice(0, 500) }

    if (failure.kind === 'quota' || failure.kind === 'auth') {
      setOpenAIUnavailable({ status: res.status, reason: errText.slice(0, 500) || 'OpenAI rejected the request', message: "cant call ai on debug 'openai 429 or 401 error'" })
      log('error', 'ai', 'ai.call_failed', `OpenAI Unavailable (${failure.kind}): ${res.status}`, { duration_ms: durationMs, details: errDetails })
      return null
    }

    if (failure.kind === 'rate_limit' && attempt < MAX_RATE_LIMIT_RETRIES) {
      const waitMs = noteOpenAIRateLimited(failure.retryAfterMs)
      log('warn', 'ai', 'ai.rate_limited', `OpenAI rate limited, retrying in ${Math.round(waitMs / 1000)}s`, { duration_ms: durationMs, details: { ...errDetails, attempt: attempt + 1, waitMs } })
      continue
    }

    log('error', 'ai', 'ai.call_failed', `OpenAI returned ${res.status} (${failure.kind})`, { duration_ms: durationMs, details: errDetails })
    return null
  }
  return null
}

// Bot prompts live in ai_bots_config. They change rarely, so cache them for a
// minute instead of paying a DB round trip on every single AI call.
const BOT_CONFIG_TTL_MS = 60_000
const botConfigCache = new Map() // botId -> { at, config }

async function getBotConfigCached(supabase, botId) {
  const hit = botConfigCache.get(botId)
  if (hit && Date.now() - hit.at < BOT_CONFIG_TTL_MS) return hit.config
  const config = await getBotConfig(supabase, botId)
  botConfigCache.set(botId, { at: Date.now(), config })
  return config
}

// Fetches prompt from ai_bots_config — falls back to hardcoded if missing.
// Precedence for model: an admin override saved in ai_bots_config always
// wins, then the caller's own default (e.g. a classifier that wants a
// cheaper model than the platform default), then OPENAI_MODEL.
export async function callBot(supabase, botId, userContent, fallbackPrompt, options = {}) {
  const config = await getBotConfigCached(supabase, botId)
  return callOpenAI({
    systemPrompt: config?.prompt ?? fallbackPrompt,
    userContent,
    model: config?.model ?? options.model ?? OPENAI_MODEL,
    temperature: config?.temperature ?? options.temperature ?? 0.7,
    maxTokens: config?.max_tokens ?? options.maxTokens ?? 500,
    json: options.json,
    purpose: options.purpose ?? botId,
    businessId: options.businessId ?? null,
    skipBilling: options.skipBilling === true,
    cacheKey: options.cacheKey ?? null
  })
}
