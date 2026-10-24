// Database access for the chat AI orchestrator. Kept separate so the orchestrator can be tested with a fake.

import { canAffordChatAi } from './billing.js';

const BUSINESS_COLUMNS = 'business_id, chat_ai_enabled, chat_ai_daily_cap, chat_ai_model, chat_ai_human_pause_minutes, chat_ai_settings, subscription_active, timezone';
const BUSINESS_CACHE_MS = 15_000;

// Account-scoped reads add the account when there is one (ACCOUNTS.md rule 5). A business from before accounts has none.
const forAccount = (query, accountId) => (accountId ? query.eq('account_id', accountId) : query);

export function createStore(supabase) {
  const businessCache = new Map();

  return {
    // The account a conversation belongs to, for callers that did not pass one.
    async accountIdFor(conversationId) {
      if (!conversationId) return null;
      const { data, error } = await supabase.from('conversations').select('account_id').eq('id', conversationId).maybeSingle();
      if (error) throw error;
      return data?.account_id ?? null;
    },

    // The chat AI settings this number runs with: the business defaults with the account's overrides laid over them
    // (account_settings), plus whether the account may operate at all (account_can_operate: false when suspended or closed).
    async loadBusiness(businessId, accountId = null) {
      const key = accountId || `business:${businessId}`;
      const hit = businessCache.get(key);
      if (hit && Date.now() - hit.at < BUSINESS_CACHE_MS) return hit.row;
      let row;
      if (accountId) {
        const [settings, operate] = await Promise.all([
          supabase.rpc('account_settings', { p_account_id: accountId }),
          supabase.rpc('account_can_operate', { p_account_id: accountId }),
        ]);
        if (settings.error) throw settings.error;
        if (operate.error) throw operate.error;
        // An account of another business is never used (the AI stays quiet, like the switch being off).
        row = settings.data && settings.data.business_id === businessId ? { ...settings.data, account_can_operate: operate.data !== false } : null;
      } else {
        const { data, error } = await supabase.from('businesses').select(BUSINESS_COLUMNS).eq('business_id', businessId).maybeSingle();
        if (error) throw error;
        row = data;
      }
      businessCache.set(key, { at: Date.now(), row });
      return row;
    },

    async loadChat(conversationId, contactId, accountId = null) {
      const [convo, contact, owner, aiReply] = await Promise.all([
        forAccount(supabase.from('conversations').select('id, ai_enabled, handover_flag, handover_resolved_at, is_business_chat').eq('id', conversationId), accountId).maybeSingle(),
        forAccount(supabase.from('contacts').select('id, lead_type, contact_role, is_ad_lead, ad_id, intent_score, lead_state').eq('id', contactId), accountId).maybeSingle(),
        // Only genuine owner messages count. Messages the AI or the follow-up engine sent carry their own agent_role.
        forAccount(supabase.from('messages').select('created_at').eq('conversation_id', conversationId).eq('direction', 'out').eq('agent_role', 'human'), accountId)
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
        // Has the AI already answered in this chat? Then the audience choice no longer applies to it (see audience.js).
        forAccount(supabase.from('chat_ai_turns').select('id').eq('conversation_id', conversationId).eq('mode', 'live').in('status', ['replied', 'handoff']), accountId).limit(1).maybeSingle(),
      ]);
      for (const r of [convo, contact, owner, aiReply]) if (r.error) throw r.error;
      return { conversation: convo.data, contact: contact.data, lastOwnerMessageAt: owner.data?.created_at || null, aiHasReplied: Boolean(aiReply.data) };
    },

    // Chat AI is billed per use, so it pauses when the wallet is empty (HeySasa's own business is never charged).
    async canAfford(businessId, accountId = null) {
      return canAffordChatAi(supabase, businessId, accountId);
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

    // Counts per WhatsApp number: the SQL function takes the account from the conversation.
    async claimSlot(businessId, conversationId, cap) {
      const { data, error } = await supabase.rpc('chat_ai_claim_slot', { p_business_id: businessId, p_conversation_id: conversationId, p_cap: cap });
      if (error) throw error;
      return data;
    },

    // The customer's newest message, if it arrived after `sinceIso` and nothing has been sent in reply yet.
    async unansweredInboundSince(conversationId, sinceIso, accountId = null) {
      const { data, error } = await forAccount(supabase.from('messages')
        .select('whatsapp_message_id, direction, type, content, created_at')
        .eq('conversation_id', conversationId).neq('type', 'reaction'), accountId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      if (!data || data.direction !== 'in' || !(data.created_at > sinceIso)) return null;
      return { keyId: data.whatsapp_message_id, text: data.content?.text || '', type: data.type };
    },

    async logTurn(row) {
      const { error } = await supabase.from('chat_ai_turns').insert(row);
      if (error) throw error;
    },
  };
}
