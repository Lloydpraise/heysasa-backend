// Ad intake: the moment an ad has real leads, it gets a playbook. Runs on a database event (a new ad_attributions row,
// an owner edit on ad_playbooks) and on a slow timer as a safety net.
//
// Spend is deliberately bounded: only ads with leads in the last 30 days, a few new playbooks per business per run, and
// a couple of AI generations per run. Everything produced is a draft for the owner.

import { log } from '../lib/log.js'
import { NON_CUSTOMER_TYPES } from '../lib/leadTypes.js'
import { generatePlaybook } from './playbookAuthor.js'
import { logTurn } from './turns.js'

const RECENT_DAYS = 30
const NEW_PER_BUSINESS_PER_RUN = 3
const GENERATIONS_PER_RUN = 2

const clean = (v) => { const s = String(v ?? '').trim(); return s || null }

export async function runAdIntake(supabase) {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString()

  // 1. ads that actually have leads, per business
  const { data: leads, error } = await supabase.from('contacts')
    .select('business_id, ad_id, original_ad_id, lead_type')
    .eq('is_ad_lead', true).gte('ad_attributed_at', since).limit(5000)
  if (error) throw new Error(`ad intake: lead lookup failed: ${error.message}`)

  const wanted = new Map() // business_id -> Set(ad_id)
  for (const c of leads ?? []) {
    const adKey = c.original_ad_id || c.ad_id
    if (!adKey || NON_CUSTOMER_TYPES.has(c.lead_type)) continue
    if (!wanted.has(c.business_id)) wanted.set(c.business_id, new Set())
    wanted.get(c.business_id).add(String(adKey))
  }
  const businessIds = [...wanted.keys()]
  let created = 0
  if (businessIds.length) {
    const { data: businesses } = await supabase.from('businesses').select('business_id, followup_ai_enabled, subscription_active').in('business_id', businessIds)
    const active = new Set((businesses ?? []).filter(b => b.followup_ai_enabled && b.subscription_active).map(b => b.business_id))

    const [{ data: existing }, { data: attributions }] = await Promise.all([
      supabase.from('ad_playbooks').select('id, business_id, ad_id, status, auto_headline, auto_body, auto_thumbnail_url').in('business_id', [...active]),
      supabase.from('ad_attributions').select('business_id, ad_id, ad_headline, ad_body, ad_thumbnail_url').in('business_id', [...active]),
    ])
    const have = new Map((existing ?? []).map(p => [`${p.business_id}:${p.ad_id}`, p]))
    const attrByKey = new Map((attributions ?? []).map(a => [`${a.business_id}:${a.ad_id}`, a]))

    for (const businessId of active) {
      let made = 0
      for (const adId of wanted.get(businessId)) {
        const key = `${businessId}:${adId}`
        const attr = attrByKey.get(key)
        const current = have.get(key)
        const auto = { auto_headline: clean(attr?.ad_headline), auto_body: clean(attr?.ad_body), auto_thumbnail_url: clean(attr?.ad_thumbnail_url) }

        if (!current) {
          if (made >= NEW_PER_BUSINESS_PER_RUN) continue
          const images = auto.auto_thumbnail_url ? [{ url: auto.auto_thumbnail_url, source: 'meta', label: 'Ad thumbnail' }] : []
          const { error: insertError } = await supabase.from('ad_playbooks')
            .upsert({ business_id: businessId, ad_id: adId, status: 'pending', images, ...auto }, { onConflict: 'business_id,ad_id', ignoreDuplicates: true })
          if (insertError) { log('error', 'followup_ai', 'followup_ai.intake_insert_failed', insertError.message, { business_id: businessId }); continue }
          made++; created++
          await logTurn(supabase, { businessId, kind: 'intake', decision: 'ad_found', details: { adId } })
          continue
        }

        // late data (the headline or text arrived after the first message): fill what was missing while nothing is drafted yet
        if (['pending', 'needs_data', 'failed'].includes(current.status)) {
          const patch = {}
          for (const [col, value] of Object.entries(auto)) if (value && value !== current[col]) patch[col] = value
          if (Object.keys(patch).length) {
            if (current.status === 'needs_data') patch.status = 'pending'
            await supabase.from('ad_playbooks').update(patch).eq('id', current.id)
          }
        }
      }
    }
  }

  // 2. write the playbooks that are waiting (new ads, owner edits, a retry after an AI outage)
  const { data: work } = await supabase.from('ad_playbooks').select('id, business_id')
    .or('status.eq.pending,regenerate_requested_at.not.is.null')
    .neq('status', 'generating')
    .order('created_at', { ascending: true }).limit(GENERATIONS_PER_RUN)

  let generated = 0
  for (const item of work ?? []) {
    try {
      const result = await generatePlaybook(supabase, item.id)
      if (result.ok) generated++
    } catch (e) {
      log('error', 'followup_ai', 'followup_ai.playbook_failed', `Playbook ${item.id} failed: ${e.message}`, { business_id: item.business_id })
      await supabase.from('ad_playbooks').update({ status: 'failed', last_error: String(e.message).slice(0, 300) }).eq('id', item.id)
    }
  }
  return { created, generated }
}
