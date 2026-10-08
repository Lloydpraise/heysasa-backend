// All database access for Ask HeySasa, kept in one place so the orchestrator can be tested with a fake.
// Uses the service-key client: every function takes the business id and scopes by it.

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

const SKILL_CACHE_MS = 60_000;

export function createStore(supabase) {
  let platformCache = { at: 0, rows: [] };

  return {
    // ── business context ──
    async loadBusiness(businessId) {
      return must(await supabase.from('businesses').select('business_id, name, currency').eq('business_id', businessId).maybeSingle(), 'business');
    },
    async loadPreferences(businessId) {
      return must(await supabase.from('ba_preferences').select('*').eq('business_id', businessId).maybeSingle(), 'preferences');
    },
    async loadPersona(businessId) {
      const rows = must(await supabase.from('persona_packs').select('pack').eq('business_id', businessId).eq('is_active', true).order('version', { ascending: false }).limit(1), 'persona pack');
      return rows?.[0]?.pack ?? null;
    },
    async loadSkills(businessId) {
      if (Date.now() - platformCache.at > SKILL_CACHE_MS) {
        const rows = must(await supabase.from('ba_default_skills').select('key, title, when_to_use, instructions, sort_order').eq('enabled', true).order('sort_order'), 'platform skills');
        platformCache = { at: Date.now(), rows: rows ?? [] };
      }
      const own = must(await supabase.from('ba_skills').select('key, title, when_to_use, instructions').eq('business_id', businessId).eq('enabled', true), 'business skills');
      const platformKeys = new Set(platformCache.rows.map((s) => s.key));
      // A business skill can never replace a platform skill.
      return [...platformCache.rows, ...(own ?? []).filter((s) => !platformKeys.has(s.key))];
    },

    // ── conversations ──
    async getConversation(id, businessId) {
      return must(await supabase.from('ba_conversations').select('*').eq('id', id).eq('business_id', businessId).maybeSingle(), 'conversation');
    },
    async createConversation(row) {
      return must(await supabase.from('ba_conversations').insert(row).select('*').single(), 'new conversation');
    },
    async updateConversation(id, businessId, patch) {
      must(await supabase.from('ba_conversations').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('business_id', businessId), 'update conversation');
    },
    async listConversations(businessId, { contextKey = null, surface = null, limit = 30 } = {}) {
      let q = supabase.from('ba_conversations').select('id, surface, context_key, title, message_count, created_at, updated_at').eq('business_id', businessId);
      if (contextKey) q = q.eq('context_key', contextKey);
      if (surface) q = q.eq('surface', surface);
      return must(await q.order('updated_at', { ascending: false }).limit(Math.min(limit, 100)), 'conversations') ?? [];
    },
    async listMessages(conversationId, businessId, limit = 200) {
      const rows = must(await supabase.from('ba_messages').select('id, role, content, draft, approved, approved_at, action_ids, created_at')
        .eq('conversation_id', conversationId).eq('business_id', businessId).order('created_at', { ascending: false }).limit(limit), 'messages');
      return (rows ?? []).reverse();
    },
    async insertMessage(row) {
      return must(await supabase.from('ba_messages').insert(row).select('id, created_at').single(), 'save message');
    },
    async approveMessage(id, businessId, finalText) {
      return must(await supabase.from('ba_messages').update({ approved: true, approved_at: new Date().toISOString(), final_text: finalText ?? null })
        .eq('id', id).eq('business_id', businessId).eq('role', 'assistant').select('id').maybeSingle(), 'approve message');
    },

    // ── notes ──
    async listNotes(businessId) {
      return must(await supabase.from('ba_notes').select('id, text, pinned, source, created_at, updated_at').eq('business_id', businessId).order('updated_at', { ascending: false }).limit(500), 'notes') ?? [];
    },
    async pinnedNotes(businessId) {
      return must(await supabase.from('ba_notes').select('id, text, last_used_at, updated_at').eq('business_id', businessId).eq('pinned', true).order('updated_at', { ascending: false }).limit(60), 'pinned notes') ?? [];
    },
    async getNote(id, businessId) {
      return must(await supabase.from('ba_notes').select('id, text, pinned').eq('id', id).eq('business_id', businessId).maybeSingle(), 'note');
    },
    async insertNote(row) {
      return must(await supabase.from('ba_notes').insert(row).select('id').single(), 'save note');
    },
    async updateNote(id, businessId, patch) {
      return must(await supabase.from('ba_notes').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('business_id', businessId).select('id').maybeSingle(), 'update note');
    },
    async deleteNote(id, businessId) {
      return must(await supabase.from('ba_notes').delete().eq('id', id).eq('business_id', businessId).select('id').maybeSingle(), 'delete note');
    },
    async matchNotes(businessId, embedding, count, threshold) {
      return must(await supabase.rpc('ba_match_notes', { p_business_id: businessId, p_embedding: embedding, p_count: count, p_threshold: threshold }), 'recall notes') ?? [];
    },
    async recentNotes(businessId, count) {
      return must(await supabase.from('ba_notes').select('id, text, pinned, updated_at').eq('business_id', businessId).order('updated_at', { ascending: false }).limit(count), 'recent notes') ?? [];
    },
    async touchNotes(ids) {
      if (!ids.length) return;
      // Best effort: usage counts only help tidy the pin budget.
      await supabase.rpc('ba_touch_notes', { p_ids: ids }).then(() => {}, () => {});
    },

    // ── preferences ──
    async savePreferences(businessId, prefs) {
      return must(await supabase.from('ba_preferences').upsert({ business_id: businessId, ...prefs, updated_at: new Date().toISOString() }).select('*').single(), 'save preferences');
    },

    // ── actions: the approval queue and the activity log ──
    async insertAction(row) {
      return must(await supabase.from('ba_actions').insert(row).select('*').single(), 'save action');
    },
    async getAction(id, businessId) {
      return must(await supabase.from('ba_actions').select('*').eq('id', id).eq('business_id', businessId).maybeSingle(), 'action');
    },
    // Moves an action from one status to another ONLY if it is still in `from`. Returns the row, or null if someone
    // else got there first (a double tap, two tabs): this is what makes approve safe to press twice.
    async transitionAction(id, businessId, from, patch) {
      const fromList = Array.isArray(from) ? from : [from];
      return must(await supabase.from('ba_actions').update(patch).eq('id', id).eq('business_id', businessId).in('status', fromList).select('*').maybeSingle(), 'update action');
    },
    async patchAction(id, businessId, patch) {
      return must(await supabase.from('ba_actions').update(patch).eq('id', id).eq('business_id', businessId).select('*').maybeSingle(), 'patch action');
    },
    async listActionsByIds(ids, businessId) {
      if (!ids?.length) return [];
      return must(await supabase.from('ba_actions').select('*').in('id', ids).eq('business_id', businessId), 'actions') ?? [];
    },
    async listPendingActions(businessId, { limit = 50 } = {}) {
      return must(await supabase.from('ba_actions').select('*').eq('business_id', businessId).eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(limit), 'pending actions') ?? [];
    },
    // Activity log: finished things only (done, failed, undone, rejected), newest first, paged by `before` (ISO time).
    async listActivity(businessId, { limit = 30, before = null, area = null } = {}) {
      let q = supabase.from('ba_actions')
        .select('id, type, area, risk, title, status, approval, summary, undoable, created_at, executed_at, decided_at, undone_at, conversation_id, error, result')
        .eq('business_id', businessId).in('status', ['done', 'failed', 'undone', 'rejected']);
      if (area) q = q.eq('area', area);
      if (before) q = q.lt('created_at', before);
      return must(await q.order('created_at', { ascending: false }).limit(Math.min(limit, 100)), 'activity') ?? [];
    },
    async expireStaleActions(businessId) {
      must(await supabase.from('ba_actions').update({ status: 'expired', decided_at: new Date().toISOString() })
        .eq('business_id', businessId).eq('status', 'pending').lt('expires_at', new Date().toISOString()), 'expire actions');
    },
    // A server restart mid-action would leave a row on 'running' forever; after 10 minutes it is marked failed.
    async failStuckActions(businessId) {
      const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
      must(await supabase.from('ba_actions').update({ status: 'failed', error: 'Interrupted before it finished.', summary: 'This was interrupted before it finished. Please check and try again.' })
        .eq('business_id', businessId).eq('status', 'running').lt('decided_at', cutoff), 'fail stuck actions');
    },
    async listActionPrefs(businessId) {
      return must(await supabase.from('ba_action_prefs').select('action_type, always_allow').eq('business_id', businessId), 'action prefs') ?? [];
    },
    async setActionPref(businessId, actionType, alwaysAllow) {
      return must(await supabase.from('ba_action_prefs').upsert({ business_id: businessId, action_type: actionType, always_allow: !!alwaysAllow, updated_at: new Date().toISOString() }).select('action_type, always_allow').single(), 'save action pref');
    },

    // ── catalog ──
    async matchProducts(businessId, embedding, query) {
      return must(await supabase.rpc('match_products_v8', {
        query_embedding: embedding, match_threshold: 0.3, match_count: 5, filter_business_id: businessId, query_text: query,
      }), 'product search') ?? [];
    },
  };
}
