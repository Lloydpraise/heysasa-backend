// Resolves merge-field tokens (e.g. {{first_name}}) inside campaign step
// content against a contact record, before the message is queued for send.
//
// Only first_name is resolved for now. product_interest and price need a
// defined data source (product_interests is an array on contacts; there's
// no price column yet) — until that's designed, those tokens are left
// untouched in the message rather than guessed at.

function firstName(contact) {
  const name = (contact?.name ?? '').trim()
  if (!name) return 'there'
  return name.split(/\s+/)[0]
}

export function resolveMergeFields(content, contact) {
  if (!content) return content
  return content.replace(/\{\{\s*first_name\s*\}\}/gi, firstName(contact))
}