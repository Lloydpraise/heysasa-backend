import { EVOLUTION_URL, EVOLUTION_KEY } from '../config.js'
import { normalizePhone } from '../sender-baileys/evolutionSender.js'
import { log } from './log.js'

// Asks WhatsApp whether a number has an account, BEFORE we try to message it.
// Sending to a number that is not on WhatsApp is what WhatsApp treats as spam-like
// behaviour, and it is the biggest single source of failed sends so far.
// The answer is remembered on the contact (wa_exists, wa_checked_at), so each number
// is only ever asked about once. Checks are also spaced out so we never fire a burst.
const CHECK_GAP_MS = 4_000
const RECHECK_TRUE_MS = 30 * 86_400_000     // a "yes" is trusted for 30 days
const RECHECK_FALSE_MS = 60 * 86_400_000    // a "no" is trusted for 60 days
const lastCheckAt = new Map()               // business_id -> ms

// true / false / null (null = could not tell, so caller carries on and the send itself decides)
async function askWhatsApp(instanceName, number) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(`${EVOLUTION_URL}/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
      body: JSON.stringify({ numbers: [number] }),
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    const row = Array.isArray(body) ? body[0] : null
    return typeof row?.exists === 'boolean' ? row.exists : null
  } catch {
    return null
  }
}

// Returns { status: 'ok' | 'not_on_whatsapp' | 'wait' }.
//   ok               -> go ahead and send (checked, or could not be checked)
//   not_on_whatsapp  -> do NOT send; the contact has been marked
//   wait             -> a check for this business ran a moment ago; try again next poll
export async function ensureNumberOnWhatsApp(supabase, { instanceName, contact, businessId }) {
  const age = contact.wa_checked_at ? Date.now() - new Date(contact.wa_checked_at).getTime() : Infinity
  if (contact.wa_exists === false && age < RECHECK_FALSE_MS) return { status: 'not_on_whatsapp' }
  if (contact.wa_exists === true && age < RECHECK_TRUE_MS) return { status: 'ok' }

  if (Date.now() - (lastCheckAt.get(businessId) ?? 0) < CHECK_GAP_MS) return { status: 'wait' }
  lastCheckAt.set(businessId, Date.now())

  const number = normalizePhone(contact.phone, contact.country_code)
  if (!number) return { status: 'not_on_whatsapp' }

  const exists = await askWhatsApp(instanceName, number)
  if (exists === null) return { status: 'ok' }

  await supabase.from('contacts').update({ wa_exists: exists, wa_checked_at: new Date().toISOString() }).eq('id', contact.id)
  if (!exists) {
    log('info', 'sender', 'sender.number_not_on_whatsapp', `${number} is not on WhatsApp, skipped before sending`, {
      business_id: businessId, contact_id: contact.id, details: { number }
    })
    return { status: 'not_on_whatsapp' }
  }
  return { status: 'ok' }
}
