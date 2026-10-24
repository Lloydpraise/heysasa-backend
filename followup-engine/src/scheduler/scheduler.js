import { runWorker } from './worker.js'
import { isBusinessAwake } from '../lib/timing.js'
import { log } from '../lib/log.js'
import { loadAccounts, withAccountSettings } from '../lib/accounts.js'

const WORKER_CONCURRENCY = Math.max(1, parseInt(process.env.SCHEDULER_WORKER_CONCURRENCY ?? '8'))

export async function runScheduler(supabase) {
  const { data: items, error } = await supabase
    .from('follow_up_queue')
    .select('id, business_id, account_id')
    .eq('status', 'pending')
    .eq('approval_status', 'approved')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(50)

  if (error) throw new Error(error.message)
  if (!items?.length) return { processed: 0 }

  // "Sleep mode" — hold every item for a business that's currently in
  // quiet hours or on an inactive day, untouched (no reschedule, no
  // write at all). They stay 'pending' and are picked back up together
  // the moment the business's active hours return, instead of each one
  // being individually rescheduled by the worker (which used to produce
  // a wall of per-item stall events every night).
  const businessIds = [...new Set(items.map(item => item.business_id))]
  const { data: businesses, error: businessError } = await supabase
    .from('businesses')
    .select('business_id, timezone, followup_quiet_start, followup_quiet_end, followup_active_days')
    .in('business_id', businessIds)
  if (businessError) throw new Error(businessError.message)

  // Quiet hours and active days can be overridden per account (accounts.settings).
  const businessById = new Map((businesses ?? []).map(b => [b.business_id, b]))
  const accounts = await loadAccounts(supabase, items.map(item => item.account_id))
  const awake = new Map()
  const isAwake = (item) => {
    const key = `${item.business_id}|${item.account_id ?? ''}`
    if (!awake.has(key)) {
      const business = businessById.get(item.business_id)
      awake.set(key, !!business && isBusinessAwake(item.account_id ? withAccountSettings(business, accounts.get(item.account_id)) : business))
    }
    return awake.get(key)
  }
  const awakeItems = items.filter(isAwake)
  const asleepCount = items.length - awakeItems.length
  if (asleepCount) log('debug', 'engine', 'scheduler.holding', `Holding ${asleepCount} item(s) — business asleep (quiet hours/inactive day)`, { details: { asleepCount } })
  if (!awakeItems.length) return { processed: 0 }

  // CHANGED from the original: same process, no fetch-to-self hop.
  // The old Deno version had to HTTP-call its own worker route because
  // edge functions are stateless/cold-start-per-invocation. A
  // persistent Node process doesn't have that constraint.
  // Run them through a small pool instead of all at once: 50 workers at the same moment each fire several queries
  // (plus AI calls for rewritten campaigns), which spikes the database and the shared 40 requests/second budget.
  const results = new Array(awakeItems.length)
  let cursor = 0
  const lanes = Array.from({ length: Math.min(WORKER_CONCURRENCY, awakeItems.length) }, async () => {
    while (cursor < awakeItems.length) {
      const idx = cursor++
      try { results[idx] = { status: 'fulfilled', value: await runWorker(supabase, awakeItems[idx].id) } }
      catch (reason) { results[idx] = { status: 'rejected', reason } }
    }
  })
  await Promise.all(lanes)

  const failures = results.filter(r => r.status === 'rejected')
  if (failures.length) {
    log('error', 'engine', 'scheduler.worker_failures', `${failures.length}/${awakeItems.length} worker runs threw`, { details: { failed: failures.length, total: awakeItems.length } })
  }

  if (awakeItems.length) log('info', 'engine', 'scheduler.cycle_completed', `Cycle completed: processed ${awakeItems.length}, failures ${failures.length}`, { details: { processed: awakeItems.length, failures: failures.length } })
  return { processed: awakeItems.length }
}