import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from './config.js'
import { createDbGuard } from './lib/dbGuard.js'
import { log } from './lib/log.js'

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[Supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — check your .env')
}

// Every REST call goes through the guard: per-minute usage summary (db.stats), de-duplicated error
// logging that reaches the debug console, a request-rate cap (SUPABASE_MAX_RPS) and a circuit breaker.
const dbGuard = createDbGuard({
  label: 'engine',
  onLog: (level, event, message, details) => log(level, 'db', event, message, { details })
})

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: { fetch: dbGuard.fetch }
})
