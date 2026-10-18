// sasa-brain: the chat AI. The backend calls this after its gates pass (switch on, cap not used up, chat not busy...).
// POST { business_id, conversation_id, contact_id, trigger_message_id }                 -> a live turn: replies to the customer
// POST { business_id, simulate: true, message, history?, contact? }                      -> a dry run for the Playground: nothing is sent
// Auth: Authorization: Bearer <service role key> for everything.
//   The Playground (browser) may instead send the signed-in user's own login token, but ONLY for simulate:true,
//   and only for a business that user owns. A login token can never trigger a live turn.
//
// Secrets this function needs: OPENAI_API_KEY (already set for your other functions), SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY (set by Supabase). Optional: SASA_TOOL_SECRET, sent to your own http tools.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { runTurn, type TurnInput } from './core/turn.ts';
import { buildDeps } from './core/deps.ts';
import { createContextCache } from './core/context.ts';

const allowedOrigins = new Set([
  'https://heysasa.co.ke',
]);
// The site and its sub-domains, and the local dev server on any port. A token is still needed for everything.
const originAllowed = (origin: string | null) => Boolean(origin) && (
  allowedOrigins.has(origin as string) || /^https:\/\/([a-z0-9-]+\.)*heysasa\.co\.ke$/i.test(origin as string) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin as string)
);
const corsHeaders = (origin: string | null) => ({
  ...(origin && originAllowed(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
});
const BUILD = 'chat-live-2026-10-17';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Lives as long as this function instance does. Holds persona, skills, tools, flows and product categories for a short
// while (30 seconds; categories 5 minutes), so a busy chat does not re-read them on every message. The Playground skips it.
const contextCache = createContextCache();

Deno.serve(async (req) => {
  // One line for EVERY request, before anything can refuse it. If this line is missing in the function logs, the request never arrived.
  const origin = req.headers.get('origin');
  console.log(JSON.stringify({ event: 'sasa-brain.request', build: BUILD, method: req.method, origin, origin_allowed: originAllowed(origin), has_auth: Boolean(req.headers.get('authorization')) }));
  const json = (body: unknown, status = 200) => {
    if (status >= 400) console.warn(JSON.stringify({ event: 'sasa-brain.refused', status, error: (body as { error?: string })?.error ?? null }));
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders(req.headers.get('origin')), 'Content-Type': 'application/json' },
    });
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req.headers.get('origin')) });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!url || !serviceKey || !openaiKey) return json({ error: 'The function is missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or OPENAI_API_KEY.' }, 500);
  const authorization = req.headers.get('authorization') ?? '';
  const isService = authorization === `Bearer ${serviceKey}`;
  const userToken = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? '';
  if (!isService && !userToken) return json({ error: 'unauthorized' }, 401);

  let input: TurnInput;
  try {
    input = await req.json();
  } catch {
    return json({ error: 'The body must be JSON.' }, 400);
  }
  // A quick "is it alive?" check: no database, no OpenAI. Answers at once if the function boots and has its secrets.
  // curl -X POST <url>/functions/v1/sasa-brain -H "Authorization: Bearer <service key>" -d '{"ping":true}'
  if ((input as { ping?: boolean })?.ping === true) return json({ ok: true, ping: true, build: BUILD, now: new Date().toISOString() });
  if (!input?.business_id) return json({ error: 'business_id is required' }, 400);
  if (!input.simulate && (!input.conversation_id || !input.contact_id)) return json({ error: 'conversation_id and contact_id are required for a live turn' }, 400);
  if (input.simulate && !input.message && !input.history?.length) return json({ error: 'A simulation needs a message or a history.' }, 400);

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (!isService) {
    // A signed-in user (the Playground). Simulations only, and only for a business they own.
    if (!input.simulate) return json({ error: 'unauthorized' }, 401);
    const { data: authData, error: authError } = await db.auth.getUser(userToken);
    const userId = authData?.user?.id;
    if (authError || !userId) return json({ error: 'unauthorized' }, 401);
    const { data: owned, error: ownedError } = await db.from('businesses').select('business_id')
      .eq('business_id', input.business_id).eq('user_id', userId).maybeSingle();
    if (ownedError) return json({ error: 'Could not check access to this business.' }, 500);
    if (!owned) return json({ error: 'forbidden' }, 403);
  }

  const deps = buildDeps({ db, openaiKey, fetch, sleep, toolSecret: Deno.env.get('SASA_TOOL_SECRET') ?? undefined, contextCache }, input);

  const startedAt = Date.now();
  const tag = { mode: input.simulate ? 'simulate' : 'live', business_id: input.business_id, conversation_id: input.conversation_id ?? null };
  console.log(JSON.stringify({ event: 'sasa-brain.start', build: BUILD, ...tag }));
  try {
    const run = runTurn(deps, input);
    // A simulation that hangs would leave the Playground waiting for ever, so it gives up with a clear message after 60 seconds.
    // A live turn is never cut off here: it may already be sending, and cutting it off could send the reply twice.
    const outcome = input.simulate
      ? await Promise.race([run, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The simulation took longer than 60 seconds. The model call or a tool is stuck; check OPENAI_API_KEY and the model name.')), 60_000))])
      : await run;
    console.log(JSON.stringify({ event: 'sasa-brain.done', ...tag, status: outcome.status, skip_reason: outcome.skip_reason ?? null, error: outcome.error ?? null, ms: Date.now() - startedAt }));
    return json({
      status: outcome.status, reply: outcome.reply, skip_reason: outcome.skip_reason ?? null, handoff: outcome.handoff,
      flow: outcome.flow, skills_loaded: outcome.skills_loaded, holding_message: outcome.holding_message, reruns: outcome.reruns,
      usage: outcome.usage, error: outcome.error ?? null, ms: Date.now() - startedAt, build: BUILD,
      // The tool trail and the model's reasoning summary: what the Playground shows beside the reply.
      steps: input.simulate ? outcome.steps : undefined, thoughts: input.simulate ? outcome.thoughts : undefined,
      // What the Playground shows: photos and images that would have gone out, and who a handoff would alert.
      outbox: input.simulate ? outcome.outbox ?? [] : undefined, handoff_alert: input.simulate ? outcome.handoff_alert ?? null : undefined,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'sasa-brain.error', ...tag, error: String((error as Error)?.message ?? error), stack: String((error as Error)?.stack ?? '').slice(0, 800), ms: Date.now() - startedAt }));
    return json({ status: 'error', error: String((error as Error)?.message ?? error), ms: Date.now() - startedAt, build: BUILD }, 500);
  }
});
