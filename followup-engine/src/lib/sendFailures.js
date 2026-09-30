// Turns a raw send error into one plain label and a retry rule.
//
// Ground rule: every message that does not go through is a ban risk, so we retry
// less, not more. Numbers that are not on WhatsApp are never retried. Everything
// else gets at most 3 more tries, spaced out, and then is given up on and reported.
// (instance_down is the one exception: it is not the lead's fault, so it waits longer.)
const MIN = 60_000
const HOUR = 60 * MIN

const POLICY = {
  not_on_whatsapp: { permanent: true,  retryDelays: [],                        reportAs: 'warn'  },
  invalid_number:  { permanent: true,  retryDelays: [],                        reportAs: 'warn'  },
  timeout:         { permanent: false, retryDelays: [5 * MIN, 30 * MIN, 2 * HOUR], reportAs: 'error' },
  server_error:    { permanent: false, retryDelays: [5 * MIN, 30 * MIN, 2 * HOUR], reportAs: 'error' },
  rate_limited:    { permanent: false, retryDelays: [HOUR, 3 * HOUR, 6 * HOUR],    reportAs: 'error' },
  instance_down:   { permanent: false, retryDelays: Array(6).fill(30 * MIN),        reportAs: 'error' },
  auth_error:      { permanent: false, retryDelays: [30 * MIN, HOUR, 2 * HOUR],     reportAs: 'error' },
  unknown:         { permanent: false, retryDelays: [5 * MIN, 30 * MIN, 2 * HOUR], reportAs: 'error' },
}

export function classifyFailure(errorMessage) {
  const raw = String(errorMessage ?? '')
  const msg = raw.toLowerCase()

  if (msg.includes('"exists":false') || (msg.includes('exists') && msg.includes('false')) ||
      msg.includes('not on whatsapp') || msg.includes('not registered') || msg.includes('number_not_on_whatsapp')) return 'not_on_whatsapp'
  if (msg.includes('invalid_phone') || msg.includes('invalid number')) return 'invalid_number'

  const status = parseInt(raw.match(/^(\d{3}):/)?.[1] ?? '', 10)
  if (status === 401 || status === 403 || msg.includes('apikey')) return 'auth_error'
  if (status === 429 || msg.includes('rate-overlimit') || msg.includes('rate limit') || msg.includes('too many')) return 'rate_limited'
  if (msg.includes('connection closed') || msg.includes('not connected') || msg.includes('instance does not exist') ||
      msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('fetch failed') || status === 404) return 'instance_down'
  if (msg.includes('aborted') || msg.includes('timed out') || msg.includes('timeout') || msg.includes('etimedout')) return 'timeout'
  if (status >= 500 && status < 600) return 'server_error'
  return 'unknown'
}

// attemptsSoFar counts this failure (first failure = 1).
// Returns { failureClass, giveUp, retryInMs|null, reportAs }.
export function decideRetry(errorMessage, attemptsSoFar) {
  const failureClass = classifyFailure(errorMessage)
  const policy = POLICY[failureClass]
  if (policy.permanent || attemptsSoFar > policy.retryDelays.length) {
    return { failureClass, giveUp: true, retryInMs: null, reportAs: policy.permanent ? policy.reportAs : 'error', permanent: policy.permanent }
  }
  return { failureClass, giveUp: false, retryInMs: policy.retryDelays[attemptsSoFar - 1], reportAs: 'warn', permanent: false }
}

// Kept for anything that still imports the old name.
export function isPermanentSendFailure(errorMessage) {
  return POLICY[classifyFailure(errorMessage)].permanent
}
