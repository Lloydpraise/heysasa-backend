// One AI turn, start to finish. Everything outside the model (database, sending, clock) is passed in.

import { NO_REPLY, checkReply } from './guards.ts';
import { pickFlow, type Flow } from './flows.ts';
import { buildInput, buildInstructions, renderCustomerFile, type CustomerFile, type HistoryMessage, type Persona, type Skill } from './prompt.ts';
import { executeBatch, resolveTools, toModelTools, type ToolRow } from './tools.ts';
import { runLoop, type ModelCall, type Usage } from './loop.ts';
import { runRegistryTool, settlePending, type Deps, type QueueResult, type SendItem, type SendResult, type TurnState } from './builtin.ts';

export type TurnInput = {
  business_id: string; conversation_id?: string | null; contact_id?: number | null; trigger_message_id?: string | null;
  simulate?: boolean; message?: string; history?: HistoryMessage[]; contact?: Partial<CustomerFile> & { ad_id?: string | null; list_ids?: string[] };
};

export type TurnContext = {
  business: { name: string; currency: string | null; model: string };
  settings: { effort: string; settleMs: number; holdingAfterMs: number; maxRounds: number; holdingModel: string };
  persona: Persona;
  categories: Array<{ name: string; count: number }>;
  skills: Skill[];
  toolRows: ToolRow[];
  flows: Flow[];
  customer: CustomerFile;
  adIds: Array<string | null | undefined>;
  listIds: string[];
  stickyFlowId: string | null;
  history: HistoryMessage[];
};

export type TurnDeps = {
  loadContext: (input: TurnInput) => Promise<TurnContext>;
  hasNewerInbound: (input: TurnInput) => Promise<boolean>;
  callModel: ModelCall;
  tools: Omit<Deps, 'send' | 'queue'>;
  send: (items: SendItem[]) => Promise<SendResult>;
  // Optional. Hands photos to the sender and returns at once; see builtin.ts (send_products) and settlePending.
  queue?: (items: SendItem[]) => Promise<QueueResult>;
  // Optional. Just the settings, from the cache, so the burst wait can start before the full context is loaded.
  loadSettings?: (input: TurnInput) => Promise<TurnContext['settings']>;
  // Optional. When the customer's newest message arrived (ms since epoch), so the burst wait only covers what is left.
  latestInboundAt?: (input: TurnInput) => Promise<number | null>;
  now?: () => number;
  holdingMessage: (ctx: TurnContext, lastCustomerText: string) => Promise<string | null>;
  recordHandoff: (input: TurnInput, reason: string, summary: string) => Promise<void>;
  rememberFlow: (input: TurnInput, flowId: string) => Promise<void>;
  logTurn: (row: Record<string, unknown>) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  // Optional, supplied by the real wiring (deps.ts). Without them a turn is free and costs are estimated.
  turnId?: string;
  canAfford?: (businessId: string) => Promise<boolean>;
  spend?: () => { base: number; billed: number };
};

// Estimates only, in US dollars per million tokens. Edit when prices change; unknown models are left blank.
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },
};
const MAX_RERUNS = 2;

const nowLabel = (): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', dateStyle: 'full', timeStyle: 'short' }).format(new Date());

export type TurnOutcome = {
  status: 'replied' | 'handoff' | 'skipped' | 'error' | 'superseded';
  reply: string | null; skip_reason?: string; handoff: { reason: string; urgency: string; summary: string } | null;
  steps: unknown[]; thoughts: string; flow: string | null; flow_id: string | null; skills_loaded: string[]; holding_message: string | null;
  usage: Usage; error?: string; reruns: number;
};

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutcome> {
  const started = Date.now();
  const simulate = input.simulate === true;
  const turnId = deps.turnId ?? crypto.randomUUID();

  // Where the time before the model call goes. Saved with the turn so a slow chat can be traced to its cause.
  const timings: Record<string, number> = { delivery_wait_ms: 0 };
  let lapAt = Date.now();
  const lap = (name: string) => { const t = Date.now(); timings[name] = t - lapAt; lapAt = t; };

  // The wallet check and the settings read do not depend on each other, so they run together. Nothing goes to the model
  // until both are back: an empty wallet still stops the turn before any OpenAI call.
  // Chat AI is paid for per use. An empty wallet pauses it, in live chats and in the Playground alike.
  const [affordable, settings] = await Promise.all([
    deps.canAfford ? deps.canAfford(input.business_id) : Promise.resolve(true),
    simulate ? Promise.resolve(null) : (deps.loadSettings ? deps.loadSettings(input) : deps.loadContext(input).then((c) => c.settings)),
  ]);
  lap('prep_ms');
  if (!affordable) {
    await deps.logTurn({
      id: turnId, business_id: input.business_id, conversation_id: input.conversation_id ?? null, contact_id: input.contact_id ?? null,
      trigger_message_id: input.trigger_message_id ?? null, mode: simulate ? 'simulation' : 'live', status: 'skipped', skip_reason: 'no_balance',
      input: { customer_message: input.message ?? null },
    }).catch(() => {});
    return {
      status: 'skipped', reply: null, skip_reason: 'no_balance', handoff: null, steps: [], thoughts: '', flow: null, flow_id: null,
      skills_loaded: [], holding_message: null, usage: { input: 0, cached: 0, output: 0 }, reruns: 0,
    };
  }
  if (settings) {
    await waitForBurst(deps, input, settings.settleMs); // let a burst of messages finish
    lap('settle_ms');
  }

  let ctx = await deps.loadContext(input);
  lap('context_ms');
  let sentCount = 0;
  let holding: { text: string | null; announced: boolean } = { text: null, announced: false };
  let finished = false;
  const trackedSend = async (items: SendItem[]) => {
    const result = await deps.send(items);
    if (result.ok) sentCount += items.length;
    return result;
  };
  // Queued photos count as sent for the "checking..." holding message: the customer is about to see them.
  const trackedQueue = deps.queue
    ? async (items: SendItem[]) => {
        const queued = await deps.queue!(items);
        if (queued.ok) sentCount += items.length;
        return queued;
      }
    : undefined;

  const lastCustomerText = () => [...ctx.history].reverse().find((m) => m.role === 'user')?.text ?? input.message ?? '';
  const timer = ctx.settings.holdingAfterMs > 0 && !simulate
    ? setTimeout(async () => {
        if (finished || sentCount > 0) return;
        try {
          const text = await deps.holdingMessage(ctx, lastCustomerText());
          if (!text || finished || sentCount > 0) return;
          const result = await trackedSend([{ text }]);
          if (result.ok) holding = { text, announced: false };
        } catch { /* a missed holding message must never break the real reply */ }
      }, ctx.settings.holdingAfterMs)
    : null;

  let outcome: TurnOutcome | null = null;
  let reruns = 0;

  try {
    for (;;) {
      // The customer may write again while we work. attempt() checks just before it sends, and gives up its draft
      // (status 'superseded') so we start over with everything they said. After MAX_RERUNS we send whatever we have.
      outcome = await attempt(deps, input, ctx, { send: trackedSend, queue: trackedQueue }, () => holding, simulate, reruns < MAX_RERUNS, timings);
      if (outcome.status !== 'superseded') break;
      reruns++;
      ctx = await deps.loadContext(input);
    }
  } catch (error) {
    outcome = {
      status: 'error', reply: null, handoff: null, steps: [], thoughts: '', flow: null, flow_id: null, skills_loaded: [], holding_message: holding.text,
      usage: { input: 0, cached: 0, output: 0 }, error: String((error as Error)?.message ?? error), reruns,
    };
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
  }

  const result = { ...outcome!, holding_message: holding.text, reruns };
  // The real cost comes from the billing function (admin-editable prices). The table below is only a fallback estimate.
  const price = PRICES[ctx.business.model];
  const estimate = price
    ? ((result.usage.input - result.usage.cached) * price.input + result.usage.cached * price.cached + result.usage.output * price.output) / 1_000_000
    : null;
  const cost = deps.spend ? deps.spend().base : estimate;

  await deps.logTurn({
    id: turnId, business_id: input.business_id, conversation_id: input.conversation_id ?? null, contact_id: input.contact_id ?? null,
    trigger_message_id: input.trigger_message_id ?? null, mode: simulate ? 'simulation' : 'live',
    status: result.status, skip_reason: result.skip_reason ?? null, model: ctx.business.model,
    flow_id: result.flow_id, skills_loaded: result.skills_loaded,
    input: { customer_message: lastCustomerText(), flow: result.flow, customer: renderCustomerFile(ctx.customer), recent_history: ctx.history.slice(-8), reruns, timings },
    steps: result.steps, thoughts: result.thoughts || null, reply: result.reply, holding_message: holding.text,
    tokens_in: result.usage.input, tokens_cached: result.usage.cached, tokens_out: result.usage.output,
    cost_usd: cost, duration_ms: Date.now() - started, error: result.error ?? null,
    qc_status: !simulate && (result.status === 'replied' || result.status === 'handoff') ? 'pending' : null,
  }).catch(() => {});

  return result;
}

type Io = { send: (items: SendItem[]) => Promise<SendResult>; queue?: (items: SendItem[]) => Promise<QueueResult> };

// Only reasoning models accept a reasoning setting; a non-reasoning model (a faster option some businesses may pick) would reject it.
const isReasoningModel = (model: string) => /^(gpt-5|o\d)/.test(model);

// Customers often send two or three short messages in a row. Waiting until they have been quiet for `settleMs` lets one
// answer cover all of them. The wait only covers what is left of that quiet time (the message has usually been travelling
// for a second or two already), and never runs past twice `settleMs` in total.
async function waitForBurst(deps: TurnDeps, input: TurnInput, settleMs: number): Promise<void> {
  if (settleMs <= 0) return;
  if (!deps.latestInboundAt) { await deps.sleep(settleMs); return; }
  const now = deps.now ?? Date.now;
  const deadline = now() + settleMs * 2;
  for (let i = 0; i < 4; i++) {
    const last = await deps.latestInboundAt(input).catch(() => null);
    if (last === null) { if (i === 0) await deps.sleep(settleMs); return; }   // cannot tell when it arrived: wait the full time
    const age = Math.max(0, now() - last);
    const remaining = Math.min(settleMs - age, deadline - now());
    if (remaining <= 0) return;
    await deps.sleep(remaining);
  }
}

async function attempt(
  deps: TurnDeps, input: TurnInput, ctx: TurnContext, io: Io,
  getHolding: () => { text: string | null; announced: boolean }, simulate: boolean, allowSupersede: boolean,
  timings: Record<string, number>,
): Promise<TurnOutcome> {
  const send = io.send;
  const tools = resolveTools(ctx.toolRows, input.business_id);

  const flow = pickFlow(ctx.flows, { stickyFlowId: ctx.stickyFlowId, adIds: ctx.adIds, listIds: ctx.listIds });
  if (flow && !simulate && flow.id !== ctx.stickyFlowId) await deps.rememberFlow(input, flow.id).catch(() => {});

  const skillByKey = new Map(ctx.skills.map((s) => [s.key, s]));
  const state: TurnState = {
    businessId: input.business_id, contactId: input.contact_id ?? null, conversationId: input.conversation_id ?? null,
    currency: ctx.business.currency, simulate, seenProducts: new Map(), skills: skillByKey, skillsLoaded: new Set(),
    productsSent: [], handoff: null, corpus: [],
  };
  // The flow's skills are loaded by code, up front, so the AI does not spend a call asking for them.
  const preloaded = (flow?.skill_keys ?? []).map((k) => skillByKey.get(k)).filter((s): s is Skill => Boolean(s));
  // A customer writing for the first time gets the first-reply skill without the AI having to ask for it.
  const firstReply = ctx.customer.first_contact ? skillByKey.get('first_reply') : undefined;
  if (firstReply && !preloaded.includes(firstReply)) preloaded.push(firstReply);
  for (const s of preloaded) state.skillsLoaded.add(s.key);

  const instructions = buildInstructions({
    businessName: ctx.business.name, currency: ctx.business.currency, persona: ctx.persona, categories: ctx.categories,
    skillMenu: ctx.skills,
  });
  const input_items = buildInput({
    flow: flow ? { name: flow.name, goal: flow.goal, instructions: flow.instructions } : null,
    loadedSkills: preloaded, customer: ctx.customer, history: ctx.history, nowLabel: nowLabel(),
  });

  const baseCorpus = [
    JSON.stringify(ctx.persona ?? {}), flow?.instructions ?? '', flow?.goal ?? '', ...preloaded.map((s) => s.instructions),
    renderCustomerFile(ctx.customer), ...ctx.history.map((m) => m.text),
  ];
  const toolDeps: Deps = { ...deps.tools, send, queue: io.queue };
  const executeCalls = (calls: Parameters<typeof executeBatch>[0]) =>
    executeBatch(calls, tools, (row, args) => runRegistryTool(row, args, state, toolDeps));
  // The same tools, but send_products waits for WhatsApp. Used only to redo a reply after photos failed to send, so the
  // AI sees for itself what went out and can retry, exactly as it could before photos were sent in the background.
  const syncDeps: Deps = { ...deps.tools, send };
  const executeCallsSync = (calls: Parameters<typeof executeBatch>[0]) =>
    executeBatch(calls, tools, (row, args) => runRegistryTool(row, args, state, syncDeps));

  const common = {
    callModel: deps.callModel, model: ctx.business.model, instructions, tools: toModelTools(tools),
    effort: isReasoningModel(ctx.business.model) ? ctx.settings.effort : undefined, cacheKey: `sasa:${input.business_id}`,
  };
  const loop = await runLoop({
    ...common, input: input_items, executeCalls, maxRounds: ctx.settings.maxRounds,
    extraInput: () => {
      const h = getHolding();
      if (h.text && !h.announced) {
        h.announced = true;
        return [{ role: 'developer', content: `You already sent the customer this holding message: "${h.text}". Do not repeat it and do not greet again.` }];
      }
      return [];
    },
  });

  const usage = { ...loop.usage };
  const steps: unknown[] = [...loop.steps];
  let text = loop.text;
  const corpus = () => [...baseCorpus, ...state.corpus].join('\n');
  const finish = (partial: Partial<TurnOutcome> & Pick<TurnOutcome, 'status' | 'reply'>): TurnOutcome => ({
    handoff: state.handoff, steps, thoughts: loop.thoughts, flow: flow?.name ?? null, flow_id: flow?.id ?? null, skills_loaded: [...state.skillsLoaded],
    holding_message: null, usage, reruns: 0, ...partial,
  });

  // Photos queued by send_products may still be on their way. Waiting for them here, instead of inside the tool, is what
  // lets the AI write its message while the sender works. Only the time spent purely waiting is counted in the timings.
  const awaitDelivery = async () => {
    if (!state.pending?.length) return { sent: [] as string[], failed: [] as Array<{ id: string; error: string }> };
    const startedWaiting = Date.now();
    const result = await settlePending(state);
    timings.delivery_wait_ms += Date.now() - startedWaiting;
    return result;
  };
  const endAfterDelivery = async (partial: Partial<TurnOutcome> & Pick<TurnOutcome, 'status' | 'reply'>) => {
    await awaitDelivery();
    return finish(partial);
  };
  const silence = { status: 'skipped', reply: null, skip_reason: 'ai_chose_silence' } as const;

  if (text.includes(NO_REPLY)) return endAfterDelivery(silence);

  // Two bad drafts in a row: do not send a risky message. Give the chat to the owner with what we know.
  const giveToOwner = async (problems: string[]) => {
    const reason = 'reply_failed_checks';
    const summary = `The AI could not write a safe reply. Problems: ${problems.join(' ')} Customer's last message: "${ctx.history.filter((m) => m.role === 'user').slice(-1)[0]?.text ?? input.message ?? ''}"`;
    state.handoff = { reason, urgency: 'normal', summary };
    if (!simulate) await deps.recordHandoff(input, reason, summary).catch(() => {});
    return endAfterDelivery({ status: 'handoff', reply: null, skip_reason: reason });
  };

  let lastId = loop.lastResponseId;
  let check = checkReply(text, corpus());
  if (!check.ok) {
    const revised = await runLoop({
      ...common, input: [{ role: 'developer', content: `Your reply was rejected:\n${check.problems.map((p) => `- ${p}`).join('\n')}\nWrite the reply again, fixing every point. Output only the message.` }],
      previousResponseId: lastId, executeCalls, maxRounds: 1, noTools: true,
    });
    usage.input += revised.usage.input; usage.cached += revised.usage.cached; usage.output += revised.usage.output;
    steps.push({ revision: true, problems: check.problems, text: revised.text });
    text = revised.text;
    lastId = revised.lastResponseId ?? lastId;
    if (text.includes(NO_REPLY)) return endAfterDelivery(silence);
    check = checkReply(text, corpus());
  }
  if (!check.ok) return giveToOwner(check.problems);

  // The photos must have landed before the message about them goes out, and the AI must never talk as if the customer
  // saw something that failed to send. If any failed, it writes the reply again knowing which ones.
  const delivery = await awaitDelivery();
  if (delivery.failed.length) {
    const names = delivery.failed.map((f) => state.seenProducts.get(f.id)?.title ?? f.id).join(', ');
    const redo = await runLoop({
      ...common, input: [{ role: 'developer', content: `These photos did not reach the customer, so they have not seen them: ${names}. Write the reply again without saying or implying they can see them. If it matters, say you will send them shortly, or hand off. Output only the message.` }],
      previousResponseId: lastId, executeCalls: executeCallsSync, maxRounds: 3,
    });
    usage.input += redo.usage.input; usage.cached += redo.usage.cached; usage.output += redo.usage.output;
    steps.push({ delivery_failed: delivery.failed, text: redo.text }, ...redo.steps);
    text = redo.text;
    if (text.includes(NO_REPLY)) return endAfterDelivery(silence);
    check = checkReply(text, corpus());
    if (!check.ok) return giveToOwner(check.problems);
  }

  // A reply to a message the customer has already followed up on would read as stale. A handoff is never dropped.
  if (allowSupersede && !simulate && !state.handoff && await deps.hasNewerInbound(input)) {
    return finish({ status: 'superseded', reply: null, skip_reason: 'newer_message' });
  }

  // In simulation `send` records what would have gone out instead of sending it.
  const sent = await send([{ text }]);
  if (!sent.ok) return finish({ status: 'error', reply: text, error: sent.error || 'The reply could not be sent.' });
  return finish({ status: state.handoff ? 'handoff' : 'replied', reply: text });
}
