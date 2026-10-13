// Writes one follow-up message from an intent (used for follow-ups the chat AI or the Follow-up AI scheduled on its own).

import { callBot } from '../lib/ai.js'
import { AI_PROMPT_CATALOG } from '../../../src/aiPromptCatalog.js'
import { BOTS } from './constants.js'
import { renderSkills } from './skills.js'
import { formatTimeline, digest } from './timeline.js'

const WRITER_PROMPT = AI_PROMPT_CATALOG.followup_ai_writer.prompt

export async function writeFollowupMessage(supabase, { business, contact, pack, conv, ctx, skills, intent }) {
  const userContent = [
    renderSkills(skills),
    `PERSONA (the business voice):\n${JSON.stringify(pack?.persona ?? {})}`,
    `BUSINESS CONTEXT:\n${JSON.stringify(pack?.business_context ?? {})}`,
    ctx.flow ? `CHAT FLOW FOR THIS LEAD:\nGoal: ${ctx.flow.goal ?? ''}` : '',
    ctx.adBlock,
    ctx.profile ? `CUSTOMER PROFILE:\n${JSON.stringify(ctx.profile)}` : '',
    `LEAD NAME: ${contact.name ?? 'Customer'} | stage: ${conv?.lead_stage_ecom ?? conv?.lead_stage_service ?? 'unknown'}`,
    `WHAT CHANGED: ${digest(ctx.messages)}`,
    `TIMELINE (oldest first):\n${formatTimeline(ctx.messages)}`,
    `PURPOSE OF THIS FOLLOW-UP (write to achieve this):\n${intent}`,
  ].filter(Boolean).join('\n\n')

  const text = await callBot(supabase, BOTS.writer, userContent, WRITER_PROMPT, {
    temperature: 0.6, maxTokens: 300, businessId: business.business_id, cacheKey: `fuaiw:${business.business_id}`,
  })
  return text ? text.replace(/^["“]|["”]$/g, '').trim() : null
}
