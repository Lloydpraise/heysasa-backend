// Builds (or rebuilds) the playbook for ONE ad: the Chat AI flow and the 5-13 step follow-up sequence, written from the
// ad's headline, text and picture plus the business's voice and real proof. Everything lands as drafts for the owner
// to approve; nothing is live until followup_ai_activate_playbook() runs.

import { callBot } from '../lib/ai.js'
import { getBusiness, getPersonaPack } from '../lib/db.js'
import { checkAiBalance } from '../lib/billing.js'
import { DEFAULT_MAX_PER_LEAD } from '../config.js'
import { AI_PROMPT_CATALOG } from '../../../src/aiPromptCatalog.js'
import { log } from '../lib/log.js'
import { BOTS } from './constants.js'
import { loadSkills, renderSkills } from './skills.js'
import { effectiveAd, assessAdData, stepBudget, validatePlaybook } from './playbookRules.js'
import { persistAdImage, isOurStorageUrl } from './adImage.js'
import { qcMessage } from './qc.js'
import { logTurn } from './turns.js'

const AUTHOR_PROMPT = AI_PROMPT_CATALOG.followup_ai_author.prompt
const QC_CONCURRENCY = 3

async function loadMaterials(supabase, businessId) {
  const { data } = await supabase.from('followup_materials')
    .select('id, material_type, title, content, image_url')
    .eq('business_id', businessId).eq('is_active', true)
    .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
    .order('created_at', { ascending: false }).limit(20)
  return data ?? []
}

async function inBatches(items, size, fn) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)))
  return out
}

// A picture copied into our storage (once). Updates the playbook's image list so the editor offers it.
async function ensureStoredImage(supabase, pb) {
  const { imageUrl } = effectiveAd(pb)
  if (!imageUrl || isOurStorageUrl(imageUrl)) return { pb, imageUrl }
  const stored = await persistAdImage(supabase, pb.business_id, pb.ad_id, imageUrl)
  if (!stored) return { pb, imageUrl, expired: true }
  const images = [{ url: stored, source: 'meta', label: 'Ad thumbnail' }, ...(Array.isArray(pb.images) ? pb.images.filter(i => i?.url && i.url !== imageUrl) : [])]
  const patch = { images }
  if (pb.chosen_image_url === imageUrl) patch.chosen_image_url = stored
  if (pb.auto_thumbnail_url === imageUrl) patch.auto_thumbnail_url = stored
  await supabase.from('ad_playbooks').update(patch).eq('id', pb.id)
  return { pb: { ...pb, ...patch }, imageUrl: stored }
}

export async function generatePlaybook(supabase, playbookId) {
  const { data: loaded } = await supabase.from('ad_playbooks').select('*').eq('id', playbookId).maybeSingle()
  if (!loaded) return { ok: false, reason: 'playbook_not_found' }
  let pb = loaded
  const seenRegenerate = pb.regenerate_requested_at

  const business = await getBusiness(supabase, pb.business_id)
  if (!business) return { ok: false, reason: 'business_not_found' }

  // 1. is the ad data good enough?
  const stored = await ensureStoredImage(supabase, pb)
  pb = stored.pb
  const ad = effectiveAd(pb)
  const assessed = assessAdData(ad)
  const issues = stored.expired && !assessed.issues.includes('no_image') ? [...assessed.issues, 'image_link_expired'] : assessed.issues
  const quality = stored.expired && assessed.quality === 'good' ? 'weak' : assessed.quality
  if (!assessed.canGenerate) {
    await supabase.from('ad_playbooks').update({ status: 'needs_data', data_quality: quality, data_issues: issues, last_error: null }).eq('id', pb.id)
    await logTurn(supabase, { businessId: pb.business_id, kind: 'author', decision: 'needs_data', reason: issues.join(', '), details: { adId: pb.ad_id } })
    return { ok: false, reason: 'needs_data', issues }
  }

  // 2. can the business pay for the AI? (leave it pending; nothing is lost)
  if (!(await checkAiBalance(supabase, pb.business_id))) return { ok: false, reason: 'insufficient_balance' }

  await supabase.from('ad_playbooks').update({ status: 'generating' }).eq('id', pb.id)

  // 3. context
  const [pack, materials, skills] = await Promise.all([
    getPersonaPack(supabase, pb.business_id),
    loadMaterials(supabase, pb.business_id),
    loadSkills(supabase, pb.business_id, 'author'),
  ])
  const budget = stepBudget(business.followup_max_per_lead ?? DEFAULT_MAX_PER_LEAD)
  const minGap = business.followup_min_gap_hours ?? 20
  const testimonials = materials.filter(m => m.material_type === 'testimonial')
  const otherMaterials = materials.filter(m => m.material_type !== 'testimonial')
  const hasImage = !!ad.imageUrl && !stored.expired

  const materialsBlock = materials.length
    ? 'REAL PROOF AND MATERIALS THE BUSINESS HAS (use only these):\n' + materials.map(m => `[${m.material_type.toUpperCase()}] ${m.title}: ${String(m.content ?? '').slice(0, 400)}${m.image_url ? ' (has an image)' : ''}`).join('\n')
    : 'REAL PROOF AND MATERIALS THE BUSINESS HAS: none. Do not quote any testimonial; steps that need one must use media_need: testimonial.'

  const userContent = [
    renderSkills(skills),
    `PERSONA (the business voice):\n${JSON.stringify(pack?.persona ?? {})}`,
    `BUSINESS CONTEXT:\n${JSON.stringify(pack?.business_context ?? {})}`,
    `OBJECTION PLAYBOOK:\n${JSON.stringify(pack?.objection_playbook ?? [])}`,
    materialsBlock,
    `THE AD:\nHeadline: ${ad.headline || '(none)'}\nText: ${ad.body}${hasImage ? '\n(The ad picture is attached: describe nothing you cannot see, and use what it shows.)' : ''}`,
    `LIMITS: write between ${budget.min} and ${budget.max} steps (the owner allows at most ${budget.max} follow-ups per lead). Minimum ${minGap} hours between steps. The first step goes out after the lead has been quiet a while.`,
    pb.version > 1 || pb.regenerate_requested_at ? 'The owner corrected the ad details above. Rewrite everything for the corrected ad.' : '',
  ].filter(Boolean).join('\n\n')

  const run = async (extra = '') => {
    const raw = await callBot(supabase, BOTS.author, userContent + extra, AUTHOR_PROMPT, {
      json: true, temperature: 0.7, maxTokens: 4000, businessId: pb.business_id, cacheKey: `fuaiauth:${pb.business_id}`,
      images: hasImage ? [ad.imageUrl] : undefined,
    })
    if (!raw) return { unavailable: true }
    try { return { parsed: JSON.parse(raw) } } catch { return { parsed: null } }
  }

  let result = await run()
  if (result.unavailable) {
    await supabase.from('ad_playbooks').update({ status: 'pending' }).eq('id', pb.id) // AI down or out of credit: try again later, nothing spent
    return { ok: false, reason: 'ai_unavailable' }
  }
  const rules = { maxSteps: budget.max, minSteps: budget.min, minGapHours: minGap, hasTestimonial: testimonials.length > 0, hasAdImage: hasImage }
  let built = validatePlaybook(result.parsed, rules)
  if (!built.ok || built.problems.includes('too_few_steps')) {
    result = await run(`\n\nYour last answer had a problem (${built.problems.join(', ') || 'unreadable'}). Return the full JSON again with ${budget.min} to ${budget.max} steps.`)
    if (!result.unavailable) built = validatePlaybook(result.parsed, rules)
  }
  if (!built.ok || built.steps.length < Math.min(3, budget.min)) {
    await supabase.from('ad_playbooks').update({ status: 'failed', last_error: built.problems.join(', ') || 'unreadable_answer', data_quality: quality, data_issues: issues }).eq('id', pb.id)
    await logTurn(supabase, { businessId: pb.business_id, kind: 'author', decision: 'failed', reason: built.problems.join(', ') || 'unreadable_answer', details: { adId: pb.ad_id } })
    return { ok: false, reason: 'invalid_playbook', problems: built.problems }
  }

  // 4. media for each step, then quality control on each message
  let testimonialIndex = 0
  const steps = built.steps.map(s => {
    let media = null
    if (s.media_need === 'ad_image' && hasImage) media = { type: 'image', url: ad.imageUrl, caption: null }
    if (s.media_need === 'testimonial' && testimonials.length) {
      const t = testimonials.filter(x => x.image_url)[testimonialIndex++ % Math.max(1, testimonials.filter(x => x.image_url).length)]
      if (t?.image_url) media = { type: 'image', url: t.image_url, caption: null }
    }
    return { ...s, media }
  })

  const contextText = [ad.headline, ad.body, JSON.stringify(pack?.business_context ?? {}), ...materials.map(m => `${m.title} ${m.content}`)].join('\n')
  const reviewed = await inBatches(steps, QC_CONCURRENCY, (s) => qcMessage(supabase, s.content, {
    businessId: pb.business_id, pack, contextText, previousMessages: [],
  }))

  // 5. write: old drafts out of the way (live steps stay `applied` until the new ones are activated)
  const version = (pb.version ?? 1) + (pb.last_generated_at ? 1 : 0)
  await supabase.from('ad_playbook_items').update({ status: 'superseded' })
    .eq('playbook_id', pb.id).in('status', ['draft', 'approved', 'rejected', 'needs_media'])

  const rows = [
    {
      playbook_id: pb.id, business_id: pb.business_id, kind: 'flow', position: 0, status: 'draft', version,
      title: built.flow.name || 'Chat flow', goal: built.flow.goal, content: built.flow.instructions, skill_keys: built.flow.skill_keys,
      rationale: null,
    },
    ...steps.map((s, i) => ({
      playbook_id: pb.id, business_id: pb.business_id, kind: 'step', position: s.position, version,
      klt_phase: s.klt_phase, touchpoint_type: s.touchpoint_type, title: s.title,
      content: reviewed[i].finalMessage, delay_hours: s.delay_hours, media: s.media, media_source: s.media_source,
      status: s.status, qc_passed: reviewed[i].passed, qc_notes: reviewed[i].issues.join('; ') || null, rationale: s.rationale,
    })),
  ]
  const { error: insertError } = await supabase.from('ad_playbook_items').insert(rows)
  if (insertError) {
    await supabase.from('ad_playbooks').update({ status: 'failed', last_error: insertError.message }).eq('id', pb.id)
    log('error', 'followup_ai', 'followup_ai.playbook_save_failed', insertError.message, { business_id: pb.business_id, details: { adId: pb.ad_id } })
    return { ok: false, reason: 'save_failed' }
  }

  await supabase.from('ad_playbooks').update({
    status: 'review', version, last_generated_at: new Date().toISOString(), last_error: null,
    data_quality: quality, data_issues: issues,
  }).eq('id', pb.id)
  // clear the edit request only if the owner did not edit again while we were writing
  if (seenRegenerate) await supabase.from('ad_playbooks').update({ regenerate_requested_at: null }).eq('id', pb.id).eq('regenerate_requested_at', seenRegenerate)

  const failed = reviewed.filter(r => !r.passed).length
  const waiting = steps.filter(s => s.status === 'needs_media').length
  await logTurn(supabase, {
    businessId: pb.business_id, kind: 'author', decision: 'authored',
    reason: `${steps.length} steps${failed ? `, ${failed} failed quality control` : ''}${waiting ? `, ${waiting} waiting for media` : ''}`,
    details: { adId: pb.ad_id, version, steps: steps.length, qcFailed: failed, needsMedia: waiting, otherMaterials: otherMaterials.length },
  })
  return { ok: true, steps: steps.length, qcFailed: failed, needsMedia: waiting }
}
