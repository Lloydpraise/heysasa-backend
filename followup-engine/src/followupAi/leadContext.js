// Everything the Follow-up AI should know about one lead before it writes or decides, loaded the same way for the
// director, the writer and the reviewer so they never disagree about the facts.

import { getMessages, getLastSentFollowups } from '../lib/db.js'
import { getCustomerProfile } from '../lib/campaignContext.js'
import { getAdContext, formatAdContext } from '../lib/adContext.js'

const TIMELINE_MESSAGES = 40

async function loadFlow(supabase, contact, conv) {
  try {
    const adKey = contact.original_ad_id || contact.ad_id || null
    let flowId = null
    if (conv?.id) {
      const { data } = await supabase.from('conversations').select('chat_ai_flow_id').eq('id', conv.id).maybeSingle()
      flowId = data?.chat_ai_flow_id ?? null
    }
    if (flowId) {
      const { data } = await supabase.from('chat_flows').select('id, name, goal, instructions').eq('id', flowId).maybeSingle()
      if (data) return data
    }
    if (adKey) {
      const { data } = await supabase.from('chat_flows').select('id, name, goal, instructions')
        .eq('business_id', contact.business_id).eq('enabled', true).contains('trigger', { ad_ids: [adKey] })
        .order('priority', { ascending: false }).limit(1).maybeSingle()
      if (data) return data
    }
  } catch { /* a flow is optional context */ }
  return null
}

// The owner's corrected headline/text (ad editor) win over what the ad message carried.
async function applyAdOverrides(supabase, contact, ad) {
  const adKey = contact.original_ad_id || contact.ad_id || null
  if (!adKey) return ad
  try {
    const { data } = await supabase.from('ad_playbooks').select('override_headline, override_body')
      .eq('business_id', contact.business_id).eq('ad_id', adKey).maybeSingle()
    const headline = String(data?.override_headline ?? '').trim()
    const body = String(data?.override_body ?? '').trim()
    if (!headline && !body) return ad
    return { adKey, platform: ad?.platform ?? '', headline: headline || ad?.headline || '', body: body || ad?.body || '' }
  } catch { return ad }
}

async function materialsText(supabase, businessId) {
  try {
    const { data } = await supabase.from('followup_materials').select('title, content')
      .eq('business_id', businessId).eq('is_active', true)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString()).limit(20)
    return (data ?? []).map(m => `${m.title} ${m.content ?? ''}`).join('\n')
  } catch { return '' }
}

// Everything a message is allowed to draw on (used by quality control to catch invented prices and claims).
export const factsText = (ctx, pack) => [
  ctx.ad?.headline, ctx.ad?.body, ctx.flow?.instructions, ctx.materials,
  JSON.stringify(pack?.business_context ?? {}),
].filter(Boolean).join('\n')

export async function loadLeadContext(supabase, { contact, business, conv }) {
  const [messages, stateRes, profile, adRaw, flow, lastFollowups, materials] = await Promise.all([
    conv ? getMessages(supabase, conv.id, { limit: TIMELINE_MESSAGES }) : Promise.resolve([]),
    supabase.from('lead_ai_state').select('*').eq('business_id', contact.business_id).eq('contact_id', contact.id).maybeSingle(),
    getCustomerProfile(supabase, contact.id),
    getAdContext(supabase, contact),
    loadFlow(supabase, contact, conv),
    getLastSentFollowups(supabase, contact.id, 3),
    materialsText(supabase, contact.business_id),
  ])
  const ad = await applyAdOverrides(supabase, contact, adRaw)
  return {
    messages,
    state: stateRes?.data ?? null,
    profile,
    ad,
    adBlock: formatAdContext(ad),
    flow,
    lastFollowups,
    materials,
    lastFollowupAt: lastFollowups[0]?.created_at ?? null,
    business,
  }
}
