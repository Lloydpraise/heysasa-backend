// In-memory stand-ins used by the tests.

export function fakeStore(over = {}) {
  const db = { conversations: [], messages: [], notes: [], actions: [], actionPrefs: [], prefs: null, calls: { persona: 0, products: 0 }, seq: 0 };
  const id = () => `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
  const skills = [
    { key: 'copywriting', title: 'Copywriting', when_to_use: 'writing copy', instructions: 'COPY RULES' },
    { key: 'campaign_message_writing', title: 'Campaign messages', when_to_use: 'campaigns', instructions: 'CAMPAIGN RULES' },
    { key: 'message_safety', title: 'Message safety', when_to_use: 'safety', instructions: 'SAFETY RULES' },
    { key: 'flow_instructions_writing', title: 'Chat AI flows', when_to_use: 'flows', instructions: 'FLOW RULES' },
    { key: 'owner_discovery', title: 'Learning your business', when_to_use: 'discovery', instructions: 'DISCOVERY RULES' },
    { key: 'offers_and_promotions', title: 'Offers', when_to_use: 'offers', instructions: 'OFFER RULES' },
  ];
  const store = {
    db,
    loadBusiness: async (b) => ({ business_id: b, name: 'Kitchen & All', currency: 'KES' }),
    loadPreferences: async () => db.prefs,
    loadPersona: async () => { db.calls.persona++; return { persona: 'Warm, short, uses "karibu".', objection_playbook: 'Offer a smaller size.' }; },
    loadSkills: async () => skills,
    getConversation: async (cid, b) => db.conversations.find((c) => c.id === cid && c.business_id === b) ?? null,
    createConversation: async (row) => { const c = { id: id(), loaded_skills: [], message_count: 0, ...row }; db.conversations.push(c); return c; },
    updateConversation: async (cid, b, patch) => { Object.assign(db.conversations.find((c) => c.id === cid && c.business_id === b), patch); },
    listConversations: async (b) => db.conversations.filter((c) => c.business_id === b),
    listMessages: async (cid) => db.messages.filter((m) => m.conversation_id === cid),
    insertMessage: async (row) => { const m = { id: id(), created_at: new Date().toISOString(), approved: false, ...row }; db.messages.push(m); return m; },
    approveMessage: async (mid, b, finalText) => { const m = db.messages.find((x) => x.id === mid && x.business_id === b && x.role === 'assistant'); if (!m) return null; m.approved = true; m.final_text = finalText; return m; },
    listNotes: async (b) => db.notes.filter((n) => n.business_id === b),
    pinnedNotes: async (b) => db.notes.filter((n) => n.business_id === b && n.pinned),
    getNote: async (nid, b) => db.notes.find((n) => n.id === nid && n.business_id === b) ?? null,
    insertNote: async (row) => { const n = { id: id(), updated_at: new Date(++db.seq * 1000).toISOString(), ...row }; db.notes.push(n); return n; },
    updateNote: async (nid, b, patch) => { const n = db.notes.find((x) => x.id === nid && x.business_id === b); if (!n) return null; Object.assign(n, patch, { updated_at: new Date(++db.seq * 1000).toISOString() }); return n; },
    deleteNote: async (nid, b) => { const i = db.notes.findIndex((x) => x.id === nid && x.business_id === b); if (i < 0) return null; return db.notes.splice(i, 1)[0]; },
    // cosine similarity over the tiny fake vectors
    matchNotes: async (b, vec, count, threshold) => db.notes
      .filter((n) => n.business_id === b && n.embedding)
      .map((n) => ({ ...n, similarity: cosine(n.embedding, vec) }))
      .filter((n) => n.similarity > threshold)
      .sort((a, c) => c.similarity - a.similarity).slice(0, count),
    recentNotes: async (b, count) => db.notes.filter((n) => n.business_id === b).slice(-count),
    touchNotes: async () => {},
    savePreferences: async (b, prefs) => { db.prefs = { business_id: b, ...prefs }; return db.prefs; },
    matchProducts: async () => { db.calls.products++; return [{ title: 'Non-stick pan 28cm', price: 2500, category: 'Cookware', description_short: 'Heavy-bottom pan.' }]; },
    // actions (approval queue + activity log)
    insertAction: async (row) => { const a = { id: id(), created_at: new Date(++db.seq * 1000).toISOString(), status: 'pending', expires_at: new Date(Date.now() + 86_400_000).toISOString(), undoable: false, ...row }; db.actions.push(a); return { ...a }; },
    getAction: async (aid, b) => { const a = db.actions.find((x) => x.id === aid && x.business_id === b); return a ? { ...a } : null; },
    transitionAction: async (aid, b, from, patch) => { const a = db.actions.find((x) => x.id === aid && x.business_id === b && [].concat(from).includes(x.status)); if (!a) return null; Object.assign(a, patch); return { ...a }; },
    patchAction: async (aid, b, patch) => { const a = db.actions.find((x) => x.id === aid && x.business_id === b); if (!a) return null; Object.assign(a, patch); return { ...a }; },
    listActionsByIds: async (ids, b) => db.actions.filter((a) => ids.includes(a.id) && a.business_id === b).map((a) => ({ ...a })),
    listPendingActions: async (b) => db.actions.filter((a) => a.business_id === b && a.status === 'pending').map((a) => ({ ...a })),
    listActivity: async (b, { limit = 30, before = null, area = null } = {}) => db.actions
      .filter((a) => a.business_id === b && ['done', 'failed', 'undone', 'rejected'].includes(a.status) && (!area || a.area === area) && (!before || a.created_at < before))
      .sort((x, y) => (x.created_at < y.created_at ? 1 : -1)).slice(0, limit).map((a) => ({ ...a })),
    expireStaleActions: async (b) => { for (const a of db.actions) if (a.business_id === b && a.status === 'pending' && a.expires_at < new Date().toISOString()) a.status = 'expired'; },
    failStuckActions: async () => {},
    listActionPrefs: async (b) => db.actionPrefs.filter((p) => p.business_id === b),
    setActionPref: async (b, type, on) => { const p = db.actionPrefs.find((x) => x.business_id === b && x.action_type === type); if (p) p.always_allow = on; else db.actionPrefs.push({ business_id: b, action_type: type, always_allow: on }); return { action_type: type, always_allow: !!on }; },
    ...over,
  };
  return store;
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Fake embedding: a 4-number vector keyed on a few words, so similar notes land close together.
export const WORDS = ['pan', 'delivery', 'swahili', 'price'];
export const fakeEmbed = async (text) => {
  const t = String(text).toLowerCase();
  const v = WORDS.map((w) => (t.includes(w) ? 1 : 0));
  return v.some(Boolean) ? v : [0.01, 0.01, 0.01, 0.01];
};

// A scripted model: each entry is either {text} or {calls:[{name, args}]}. Streams text in small chunks.
export function scriptedModel(script) {
  const calls = [];
  const fn = async (body, onDelta = () => {}) => {
    calls.push(body);
    const step = script[calls.length - 1];
    if (!step) throw new Error('model script ran out');
    if (step.calls) {
      return {
        id: `r${calls.length}`, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10 },
        output: step.calls.map((c, i) => ({ type: 'function_call', call_id: `c${calls.length}-${i}`, name: c.name, arguments: JSON.stringify(c.args ?? {}) })),
      };
    }
    for (let i = 0; i < step.text.length; i += 7) onDelta(step.text.slice(i, i + 7));
    return {
      id: `r${calls.length}`, usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 40 }, output_tokens: 30 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: step.text }] }],
    };
  };
  fn.calls = calls;
  return fn;
}
