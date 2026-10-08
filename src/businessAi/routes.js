import express from 'express';
import { UserFacingError } from './orchestrator.js';
import { createRateLimiter } from './rateLimit.js';
import { ActionError } from './agent/engine.js';

const LANGUAGES = ['auto', 'english', 'swahili', 'mixed'];
const EMOJI = ['none', 'light', 'normal'];
const LENGTHS = ['short', 'medium'];

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

// `auth` (the business-ownership middleware) is passed in, so tests need no Supabase.
export function createAssistantRouter({ store, notes, handleChat, skillsForBusiness, auth, agent = null, limiter = createRateLimiter(), log = () => {} }) {
  const router = express.Router();
  router.use(auth);

  const tokenOf = (req) => (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null);
  const ctxFor = (req) => agent.makeCtx({ businessId: req.businessId, userId: req.userId, token: tokenOf(req) });

  const logUnexpectedError = (message, error, metadata = {}) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const details = {
      ...metadata.details,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
    const entry = { ...metadata, details };
    console.error(`[Ask HeySasa] ${message}: ${errorMessage}`, {
      businessId: metadata.businessId ?? null,
      durationMs: metadata.durationMs ?? null,
      details,
    });
    log('error', `${message}: ${errorMessage}`, entry);
  };

  const fail = (res, error, metadata = {}) => {
    if (error instanceof ActionError) {
      const status = error.code === 'action_not_found' ? 404 : ['unknown_action', 'critical'].includes(error.code) ? 400 : 409;
      return res.status(status).json({ ok: false, error: error.code, message: error.message });
    }
    if (error instanceof UserFacingError) {
      const status = error.code === 'out_of_balance' ? 402 : error.code === 'busy' ? 409 : error.code === 'conversation_not_found' ? 404 : 400;
      return res.status(status).json({ ok: false, error: error.code, message: error.message });
    }
    logUnexpectedError('assistant route failed', error, metadata);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Something went wrong. Please try again.' });
  };

  // ── Chat (Server-Sent Events) ──────────────────────────────────────────────
  router.post('/chat', async (req, res) => {
    const requestStartedAt = Date.now();
    const body = req.body ?? {};
    const check = limiter(req.businessId);
    if (!check.ok) return res.status(429).json({ ok: false, error: 'slow_down', message: 'You are going fast. Try again in a minute.', retry_after: check.retryAfterSec });
    if (body.conversation_id && !isUuid(body.conversation_id)) return res.status(400).json({ ok: false, error: 'bad_conversation_id' });

    let started = false;
    const send = (event) => {
      if (res.writableEnded) return;
      if (!started) {
        started = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => { if (started && !res.writableEnded) res.write(': keep-alive\n\n'); }, 15_000);
    res.on('close', () => clearInterval(heartbeat));

    try {
      await handleChat({
        businessId: req.businessId, userId: req.userId, conversationId: body.conversation_id || null,
        surface: body.surface, contextKey: body.context_key, context: body.context, message: body.message,
        currentText: body.current_text, retry: body.retry === true, token: tokenOf(req),
      }, send);
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    } catch (error) {
      clearInterval(heartbeat);
      if (!started) return fail(res, error, {
        event: 'assistant.chat_failed',
        businessId: req.businessId,
        durationMs: Date.now() - requestStartedAt,
        details: { surface: body.surface ?? 'general' },
      });
      const friendly = error instanceof UserFacingError ? error.message : 'Something went wrong. Please try again.';
      if (!(error instanceof UserFacingError)) logUnexpectedError('assistant chat failed', error, {
        event: 'assistant.chat_failed',
        businessId: req.businessId,
        durationMs: Date.now() - requestStartedAt,
        details: { surface: body.surface ?? 'general' },
      });
      send({ type: 'error', message: friendly });
      return res.end();
    }
    return undefined;
  });

  // ── Conversations ──────────────────────────────────────────────────────────
  router.get('/conversations', async (req, res) => {
    try {
      const rows = await store.listConversations(req.businessId, {
        contextKey: typeof req.query.context_key === 'string' ? req.query.context_key : null,
        surface: typeof req.query.surface === 'string' ? req.query.surface : null,
        limit: Number(req.query.limit) || 30,
      });
      res.json({ ok: true, conversations: rows });
    } catch (error) { fail(res, error); }
  });

  router.get('/conversations/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_conversation_id' });
      const conversation = await store.getConversation(req.params.id, req.businessId);
      if (!conversation) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
      const messages = await store.listMessages(conversation.id, req.businessId);
      const actionIds = messages.flatMap((m) => m.action_ids ?? []);
      const actions = agent && actionIds.length ? (await store.listActionsByIds(actionIds, req.businessId)).map(agent.toPublicAction) : [];
      return res.json({ ok: true, actions, conversation: { id: conversation.id, surface: conversation.surface, context_key: conversation.context_key, context: conversation.context, title: conversation.title }, messages });
    } catch (error) { return fail(res, error); }
  });

  router.post('/messages/:id/approve', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_message_id' });
      const finalText = typeof req.body?.final_text === 'string' ? req.body.final_text.slice(0, 8000) : null;
      const row = await store.approveMessage(req.params.id, req.businessId, finalText);
      if (!row) return res.status(404).json({ ok: false, error: 'message_not_found' });
      return res.json({ ok: true });
    } catch (error) { return fail(res, error); }
  });

  // ── Notes (what Ask HeySasa remembers) ─────────────────────────────────────
  router.get('/notes', async (req, res) => {
    try { res.json({ ok: true, notes: await store.listNotes(req.businessId) }); } catch (error) { fail(res, error); }
  });

  router.post('/notes', async (req, res) => {
    try {
      const result = await notes.save({ businessId: req.businessId, text: req.body?.text, pinned: req.body?.pinned === true, source: 'owner' });
      if (result.status === 'ignored') return res.status(400).json({ ok: false, error: 'note_too_short' });
      return res.json({ ok: true, ...result });
    } catch (error) { return fail(res, error); }
  });

  router.patch('/notes/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_note_id' });
      const result = await notes.edit({ businessId: req.businessId, id: req.params.id, text: req.body?.text, pinned: req.body?.pinned });
      if (result.status === 'not_found') return res.status(404).json({ ok: false, error: 'note_not_found' });
      if (result.status === 'invalid') return res.status(400).json({ ok: false, error: 'note_too_short' });
      return res.json({ ok: true });
    } catch (error) { return fail(res, error); }
  });

  router.delete('/notes/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_note_id' });
      const row = await store.deleteNote(req.params.id, req.businessId);
      return row ? res.json({ ok: true }) : res.status(404).json({ ok: false, error: 'note_not_found' });
    } catch (error) { return fail(res, error); }
  });

  // ── Preferences ────────────────────────────────────────────────────────────
  router.get('/preferences', async (req, res) => {
    try {
      const prefs = await store.loadPreferences(req.businessId);
      res.json({ ok: true, preferences: prefs ?? { personalization: '', language: 'auto', emoji_level: 'light', message_length: 'short' } });
    } catch (error) { fail(res, error); }
  });

  router.put('/preferences', async (req, res) => {
    try {
      const b = req.body ?? {};
      const personalization = typeof b.personalization === 'string' ? b.personalization.trim() : '';
      if (personalization.length > 1500) return res.status(400).json({ ok: false, error: 'personalization_too_long' });
      if (!LANGUAGES.includes(b.language) || !EMOJI.includes(b.emoji_level) || !LENGTHS.includes(b.message_length)) return res.status(400).json({ ok: false, error: 'bad_preferences' });
      const saved = await store.savePreferences(req.businessId, { personalization, language: b.language, emoji_level: b.emoji_level, message_length: b.message_length });
      res.json({ ok: true, preferences: saved });
    } catch (error) { fail(res, error); }
  });


  // ── Actions: approve, refuse, undo, the Activity log, and "always allow" ───
  if (agent) {
    router.get('/actions/pending', async (req, res) => {
      try {
        await agent.engine.sweep(req.businessId);
        const rows = await store.listPendingActions(req.businessId);
        res.json({ ok: true, actions: rows.map(agent.toPublicAction) });
      } catch (error) { fail(res, error); }
    });

    const actionRoute = (name, handler) => router.post(`/actions/:id/${name}`, async (req, res) => {
      try {
        if (!isUuid(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_action_id' });
        const out = await handler(req);
        return res.json({ ok: true, action: agent.toPublicAction(out.action), already: out.already === true });
      } catch (error) { return fail(res, error); }
    });

    actionRoute('approve', async (req) => {
      // "Always allow" is chosen on the same tap; it is only ever stored for actions that are not critical.
      if (req.body?.always_allow === true) {
        const row = await store.getAction(req.params.id, req.businessId);
        if (row) await agent.engine.setAlwaysAllow(req.businessId, row.type, true);
      }
      return agent.engine.approve(ctxFor(req), req.params.id);
    });
    actionRoute('reject', (req) => agent.engine.reject(ctxFor(req), req.params.id));
    actionRoute('undo', (req) => agent.engine.undo(ctxFor(req), req.params.id));

    router.get('/activity', async (req, res) => {
      try {
        await agent.engine.sweep(req.businessId);
        const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
        const rows = await store.listActivity(req.businessId, { limit: Number(req.query.limit) || 30, before, area: typeof req.query.area === 'string' ? req.query.area : null });
        res.json({ ok: true, activity: rows.map((r) => ({ ...agent.toPublicAction({ ...r, params: undefined }), result: undefined })), next_before: rows.length ? rows[rows.length - 1].created_at : null });
      } catch (error) { fail(res, error); }
    });

    router.get('/action-prefs', async (req, res) => {
      try {
        const prefs = new Map((await store.listActionPrefs(req.businessId)).map((p) => [p.action_type, p.always_allow]));
        res.json({ ok: true, actions: agent.registry.allowable().map((a) => ({ ...a, always_allow: !a.critical && prefs.get(a.type) === true })) });
      } catch (error) { fail(res, error); }
    });

    router.put('/action-prefs', async (req, res) => {
      try {
        const type = req.body?.type;
        if (typeof type !== 'string') return res.status(400).json({ ok: false, error: 'bad_type' });
        const saved = await agent.engine.setAlwaysAllow(req.businessId, type, req.body?.always_allow === true);
        return res.json({ ok: true, type: saved.action_type, always_allow: saved.always_allow });
      } catch (error) { return fail(res, error); }
    });
  }

  // ── Skills: names only. Owners can see what Ask HeySasa can do, never how. ──
  router.get('/skills', async (req, res) => {
    try {
      const skills = await skillsForBusiness(req.businessId);
      res.json({ ok: true, skills: skills.map((s) => ({ key: s.key, title: s.title })) });
    } catch (error) { fail(res, error); }
  });

  return router;
}
