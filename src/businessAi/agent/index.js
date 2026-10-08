// Puts the agent together: the tool registry, the action engine, and the context every tool receives.
import { createClient } from '@supabase/supabase-js';
import { buildRegistry } from './registry.js';
import { createActionEngine } from './engine.js';
import { createSearchCache } from './helpers.js';

// What the dashboard is shown for an action card or an Activity row. Never includes raw params.
export function toPublicAction(row) {
  if (!row) return null;
  return {
    id: row.id, type: row.type, area: row.area, risk: row.risk, title: row.title, status: row.status, preview: row.preview ?? {},
    summary: row.summary ?? null, undoable: Boolean(row.undoable), approval: row.approval ?? null, conversation_id: row.conversation_id ?? null,
    created_at: row.created_at, executed_at: row.executed_at ?? null, expires_at: row.expires_at ?? null, can_always_allow: row.risk === 'normal',
  };
}

export function createAgent({ supabase, store, canAfford, log = () => {}, now = () => new Date(), env = process.env, fetchImpl = (...a) => fetch(...a) }) {
  const registry = buildRegistry();
  const engine = createActionEngine({ store, registry, now, log });
  const searches = createSearchCache();

  // `req` carries who is asking: { businessId, userId, token, conversationId, emit }.
  function makeCtx(req) {
    const baseUrl = `http://127.0.0.1:${env.PORT || 3000}`;
    return {
      db: supabase, businessId: req.businessId, userId: req.userId ?? null, conversationId: req.conversationId ?? null,
      now, searches, emit: req.emit ?? (() => {}), log,
      canAfford: () => canAfford(req.businessId),
      // Runs a database function AS the owner when we can, because some were written for the browser and check who is signed in.
      async userRpc(name, args) {
        const anon = env.SUPABASE_ANON_KEY?.trim();
        if (anon && req.token && env.SUPABASE_URL) {
          const client = createClient(env.SUPABASE_URL.trim(), anon, { global: { headers: { Authorization: `Bearer ${req.token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
          return client.rpc(name, args);
        }
        return supabase.rpc(name, args);
      },
      // Calls this same backend's own routes with the owner's login, so analysis and discovery start exactly as if the owner pressed the button.
      async selfCall(method, path, body) {
        try {
          const res = await fetchImpl(`${baseUrl}${path}`, {
            method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.token}`, 'X-Business-Id': req.businessId },
            body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
          });
          return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
        } catch (error) {
          log('warn', `self call ${path} failed: ${error.message}`);
          return { ok: false, status: 0, json: {} };
        }
      },
    };
  }

  return { registry, engine, searches, makeCtx, toPublicAction };
}
