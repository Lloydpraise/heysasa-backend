// sasa-brain: the chat AI. The backend calls this after its gates pass (switch on, cap not used up, chat not busy...).
// POST { business_id, conversation_id, contact_id, trigger_message_id }                 -> a live turn: replies to the customer
// POST { business_id, simulate: true, message, history?, contact? }                      -> a dry run for the Playground: nothing is sent
// Auth: Authorization: Bearer <service role key>.
//
// Secrets this function needs: OPENAI_API_KEY (already set for your other functions), SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY (set by Supabase). Optional: SASA_TOOL_SECRET, sent to your own http tools.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { runTurn, type TurnInput } from './core/turn.ts';
import { buildDeps } from './core/deps.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!url || !serviceKey || !openaiKey) return json({ error: 'The function is missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or OPENAI_API_KEY.' }, 500);
  if (req.headers.get('authorization') !== `Bearer ${serviceKey}`) return json({ error: 'unauthorized' }, 401);

  let input: TurnInput;
  try {
    input = await req.json();
  } catch {
    return json({ error: 'The body must be JSON.' }, 400);
  }
  if (!input?.business_id) return json({ error: 'business_id is required' }, 400);
  if (!input.simulate && (!input.conversation_id || !input.contact_id)) return json({ error: 'conversation_id and contact_id are required for a live turn' }, 400);
  if (input.simulate && !input.message && !input.history?.length) return json({ error: 'A simulation needs a message or a history.' }, 400);

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const deps = buildDeps({ db, openaiKey, fetch, sleep, toolSecret: Deno.env.get('SASA_TOOL_SECRET') ?? undefined }, input);

  try {
    const outcome = await runTurn(deps, input);
    return json({
      status: outcome.status, reply: outcome.reply, skip_reason: outcome.skip_reason ?? null, handoff: outcome.handoff,
      flow: outcome.flow, skills_loaded: outcome.skills_loaded, holding_message: outcome.holding_message, reruns: outcome.reruns,
      usage: outcome.usage, error: outcome.error ?? null,
      // The tool trail and the model's reasoning summary: what the Playground shows beside the reply.
      steps: input.simulate ? outcome.steps : undefined, thoughts: input.simulate ? outcome.thoughts : undefined,
    });
  } catch (error) {
    return json({ status: 'error', error: String((error as Error)?.message ?? error) }, 500);
  }
});
