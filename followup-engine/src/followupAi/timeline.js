// A short, honest picture of one lead for the Follow-up AI: who said what, when, and who each speaker was.
// The chat AI, the owner and the Follow-up AI all write to the same chat, so the Follow-up AI must see all three and
// tell them apart. Pure formatting; leadContext.js does the loading.

const MESSAGE_CHARS = 280

export const roleLabel = (m) => {
  if (m.direction === 'in') return 'Customer'
  switch (m.agent_role) {
    case 'human': return 'Owner (a person)'
    case 'chat_ai': return 'Chat AI'
    case 'follow_up_ai': return 'Follow-up AI'
    case 'legacy_ai': return 'Old AI'
    default: return 'Business'
  }
}

export function ago(ts, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatTimeline(messages, now = Date.now()) {
  if (!messages?.length) return 'No messages yet.'
  return messages.map(m => {
    const text = String(m.content?.text || `[${m.type ?? 'media'}]`).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS)
    return `[${ago(m.created_at, now)}] ${roleLabel(m)}: ${text}`
  }).join('\n')
}

// Who spoke last and what changed since our last follow-up: the one-line digest the director reads first.
export function digest(messages, { lastFollowupAt = null, now = Date.now() } = {}) {
  const lines = []
  const lastIn = [...(messages ?? [])].reverse().find(m => m.direction === 'in')
  const lastOut = [...(messages ?? [])].reverse().find(m => m.direction === 'out')
  lines.push(lastIn ? `Customer last wrote ${ago(lastIn.created_at, now)}${lastIn.intent_level != null ? ` (intent ${lastIn.intent_level}/10)` : ''}.` : 'The customer has never written.')
  if (lastOut) lines.push(`Our last message was ${ago(lastOut.created_at, now)} from ${roleLabel(lastOut)}.`)
  if (lastFollowupAt) {
    const after = (messages ?? []).filter(m => new Date(m.created_at).getTime() > new Date(lastFollowupAt).getTime())
    const byWho = {}
    for (const m of after) byWho[roleLabel(m)] = (byWho[roleLabel(m)] ?? 0) + 1
    lines.push(Object.keys(byWho).length
      ? `Since our last follow-up: ${Object.entries(byWho).map(([k, v]) => `${v} from ${k}`).join(', ')}.`
      : 'Since our last follow-up: nothing.')
  }
  return lines.join(' ')
}
