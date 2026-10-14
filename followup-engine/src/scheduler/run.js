import { supabase } from '../supabaseClient.js'
import { runScheduler } from './scheduler.js'
import { runCampaignScheduler } from './campaignScheduler.js'
import { runPostSendReconciliation } from './reconciliation.js'
import { runStageClassifier, STAGE_REVIEW_DEBOUNCE_MS } from './stageClassifier.js'
import { runStageRequests } from './stageRequests.js'
import { runActivityPatterns } from './activityPatterns.js'
import { runLeadTemperatureReview } from './leadTemperatureReview.js'
import { runAutoListSync } from './autoListSync.js'
import { log } from '../lib/log.js'
import { runAdIntake } from '../followupAi/adIntake.js'
import { createSwitchWatch } from '../followupAi/switchWatch.js'
import { ensureDefaultSkills } from '../followupAi/skills.js'
import { isAnalysisActive, onAnalysisFinished, deferUntilAnalysisEnds } from '../lib/analysisGate.js'

const RETRY_MS = 60_000
const AD_INTAKE_FALLBACK_MS = 5 * 60_000
// Realtime events can arrive many times a second (the analyser rewrites contacts in bulk, every send updates
// follow_up_queue). Event-driven runs of a job are therefore limited to one per gap, with one trailing run so
// the last change is never missed. Timers and startup runs are not throttled.
const EVENT_GAP_MS = parseInt(process.env.ENGINE_EVENT_GAP_MS ?? '5000')
const CONTACT_EVENT_GAP_MS = parseInt(process.env.ENGINE_CONTACT_EVENT_GAP_MS ?? '15000')
const CONTACT_QUIET_MS = 10_000
const QUIET_MS = 150
// Customer profile + auto-list syncs are heavy Postgres functions (sync_auto_lists averages ~3s).
// Debounce them hard so a burst of inbound messages triggers one run, not hundreds.
const HEAVY_QUIET_MS = 30_000
const LEAD_COLD_MS = 5 * 24 * 60 * 60_000
const STAGE_RETRY_MS = 3 * 60 * 60_000
const timers = new Map()
const runs = new Map()
const pending = new Map()
let dueTimer
let dueAt = 0

async function runCustomerProfileSync(sb) {
  const { data, error } = await sb.rpc('sync_customer_profiles')
  if (error) throw new Error(`sync_customer_profiles failed: ${error.message}`)
  return { profilesChanged: data?.profiles_changed ?? 0 }
}

// A timer callback must never be able to take the whole engine down: an uncaught throw inside
// setTimeout kills the process, and the parent respawns it every 5s (a crash loop that hammers the DB).
function safely(key, callback) {
  try {
    const result = callback()
    if (result && typeof result.catch === 'function') {
      result.catch((e) => log('error', 'engine', 'engine.timer_failed', `${key} timer failed: ${e?.message ?? e}`))
    }
  } catch (e) {
    log('error', 'engine', 'engine.timer_failed', `${key} timer failed: ${e?.message ?? e}`)
  }
}

function scheduleAt(key, at, callback, replace = false) {
  if (!Number.isFinite(at)) return
  const old = timers.get(key)
  if (!replace && old?.at <= at) return
  if (old) clearTimeout(old.timer)
  const timer = setTimeout(() => {
    timers.delete(key)
    safely(key, callback)
  }, Math.max(0, at - Date.now()))
  timers.set(key, { at, timer })
}

function afterQuiet(key, callback, delay = QUIET_MS) {
  const old = timers.get(key)
  if (old) clearTimeout(old.timer)
  const timer = setTimeout(() => {
    timers.delete(key)
    safely(key, callback)
  }, delay)
  timers.set(key, { at: Date.now() + delay, timer })
}

const lastEventRun = new Map()
const trailingEvent = new Map()

function mergeEventArgs(a, b) {
  return a.length && b.length ? [{ ...a[0], ...b[0], seed: a[0]?.seed === true || b[0]?.seed === true }] : (b.length ? b : a)
}

// Leading + trailing throttle in front of invoke(): the first event runs now, further events inside the gap
// collapse into ONE run when the gap ends (seed flags are OR-ed together, like invoke() does for pending runs).
function invokeThrottled(name, fn, args = [], gapMs = EVENT_GAP_MS) {
  const wait = (lastEventRun.get(name) ?? 0) + gapMs - Date.now()
  if (wait <= 0 && !trailingEvent.has(name)) {
    lastEventRun.set(name, Date.now())
    return invoke(name, fn, args)
  }
  const waiting = trailingEvent.get(name)
  if (waiting) {
    waiting.args = mergeEventArgs(waiting.args, args)
    return
  }
  const entry = { args, timer: null }
  entry.timer = setTimeout(() => {
    trailingEvent.delete(name)
    lastEventRun.set(name, Date.now())
    safely(`throttled:${name}`, () => invoke(name, fn, entry.args))
  }, Math.max(0, wait))
  trailingEvent.set(name, entry)
}

function invoke(name, fn, args = []) {
  if (runs.has(name)) {
    const old = pending.get(name)
    const mergedArgs = args.length && old?.args.length
      ? [{ ...old.args[0], ...args[0], seed: old.args[0]?.seed === true || args[0]?.seed === true }]
      : args
    pending.set(name, { fn, args: mergedArgs })
    return runs.get(name)
  }
  const run = (async () => {
    try {
      const result = await fn(supabase, ...args)
      const counts = result && typeof result === 'object' ? result : {}
      const total = Object.values(counts).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
      if (total > 0) log('info', 'engine', 'engine.event_job', `${name}: ${JSON.stringify(counts)}`, { details: { job: name, ...counts } })
      if (name === 'Scheduler' || name === 'CampaignScheduler') await armDueWork()
      return result
    } catch (e) {
      log('error', 'engine', 'engine.event_job_failed', `${name} failed: ${e.message}`, { details: { job: name, error: { name: e.name, message: e.message } } })
      scheduleAt(`retry:${name}`, Date.now() + RETRY_MS, () => invoke(name, fn, args))
      if (name === 'Scheduler' || name === 'CampaignScheduler') await armDueWork().catch(() => {})
      return null
    } finally {
      runs.delete(name)
      if (name.startsWith('LeadTemperatureReview')) {
        void armTemperatureDue().catch((e) => log('error', 'engine', 'lead_temperature.schedule_failed', e.message))
      }
      if (name.startsWith('StageClassifier')) {
        void armStageRetry().catch((e) => log('error', 'engine', 'stage_classifier.schedule_failed', e.message))
      }
      const next = pending.get(name)
      pending.delete(name)
      if (next) void invoke(name, next.fn, next.args)
    }
  })()
  runs.set(name, run)
  return run
}

async function armDueWork() {
  const now = new Date().toISOString()
  const [queue, enrollments, dueQueue, dueEnrollments] = await Promise.all([
    supabase.from('follow_up_queue').select('scheduled_at').eq('status', 'pending').eq('approval_status', 'approved')
      .gt('scheduled_at', now).order('scheduled_at', { ascending: true }).limit(1),
    supabase.from('campaign_enrollments').select('next_send_at').in('status', ['pending', 'active'])
      .not('next_send_at', 'is', null).gt('next_send_at', now).order('next_send_at', { ascending: true }).limit(1),
    supabase.from('follow_up_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending')
      .eq('approval_status', 'approved').lte('scheduled_at', now),
    supabase.from('campaign_enrollments').select('id', { count: 'exact', head: true }).in('status', ['pending', 'active'])
      .or(`next_send_at.is.null,next_send_at.lte.${now}`),
  ])
  const error = [queue.error, enrollments.error, dueQueue.error, dueEnrollments.error].find(Boolean)
  if (error) throw error
  const times = [queue.data?.[0]?.scheduled_at, enrollments.data?.[0]?.next_send_at]
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
  if (times.length) {
    const earliest = Math.min(...times)
    if (!dueTimer || dueAt !== earliest) {
      clearTimeout(dueTimer)
      dueAt = earliest
      dueTimer = setTimeout(() => {
        dueTimer = null
        dueAt = 0
        void invoke('Scheduler', runScheduler)
        void invoke('CampaignScheduler', runCampaignScheduler, [{ seed: false }])
      }, Math.max(0, earliest - Date.now()))
    }
  } else if (dueTimer) {
    clearTimeout(dueTimer)
    dueTimer = null
    dueAt = 0
  }
  if ((dueQueue.count ?? 0) > 0 || (dueEnrollments.count ?? 0) > 0) {
    scheduleAt('due-retry', Date.now() + RETRY_MS, () => {
      void invoke('Scheduler', runScheduler)
      void invoke('CampaignScheduler', runCampaignScheduler, [{ seed: false }])
    })
  } else {
    const retry = timers.get('due-retry')
    if (retry) clearTimeout(retry.timer)
    timers.delete('due-retry')
  }
}

async function armTemperatureDue() {
  const now = Date.now()
  const cutoff = new Date(now - LEAD_COLD_MS).toISOString()
  const excludedStates = '(won,lost,do_not_contact)'
  const [old, upcoming] = await Promise.all([
    supabase.from('contacts').select('id', { count: 'exact', head: true })
      .eq('lead_type', 'business').lte('last_seen', cutoff).or('lead_quality.is.null,lead_quality.neq.cold')
      .not('lead_state', 'in', excludedStates),
    supabase.from('contacts').select('id, last_seen')
      .eq('lead_type', 'business').gt('last_seen', cutoff).or('lead_quality.is.null,lead_quality.neq.cold')
      .not('lead_state', 'in', excludedStates).order('last_seen', { ascending: true }).limit(1),
  ])
  if (old.error || upcoming.error) throw old.error || upcoming.error
  if ((old.count ?? 0) > 0) {
    scheduleAt('lead-temperature-backlog', now + RETRY_MS, () => {
      void invoke('LeadTemperatureReview', runLeadTemperatureReview)
    })
  } else {
    const backlog = timers.get('lead-temperature-backlog')
    if (backlog) clearTimeout(backlog.timer)
    timers.delete('lead-temperature-backlog')
  }
  const next = upcoming.data?.[0]
  if (next?.last_seen) {
    scheduleAt('lead-temperature-due', Date.parse(next.last_seen) + LEAD_COLD_MS, () => {
      void invoke('LeadTemperatureReview', runLeadTemperatureReview)
    })
  } else {
    const due = timers.get('lead-temperature-due')
    if (due) clearTimeout(due.timer)
    timers.delete('lead-temperature-due')
  }
}

async function armStageRetry() {
  const { count, error } = await supabase.from('conversations').select('id', { count: 'exact', head: true })
    .not('stage_review_requested_at', 'is', null)
  if (error) throw error
  if ((count ?? 0) > 0) {
    scheduleAt('stage-classifier-retry', Date.now() + STAGE_RETRY_MS, () => {
      void invoke('StageClassifier', runStageClassifier)
    })
  } else {
    const retry = timers.get('stage-classifier-retry')
    if (retry) clearTimeout(retry.timer)
    timers.delete('stage-classifier-retry')
  }
}

function onStageRequest(payload) {
  const row = payload.new
  if (!row?.id) return
  const key = `stage:${row.id}`
  if (!row.stage_review_requested_at) {
    const debounce = timers.get(key)
    if (debounce) clearTimeout(debounce.timer)
    timers.delete(key)
    const retry = timers.get('stage-classifier-retry')
    if (retry) clearTimeout(retry.timer)
    timers.delete('stage-classifier-retry')
    return
  }
  const requestedAt = Date.parse(row.stage_review_requested_at)
  if (!Number.isFinite(requestedAt)) return
  scheduleAt(key, requestedAt + STAGE_REVIEW_DEBOUNCE_MS, () => {
    void invoke('StageClassifier', runStageClassifier)
  }, true)
}

// Everything a burst of contact changes would have triggered, run once.
function runContactCatchUp() {
  void invoke('Scheduler', runScheduler)
  void invoke('CampaignScheduler', runCampaignScheduler, [{ seed: true }])
  void invoke('LeadTemperatureReview', runLeadTemperatureReview)
  void invoke('CustomerProfiles', runCustomerProfileSync)
  void invoke('AutoListSync', runAutoListSync)
  void armDueWork().catch((e) => log('error', 'engine', 'engine.due_schedule_failed', e.message))
}
onAnalysisFinished(runContactCatchUp)

async function onContactChange(payload) {
  if (await isAnalysisActive()) {
    deferUntilAnalysisEnds()
    return
  }
  if (payload.new?.id) {
    afterQuiet('LeadTemperatureReview', () => void invoke('LeadTemperatureReview', runLeadTemperatureReview), CONTACT_QUIET_MS)
    invokeThrottled('CampaignScheduler', runCampaignScheduler, [{ seed: false }], CONTACT_EVENT_GAP_MS)
  }
  afterQuiet('CustomerProfiles', () => void invoke('CustomerProfiles', runCustomerProfileSync), HEAVY_QUIET_MS)
  afterQuiet('AutoListSync', () => void invoke('AutoListSync', runAutoListSync), HEAVY_QUIET_MS)
}

function subscribe() {
  const channel = supabase.channel('follow-up-scheduler-events')
  const watch = (table, callback, event = '*') => {
    channel.on('postgres_changes', { event, schema: 'public', table }, callback)
  }

  watch('follow_up_queue', (payload) => {
    invokeThrottled('Scheduler', runScheduler)
    if (payload.eventType === 'UPDATE' && payload.new?.status === 'sent' && payload.new?.next_step_processed === false) {
      void invoke('Reconciliation', runPostSendReconciliation)
    }
  })
  watch('campaign_enrollments', () => invokeThrottled('CampaignScheduler', runCampaignScheduler, [{ seed: false }]))
  // Campaign edits come from a person clicking in the dashboard: first one runs immediately, bursts collapse.
  watch('campaigns', () => invokeThrottled('CampaignScheduler', runCampaignScheduler, [{ seed: true }], 1000))
  watch('campaign_steps', () => invokeThrottled('CampaignScheduler', runCampaignScheduler, [{ seed: true }], 1000))
  watch('list_members', () => {
    invokeThrottled('CampaignScheduler', runCampaignScheduler, [{ seed: true }])
    afterQuiet('AutoListSync', () => void invoke('AutoListSync', runAutoListSync), HEAVY_QUIET_MS)
  })
  // a new ad row, or an owner edit in the ad editor, starts the Follow-up AI's ad intake after a short quiet period
  watch('ad_attributions', () => afterQuiet('AdIntake', () => void invoke('AdIntake', runAdIntake), 5_000))
  watch('ad_playbooks', (payload) => {
    const row = payload.new
    if (row && (row.status === 'pending' || row.regenerate_requested_at)) afterQuiet('AdIntake', () => void invoke('AdIntake', runAdIntake), 2_000)
  })
  // The owner switching the Follow-up AI on starts the ad intake right away, so plans for the ads already found get written now.
  const followupAiSwitch = createSwitchWatch()
  watch('businesses', (payload) => {
    invokeThrottled('CampaignScheduler', runCampaignScheduler, [{ seed: false }])
    if (followupAiSwitch.switchedOn(payload.new)) afterQuiet('AdIntake', () => void invoke('AdIntake', runAdIntake), 2_000)
  })
  // An AI asked to move a lead's stage (chat AI tool). Checked, billed and audited by runStageRequests.
  watch('lead_stage_requests', (payload) => {
    if (payload.eventType === 'INSERT') afterQuiet('StageRequests', () => void invoke('StageRequests', runStageRequests), 3_000)
  })
  // Safety net in case a realtime event is missed: nothing stays pending for long.
  const stageRequestsTimer = setInterval(() => void invoke('StageRequests', runStageRequests), 5 * 60_000)
  stageRequestsTimer.unref?.()
  watch('whatsapp_sessions', () => invokeThrottled('CampaignScheduler', runCampaignScheduler, [{ seed: false }]))
  watch('contacts', (payload) => { void onContactChange(payload) })
  watch('conversations', (payload) => {
    onStageRequest(payload)
    afterQuiet('AutoListSync', () => void invoke('AutoListSync', runAutoListSync), HEAVY_QUIET_MS)
    afterQuiet('CustomerProfiles', () => void invoke('CustomerProfiles', runCustomerProfileSync), HEAVY_QUIET_MS)
  })
  watch('messages', (payload) => {
    if (payload.eventType !== 'INSERT' || payload.new?.direction !== 'in') return
    const row = payload.new
    afterQuiet(`ActivityPatterns:${row.contact_id}`, () => {
      void invoke(`ActivityPatterns:${row.contact_id}`, runActivityPatterns, [row.contact_id])
    })
    afterQuiet('LeadTemperatureReview', () => void invoke('LeadTemperatureReview', runLeadTemperatureReview))
    afterQuiet('CustomerProfiles', () => void invoke('CustomerProfiles', runCustomerProfileSync), HEAVY_QUIET_MS)
    afterQuiet('AutoListSync', () => void invoke('AutoListSync', runAutoListSync), HEAVY_QUIET_MS)
  })
  channel.subscribe((status, error) => {
    if (status === 'SUBSCRIBED') {
      log('info', 'engine', 'engine.realtime_connected', 'Scheduler listening for database changes')
      void invoke('Scheduler', runScheduler)
      void invoke('CampaignScheduler', runCampaignScheduler, [{ seed: true }])
      void invoke('Reconciliation', runPostSendReconciliation)
      void invoke('StageClassifier', runStageClassifier)
      void invoke('StageRequests', runStageRequests)
      void invoke('LeadTemperatureReview', runLeadTemperatureReview)
      void invoke('ActivityPatterns', runActivityPatterns)
      void invoke('CustomerProfiles', runCustomerProfileSync)
      void invoke('AutoListSync', runAutoListSync)
      void ensureDefaultSkills(supabase).catch((e) => log('warn', 'followup_ai', 'followup_ai.skills_sync_failed', e.message))
      void invoke('AdIntake', runAdIntake)
      void armDueWork().catch((e) => log('error', 'engine', 'engine.due_schedule_failed', e.message))
      void armTemperatureDue().catch((e) => log('error', 'engine', 'lead_temperature.schedule_failed', e.message))
      void armStageRetry().catch((e) => log('error', 'engine', 'stage_classifier.schedule_failed', e.message))
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      log('error', 'engine', 'engine.realtime_disconnected', `Scheduler notifications unavailable: ${status}`, { details: { error: error?.message ?? null } })
    }
  })
}

log('info', 'engine', 'engine.started', 'Scheduler waiting for database events and due work')
subscribe()
setInterval(() => void invoke('AdIntake', runAdIntake), AD_INTAKE_FALLBACK_MS).unref?.()
