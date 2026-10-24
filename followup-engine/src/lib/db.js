// Ported 1:1 from db.ts — same queries, same field lists. No logic changes.
import { log } from './log.js'

// ── Business ──────────────────────────────────────────────────
const BUSINESS_COLUMNS = `
    business_id, name, timezone, whatsapp_channel, evolution_instance_id,
    followup_ai_enabled, business_type, currency, subscription_active,
    followup_daily_cap, followup_total_sent, followup_zone_recent,
    followup_zone_medium, followup_max_per_lead, owner_phone,
    followup_nudge_enabled, followup_nudge_interval_hrs,
    followup_nudge_min_pending, hot_lead_alert_enabled,
    hot_lead_intent_threshold, followup_stop_at_stage,
    followup_alert_at_stage, waba_phone_number_id,
    followup_quiet_start, followup_quiet_end, followup_active_days,
    followup_zone_recent_mode, followup_zone_medium_mode, followup_zone_old_mode`
// Follow-up AI settings. If the database does not have these columns yet (code deployed before the migration ran),
// the engine keeps working without them instead of treating every business as missing.
const FOLLOWUP_AI_COLUMNS = `, followup_ai_scheduling, followup_min_gap_hours, followup_silence_hours, followup_approval_default`

export async function getBusiness(s, businessId) {
  const full = await s.from('businesses').select(BUSINESS_COLUMNS + FOLLOWUP_AI_COLUMNS).eq('business_id', businessId).single()
  if (!full.error) return full.data
  const { data } = await s.from('businesses').select(BUSINESS_COLUMNS).eq('business_id', businessId).single()
  return data
}

// ── Contact ───────────────────────────────────────────────────
export const CONTACT_SELECT = `
    id, name, phone, social_id, country_code, business_id, do_not_contact, follow_up_opted_in,
    lead_state, optimal_contact_hour, follow_up_sequence_id,
    current_sequence_step, follow_up_count, consent_message_sent_at,
    created_at, last_seen, daily_followup_count, daily_followup_reset_at,
    lifetime_followups_sent, followup_zone, product_interests,
    wa_exists, wa_checked_at,
    lead_type, is_ad_lead, ad_id, original_ad_id, ad_headline, ad_body, ad_platform, ad_source_url
  `

export async function getContact(s, contactId) {
  const { data } = await s.from('contacts').select(CONTACT_SELECT).eq('id', contactId).single()
  return data
}

// Many contacts in a few requests (same columns as getContact). Returns Map(id -> contact).
export async function getContactsByIds(s, ids, chunkSize = 200) {
  const out = new Map()
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += chunkSize) {
    const { data, error } = await s.from('contacts').select(CONTACT_SELECT).in('id', unique.slice(i, i + chunkSize))
    if (error) throw new Error(`Contact lookup failed: ${error.message}`)
    for (const row of data ?? []) out.set(row.id, row)
  }
  return out
}

// ── Persona Pack ──────────────────────────────────────────────
export async function getPersonaPack(s, businessId) {
  const { data } = await s.from('persona_packs')
    .select('pack').eq('business_id', businessId).eq('is_active', true).single()
  return data?.pack ?? null
}

// ── Conversation ──────────────────────────────────────────────
// NOTE: lead_state lives on contacts, not conversations. Selecting it here made this query fail with
// "column conversations.lead_state does not exist" for every call, and because the error used to be
// ignored it silently returned null (so conversation_id was never attached to queued follow-ups,
// opt-in classification never ran, the stage check and hot-lead alert never worked).
export const CONVERSATION_SELECT = `
    id, lead_quality, lead_stage_ecom, lead_stage_service,
    active_agent, last_user_message_at, ai_enabled, customer_intent
  `

export async function getConversation(s, contactId, businessId) {
  const { data, error } = await s.from('conversations').select(CONVERSATION_SELECT)
    .eq('business_id', businessId).eq('contact_id', contactId).maybeSingle()
  if (error) {
    log('error', 'engine', 'db.get_conversation_failed', `getConversation failed for contact ${contactId}: ${error.message}`, {
      business_id: businessId, contact_id: contactId, details: { error: error.message, code: error.code }
    })
    return null
  }
  return data
}

// Conversations for many contacts of one business in a few requests. Returns Map(contact_id -> conversation).
export async function getConversationsByContactIds(s, contactIds, chunkSize = 200) {
  const out = new Map()
  const unique = [...new Set(contactIds)]
  for (let i = 0; i < unique.length; i += chunkSize) {
    const { data, error } = await s.from('conversations').select(`${CONVERSATION_SELECT}, contact_id, business_id`)
      .in('contact_id', unique.slice(i, i + chunkSize))
    if (error) throw new Error(`Conversation lookup failed: ${error.message}`)
    for (const row of data ?? []) out.set(`${row.business_id}|${row.contact_id}`, row)
  }
  return out
}

// ── Messages ──────────────────────────────────────────────────
// `limit` returns only the most recent N messages (still oldest-first), so AI
// callers don't ship an entire multi-month thread when the tail is enough.
// Omit it to get the full thread as before.
export async function getMessages(s, conversationId, { limit = null } = {}) {
  const base = s.from('messages')
    .select('direction, content, type, created_at, sentiment_score, intent_level, agent_role')
    .eq('conversation_id', conversationId)
  if (limit) {
    const { data } = await base.order('created_at', { ascending: false }).limit(limit)
    return (data ?? []).reverse()
  }
  const { data } = await base.order('created_at', { ascending: true })
  return data ?? []
}

export async function getLastSentFollowups(s, contactId, count = 3) {
  const { data } = await s.from('messages')
    .select('content, created_at')
    .eq('contact_id', contactId)
    .eq('agent_role', 'follow_up_ai')
    .eq('direction', 'out')
    .order('created_at', { ascending: false })
    .limit(count)
  return data ?? []
}

// ── Sequence ──────────────────────────────────────────────────
export async function getSequenceStep(s, sequenceId, step) {
  const { data } = await s.from('follow_up_steps')
    .select('*').eq('sequence_id', sequenceId).eq('step_number', step)
    .single()
  return data
}

export async function getNextSequenceStep(s, sequenceId, currentStep) {
  const { data } = await s.from('follow_up_steps')
    .select('*').eq('sequence_id', sequenceId)
    .gt('step_number', currentStep).order('step_number', { ascending: true })
    .limit(1).maybeSingle()
  return data
}

export async function getBusinessSequence(s, businessId, businessType) {
  const { data: specific } = await s.from('follow_up_sequences')
    .select('*').eq('business_id', businessId).eq('is_active', true).maybeSingle()
  if (specific) return specific

  const type = businessType === 'ecommerce' ? 'ecom' : 'service'
  const { data: global } = await s.from('follow_up_sequences')
    .select('*').is('business_id', null).eq('business_type', type)
    .eq('is_active', true).maybeSingle()
  return global
}

// ── Materials ────────────────────────────────────────────────
const TOUCHPOINT_MATERIAL_MAP = {
  social_proof: ['testimonial'],
  value_tip: ['tip', 'educational'],
  expert_authority: ['tip'],
  offer: ['offer'],
  fomo: ['testimonial', 'offer'],
  new_angle: ['educational'],
  proprietary_content: ['tip', 'educational'],
  graceful_exit: ['story'],
  soft_checkin: ['story'],
  final_offer: ['offer'],
  product_reminder: ['educational'],
}

export async function getMaterialsForTouchpoint(s, businessId, touchpointType) {
  const types = TOUCHPOINT_MATERIAL_MAP[touchpointType] ?? []
  if (!types.length) return []

  const { data } = await s.from('followup_materials')
    .select('material_type, title, content, image_url')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .in('material_type', types)
    .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
    .limit(3)
  return data ?? []
}

// ── Bot config ────────────────────────────────────────────────
// maybeSingle: a bot with no override row is normal (the built-in prompt is used), not a database error.
export async function getBotConfig(s, botId) {
  try {
    const { data } = await s.from('ai_bots_config')
      .select('prompt, model, temperature, max_tokens')
      .eq('bot_id', botId).eq('is_active', true).maybeSingle()
    return data
  } catch { return null }
}

// ── Config helpers ────────────────────────────────────────────
export async function getGlobalConfig(s, key, fallback) {
  try {
    const { data } = await s.from('global_config')
      .select('value').eq('key', key).single()
    return data?.value ?? fallback
  } catch { return fallback }
}

export async function getBillingConfig(s, key, fallback) {
  try {
    const { data } = await s.from('followup_billing_config')
      .select('value').eq('key', key).maybeSingle()
    return data ? parseFloat(data.value) : fallback
  } catch { return fallback }
}

export async function getStageWeight(s, stage, businessType) {
  try {
    const type = businessType === 'ecommerce' ? 'ecom' : 'service'
    const { data } = await s.from('followup_billing_stage_weights')
      .select('weight').eq('stage', stage).eq('business_type', type).maybeSingle()
    return data ? parseFloat(String(data.weight)) : 0.1
  } catch { return 0.1 }
}

// ── Daily cap check ───────────────────────────────────────────
export async function getDailyCount(s, businessId) {
  const today = new Date().toISOString().split('T')[0]
  const { count } = await s.from('follow_up_queue')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('status', 'sent')
    .gte('processed_at', today + 'T00:00:00Z')
  return count ?? 0
}

// ── Nudge log ─────────────────────────────────────────────────
export async function getLastNudge(s, businessId, nudgeType) {
  const { data } = await s.from('followup_nudge_log')
    .select('sent_at').eq('business_id', businessId)
    .eq('nudge_type', nudgeType)
    .order('sent_at', { ascending: false }).limit(1).maybeSingle()
  return data?.sent_at ?? null
}