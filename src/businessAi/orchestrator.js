// One owner message, start to finish. Everything outside the model (database, OpenAI, billing, clock) is passed in.
//
//   emit({type, ...}) events: conversation, status, reset, reply, draft_start, done, error
//
// Order of work:
//   gates (valid input, wallet) -> load everything in parallel -> save the owner's message -> first-turn note recall
//   -> model loop (streaming) -> save the reply (+ draft) -> done

import { SURFACES, isSurface, sanitizeContext } from './surfaces.js';
import { buildInput, buildInstructions } from './prompt.js';
import { createStreamParser, parseModelOutput } from './output.js';
import { TOOL_DEFS, TOOL_STATUS, createToolRunner } from './tools.js';
import { runLoop } from './loop.js';

export const LIMITS = { message: 4000, currentText: 4000, history: 24, firstTurnRecall: 4 };

const isReasoningModel = (model) => /^(gpt-5|o\d)/.test(model);

export class UserFacingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function createOrchestrator({ store, notes, embed, callModel, canAfford, billModel, model = 'gpt-5-mini', effort = 'low', now = () => new Date(), log = () => {} }) {
  const inFlight = new Set();

  return async function handleChat(input, emit = () => {}) {
    const started = Date.now();
    const { businessId, userId = null } = input;
    const message = String(input.message ?? '').trim();
    const currentText = String(input.currentText ?? '').trim().slice(0, LIMITS.currentText);

    if (!message) throw new UserFacingError('empty_message', 'Write something first.');
    if (message.length > LIMITS.message) throw new UserFacingError('message_too_long', 'That message is too long. Try a shorter one.');
    const surface = isSurface(input.surface) ? input.surface : 'general';
    const def = SURFACES[surface];

    if (!(await canAfford(businessId))) {
      throw new UserFacingError('out_of_balance', 'Your balance is empty, so Ask HeySasa is paused. Top up to keep going.');
    }

    // Conversation: resume the given one (it must belong to this business) or start a new one.
    let conversation = null;
    if (input.conversationId) {
      conversation = await store.getConversation(input.conversationId, businessId);
      if (!conversation) throw new UserFacingError('conversation_not_found', 'That conversation was not found.');
    }
    const lockKey = conversation?.id ?? `new:${businessId}:${input.contextKey ?? ''}`;
    if (inFlight.has(lockKey)) throw new UserFacingError('busy', 'Still working on your last message.');
    inFlight.add(lockKey);

    try {
      const [business, preferences, skills, pinned, persona] = await Promise.all([
        store.loadBusiness(businessId),
        store.loadPreferences(businessId),
        store.loadSkills(businessId),
        notes.pinnedForPrompt(businessId),
        def.audience === 'customer' ? store.loadPersona(businessId) : Promise.resolve(null),
      ]);
      if (!business) throw new UserFacingError('business_not_found', 'Business not found.');

      if (!conversation) {
        conversation = await store.createConversation({
          business_id: businessId, user_id: userId, surface, context_key: input.contextKey ? String(input.contextKey).slice(0, 200) : null,
          context: sanitizeContext(input.context), title: message.slice(0, 60),
        });
      } else if (input.context) {
        // The box may have changed since last time (another step, edited text): keep the newest context.
        conversation.context = sanitizeContext(input.context);
      }
      emit({ type: 'conversation', conversation_id: conversation.id });

      const history = await store.listMessages(conversation.id, businessId, LIMITS.history);
      const firstTurn = !history.some((m) => m.role === 'assistant');
      if (!input.retry) await store.insertMessage({ conversation_id: conversation.id, business_id: businessId, role: 'user', content: message });
      const turnHistory = input.retry ? history : [...history, { role: 'user', content: message }];

      // First turn only: look up what we already know about what they are asking, in code, without an extra model round.
      let recalled = [];
      if (firstTurn) {
        try { recalled = await notes.recall({ businessId, query: message, count: LIMITS.firstTurnRecall, threshold: 0.35 }); } catch (error) { log('warn', `first-turn recall failed: ${error.message}`); }
        const pinnedTexts = new Set(pinned.map((n) => n.text));
        recalled = recalled.filter((n) => !pinnedTexts.has(n.text));
      }

      const skillByKey = new Map(skills.map((s) => [s.key, s]));
      const loadedKeys = new Set([...def.skills, ...(conversation.loaded_skills ?? [])].filter((k) => skillByKey.has(k)));
      const state = {
        businessId, conversationId: conversation.id, currency: business.currency, skills,
        loaded: loadedKeys, newlyLoaded: new Set(),
      };
      const runCalls = createToolRunner({ store, notes, embed, state, log });

      const loadedSkills = () => [...state.loaded].map((k) => skillByKey.get(k)).filter(Boolean);
      const instructions = buildInstructions({
        businessName: business.name || 'the business', currency: business.currency, preferences, pinnedNotes: pinned,
        skillMenu: skills.map(({ key, when_to_use }) => ({ key, when_to_use })),
      });
      const modelInput = buildInput({
        surface, context: conversation.context ?? {}, currentText, persona, loadedSkills: loadedSkills(), recalled,
        history: turnHistory.slice(-LIMITS.history), nowLabel: now().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      });

      // Streaming: the chat reply appears as it is written; the draft block is held back and arrives whole.
      let parser = null;
      let streamedAny = false;
      const startRound = () => {
        if (streamedAny) emit({ type: 'reset' });
        streamedAny = false;
        parser = createStreamParser({
          onReply: (text) => { streamedAny = true; emit({ type: 'reply', text }); },
          onDraftStart: () => emit({ type: 'draft_start' }),
        });
      };

      const result = await runLoop({
        callModel, model, instructions, tools: TOOL_DEFS, input: modelInput, runCalls,
        effort: isReasoningModel(model) ? effort : null, cacheKey: `ba:${businessId}`.slice(0, 64),
        onRound: startRound,
        onDelta: (chunk) => parser.feed(chunk),
        onTools: (calls) => {
          // Any text before a tool call is thrown away; show what is happening instead.
          emit({ type: 'status', text: TOOL_STATUS[calls[0]?.name] ?? 'Working on it…' });
        },
        onUsage: (res) => Promise.resolve(billModel({ businessId, model, usage: res?.usage })).catch((error) => log('error', `billing failed: ${error.message}`)),
      });
      parser.finish();

      // A flow's <skills> are the business's CHAT AI skills, listed by the dashboard in context.available_skills.
      const chatSkillKeys = (Array.isArray(conversation.context?.available_skills) ? conversation.context.available_skills : [])
        .map((s) => (typeof s === 'string' ? s : s?.key)).filter(Boolean);
      const parsed = parseModelOutput(result.text, { draftType: def.draft, validSkillKeys: chatSkillKeys });
      let reply = parsed.reply;
      const draft = parsed.draft;
      if (!reply && !draft) reply = result.hitLimit ? 'I got a bit tangled on that. Could you say it again, a little simpler?' : 'I could not come up with anything for that. Could you tell me a bit more?';

      const saved = await store.insertMessage({
        conversation_id: conversation.id, business_id: businessId, role: 'assistant', content: reply, draft: draft ?? null,
        model, usage: { ...result.usage, rounds: result.rounds }, tools_used: result.toolsUsed, duration_ms: Date.now() - started,
      });
      await store.updateConversation(conversation.id, businessId, {
        message_count: history.length + (input.retry ? 1 : 2),
        ...(state.newlyLoaded.size ? { loaded_skills: [...new Set([...(conversation.loaded_skills ?? []), ...state.newlyLoaded])] } : {}),
        ...(input.context ? { context: conversation.context } : {}),
      });

      const done = { type: 'done', conversation_id: conversation.id, message_id: saved.id, reply, draft, ms: Date.now() - started };
      emit(done);
      return done;
    } finally {
      inFlight.delete(lockKey);
    }
  };
}
