import { DEFAULT_MIN_CHARGE, DEFAULT_MAX_CHARGE } from '../config.js'
import { getBillingConfig, getStageWeight } from './db.js'

export async function checkBalance(s, businessId, required) {
  const { data } = await s.from('business_balances')
    .select('balance_usd').eq('business_id', businessId).single()
  return !!data && data.balance_usd >= required
}

export async function deductBalance(s, businessId, amount, reason) {
  const { data } = await s.from('business_balances')
    .select('balance_usd').eq('business_id', businessId).single()
  if (!data) return

  const newBalance = Math.max(0, data.balance_usd - amount)
  await s.from('business_balances').update({ balance_usd: newBalance }).eq('business_id', businessId)

  await s.from('balance_transactions').insert({
    business_id: businessId,
    amount: -amount,
    type: 'debit',
    description: reason,
    balance_after: newBalance
  }).then(() => {}, () => {})
}

export async function flagInsufficientFunds(s, businessId) {
  await s.from('businesses').update({ followup_ai_enabled: false }).eq('business_id', businessId)
}

export async function chargeLeadStageChange(s, businessId, contactId, fromStage, toStage, businessType) {
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