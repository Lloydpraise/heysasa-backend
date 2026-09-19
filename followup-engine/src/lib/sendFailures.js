// Only one send failure is treated as permanent: the number isn't on
// WhatsApp at all, so no amount of retrying will ever make it send.
// Everything else (timeouts, Evolution instance hiccups, rate limits,
// transient 5xx/network errors) is assumed recoverable and gets retried.
export function isPermanentSendFailure(errorMessage) {
  const msg = String(errorMessage ?? '').toLowerCase()
  if (msg.includes('exists') && msg.includes('false')) return true
  if (msg.includes('not on whatsapp')) return true
  if (msg.includes('not registered')) return true
  return false
}
