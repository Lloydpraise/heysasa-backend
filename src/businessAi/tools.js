import { ToolError } from './agent/helpers.js';

// The tools Ask HeySasa can call. All four are shown to the model on every turn (same list for everyone, so the
// prompt cache stays warm), and all four are safe: none of them sends anything to a customer.

export const TOOL_DEFS = [
  {
    type: 'function', name: 'load_skill',
    description: 'Load a skill from the skill menu when its situation matches and it is not loaded yet. Returns its instructions.',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'The skill key from the skill menu.' } }, required: ['key'], additionalProperties: false },
  },
  {
    type: 'function', name: 'search_products',
    description: "Search this business's product catalog by meaning. Use it before writing copy that names a product, price or category. Returns up to 5 items with real prices.",
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, e.g. "braids" or "wireless earbuds".' } }, required: ['query'], additionalProperties: false },
  },
  {
    type: 'function', name: 'recall_notes',
    description: 'Search everything saved about this business and owner (past decisions, preferences, facts, earlier conversations) by meaning. Use it when the request touches something not already in front of you.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you want to remember, in plain words.' } }, required: ['query'], additionalProperties: false },
  },
  {
    type: 'function', name: 'save_note',
    description: 'Save one durable fact about the business or how the owner likes things done, so they never have to repeat it. One fact per note, plain words. Never save guesses, passwords, payment details or customers\' personal details.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, in one or two plain sentences.' },
        pinned: { type: 'boolean', description: 'true only for a core, stable fact (what they sell, who buys, their tone, a standing rule). It is then known in every conversation.' },
      },
      required: ['text'], additionalProperties: false,
    },
  },
];

export const TOOL_STATUS = {
  load_skill: 'Getting ready…',
  search_products: 'Checking your products…',
  recall_notes: 'Remembering…',
  save_note: 'Noting that down…',
};

const asText = (v) => (typeof v === 'string' ? v.trim() : '');

function formatPrice(price, currency) {
  if (price === null || price === undefined || price === '') return 'no price on file';
  const n = Number(price);
  return Number.isFinite(n) ? `${currency ? `${currency} ` : ''}${n.toLocaleString('en-KE')}` : String(price);
}

// state: { businessId, conversationId, currency, skills (all available), loaded: Set<key>, recordLoaded(key) }
export function createToolRunner({ store, notes, embed, state, agent = null, log = () => {} }) {
  const handlers = {
    async load_skill({ key }) {
      const skill = state.skills.find((s) => s.key === asText(key));
      if (!skill) return { error: `No skill called "${key}". Use a key from the skill menu.` };
      state.loaded.add(skill.key);
      state.newlyLoaded.add(skill.key);
      return { title: skill.title, instructions: skill.instructions };
    },
    async search_products({ query }) {
      const q = asText(query);
      if (!q) return { error: 'query is required' };
      const rows = await store.matchProducts(state.businessId, await embed(q, state.businessId), q);
      if (!rows.length) return { results: [], message: 'No matching products in the catalog.' };
      return {
        results: rows.map((p) => ({
          name: p.title, price: formatPrice(p.price, state.currency), category: p.category || undefined,
          description: p.description_short ? String(p.description_short).slice(0, 240) : undefined,
        })),
      };
    },
    async recall_notes({ query }) {
      const found = await notes.recall({ businessId: state.businessId, query: asText(query) });
      return found.length ? { notes: found.map((n) => n.text) } : { notes: [], message: 'Nothing saved matches that.' };
    },
    async save_note({ text, pinned }) {
      const result = await notes.save({ businessId: state.businessId, text: asText(text), pinned: pinned === true, conversationId: state.conversationId });
      if (result.status !== 'ignored') await state.recordNote?.(asText(text));
      return { status: result.status };
    },
  };

  async function runAgentTool(tool, args) {
    const ctx = state.agentCtx;
    if (tool.kind !== 'propose') return tool.run(ctx, args);
    const { action, auto } = await agent.engine.propose(ctx, tool, args);
    state.actionIds.push(action.id);
    state.emit?.({ type: auto ? 'action_done' : 'action', action: agent.toPublicAction(action) });
    if (action.status === 'done') return { status: 'done', action_id: action.id, what: action.title, result: action.summary };
    if (action.status === 'failed') return { status: 'failed', action_id: action.id, what: action.title, problem: action.summary };
    return { status: 'waiting_for_owner', action_id: action.id, what: action.title, note: 'A card is now in front of the owner. Nothing has changed yet.' };
  }

  return async function runCalls(calls) {
    return Promise.all(calls.map(async (call) => {
      const started = Date.now();
      let args = {};
      try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { /* handled below */ }
      const handler = handlers[call.name];
      const agentTool = !handler && agent?.registry.byName.get(call.name);
      let output; let ok = true;
      try {
        if (handler) output = await handler(args);
        else if (agentTool) output = await runAgentTool(agentTool, args);
        else output = { error: `Unknown tool ${call.name}` };
        if (output?.error) ok = false;
      } catch (error) {
        ok = false;
        // A ToolError is written for the owner to read; anything else is a bug and stays in the logs.
        output = error instanceof ToolError ? { error: error.message } : { error: 'That tool failed. Carry on without it.' };
        if (!(error instanceof ToolError)) log('warn', `tool ${call.name} failed: ${error.message}`);
      }
      return { call_id: call.call_id, name: call.name, ok, ms: Date.now() - started, output: JSON.stringify(output).slice(0, 6000) };
    }));
  };
}
