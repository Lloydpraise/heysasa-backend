import { DEFAULT_PHONE_COUNTRY_CODE, EVOLUTION_URL, EVOLUTION_KEY, PLATFORM_EVOLUTION_INSTANCE } from '../config.js'
import { log } from '../lib/log.js'

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

// NOTE: this used to also do a live HTTP ping to Evolution's
// /instance/connectionState/ endpoint before every send (and again in a
// couple of scheduler-side health checks), on top of checking the
// whatsapp_sessions table. That was two sources of truth for the same
// fact, and the live ping was the flaky one — a single slow/failed ping
// was enough to kill a healthy campaign outright. whatsapp_sessions is
// kept live by Evolution's own connection.update webhook, so it's
// trusted as the sole source of truth now: if a row says 'connected',
// we send. If the instance is actually down, the send call below will
// fail with a real error and get retried like any other send failure.
export async function sendViaEvolution(instanceName, phoneOrJid, message, countryCode = DEFAULT_PHONE_COUNTRY_CODE) {
  return sendContentViaEvolution(instanceName, phoneOrJid, { text: message }, countryCode)
}

// Only these two WhatsApp address types may be passed through as-is. Group
// (@g.us), broadcast and newsletter JIDs are deliberately rejected so a bad
// contact row can never turn a follow-up into a group message.
const SENDABLE_JID_RE = /^\d+@(lid|s\.whatsapp\.net)$/

// `target` is either a phone number (normalised as before) or a WhatsApp JID.
// A "@lid" JID is how we reach customers whose phone number WhatsApp hides:
// Evolution routes it directly, so no phone number is needed.
export function resolveEvolutionNumber(target, countryCode = DEFAULT_PHONE_COUNTRY_CODE) {
  const raw = (target !== null && typeof target === 'object') ? target.number : target
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (text.includes('@')) return SENDABLE_JID_RE.test(text) ? text : ''
  return normalizePhone(text, countryCode)
}

export async function sendContentViaEvolution(instanceName, target, content = {}, countryCode = DEFAULT_PHONE_COUNTRY_CODE) {
  try {
    const number = resolveEvolutionNumber(target, countryCode)
    if (!number) return { ok: false, error: 'invalid_phone' }
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

    log('debug', 'connection', 'evolution.sending', `Sending ${media ? media.type : 'text'} via ${instanceName} to ${number}`, { details: { type: media ? media.type : 'text', instance: instanceName } })
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
        to: number,
        messageId: body?.key?.id ?? body?.data?.key?.id ?? body?.message?.key?.id ?? body?.id ?? null
      }
    }
    const errText = await res.text().catch(() => '')
    log('debug', 'connection', 'evolution.http_error', `${res.status}: ${errText}`, { details: { status: res.status, instance: instanceName } })
    return { ok: false, error: `${res.status}: ${errText}` }
  } catch (e) {
    log('debug', 'connection', 'evolution.request_error', e.message, { details: { instance: instanceName, error: e.message } })
    return { ok: false, error: e.message }
  }
}

// Send from our official heysasa number to the business owner
// (uses the platform-level Evolution instance, not the business's own)
export async function sendPlatformMessage(ownerPhone, message) {
  if (!PLATFORM_EVOLUTION_INSTANCE) {
    log('warn', 'connection', 'evolution.platform_instance_not_configured', 'PLATFORM_EVOLUTION_INSTANCE not set — nudge not sent', {})
    return { ok: false, error: 'platform_instance_not_configured' }
  }
  return sendViaEvolution(PLATFORM_EVOLUTION_INSTANCE, ownerPhone, message)
}