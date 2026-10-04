// Database access for the chat AI orchestrator. Kept separate so the orchestrator can be tested with a fake.

const BUSINESS_COLUMNS = 'business_id, chat_ai_enabled, chat_ai_daily_cap, chat_ai_model, chat_ai_human_pause_minutes, chat_ai_settings, subscription_active, timezone';
const BUSINESS_CACHE_MS = 15_000;

export function createStore(supabase) {
  const businessCache = new Map();

  return {
    async loadBusiness(businessId) {
      const hit = businessCache.get(businessId);
      if (hit && Date.now() - hit.at < BUSINESS_CACHE_MS) return hit.row;
      const { data, error } = await supabase.from('businesses').select(BUSINESS_COLUMNS).eq('business_id', businessId).maybeSingle();
      if (error) throw error;
      businessCache.set(businessId, { at: Date.now(), row: data });
      return data;
    },

    async loadChat(conversationId, contactId) {
      const [convo, contact, owner] = await Promise.all([
        supabase.from('conversations').select('id, ai_enabled, handover_flag, handover_resolved_at, is_business_chat').eq('id', conversationId).maybeSingle(),
        supabase.from('contacts').select('id, lead_type, contact_role').eq('id', contactId).maybeSingle(),
        // Only genuine owner messages count. Messages the AI or the follow-up engine sent carry their own agent_role.
        supabase.from('messages').select('created_at').eq('conversation_id', conversationId).eq('direction', 'out').eq('agent_role', 'human')
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      for (const r of [convo, contact, owner]) if (r.error) throw r.error;
      return { conversation: convo.data, contact: contact.data, lastOwnerMessageAt: owner.data?.created_at || null };
    },

    async acquireLock(conversationId, seconds = 120) {
      const { data, error } = await supabase.rpc('chat_ai_acquire_lock', { p_conversation_id: conversationId, p_seconds: seconds });
      if (error) throw error;
      return data || null;
    },

    async releaseLock(conversationId, token) {
      const { error } = await supabase.rpc('chat_ai_release_lock', { p_conversation_id: conversationId, p_token: token });
      if (error) throw error;
    },

    async claimSlot(businessId, conversationId, cap) {
      const { data, error } = await supabase.rpc('chat_ai_claim_slot', { p_business_id: businessId, p_conversation_id: conversationId, p_cap: cap });
      if (error) throw error;
      return data;
    },

    async logTurn(row) {
      const { error } = await supabase.from('chat_ai_turns').insert(row);
      if (error) throw error;
    },
  };
}
