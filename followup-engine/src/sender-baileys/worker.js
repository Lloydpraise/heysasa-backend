import { supabase } from '../supabaseClient.js'
import { getBusinessForAccount, getContact, getConversation } from '../lib/db.js'
import { loadAccounts, accountCanOperate, laneKey } from '../lib/accounts.js'
import { sendContentViaEvolution } from './evolutionSender.js'
import { resolveSendTarget } from '../lib/sendTarget.js'
import { checkAntiban, recordSend, recordFailedAttempt, primeAntiban, reserveSend } from './antiban.js'
import { effectiveDailyCap, sentTodayCount, noteSent, logWarmupHold } from '../lib/warmup.js'
import { recordSuccessfulSend, recordFailedDispatch } from './postSend.js'
import { ensureNumberOnWhatsApp, needsNumberLookup } from '../lib/numberCheck.js'
import { checkSendBalance } from '../lib/billing.js'
import { NON_CUSTOMER_TYPES } from '../lib/leadTypes.js'
import { confirmInstanceAfterFailure, healDemotedSessions } from '../lib/instanceHealth.js'
import { log } from '../lib/log.js'
import { isBusinessAwake } from '../lib/timing.js'
import { nextAwakeAt } from '../lib/wakeTimes.js'

// How the sender picks work (one pass = one call to processBaileysBatch):
//   1. Lanes are visited one by one, in random order, so a number with a 900-lead campaign can never sit in
//      front of everyone else's follow-ups. A lane is one connected account (one WhatsApp number, sending from
//      accounts.instance_name); sessions without an account (from before accounts) make one lane per business.
//      An account that is not connected, or may not operate (access fee unpaid), has no lane: its rows wait.
//      Antiban timers, the daily cap and the new-number warm-up all count per lane.
//   2. For each business the cheap, in-memory gates run FIRST (quiet hours, antiban gap/hourly ceiling,
//      cool-down, daily cap). If any says "not now", the business is skipped with no per-message queries.
//   3. Only then are its oldest due messages read, and at most ONE of them is attempted: after an attempt
//      (sent or failed) the antiban gap closes the gate again anyway.
//   4. Everything that could have changed since the message was queued is re-checked right before it goes
//      (opt-out, customer type, replies, holds, balance), because a big campaign waits in the queue for days.
const POOL_PER_BUSINESS = 25
const STALE_CLAIM_MS = 2 * 60_000
const REPLY_WINDOW_MS = 2 * 3_600_000
const HOLD_LOG_EVERY_MS = 10 * 60_000
const NO_BALANCE_RETRY_MS = 10 * 60_000
const WAKE_PAD_MS = 250

let claimedAtSupported = true   // flips to false if the claimed_at column has not been added yet (see migration)
const lastHoldLog = new Map()

function logHold(businessId, reason, message, details = {}) {
  const key = `${businessId}:${reason}`
  if (Date.now() - (lastHoldLog.get(key) ?? 0) < HOLD_LOG_EVERY_MS) return
  lastHoldLog.set(key, Date.now())
  log('info', 'sender', `sender.held_${reason}`, message, { business_id: businessId, details })
}

function nextUtcMidnight() {
  const d = new Date()
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 30)
}

async function logSendEvent(businessId, { queueId = null, contactId = null, instanceName = null, eventType, reason = null, accountId = null }) {
  const { error } = await supabase.from('follow_up_send_events').insert({
    business_id: businessId,
    ...(accountId ? { account_id: accountId } : {}),
    follow_up_queue_id: queueId,
    contact_id: contactId,
    instance_name: instanceName,
    event_type: eventType,
    reason
  })
  if (error) log('error', 'sender', 'sender.log_event_failed', `Failed to log send event: ${error.message}`, { business_id: businessId, details: { error: error.message } })
}

// A 'sending' row is one we claimed and never finished (process crashed or was restarted mid-send).
// It is judged by WHEN IT WAS CLAIMED (claimed_at), not by scheduled_at (a campaign row's scheduled_at can be days old,
// which made every row in flight look stale). Before a stale row goes back in the queue we look for an outbound message
// to that person since the claim: if one exists the send DID happen, so the row is closed as sent instead of sent twice.
export async function recoverStaleClaims() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  let query = supabase.from('follow_up_queue')
    .select('id, business_id, contact_id, campaign_id, scheduled_at' + (claimedAtSupported ? ', claimed_at' : ''))
    .eq('status', 'sending')
  query = claimedAtSupported
    ? query.or(`claimed_at.lte.${cutoff},and(claimed_at.is.null,scheduled_at.lte.${cutoff})`)
    : query.lte('scheduled_at', cutoff)
  let { data, error } = await query.limit(200)

  if (error && claimedAtSupported && /claimed_at/.test(error.message ?? '')) {
    claimedAtSupported = false
    return recoverStaleClaims()
  }
  if (error) {
    log('error', 'sender', 'sender.stale_claims_recovery_failed', `Failed to recover stale claims: ${error.message}`, { details: { error: error.message } })
    return
  }
  if (!data?.length) return

  let requeued = 0
  let closedAsSent = 0
  for (const row of data) {
    const since = row.claimed_at ?? new Date(Date.now() - 30 * 60_000).toISOString()
    const { data: outbound } = await supabase.from('messages').select('id')
      .eq('contact_id', row.contact_id).eq('direction', 'out').eq('agent_role', 'follow_up_ai')
      .gte('created_at', since).limit(1)
    if (outbound?.length) {
      await supabase.from('follow_up_queue').update({ status: 'sent', processed_at: new Date().toISOString(), last_dispatch_error: 'recovered_already_sent' })
        .eq('id', row.id).eq('status', 'sending')
      closedAsSent++
    } else {
      await supabase.from('follow_up_queue').update({ status: 'ready_to_send', last_dispatch_error: 'recovered_stale_sending_claim' })
        .eq('id', row.id).eq('status', 'sending')
      requeued++
    }
  }
  log('warn', 'sender', 'sender.stale_claims_recovered', `Recovered ${data.length} stale sending claim(s): ${requeued} back in the queue, ${closedAsSent} were already sent`, { details: { requeued, closedAsSent, ids: data.map(r => r.id) } })
}

async function claimItem(item) {
  const base = { status: 'sending' }
  const attempt = async (payload) => supabase.from('follow_up_queue').update(payload).eq('id', item.id).eq('status', 'ready_to_send').select('id').maybeSingle()
  let res = await attempt(claimedAtSupported ? { ...base, claimed_at: new Date().toISOString() } : base)
  if (res.error && claimedAtSupported && /claimed_at/.test(res.error.message ?? '')) {
    claimedAtSupported = false
    res = await attempt(base)
  }
  return res
}

// Put a row back without counting an attempt (our own hiccup, or "not yet": nothing was sent).
async function releaseItem(item, delayMs, reason) {
  await supabase.from('follow_up_queue')
    .update({ status: 'ready_to_send', scheduled_at: new Date(Date.now() + delayMs).toISOString(), last_dispatch_error: reason })
    .eq('id', item.id).in('status', ['sending', 'ready_to_send'])
}

// Close a message for good (opt-out, not a customer, not on WhatsApp) and free the person's campaign spot.
async function skipItemForGood(item, skipReason, failureClass = null) {
  await supabase.from('follow_up_queue').update({
    status: 'skipped', skip_reason: skipReason, ...(failureClass ? { failure_class: failureClass } : {}), processed_at: new Date().toISOString()
  }).eq('id', item.id).eq('status', 'ready_to_send')
  if (item.campaign_id) {
    await supabase.from('campaign_enrollments').update({ status: 'exited' })
      .eq('campaign_id', item.campaign_id).eq('lead_id', item.contact_id).in('status', ['pending', 'active'])
  }
}

// What has to be true at the moment of sending. Returns null when fine, otherwise
// { action: 'skip', reason } (never going to be sent) or { action: 'hold', delayMs, reason } (not now).
async function sendTimeCheck(item, contact, business) {
  if (contact.do_not_contact) return { action: 'skip', reason: 'do_not_contact' }
  if (NON_CUSTOMER_TYPES.has(contact.lead_type)) return { action: 'skip', reason: 'not_a_customer' }
  if (['won', 'lost'].includes(contact.lead_state ?? '')) return { action: 'skip', reason: `lead_${contact.lead_state}` }
  if (!business.followup_ai_enabled) return { action: 'hold', delayMs: 10 * 60_000, reason: 'followup_disabled' }
  if (!business.subscription_active) return { action: 'hold', delayMs: 30 * 60_000, reason: 'subscription_inactive' }

  const { data: leadState } = await supabase.from('lead_ai_state').select('hold_until')
    .eq('business_id', item.business_id).eq('contact_id', item.contact_id).maybeSingle()
  const holdUntil = leadState?.hold_until ? Date.parse(leadState.hold_until) : 0
  if (holdUntil > Date.now()) return { action: 'hold', delayMs: Math.min(holdUntil - Date.now(), 24 * 3_600_000), reason: 'followup_hold' }

  // The lead wrote in recently (a reply cancels queued rows, this catches the one that slipped through).
  // Chat AI messages never come through here, so this only ever protects campaign and follow-up sends.
  const conv = await getConversation(supabase, item.contact_id, item.business_id)
  if (conv?.last_user_message_at && Date.now() - Date.parse(conv.last_user_message_at) < REPLY_WINDOW_MS) {
    return { action: 'hold', delayMs: 30 * 60_000, reason: 'lead_recently_active' }
  }
  return null
}

async function processLane(lane, ctx) {
  const { businessId, accountId, key } = lane
  // Caps, quiet hours and switches are the account's (accounts.settings over the business defaults).
  const business = await getBusinessForAccount(supabase, businessId, accountId)
  if (!business) {
    logHold(businessId, 'business_missing', `Messages are waiting for ${businessId} but the business record was not found`)
    return 0
  }

  // ── Business-level gates: cheap, and they decide before any message is read ──────────────
  if (!isBusinessAwake(business)) {
    logHold(businessId, 'quiet_hours', `Holding queued messages for ${business.name ?? businessId}: quiet hours or inactive day`)
    ctx.wake(nextAwakeAt(business))
    return 0
  }
  await primeAntiban(supabase, key, { businessId, accountId })
  const gate = checkAntiban(key, business.followup_daily_cap)
  if (!gate.allowed) {
    if (gate.reason === 'cooldown') logHold(businessId, 'cooldown', `Cooling down ${business.name ?? businessId}: recent sends failed, waiting ${Math.ceil(gate.retryAfterMs / 60_000)} min`, { retryAfterMs: gate.retryAfterMs })
    ctx.wake(Date.now() + gate.retryAfterMs + WAKE_PAD_MS)
    return 0
  }

  // The daily cap is checked HERE, at send time, for everything (campaigns included). It used to be checked only at the moment a
  // message was promoted to "ready", when nothing had been sent yet, so a big campaign was waved through whole and then
  // drained at the hourly ceiling regardless of the cap. During a business's first week the slow-start cap applies.
  const warm = await effectiveDailyCap(supabase, businessId, business.followup_daily_cap, accountId)
  const sentToday = await sentTodayCount(supabase, businessId, accountId)
  if (sentToday >= warm.cap) {
    if (warm.warmupActive) logWarmupHold(businessId, warm.day, warm.cap)
    else logHold(businessId, 'daily_cap', `Daily cap reached for ${business.name ?? businessId}: ${sentToday}/${warm.cap} sent today, resuming tomorrow`, { sentToday, cap: warm.cap })
    ctx.wake(nextUtcMidnight())
    return 0
  }

  // ── Read this lane's oldest due messages ─────────────────────────────────────────────────
  let itemsQuery = supabase
    .from('follow_up_queue')
    .select('*')
    .eq('status', 'ready_to_send')
    .eq('channel', 'baileys')
    .eq('business_id', businessId)
  if (accountId) itemsQuery = itemsQuery.eq('account_id', accountId)
  const { data: items, error } = await itemsQuery
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(POOL_PER_BUSINESS)
  if (error) {
    log('error', 'sender', 'sender.fetch_batch_failed', `Failed to fetch batch for ${businessId}: ${error.message}`, { business_id: businessId, details: { error: error.message } })
    ctx.retry = true
    return 0
  }
  if (!items?.length) return 0

  const lookupWaitCampaigns = new Set()

  for (const item of items) {
    try {
      const outcome = await processItem(item, { business, lane, ctx, lookupWaitCampaigns })
      if (outcome === 'sent') return 1
      if (outcome === 'attempted' || outcome === 'hold') return 0
    } catch (e) {
      log('error', 'sender', 'sender.unexpected_error', `Unexpected error for queue item ${item.id}: ${e.message}`, {
        business_id: item.business_id, contact_id: item.contact_id, entity_id: item.id,
        details: { error: { name: e.name, message: e.message } }
      })
      // Our own hiccup (database, bug) is not the lead's fault and nothing was sent: put it back a few minutes later without
      // counting an attempt, and slow this business down.
      recordFailedAttempt(key, 'unknown')
      await releaseItem(item, 5 * 60_000, `unexpected: ${String(e.message).slice(0, 150)}`).catch(() => {})
      await logSendEvent(item.business_id, { queueId: item.id, accountId: item.account_id ?? null, contactId: item.contact_id, eventType: 'failed', reason: e.message }).catch(() => {})
      ctx.retry = true
      return 0
    }
  }
  return 0
}

// 'skipped'  -> this message is not going now / ever; look at the next one
// 'hold'     -> the whole business must wait; stop
// 'attempted'-> a send was tried and failed; stop (the antiban gap is now closed)
// 'sent'     -> sent; stop
async function processItem(item, { business, lane, ctx, lookupWaitCampaigns }) {
  const businessId = item.business_id
  const accountId = lane.accountId
  if (item.campaign_id && lookupWaitCampaigns.has(item.campaign_id)) return 'skipped'

  const contact = await getContact(supabase, item.contact_id)
  if (!contact) {
    await recordFailedDispatch(supabase, item, 'contact_or_phone_not_found')
    await logSendEvent(businessId, { queueId: item.id, accountId: item.account_id ?? null, contactId: item.contact_id, eventType: 'contact_or_phone_not_found' })
    return 'skipped'
  }

  // Where does this message go? A phone number when we have one, otherwise the contact's WhatsApp ID (@lid). See lib/sendTarget.js.
  const target = resolveSendTarget(contact, contact.country_code)
  if (!target) {
    await recordFailedDispatch(supabase, item, 'no_send_target')
    await logSendEvent(businessId, { queueId: item.id, accountId: item.account_id ?? null, contactId: item.contact_id, eventType: 'no_send_target' })
    return 'skipped'
  }

  // Campaign items: if the campaign got paused in the meantime (or, for a campaign without an account, its assigned
  // instance doesn't match what this queue row was stamped with), leave the item for a later pass: nothing here ever
  // fails the campaign itself. Account rows always send from the account's instance, whatever name was stored.
  let campaign = null
  if (item.campaign_id) {
    campaign = ctx.campaigns.get(item.campaign_id)
    if (campaign === undefined) {
      const { data } = await supabase.from('campaigns').select('whatsapp_instance_name, status, account_id').eq('id', item.campaign_id).maybeSingle()
      campaign = data ?? null
      ctx.campaigns.set(item.campaign_id, campaign)
    }
    if (!campaign || campaign.status !== 'active') return 'skipped'
    if (!accountId && (!item.assigned_instance_name || campaign.whatsapp_instance_name !== item.assigned_instance_name)) return 'skipped'
  }

  // whatsapp_sessions is the single source of truth for connection state (kept live by Evolution's connection.update webhook).
  const activeSession = accountId
    ? { instance_name: lane.instance }
    : item.campaign_id
      ? lane.sessions.find(s => s.instance_name === item.assigned_instance_name)
      : lane.sessions[0]
  if (!activeSession?.instance_name) return 'skipped'   // connection-update events wake the sender when the number reconnects

  // Re-check at the moment of sending what may have changed since the message was queued.
  const check = await sendTimeCheck(item, contact, business)
  if (check?.action === 'skip') {
    await skipItemForGood(item, check.reason)
    await logSendEvent(businessId, { queueId: item.id, accountId: item.account_id ?? null, contactId: item.contact_id, instanceName: activeSession.instance_name, eventType: 'skipped', reason: check.reason })
    return 'skipped'
  }
  if (check?.action === 'hold') {
    await releaseItem(item, check.delayMs, check.reason)
    return 'skipped'
  }

  // Manual-campaign numbers are checked on WhatsApp just before their turn, at random times (see lib/numberCheck.js).
  // Auto campaigns and AI follow-ups are never looked up, because those people already messaged us.
  // A @lid target is never looked up and never gated on wa_exists: that person already messaged us.
  const isLidTarget = target.kind === 'lid'
  const numberCheck = isLidTarget
    ? { status: 'ok' }
    : (await needsNumberLookup(supabase, item))
      ? await ensureNumberOnWhatsApp(supabase, { instanceName: activeSession.instance_name, contact, businessId })
      : (contact.wa_exists === false ? { status: 'not_on_whatsapp' } : { status: 'ok' })
  if (numberCheck.status === 'wait') {
    ctx.wake(Date.now() + (numberCheck.retryAfterMs ?? 60_000) + WAKE_PAD_MS)
    if (item.campaign_id) lookupWaitCampaigns.add(item.campaign_id)   // the rest of this campaign would wait too: skip them without queries
    return 'skipped'
  }
  if (numberCheck.status === 'not_on_whatsapp') {
    await skipItemForGood(item, 'number_not_on_whatsapp', 'not_on_whatsapp')
    await logSendEvent(businessId, { queueId: item.id, accountId: item.account_id ?? null, contactId: item.contact_id, instanceName: activeSession.instance_name, eventType: 'skipped', reason: 'number_not_on_whatsapp' })
    return 'skipped'
  }

  // Funds: checked per message, right before it goes. (It used to be checked only when a message was queued, while the wallet
  // was still full, so a big campaign sent its whole remainder for free once the wallet ran out.)
  // The account's own wallet on separate billing, otherwise the business's.
  if (!(await checkSendBalance(supabase, businessId, item.account_id ?? accountId))) {
    logHold(businessId, 'no_balance', `Not sending for ${business.name ?? businessId}: balance too low for another message`)
    if (item.campaign_id) {
      await supabase.from('campaigns').update({ status: 'paused', failure_reason: 'insufficient_balance', failed_at: null })
        .eq('id', item.campaign_id).eq('status', 'active')
      ctx.campaigns.delete(item.campaign_id)
    }
    ctx.wake(Date.now() + NO_BALANCE_RETRY_MS)
    return 'hold'
  }

  const { data: claimedItem, error: claimError } = await claimItem(item)
  if (claimError) {
    log('error', 'sender', 'sender.claim_failed', `Could not mark ${item.id} as sending: ${claimError.message}`, {
      business_id: businessId, contact_id: item.contact_id, entity_id: item.id, details: { error: claimError.message }
    })
    return 'skipped'
  }
  if (!claimedItem) return 'skipped'

  reserveSend(lane.key)   // website events share this number's gap (see eventSender.js)
  const sendStartedAt = Date.now()
  const result = await sendContentViaEvolution(activeSession.instance_name, target.number, {
    text: item.final_message,
    media: item.media
  }, contact.country_code)
  const sendDurationMs = Date.now() - sendStartedAt

  if (!result.ok) {
    const decision = await recordFailedDispatch(supabase, item, result.error ?? 'send_failed')
    // A failed attempt still touches WhatsApp: the same gap applies to the next one, and a run of connection-type
    // failures puts the whole business on a growing cool-down instead of working through every lead.
    const cool = recordFailedAttempt(lane.key, decision.failureClass)
    if (['instance_down', 'timeout', 'server_error'].includes(decision.failureClass)) {
      await confirmInstanceAfterFailure(supabase, { instanceName: activeSession.instance_name, businessId })
    }
    await logSendEvent(businessId, {
      queueId: item.id, accountId: item.account_id ?? null, contactId: item.contact_id, instanceName: activeSession.instance_name,
      eventType: 'failed', reason: result.error ?? 'send_failed'
    })
    log('warn', 'sender', 'sender.send_failed', `Send failed to ${target.label}: ${result.error ?? 'send_failed'}`, {
      business_id: businessId, contact_id: item.contact_id, entity_id: item.id,
      duration_ms: sendDurationMs,
      details: { instance: activeSession.instance_name, campaignId: item.campaign_id ?? null, targetKind: target.kind, error: result.error ?? 'send_failed', failureClass: decision.failureClass, coolDownMs: cool }
    })
    return 'attempted'
  }

  recordSend(lane.key)
  noteSent(businessId, accountId)
  try {
    await recordSuccessfulSend(supabase, {
      item, contact, business,
      finalMessage: item.final_message,
      whatsappMessageId: result.messageId
    })
  } catch (e) {
    // The message IS out. Never put it back in the queue (that would send it twice): close it as sent and report the bookkeeping failure.
    log('error', 'sender', 'sender.bookkeeping_failed', `Sent to ${target.label} but saving the result failed: ${e.message}`, {
      business_id: businessId, contact_id: item.contact_id, entity_id: item.id, details: { error: e.message, whatsappMessageId: result.messageId }
    })
    await supabase.from('follow_up_queue').update({ status: 'sent', processed_at: new Date().toISOString(), last_dispatch_error: 'bookkeeping_failed_after_send' }).eq('id', item.id).catch(() => {})
  }
  log('ok', 'sender', 'sender.sent', `Sent to ${target.label}`, {
    business_id: businessId, contact_id: item.contact_id, entity_id: item.id,
    duration_ms: sendDurationMs,
    details: { instance: activeSession.instance_name, campaignId: item.campaign_id ?? null, targetKind: target.kind, whatsappMessageId: result.messageId }
  })
  return 'sent'
}

const shuffle = (list) => {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

// Returns { dispatched, retryNeeded, wakeAt }.
//   wakeAt      = earliest moment (ms) something is expected to become possible (gap over, lookup slot, cap reset, quiet hours end)
//   retryNeeded = something failed in a way with no known time: try again in a minute
// The lanes that may send now. An account lane needs the account connected, its instance_name served by a connected
// session (a session demoted after failed sends stops the lane too) and account_can_operate. Sessions without an
// account make one lane per business, as before accounts.
export async function buildLanes(db, sessionRows) {
  const accountIds = [...new Set((sessionRows ?? []).map(r => r.account_id).filter(Boolean))]
  const accounts = accountIds.length ? await loadAccounts(db, accountIds) : new Map()
  const connectedInstances = new Set((sessionRows ?? []).map(r => r.instance_name).filter(Boolean))
  const lanes = []
  const held = []
  const legacy = new Map()
  for (const id of accountIds) {
    const account = accounts.get(id)
    if (!account) continue
    if (account.status !== 'connected' || !account.instance_name || !connectedInstances.has(account.instance_name)) continue
    if (!(await accountCanOperate(db, id))) { held.push(account); continue }
    lanes.push({ key: laneKey(account.business_id, id), businessId: account.business_id, accountId: id, instance: account.instance_name, sessions: [] })
  }
  const businessesWithAccountLanes = new Set(lanes.map(l => l.businessId))
  for (const row of sessionRows ?? []) {
    if (!row.business_id || !row.instance_name || row.account_id) continue
    if (businessesWithAccountLanes.has(row.business_id)) continue
    const lane = legacy.get(row.business_id) ?? { key: row.business_id, businessId: row.business_id, accountId: null, instance: null, sessions: [] }
    lane.sessions.push(row)
    legacy.set(row.business_id, lane)
  }
  return { lanes: [...lanes, ...legacy.values()], held }
}

export async function processBaileysBatch() {
  await healDemotedSessions(supabase).catch(() => {})

  const { data: sessionRows, error } = await supabase
    .from('whatsapp_sessions')
    .select('business_id, account_id, instance_name, updated_at')
    .eq('status', 'connected')
    .order('updated_at', { ascending: false })
  if (error) {
    log('error', 'sender', 'sender.fetch_batch_failed', `Failed to read connected sessions: ${error.message}`, { details: { error: error.message } })
    return { dispatched: 0, retryNeeded: true, wakeAt: null }
  }

  let built
  try {
    built = await buildLanes(supabase, sessionRows)
  } catch (e) {
    log('error', 'sender', 'sender.fetch_batch_failed', `Failed to read accounts: ${e.message}`, { details: { error: e.message } })
    return { dispatched: 0, retryNeeded: true, wakeAt: null }
  }
  for (const account of built.held) {
    logHold(account.business_id, 'account_suspended', `Not sending for account ${account.id}: the account may not operate (access fee unpaid)`, { accountId: account.id })
  }
  const lanes = built.lanes
  if (!lanes.length) return { dispatched: 0, retryNeeded: false, wakeAt: null }

  let wakeAt = null
  const ctx = {
    campaigns: new Map(),   // per pass: campaign rows are read once, not once per message
    retry: false,
    wake(at) { if (Number.isFinite(at) && (wakeAt === null || at < wakeAt)) wakeAt = at },
  }

  let dispatched = 0
  for (const lane of shuffle(lanes)) {
    try {
      dispatched += await processLane(lane, ctx)
    } catch (e) {
      log('error', 'sender', 'sender.business_pass_failed', `Sender pass failed for ${lane.businessId}${lane.accountId ? ` (account ${lane.accountId})` : ''}: ${e.message}`, { business_id: lane.businessId, details: { accountId: lane.accountId, error: { name: e.name, message: e.message } } })
      ctx.retry = true
    }
  }

  if (dispatched) log('info', 'sender', 'sender.batch_done', `Dispatched ${dispatched} across ${lanes.length} connected number(s)`, { details: { dispatched, lanes: lanes.length } })
  return { dispatched, retryNeeded: ctx.retry, wakeAt }
}

export function _resetSenderForTests() {
  claimedAtSupported = true
  lastHoldLog.clear()
}
