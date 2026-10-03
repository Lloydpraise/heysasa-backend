// Decides WHERE a message to a contact goes.
//
// Why this exists: WhatsApp no longer always exposes a customer's phone number.
// For many chats (and for everyone who adopts a WhatsApp username) the only
// identifier we receive is a "LID" such as 268289544593496@lid. A LID is a real,
// routable WhatsApp address - Evolution accepts it in the `number` field of
// /message/sendText and /message/sendMedia - but it is NOT a phone number, so it
// must never be run through phone normalisation or phone validation.
//
// Priority:
//   1. a real phone number on the contact          -> send to the number
//   2. a @lid social_id (no usable phone)          -> send to the LID JID
//   3. a @s.whatsapp.net social_id (phone missing) -> send to its digits
//   4. nothing usable                              -> null (caller must not send)
import { normalizePhone } from '../sender-baileys/evolutionSender.js'

const PN_JID_RE = /^\d{8,15}@s\.whatsapp\.net$/

export function isLidJid(jid) {
  return typeof jid === 'string' && /^\d+@lid$/.test(jid.trim())
}

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '')

export function resolveSendTarget(contact, countryCode) {
  if (!contact) return null

  const socialId = typeof contact.social_id === 'string' ? contact.social_id.trim() : ''
  const lidDigits = isLidJid(socialId) ? digitsOf(socialId.split('@')[0]) : ''
  const phoneDigits = digitsOf(contact.phone)

  // A stored "phone" identical to the LID digits is the old intake bug (a LID
  // saved as a phone number), not a number anyone can be reached on.
  if (phoneDigits && phoneDigits !== lidDigits) {
    const number = normalizePhone(contact.phone, contact.country_code ?? countryCode)
    if (number.length >= 8 && number.length <= 15) {
      return { kind: 'phone', number, label: number }
    }
  }

  if (lidDigits) {
    const jid = `${lidDigits}@lid`
    return { kind: 'lid', number: jid, label: jid }
  }

  if (PN_JID_RE.test(socialId)) {
    const number = digitsOf(socialId.split('@')[0])
    return { kind: 'phone', number, label: number }
  }

  return null
}

// For logs and alerts: never prints "null".
export function contactLabel(contact) {
  return contact?.phone || contact?.social_id || (contact?.id != null ? `contact:${contact.id}` : 'unknown contact')
}

// For human-facing text (owner alerts etc.): real name, else phone, else generic.
export function contactDisplayName(contact) {
  const name = String(contact?.name ?? '').trim()
  if (name && !/^\+?[\d\s\-().]+$/.test(name)) return name
  const target = resolveSendTarget(contact)
  return target?.kind === 'phone' ? target.number : 'a customer'
}
