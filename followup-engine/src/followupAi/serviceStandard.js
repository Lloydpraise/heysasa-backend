// The service floor: rules every follow-up must meet, whoever wrote it and whatever voice the business uses.
// A persona pack copies how the owner writes. That is right for tone, but an owner who writes badly must not get a
// follow-up AI that writes badly. These checks do not look at style, only at things that hurt a customer relationship.
// Pure and deterministic; the AI reviewer (qc.js) covers what rules cannot see (relevance, voice match).

const MAX_CHARS_HARD = 600
const MAX_CHARS_SOFT = 380

const PRESSURE = /\b(last chance|hurry( up)?|act now|don'?t miss out|only \d+ (left|remaining)|expires? (today|tonight)|final warning|you must (reply|respond))\b/i
const RUDE = /\b(stupid|idiot|useless|shut up|are you ignoring me|why (are you )?ignoring)\b/i
const PLACEHOLDER = /\{\{[^}]*\}\}|\[[A-Z][A-Z _]{2,}\]|<[a-z/][^>]*>|\bas an ai\b|\blorem ipsum\b/i
const MONEY = /(?:ksh?s?\.?|kes|usd|\$|sh\.?)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:\/=|ksh?s?|kes|usd)/gi

const digits = (value) => String(value).replace(/[^\d.]/g, '').replace(/\.0+$/, '')

const words = (text) => new Set(String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2))

export function similarity(a, b) {
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / (x.size + y.size - shared)
}

// {{first_name}} and {{product_interest}} are filled in per lead at send time, so they are not "unfilled placeholders".
const MERGE_TOKENS = [[/\{\{\s*first_name\s*\}\}/gi, 'Sam'], [/\{\{\s*product_interest\s*\}\}/gi, 'this']]

export function checkServiceStandard(message, { contextText = '', previousMessages = [] } = {}) {
  let text = String(message ?? '').trim()
  for (const [token, sample] of MERGE_TOKENS) text = text.replace(token, sample)
  const issues = []
  const warnings = []
  const add = (rule, detail) => issues.push({ rule, detail })

  if (!text) return { passed: false, issues: [{ rule: 'EMPTY', detail: 'message is empty' }], warnings }

  if (PLACEHOLDER.test(text)) add('PLACEHOLDER', 'contains an unfilled placeholder, tag or AI wording')
  if (text.length > MAX_CHARS_HARD) add('TOO_LONG', `${text.length} characters (limit ${MAX_CHARS_HARD})`)
  else if (text.length > MAX_CHARS_SOFT) warnings.push({ rule: 'LONG', detail: `${text.length} characters: shorter reads better on WhatsApp` })

  const shouting = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter(w => !/^(KSH|KES|USD|M-?PESA|WHATSAPP|HTTPS?)$/.test(w))
  if (shouting.length > 1) add('CAPS', `ALL-CAPS words: ${shouting.slice(0, 3).join(', ')}`)
  if ((text.match(/!/g) ?? []).length > 2) add('EXCLAMATIONS', 'more than two exclamation marks')
  if (/([!?.])\1{2,}/.test(text)) add('PUNCTUATION', 'repeated punctuation')
  if ((text.match(/\p{Extended_Pictographic}/gu) ?? []).length > 3) add('EMOJI', 'more than three emojis')
  if ((text.match(/\?/g) ?? []).length > 2) add('ONE_ASK', 'asks more than two questions: one clear ask converts better')

  const context = String(contextText ?? '')
  if (PRESSURE.test(text) && !PRESSURE.test(context)) add('PRESSURE', 'false urgency or pressure that the offer does not state')
  if (RUDE.test(text)) add('RUDE', 'tone is not respectful')

  // Any amount of money must come from what the ad or the business actually said.
  const known = new Set()
  for (const m of context.matchAll(MONEY)) known.add(digits(m[1] ?? m[2]))
  for (const m of text.matchAll(MONEY)) {
    const amount = digits(m[1] ?? m[2])
    if (amount && !known.has(amount)) { add('UNSUPPORTED_PRICE', `price ${amount} is not in the ad or business details`); break }
  }

  for (const prev of previousMessages) {
    const prevText = typeof prev === 'string' ? prev : prev?.content?.text ?? prev?.text ?? ''
    if (prevText && similarity(text, prevText) >= 0.7) { add('REPEAT', 'says almost the same as a message already sent'); break }
  }

  return { passed: issues.length === 0, issues, warnings }
}

export const SERVICE_RULES_TEXT = [
  'Be respectful and warm. Never rude, never guilt-tripping, never "why are you ignoring me".',
  'No false urgency. Only mention a deadline, stock level or discount if the ad or the business details state it.',
  'Never invent prices, discounts, results or testimonials. Use only what is in the context.',
  'One clear ask per message. A question the customer can answer in one line.',
  'Short: ideally under 350 characters, never over 600.',
  'No spam style: no ALL CAPS shouting, at most two exclamation marks, at most three emojis.',
  'Never leave a placeholder, a bracketed tag or any AI wording in the message.',
  'Never repeat a point the customer has already been sent.',
].map((r, i) => `${i + 1}. ${r}`).join('\n')
