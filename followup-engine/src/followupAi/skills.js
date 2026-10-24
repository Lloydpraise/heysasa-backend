// Loads the skills the Follow-up AI is taught and renders them into a prompt block.
// Defaults live in defaultSkills.js (synced into followup_ai_default_skills on start so they can be seen and changed in
// the database too); a row of the account (followup_ai_skills is keyed account_id, key) with the same key overrides the
// default, enabled = false removes it. Rows without an account (from before accounts) apply underneath the account's.

import { DEFAULT_SKILLS } from './defaultSkills.js'
import { log } from '../lib/log.js'

const TTL_MS = 60_000
const cache = new Map() // `${business_id}|${account_id}` -> { at, skills }

export async function ensureDefaultSkills(supabase) {
  const rows = DEFAULT_SKILLS.map(s => ({ ...s, updated_at: new Date().toISOString() }))
  // ignoreDuplicates: a skill row edited in the database is the owner of the platform's say, the code only adds missing keys.
  const { error } = await supabase.from('followup_ai_default_skills').upsert(rows, { onConflict: 'key', ignoreDuplicates: true })
  if (error) log('warn', 'followup_ai', 'followup_ai.skills_sync_failed', `Default skills not synced: ${error.message}`)
  return { skills: rows.length }
}

// Pure merge: platform defaults, then the business's own rows on top.
export function mergeSkills(defaults, own) {
  const byKey = new Map()
  for (const s of defaults ?? []) if (s.enabled !== false) byKey.set(s.key, s)
  for (const s of own ?? []) {
    if (s.enabled === false) byKey.delete(s.key)
    else byKey.set(s.key, s)
  }
  return [...byKey.values()].sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || a.key.localeCompare(b.key))
}

export async function loadSkills(supabase, businessId, role, accountId = null) {
  const key = `${businessId}|${accountId ?? ''}`
  const hit = cache.get(key)
  let skills = hit && Date.now() - hit.at < TTL_MS ? hit.skills : null
  if (!skills) {
    const [{ data: defaults, error: defaultsError }, { data: rows }] = await Promise.all([
      supabase.from('followup_ai_default_skills').select('*').eq('enabled', true),
      supabase.from('followup_ai_skills').select('*').eq('business_id', businessId),
    ])
    // The account's own rows win over rows without an account; other accounts' rows never apply.
    const own = accountId
      ? [...(rows ?? []).filter(r => !r.account_id), ...(rows ?? []).filter(r => r.account_id === accountId)]
      : rows
    // Database not seeded yet (or unreachable): the shipped defaults are always there.
    skills = mergeSkills(defaultsError || !defaults?.length ? DEFAULT_SKILLS : defaults, own)
    cache.set(key, { at: Date.now(), skills })
  }
  return skills.filter(s => !role || (s.used_by ?? []).includes(role))
}

export function renderSkills(skills, { only = null } = {}) {
  const list = only?.length ? skills.filter(s => only.includes(s.key) || s.key === 'service_standard') : skills
  if (!list.length) return ''
  return 'YOUR SKILLS (follow them):\n\n' + list.map(s => `### ${s.title}\n${s.instructions}`).join('\n\n')
}
