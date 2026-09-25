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
export async function sendViaEvolution(instanceName, phone, message, countryCode = DEFAULT_PHONE_COUNTRY_CODE) {
  return sendContentViaEvolution(instanceName, phone, { text: message }, countryCode)
}

export async function sendContentViaEvolution(instanceName, phone, content = {}, countryCode = DEFAULT_PHONE_COUNTRY_CODE) {
  try {
    const number = normalizePhone(phone, countryCode)
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