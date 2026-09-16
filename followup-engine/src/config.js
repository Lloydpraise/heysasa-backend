import 'dotenv/config'

export const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

export const EVOLUTION_URL = process.env.EVOLUTION_URL ?? 'http://129.213.33.173:8080'
export const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY ?? ''
export const PLATFORM_EVOLUTION_INSTANCE = process.env.PLATFORM_EVOLUTION_INSTANCE ?? ''
export const EVOLUTION_WEBHOOK_URL = process.env.EVOLUTION_WEBHOOK_URL ?? ''

export const OPENAI_KEY = process.env.OPENAI_API_KEY ?? ''
export const OPENAI_MODEL = 'gpt-4.1-mini'
export const CORS_ORIGINS = (process.env.FOLLOWUP_CORS_ORIGINS ?? process.env.CORS_ORIGINS ?? 'https://heysasa.co.ke,https://www.heysasa.co.ke,http://localhost:5173')
	.split(',')
	.map(origin => origin.trim())
	.filter(Boolean)

export const WABA_TOKEN = process.env.WABA_TOKEN ?? '' // unused until 03

// Hardcoded fallbacks — overridden by followup_billing_config table
export const DEFAULT_MIN_CHARGE = 0.05
export const DEFAULT_MAX_CHARGE = 2.00
export const DEFAULT_MSG_COST = 0.002
export const DEFAULT_CONSENT_COST = 0.001
export const DEFAULT_DAILY_CAP = 40
export const DEFAULT_MAX_PER_LEAD = 12
export const DEFAULT_ZONE_RECENT = 7   // days: needs approval
export const DEFAULT_ZONE_MEDIUM = 14  // days: manual only
export const DEFAULT_QUIET_START = 21  // 9pm
export const DEFAULT_QUIET_END = 8     // 8am
export const DEFAULT_TIMEZONE = 'Africa/Nairobi'
export const DEFAULT_PHONE_COUNTRY_CODE = process.env.DEFAULT_PHONE_COUNTRY_CODE ?? '254'

// Poll intervals for the two persistent loops
export const SCHEDULER_POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS ?? '30000')
export const SENDER_POLL_INTERVAL_MS = parseInt(process.env.SENDER_POLL_INTERVAL_MS ?? '5000')

// ── Antiban defaults (system-set, not exposed to business config) ──
export const ANTIBAN_MIN_GAP_MS = 20_000       // floor gap between sends per business instance
export const ANTIBAN_JITTER_MS = 45_000        // extra random jitter added on top of the floor
export const ANTIBAN_HOURLY_CEILING = 15       // hard ceiling regardless of configured daily cap
export const ANTIBAN_WINDOW_MS = 60 * 60_000   // sliding window size for the hourly cap