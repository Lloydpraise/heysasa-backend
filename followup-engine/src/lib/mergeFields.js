// Resolves merge-field tokens (e.g. {{first_name}}) inside campaign step
// content against a contact record, before the message is queued for send.
//
// Resolved: {{first_name}} and {{product_interest}} (first entry of
// contacts.product_interests). price still has no data source, so that token
// is left untouched rather than guessed at.

function firstName(contact) {
  const name = (contact?.name ?? '').trim()
  if (!name) return 'there'
  return name.split(/\s+/)[0]
}

function productInterest(contact) {
  const list = Array.isArray(contact?.product_interests) ? contact.product_interests : []
  const first = list.map(v => String(v ?? '').trim()).find(Boolean)
  return first || 'what you were looking for'
}

export function resolveMergeFields(content, contact) {
  if (!content) return content
  return content
    .replace(/\{\{\s*first_name\s*\}\}/gi, firstName(contact))
    .replace(/\{\{\s*product_interest\s*\}\}/gi, productInterest(contact))
}

export function resolveMediaMergeFields(media, contact) {
  if (!media || typeof media !== 'object') return media
  return {
    ...media,
    ...(media.caption ? { caption: resolveMergeFields(media.caption, contact) } : {})
  }
}