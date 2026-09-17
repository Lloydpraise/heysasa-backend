import { DEFAULT_PHONE_COUNTRY_CODE, EVOLUTION_URL, EVOLUTION_KEY, PLATFORM_EVOLUTION_INSTANCE } from '../config.js'

export function normalizePhone(phone, countryCode = DEFAULT_PHONE_COUNTRY_CODE) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  const code = String(countryCode ?? DEFAULT_PHONE_COUNTRY_CODE).replace(/\D/g, '') || DEFAULT_PHONE_COUNTRY_CODE
  if (!digits) return ''
  if (digits.startsWith('00')) return digits.slice(2)
  if (digits.startsWith(code)) return digits
  if (digits.startsWith('0')) return `${code}${digits.slice(1)}`
  if (digits.length === 9 || (code !== DEFAULT_PHONE_COUNTRY_CODE && digits.length <= 10)) return `${code}${digits}`
  return digits
}

const connectionStateCache = new Map()
const CONNECTION_STATE_CACHE_MS = 10_000

// Returns the instance's real connection state, distinguishing a
// confirmed answer from Evolution API ({ open: true/false, error: null })
// from a check that couldn't complete at all ({ open: null, error }) —
// a timeout, a DNS failure, Evolution being briefly unreachable. These
// are not the same thing: a confirmed "not open" means the WhatsApp
// session is genuinely disconnected; a failed check means we simply
// don't know yet. Conflating them (as this used to do, returning a
// bare `false` for both) caused a healthy, connected campaign to be
// killed off a single network blip. Error results are deliberately
// NOT cached — caching a transient failure would keep reporting "closed"
// for the full cache window even after the network recovers.
export async function checkEvolutionInstanceState(instanceName) {
  const cached = connectionStateCache.get(instanceName)
  if (cached && cached.expiresAt > Date.now()) return { open: cached.open, error: null }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    const res = await fetch(`${EVOLUTION_URL}/instance/connectionState/${encodeURIComponent(instanceName)}`, {
      headers: { apikey: EVOLUTION_KEY },
      signal: controller.signal
    })
    clearTimeout(timeout)
    const body = await res.json().catch(() => null)
    const state = body?.instance?.state ?? body?.state
    const open = res.ok && state === 'open'
    connectionStateCache.set(instanceName, { open, expiresAt: Date.now() + CONNECTION_STATE_CACHE_MS })
    return { open, error: null }
  } catch (err) {
    return { open: null, error: err }
  }
}

// Boolean convenience wrapper for callers (the send path) that just need
// a yes/no answer and should treat "couldn't check" the same as "not
// open" — you shouldn't send a message when you can't confirm the
// instance is connected. The scheduler's health check needs the richer
// tri-state above instead, since for *that* purpose an unconfirmed check
// must NOT be treated as a confirmed disconnect.
export async function isEvolutionInstanceOpen(instanceName) {
  const { open } = await checkEvolutionInstanceState(instanceName)
  return open === true
}

export async function sendViaEvolution(instanceName, phone, message, countryCode = DEFAULT_PHONE_COUNTRY_CODE) {
  return sendContentViaEvolution(instanceName, phone, { text: message }, countryCode)
}

export async function sendContentViaEvolution(instanceName, phone, content = {}, countryCode = DEFAULT_PHONE_COUNTRY_CODE) {
  try {
    const number = normalizePhone(phone, countryCode)
    if (!number) return { ok: false, error: 'invalid_phone' }
    if (!(await isEvolutionInstanceOpen(instanceName))) {
      console.warn(`[Evolution] Instance ${instanceName} is not open; send deferred`)
      return { ok: false, error: 'evolution_instance_not_open' }
    }
    const media = content.media ?? null
    const endpoint = media ? 'sendMedia' : 'sendText'
    const payload = media
      ? {
          number,
          mediatype: media.type,
          mimetype: media.mime_type || undefined,
          caption: media.caption ?? content.text ?? '',
          media: media.url,
          fileName: media.file_name || undefined
        }
      : { number, text: content.text ?? '' }

    console.log(`[Evolution] Sending ${media ? media.type : 'text'} via ${instanceName} to ${number}`)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    const res = await fetch(`${EVOLUTION_URL}/message/${endpoint}/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (res.ok) {
      const body = await res.json().catch(() => null)
      return {
        ok: true,
        messageId: body?.key?.id ?? body?.data?.key?.id ?? body?.message?.key?.id ?? body?.id ?? null
      }
    }
    const errText = await res.text().catch(() => '')
    console.error(`[Evolution] ${res.status}: ${errText}`)
    return { ok: false, error: `${res.status}: ${errText}` }
  } catch (e) {
    console.error(`[Evolution] ${e.message}`)
    return { ok: false, error: e.message }
  }
}

// Send from our official heysasa number to the business owner
// (uses the platform-level Evolution instance, not the business's own)
export async function sendPlatformMessage(ownerPhone, message) {
  if (!PLATFORM_EVOLUTION_INSTANCE) {
    console.warn('[Evolution] PLATFORM_EVOLUTION_INSTANCE not set — nudge not sent')
    return { ok: false, error: 'platform_instance_not_configured' }
  }
  return sendViaEvolution(PLATFORM_EVOLUTION_INSTANCE, ownerPhone, message)
}