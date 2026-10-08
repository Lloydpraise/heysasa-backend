// The action engine: how a change goes from "the assistant wants this" to "it is done and on the record".
//
//   propose  -> the tool checks the request and builds a plain-language preview (nothing changes yet)
//            -> a row in ba_actions (status pending) that the owner sees as a card
//            -> if the owner chose "always allow" for this kind of action AND it is not critical, it runs straight away
//   approve  -> claims the row (pending -> running, once), re-checks everything against fresh data, runs it, records the result
//   reject   -> pending -> rejected
//   undo     -> for actions that can be put back (done -> undone)
//
// The rule that matters: the model can only PROPOSE. Nothing runs without either a tap from the owner or an
// earlier "always allow" from the owner, and critical actions never accept "always allow".

import { ToolError } from './helpers.js';

export class ActionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const ACTION_TTL_MS = 24 * 60 * 60_000;

const friendly = (error) => (error instanceof ToolError ? error.message : 'That did not work, so nothing was changed. Please try again in a moment.');

export function createActionEngine({ store, registry, now = () => new Date(), ttlMs = ACTION_TTL_MS, log = () => {} }) {
  const toolFor = (type) => {
    const tool = registry.byName.get(type);
    if (!tool || tool.kind !== 'propose') throw new ActionError('unknown_action', 'That kind of action is not available any more.');
    return tool;
  };

  async function isAlwaysAllowed(businessId, tool) {
    if (tool.risk === 'critical') return false;
    const prefs = await store.listActionPrefs(businessId);
    return prefs.some((p) => p.action_type === tool.name && p.always_allow === true);
  }

  async function execute(ctx, row, { approval, approvedBy = null }) {
    const tool = toolFor(row.type);
    const claimed = await store.transitionAction(row.id, row.business_id, 'pending', {
      status: 'running', approval, approved_by: approvedBy, decided_at: now().toISOString(),
    });
    if (!claimed) return { row: await store.getAction(row.id, row.business_id), ran: false };

    try {
      // Anything could have changed since the card was made, so the tool re-checks against fresh data.
      const done = await tool.execute(ctx, claimed.params, claimed);
      const finished = await store.patchAction(claimed.id, claimed.business_id, {
        status: 'done', summary: done.summary, result: done.result ?? null, before: done.before ?? null,
        undoable: Boolean(tool.undo) && done.undoable !== false, executed_at: now().toISOString(), error: null,
      });
      return { row: finished, ran: true };
    } catch (error) {
      if (!(error instanceof ToolError)) log('error', `action ${claimed.type} failed: ${error.message}`);
      const failed = await store.patchAction(claimed.id, claimed.business_id, {
        status: 'failed', error: String(error.message).slice(0, 500), summary: friendly(error), executed_at: now().toISOString(),
      });
      return { row: failed, ran: true, failed: true };
    }
  }

  return {
    // Called by a propose tool. Returns { action, auto } where auto means it already ran.
    async propose(ctx, tool, args) {
      const plan = await tool.plan(ctx, args);
      const row = await store.insertAction({
        business_id: ctx.businessId, actor: 'assistant', on_behalf_of: ctx.userId ?? null, conversation_id: ctx.conversationId ?? null,
        type: tool.name, area: tool.area, risk: tool.risk, title: plan.title, params: plan.params ?? {}, preview: plan.preview ?? {},
        status: 'pending', undoable: false, expires_at: new Date(now().getTime() + ttlMs).toISOString(),
      });
      if (await isAlwaysAllowed(ctx.businessId, tool)) {
        const out = await execute(ctx, row, { approval: 'always_allow' });
        return { action: out.row, auto: true };
      }
      return { action: row, auto: false };
    },

    async approve(ctx, id) {
      const row = await store.getAction(id, ctx.businessId);
      if (!row) throw new ActionError('action_not_found', 'That request was not found.');
      if (row.status !== 'pending') {
        if (['done', 'running'].includes(row.status)) return { action: row, already: true };
        throw new ActionError('not_pending', row.status === 'expired' ? 'That request has expired. Ask me again and I will redo it with fresh numbers.' : 'That request is already closed.');
      }
      if (new Date(row.expires_at).getTime() < now().getTime()) {
        await store.transitionAction(row.id, row.business_id, 'pending', { status: 'expired', decided_at: now().toISOString() });
        throw new ActionError('expired', 'That request has expired. Ask me again and I will redo it with fresh numbers.');
      }
      const out = await execute(ctx, row, { approval: 'owner', approvedBy: ctx.userId ?? null });
      return { action: out.row, already: !out.ran };
    },

    async reject(ctx, id) {
      const row = await store.getAction(id, ctx.businessId);
      if (!row) throw new ActionError('action_not_found', 'That request was not found.');
      const closed = await store.transitionAction(id, ctx.businessId, 'pending', {
        status: 'rejected', decided_at: now().toISOString(), summary: 'You said no, so nothing was changed.',
      });
      return { action: closed ?? row };
    },

    async undo(ctx, id) {
      const row = await store.getAction(id, ctx.businessId);
      if (!row) throw new ActionError('action_not_found', 'That was not found.');
      if (row.status !== 'done' || !row.undoable) throw new ActionError('not_undoable', 'This one cannot be undone.');
      const tool = toolFor(row.type);
      if (!tool.undo) throw new ActionError('not_undoable', 'This one cannot be undone.');
      const claimed = await store.transitionAction(id, ctx.businessId, 'done', { status: 'running' });
      if (!claimed) throw new ActionError('not_undoable', 'This one is already being changed.');
      try {
        const out = await tool.undo(ctx, claimed);
        const undone = await store.patchAction(id, ctx.businessId, {
          status: 'undone', undone_at: now().toISOString(), undoable: false, summary: `${claimed.summary} Then undone: ${out.summary}`.slice(0, 500),
        });
        return { action: undone };
      } catch (error) {
        if (!(error instanceof ToolError)) log('error', `undo ${claimed.type} failed: ${error.message}`);
        await store.patchAction(id, ctx.businessId, { status: 'done' });
        throw new ActionError('undo_failed', error instanceof ToolError ? error.message : 'Could not undo that. Nothing was changed.');
      }
    },

    // Housekeeping before reading the queue: old requests expire, interrupted ones are closed.
    async sweep(businessId) {
      await store.expireStaleActions(businessId);
      await store.failStuckActions(businessId);
    },

    // Plain-language lines the model reads about earlier actions in a conversation.
    describe(rows) {
      return rows.map((a) => {
        const state = { pending: 'waiting for the owner to say OK', running: 'running now', done: 'done', failed: 'failed', rejected: 'the owner said no', expired: 'expired unanswered', undone: 'done, then undone' }[a.status] ?? a.status;
        return `- ${a.title}: ${state}${a.summary ? `. ${a.summary}` : ''}`;
      }).join('\n');
    },

    async setAlwaysAllow(businessId, type, on) {
      const tool = registry.byName.get(type);
      if (!tool || tool.kind !== 'propose') throw new ActionError('unknown_action', 'That kind of action was not found.');
      if (tool.risk === 'critical') throw new ActionError('critical', 'This one always asks for your OK first. That cannot be switched off.');
      return store.setActionPref(businessId, type, on === true);
    },
  };
}
