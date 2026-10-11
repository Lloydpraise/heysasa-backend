// What the AI should know about the ad a lead came from, so a follow-up refers to what that person actually
// wanted. A business running several ads at once (kitchens, hoods, lashes...) gets a different message per ad:
// the lead's own ad details are put in front of the model next to the conversation.
//
// The details come from the contact itself (filled when the ad message arrived) and, if the headline or text is
// missing there, from the ad's own row in ad_attributions.

const MAX_BODY_CHARS = 600

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export async function getAdContext(supabase, contact) {
  if (!contact?.is_ad_lead) return null

  const adKey = contact.original_ad_id || contact.ad_id || null
  let headline = clean(contact.ad_headline, 200)
  let body = clean(contact.ad_body, MAX_BODY_CHARS)
  let platform = clean(contact.ad_platform, 40)

  if (adKey && contact.business_id && (!headline || !body)) {
    const { data } = await supabase
      .from('ad_attributions')
      .select('ad_headline, ad_body, ad_platform')
      .eq('business_id', contact.business_id)
      .eq('ad_id', adKey)
      .maybeSingle()
    headline = headline || clean(data?.ad_headline, 200)
    body = body || clean(data?.ad_body, MAX_BODY_CHARS)
    platform = platform || clean(data?.ad_platform, 40)
  }

  if (!headline && !body) return null
  return { adKey, headline, body, platform }
}

// The block that goes into the prompt. Empty string when the lead did not come from an ad (or we know nothing
// about the ad), so callers can drop it straight into their list of prompt parts.
export function formatAdContext(ad) {
  if (!ad) return ''
  const lines = ['AD THEY CAME FROM (they messaged you after seeing this ad, so what they want is what the ad offered):']
  if (ad.headline) lines.push(`Ad headline: ${ad.headline}`)
  if (ad.body) lines.push(`Ad text: ${ad.body}`)
  if (ad.platform) lines.push(`Seen on: ${ad.platform}`)
  lines.push(
    'HOW TO USE THE AD: write as a continuation of what they clicked on, in terms of the product or service the ad was about. ' +
    'Only mention offers, prices or details that appear in the ad text or elsewhere in this context. Never invent any.'
  )
  return lines.join('\n')
}
