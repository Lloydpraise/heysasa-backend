// The database as one WhatsApp account sees it (ACCOUNTS.md). Ask HeySasa's tools run on the service-role client,
// so without this a question asked while one account is selected would read every account of the business.
//
// scopedDb(db, scope) wraps the client: on an account-scoped table (or view) every select / update / delete gets
// forAccount (the selected account; a member with several accounts and none selected sees only theirs), the
// shared catalog tables get forAccountOrShared (the account's rows plus business-level ones), and inserts / upserts
// are stamped with the selected account_id. Everything else (businesses, ba_*, rpc, storage) passes through.
// No scope, or an owner/admin business-wide view, changes nothing.
import { forAccount, forAccountOrShared } from '../../middleware/accessScope.js';

export const ACCOUNT_TABLES = new Set([
  'contacts', 'conversations', 'messages', 'customer_profiles', 'customer_notes', 'contact_activity_patterns',
  'conversation_enrichment', 'sentiment_snapshots', 'lead_ai_state', 'lead_calls', 'lead_meeting_reminders',
  'lead_meetings', 'lead_stage_changes', 'lead_stage_requests', 'lead_tasks', 'lead_timeline',
  'follow_up_queue', 'follow_up_send_events', 'follow_up_outcomes', 'followup_ai_turns', 'followup_billing_events',
  'followup_nudge_log', 'followup_ai_skills', 'campaigns', 'campaign_enrollments', 'lists', 'segmentation_rules',
  'auto_campaign_configs', 'ad_attributions', 'ad_playbooks', 'ad_playbook_items', 'chat_flows', 'chat_ai_skills',
  'chat_ai_turns', 'chat_ai_outbox', 'chat_ai_daily_chats', 'chat_test_feedback', 'handoff_events',
  'product_mentions', 'conversions', 'daily_send_counters', 'enrichment_runs', 'whatsapp_sessions', 'business_setup',
  // views that carry account_id
  'v_ad_leaderboard', 'v_assistant_leads', 'v_auto_campaigns', 'v_campaign_summary', 'v_lead_summary', 'v_list_summary',
]);

// The business catalog: business-level rows (account_id null) are shared by every account.
export const SHARED_TABLES = new Set(['products', 'persona_packs', 'knowledge_sources', 'knowledge_chunks', 'followup_materials', 'chat_ai_tools']);

const VIEWS = new Set([...ACCOUNT_TABLES].filter((t) => t.startsWith('v_')));

export function scopedDb(db, scope) {
  if (!scope || (scope.isAdmin && !scope.accountId)) return db;
  const stamp = (rows) => {
    if (!scope.accountId) return rows;
    const one = (row) => (row && typeof row === 'object' && row.account_id === undefined ? { ...row, account_id: scope.accountId } : row);
    return Array.isArray(rows) ? rows.map(one) : one(rows);
  };
  const from = (table) => {
    const query = db.from(table);
    const shared = SHARED_TABLES.has(table);
    if (!shared && !ACCOUNT_TABLES.has(table)) return query;
    const narrow = (builder) => (shared ? forAccountOrShared(builder, scope) : forAccount(builder, scope));
    return new Proxy(query, {
      get(target, prop) {
        if (prop === 'select' || prop === 'update' || prop === 'delete') return (...args) => narrow(target[prop](...args));
        if ((prop === 'insert' || prop === 'upsert') && !VIEWS.has(table)) return (rows, opts) => target[prop](stamp(rows), opts);
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'from') return from;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
