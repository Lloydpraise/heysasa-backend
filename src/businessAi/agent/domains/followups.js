// Follow-up approvals: messages the follow-up AI drafted that wait for the owner's OK before they are sent to a customer.
// Ported from followup-engine/src/api/queueRoutes.js, which stays the source of truth for the rules.
import { ToolError, asText, clip, fetchAll, must, plural, uniq } from '../helpers.js';

const MAX_BATCH = 50;

async function pendingRows(ctx, ids = null) {
  const rows = await fetchAll((from, to) => {
    let q = ctx.db.from('follow_up_queue').select('id, contact_id, sequence_step, touchpoint_type, draft_message, media, qc_passed, qc_notes, scheduled_at').eq('business_id', ctx.businessId).eq('approval_status', 'awaiting_approval');
    if (ids) q = q.in('id', ids);
    return q.order('scheduled_at', { ascending: true }).range(from, to);
  }, { max: 2000 });
  return rows;
}

async function namesFor(ctx, contactIds) {
  if (!contactIds.length) return new Map();
  const rows = must(await ctx.db.from('contacts').select('id, name').eq('business_id', ctx.businessId).in('id', uniq(contactIds).slice(0, 200)), 'contacts') ?? [];
  return new Map(rows.map((r) => [String(r.id), r.name || 'Unknown']));
}

const get_followup_approvals = {
  name: 'get_followup_approvals', area: 'followups', kind: 'read', status: 'Checking messages waiting for you…',
  description: 'Follow-up messages the AI wrote that are waiting for the owner to approve before they are sent. Shows who each is for and the wording.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx) {
    const rows = await pendingRows(ctx);
    const names = await namesFor(ctx, rows.map((r) => r.contact_id));
    return {
      waiting: rows.length,
      messages: rows.slice(0, 20).map((r) => ({ id: r.id, for: names.get(String(r.contact_id)) || 'Unknown', step: r.sequence_step, text: clip(r.draft_message, 400), has_media: Boolean(r.media), quality_check_passed: r.qc_passed ?? null, quality_notes: clip(r.qc_notes, 200) || undefined })),
      note: rows.length > 20 ? `Showing the first 20 of ${rows.length}.` : undefined,
    };
  },
};

const approve_followups = {
  name: 'approve_followups', area: 'followups', kind: 'propose', risk: 'critical',
  description: 'Approve follow-up messages so they are sent to customers. Pass the ids from get_followup_approvals (up to 50). To change the wording of one first, include it in edits. Sends real messages, so it always waits for the owner\'s OK. Never approve a message the owner has not been shown.',
  parameters: {
    type: 'object',
    properties: {
      item_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_BATCH },
      edits: { type: 'array', description: 'Optional new wording for some of them.', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false } },
    },
    required: ['item_ids'], additionalProperties: false,
  },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const ids = uniq(args.item_ids).slice(0, MAX_BATCH);
    if (!ids.length) throw new ToolError('Tell me which messages to approve.');
    const rows = await pendingRows(ctx, ids);
    if (!rows.length) throw new ToolError('Those messages are no longer waiting. They may have been handled already.');
    const edits = new Map((args.edits ?? []).map((e) => [e.id, asText(e.text)]));
    for (const [id, text] of edits) if (!rows.some((r) => r.id === id) || !text) throw new ToolError('One of the edits does not match a waiting message, or is empty.');
    const names = await namesFor(ctx, rows.map((r) => r.contact_id));
    return {
      title: `Approve ${plural(rows.length, 'message')} to customers`,
      params: { item_ids: rows.map((r) => r.id), edits: Object.fromEntries(edits) },
      preview: {
        headline: `${plural(rows.length, 'message')} will be sent to customers`,
        messages: rows.slice(0, 6).map((r, i) => ({ n: i + 1, when: `To ${names.get(String(r.contact_id)) || 'Unknown'}${edits.has(r.id) ? ' (reworded)' : ''}`, text: edits.get(r.id) || r.draft_message || '' })),
        more: Math.max(0, rows.length - 6), warning: 'These go out to real customers.',
      },
    };
  },
  async execute(ctx, params) {
    const business = must(await ctx.db.from('businesses').select('whatsapp_channel').eq('business_id', ctx.businessId).maybeSingle(), 'business');
    const rows = await pendingRows(ctx, params.item_ids);
    if (!rows.length) throw new ToolError('Those messages are no longer waiting, so nothing was sent.');
    let done = 0;
    for (const r of rows) {
      const finalMessage = asText(params.edits?.[r.id]) || r.draft_message || '';
      if (!finalMessage && !r.media) continue;
      const res = await ctx.db.from('follow_up_queue').update({ status: 'ready_to_send', channel: business?.whatsapp_channel ?? null, final_message: finalMessage, draft_message: finalMessage, media: r.media ?? null, approval_status: 'approved' })
        .eq('id', r.id).eq('business_id', ctx.businessId).eq('approval_status', 'awaiting_approval');
      if (res.error) throw new Error(`approve: ${res.error.message}`);
      done += 1;
    }
    if (!done) throw new ToolError('None of those had any wording to send.');
    return { summary: `Approved ${plural(done, 'message')}. They will be sent shortly.`, result: { count: done }, undoable: false };
  },
};

const reject_followups = {
  name: 'reject_followups', area: 'followups', kind: 'propose', risk: 'normal',
  description: 'Skip follow-up messages the owner does not want sent. The customers will not get them. Pass ids from get_followup_approvals (up to 50).',
  parameters: { type: 'object', properties: { item_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_BATCH } }, required: ['item_ids'], additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const rows = await pendingRows(ctx, uniq(args.item_ids).slice(0, MAX_BATCH));
    if (!rows.length) throw new ToolError('Those messages are no longer waiting.');
    return { title: `Skip ${plural(rows.length, 'message')}`, params: { item_ids: rows.map((r) => r.id) }, preview: { headline: `${plural(rows.length, 'message')} will not be sent`, lines: ['The customers will not receive them.'] } };
  },
  async execute(ctx, params) {
    const rows = await pendingRows(ctx, params.item_ids);
    for (const r of rows) {
      const res = await ctx.db.from('follow_up_queue').update({ approval_status: 'rejected', status: 'skipped', skip_reason: 'rejected_by_owner' }).eq('id', r.id).eq('business_id', ctx.businessId).eq('approval_status', 'awaiting_approval');
      if (res.error) throw new Error(`reject: ${res.error.message}`);
    }
    return { summary: `Skipped ${plural(rows.length, 'message')}.`, result: { count: rows.length }, undoable: false };
  },
};

export default [get_followup_approvals, approve_followups, reject_followups];
