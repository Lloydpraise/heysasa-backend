// The business's uploaded files, for the Follow-up AI. The Follow-up AI writes one message in one model call and has no
// tool loop, so instead of letting it search, we search for it: the files meant for follow-ups are listed (title and what
// each is for), and the few pieces that best match this lead's situation are added. Nothing here may ever stop a
// follow-up from being written: any problem returns an empty block.
import { OPENAI_KEY } from '../config.js'
import { billAiUsage } from './billing.js'
import { supabase as billingClient } from '../supabaseClient.js'
import { log } from './log.js'

const EMBED_MODEL = 'text-embedding-3-small'
const MENU_TTL_MS = 60_000
const MAX_PIECES = 4
const menuCache = new Map()   // `${businessId}|${accountId}` -> { at, sources }

export const KNOWLEDGE_RUNNER = 'knowledge_analysis'
const clip = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

async function embedQuery(text, businessId, { fetchFn = fetch, bill = billAiUsage, billing = billingClient, accountId = null } = {}) {
  const res = await fetchFn('https://api.openai.com/v1/embeddings', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: clip(text, 2000) }), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`embedding failed: ${res.status}`)
  const data = await res.json()
  const tokens = data?.usage?.prompt_tokens ?? data?.usage?.total_tokens ?? 0
  if (tokens) bill(billing, { businessId, accountId, runner: KNOWLEDGE_RUNNER, model: EMBED_MODEL, promptTokens: tokens }).catch(() => {})
  return data?.data?.[0]?.embedding ?? null
}

// An account sees its own files plus the business-level ones (account_id null, the shared catalog).
async function loadMenu(supabase, businessId, now, accountId = null) {
  const key = `${businessId}|${accountId ?? ''}`
  const hit = menuCache.get(key)
  if (hit && now - hit.at < MENU_TTL_MS) return hit.sources
  let query = supabase.from('knowledge_sources').select('id, title, use_case, file_type')
    .eq('business_id', businessId).eq('is_active', true).eq('status', 'ready').in('used_by', ['followup', 'both'])
  if (accountId) query = query.or(`account_id.eq.${accountId},account_id.is.null`)
  const { data, error } = await query.order('created_at', { ascending: true }).limit(30)
  if (error) throw new Error(error.message)
  menuCache.set(key, { at: now, sources: data ?? [] })
  return data ?? []
}

// -> { block, facts }: `block` goes into the prompt; `facts` is everything the message may legitimately quote (for quality control).
export async function loadFollowupKnowledge(supabase, { businessId, accountId = null, queryText, deps = {} }) {
  const none = { block: '', facts: '' }
  try {
    if (!businessId) return none
    const now = (deps.now ?? Date.now)()
    const sources = await loadMenu(supabase, businessId, now, accountId)
    if (!sources.length) return none

    const menu = sources.map(s => `- ${s.title}${s.use_case ? `: ${clip(s.use_case, 240)}` : ''}`).join('\n')
    let pieces = []
    if (clip(queryText, 10)) {
      const embedding = await (deps.embed ?? embedQuery)(queryText, businessId, { ...deps, accountId })
      if (embedding) {
        const args = { p_business_id: businessId, p_embedding: embedding, p_count: MAX_PIECES, p_threshold: 0.3, p_bot: 'followup', p_source_id: null }
        if (accountId) args.p_account_id = accountId
        const { data } = await supabase.rpc('match_knowledge_chunks', args)
        pieces = (data ?? []).map(r => ({ title: r.title ?? r.source_title ?? 'File', text: clip(r.content, 700) })).filter(p => p.text)
      }
    }
    const lines = [
      'BUSINESS FILES (the owner uploaded these; follow them when they apply to this lead, and never go beyond what they say)',
      menu,
      pieces.length ? `MOST RELEVANT PARTS FOR THIS LEAD:\n${pieces.map(p => `[${p.title}] ${p.text}`).join('\n')}` : '',
    ].filter(Boolean)
    return { block: lines.join('\n'), facts: pieces.map(p => p.text).join('\n') }
  } catch (error) {
    log('warn', 'followup', 'knowledge.unavailable', `follow-up knowledge skipped: ${String(error?.message || error)}`, { business_id: businessId })
    return none
  }
}

export const _resetKnowledgeCache = () => menuCache.clear()
