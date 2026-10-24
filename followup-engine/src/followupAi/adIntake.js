// Ad intake: the moment an ad has real leads, it gets a playbook. Runs on a database event (a new ad_attributions row,
// an owner edit on ad_playbooks) and on a slow timer as a safety net.
//
// Spend is deliberately bounded: only ads with leads in the last 30 days, a few new playbooks per business per run, and
// a couple of AI generations per run. Everything produced is a draft for the owner.
//
// A playbook that fails is never retried on its own. It is tried again only when a NEW lead arrives on that ad after
// the failure (or when the owner edits the ad). A failure that repeats itself must never keep calling the AI.

import { log } from '../lib/log.js'
import { NON_CUSTOMER_TYPES } from '../lib/leadTypes.js'
import { generatePlaybook, markPlaybookFailed } from './playbookAuthor.js'
import { shouldRetryFailed } from './playbookRules.js'
import { logTurn } from './turns.js'
import { accountOverrides } from '../lib/accounts.js'

const RECENT_DAYS = 30
const NEW_PER_BUSINESS_PER_RUN = 3
const GENERATIONS_PER_RUN = 2

const clean = (v) => { const s = String(v ?? '').trim(); return s || null }

export async function runAdIntake(supabase) {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString()

  // 1. ads that actually have leads, per WhatsApp account (ad_playbooks are keyed account_id, ad_id; leads without an
  //    account, from before accounts, are grouped per business as before)
  const { data: leads, error } = await supabase.from('contacts')
    .select('business_id, account_id, ad_id, original_ad_id, lead_type, ad_attributed_at')
    .eq('is_ad_lead', true).gte('ad_attributed_at', since).limit(5000)
  if (error) throw new Error(`ad intake: lead lookup failed: ${error.message}`)

  const scopeKey = (businessId, accountId) => `${businessId}|${accountId ?? ''}`
  const wanted = new Map() // scope key -> { businessId, accountId, ads: Set(ad_id) }
  const latestLead = new Map() // `${scope key}:${ad_id}` -> newest ad_attributed_at (ms)
  for (const c of leads ?? []) {
    const adKey = c.original_ad_id || c.ad_id
    if (!adKey || NON_CUSTOMER_TYPES.has(c.lead_type)) continue
    const scope = scopeKey(c.business_id, c.account_id)
    if (!wanted.has(scope)) wanted.set(scope, { businessId: c.business_id, accountId: c.account_id ?? null, ads: new Set() })
    wanted.get(scope).ads.add(String(adKey))
    const at = Date.parse(c.ad_attributed_at)
    const key = `${scope}:${adKey}`
    if (Number.isFinite(at) && at > (latestLead.get(key) ?? 0)) latestLead.set(key, at)
  }
  const businessIds = [...new Set([...wanted.values()].map(w => w.businessId))]
  let created = 0
  if (businessIds.length) {
    const { data: businesses } = await supabase.from('businesses').select('business_id, followup_ai_enabled, subscription_active').in('business_id', businessIds)
    const byId = new Map((businesses ?? []).map(b => [b.business_id, b]))
    // The follow-up switch can be overridden per account (accounts.settings).
    const overrides = await accountOverrides(supabase, 'followup_ai_enabled')
    const isOn = ({ businessId, accountId }) => {
      const b = byId.get(businessId)
      if (!b?.subscription_active) return false
      if (accountId && overrides.on.has(accountId)) return true
      if (accountId && overrides.off.has(accountId)) return false
      return !!b.followup_ai_enabled
    }
    const activeScopes = [...wanted.entries()].filter(([, w]) => isOn(w))
    const activeBusinesses = [...new Set(activeScopes.map(([, w]) => w.businessId))]

    const [{ data: existing }, { data: attributions }] = await Promise.all([
      supabase.from('ad_playbooks').select('id, business_id, account_id, ad_id, status, failed_at, auto_headline, auto_body, auto_thumbnail_url').in('business_id', activeBusinesses),
      supabase.from('ad_attributions').select('business_id, account_id, ad_id, ad_headline, ad_body, ad_thumbnail_url').in('business_id', activeBusinesses),
    ])
    const have = new Map((existing ?? []).map(p => [`${scopeKey(p.business_id, p.account_id)}:${p.ad_id}`, p]))
    const attrByKey = new Map((attributions ?? []).map(a => [`${scopeKey(a.business_id, a.account_id)}:${a.ad_id}`, a]))

    for (const [scope, { businessId, accountId, ads }] of activeScopes) {
      let made = 0
      for (const adId of ads) {
        const key = `${scope}:${adId}`
        const attr = attrByKey.get(key)
        const current = have.get(key)
        const auto = { auto_headline: clean(attr?.ad_headline), auto_body: clean(attr?.ad_body), auto_thumbnail_url: clean(attr?.ad_thumbnail_url) }

        if (!current) {
          if (made >= NEW_PER_BUSINESS_PER_RUN) continue
          const images = auto.auto_thumbnail_url ? [{ url: auto.auto_thumbnail_url, source: 'meta', label: 'Ad thumbnail' }] : []
          const row = { business_id: businessId, ad_id: adId, status: 'pending', images, ...auto }
          if (accountId) row.account_id = accountId
          const { error: insertError } = await supabase.from('ad_playbooks')
            .upsert(row, { onConflict: accountId ? 'account_id,ad_id' : 'business_id,ad_id', ignoreDuplicates: true })
          if (insertError) { log('error', 'followup_ai', 'followup_ai.intake_insert_failed', insertError.message, { business_id: businessId, details: { accountId } }); continue }
          made++; created++
          await logTurn(supabase, { businessId, accountId, kind: 'intake', decision: 'ad_found', details: { adId } })
          continue
        }

        // failed before: one more try, but only because a new lead arrived on this ad after the failure
        if (current.status === 'failed') {
          const latest = latestLead.get(key)
          if (latest && shouldRetryFailed({ failedAt: current.failed_at, latestLeadAt: new Date(latest).toISOString() })) {
            await supabase.from('ad_playbooks').update({ ...Object.fromEntries(Object.entries(auto).filter(([, v]) => v)), status: 'pending' }).eq('id', current.id)
            await logTurn(supabase, { businessId, accountId, kind: 'intake', decision: 'retry_new_lead', details: { adId } })
          }
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
      await markPlaybookFailed(supabase, item.id, { last_error: String(e.message).slice(0, 300) })
    }
  }
  return { created, generated }
}
