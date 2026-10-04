import { DEFAULT_MIN_CHARGE, DEFAULT_MAX_CHARGE } from '../config.js'
import { getBillingConfig, getStageWeight } from './db.js'

// HeySasa's own business (business_type = 'heysasa') sends the waitlist
// messages. It must never be charged, never be blocked for "no balance", and
// above all must never have its follow-ups switched off by flagInsufficientFunds.
// Cached for a minute so this costs one lookup per business per minute.
const freeCache = new Map()
async function isFreeBusiness(s, businessId) {
  const hit = freeCache.get(businessId)
  if (hit && Date.now() - hit.at < 60_000) return hit.free
  const { data } = await s.from('businesses').select('business_type').eq('business_id', businessId).maybeSingle()
  const free = data?.business_type === 'heysasa'
  freeCache.set(businessId, { free, at: Date.now() })
  return free
}

// ── Pricing model ───────────────────────────────────────────────────────────
//   AI runs : USD, (OpenAI cost) x runner multiplier -> bill_ai_usage()   (prices in billing_prices / ai_model_prices)
//   Sends   : KES, send_price_kes per message         -> bill_send()
// Both are single atomic SQL functions, so every process bills identically.
// The main backend has the same AI wrapper in src/services/aiBilling.js.

export async function getSendPriceKes(s) {
  try {
    const { data } = await s.from('billing_prices').select('value').eq('key', 'send_price_kes').single()
    return data ? Number(data.value) : 0.5
  } catch { return 0.5 }
}

export async function getUsdKesRate(s) {
  try {
    const { data } = await s.from('billing_prices').select('value').eq('key', 'usd_kes_rate').single()
    const v = data ? Number(data.value) : 0
    return v > 0 ? v : 129.2
  } catch { return 129.2 }
}

// ONE wallet (business_balances.balance_usd) pays for both AI (USD) and sends (KES, converted at usd_kes_rate).

// Can this business pay for one more send?
export async function checkSendBalance(s, businessId) {
  if (await isFreeBusiness(s, businessId)) return true
  const [{ data }, price, rate] = await Promise.all([
    s.from('business_balances').select('balance_usd').eq('business_id', businessId).single(),
    getSendPriceKes(s), getUsdKesRate(s)
  ])
  return !!data && Number(data.balance_usd) >= price / rate
}

// Can this business pay for AI? Any positive balance; the exact cost is only known after the call.
export async function checkAiBalance(s, businessId) {
  if (await isFreeBusiness(s, businessId)) return true
  const { data } = await s.from('business_balances').select('balance_usd').eq('business_id', businessId).single()
  return !!data && Number(data.balance_usd) > 0
}

export async function billSend(s, businessId, { count = 1, reason = 'followup_send', runner = 'followup_send' } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await s.rpc('bill_send', { p_business_id: businessId, p_count: count, p_reason: reason, p_runner: runner })
    if (!error) return data
    if (attempt === 3) console.error(`[billing] FAILED to bill send business=${businessId} count=${count} reason=${reason}: ${error.message}`)
    else await new Promise(r => setTimeout(r, 300 * attempt))
  }
  return null
}

export async function billAiUsage(s, { businessId, runner, model, promptTokens = 0, cachedTokens = 0, completionTokens = 0, runId = null }) {
  if (!businessId) {
    console.error(`[billing] AI usage with NO business_id was not billed (runner=${runner}, tokens=${promptTokens}+${completionTokens})`)
    return null
  }
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await s.rpc('bill_ai_usage', {
      p_business_id: businessId, p_runner: runner, p_model: model || 'default',
      p_prompt_tokens: Math.round(promptTokens || 0), p_cached_tokens: Math.round(cachedTokens || 0),
      p_completion_tokens: Math.round(completionTokens || 0), p_run_id: runId
    })
    if (!error) return data
    lastError = error
    if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt))
  }
  console.error(`[billing] FAILED to bill AI usage business=${businessId} runner=${runner} model=${model} prompt=${promptTokens} cached=${cachedTokens} completion=${completionTokens}: ${lastError?.message}`)
  return null
}

// Outcome (stage change) charges stay in USD; atomic via the existing deduct_balance() SQL function.
export async function deductBalance(s, businessId, amount, reason) {
  if (await isFreeBusiness(s, businessId)) return
  const { error } = await s.rpc('deduct_balance', { p_business_id: businessId, p_amount: amount, p_reason: reason })
  if (error) console.error(`[billing] deduct_balance failed business=${businessId} reason=${reason}: ${error.message}`)
}

export async function flagInsufficientFunds(s, businessId) {
  if (await isFreeBusiness(s, businessId)) return
  await s.from('businesses').update({ followup_ai_enabled: false }).eq('business_id', businessId)
}

export async function chargeLeadStageChange(s, businessId, contactId, fromStage, toStage, businessType) {
  if (await isFreeBusiness(s, businessId)) return
  const [minCharge, maxCharge] = await Promise.all([
    getBillingConfig(s, 'min_charge_usd', DEFAULT_MIN_CHARGE),
    getBillingConfig(s, 'max_charge_usd', DEFAULT_MAX_CHARGE)
  ])

  const priceRange = maxCharge - minCharge
  const fromWeight = fromStage ? await getStageWeight(s, fromStage, businessType) : 0
  const toWeight = toStage === 'won' ? 1.0 : await getStageWeight(s, toStage, businessType)
  const weightDelta = Math.max(0, toWeight - fromWeight)
  const charge = weightDelta * priceRange

  if (charge <= 0) return

  const { data: balance } = await s.from('business_balances')
    .select('balance_usd').eq('business_id', businessId).single()
  const balanceBefore = balance?.balance_usd ?? 0

  await deductBalance(s, businessId, charge, `stage_change:${fromStage ?? 'new'}→${toStage}`)

  await s.from('followup_billing_events').insert({
    business_id: businessId,
    contact_id: contactId,
    event_type: toStage === 'won' ? 'lead_won' : 'stage_advance',
    from_stage: fromStage,
    to_stage: toStage,
    charge_usd: charge,
    balance_before: balanceBefore,
    balance_after: Math.max(0, balanceBefore - charge)
  }).then(() => {}, () => {})
}