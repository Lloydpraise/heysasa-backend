import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrainCaller } from './brainClient.js';

const json = (status, body) => new Response(JSON.stringify(body), { status });

test('the brain is called with the service key and the trigger message, and its outcome is summarised', async () => {
  let seen;
  const call = createBrainCaller({ url: 'https://p.supabase.co/', serviceKey: 'srv', fetchFn: async (u, init) => { seen = { u, init }; return json(200, { status: 'handoff', handoff: { reason: 'refund' }, skip_reason: null }); } });
  const out = await call({ businessId: 'b1', conversationId: 'c1', contactId: 7, message: { keyId: 'W9' } });
  assert.equal(seen.u, 'https://p.supabase.co/functions/v1/sasa-brain');
  assert.equal(seen.init.headers.Authorization, 'Bearer srv');
  assert.deepEqual(JSON.parse(seen.init.body), { business_id: 'b1', conversation_id: 'c1', contact_id: 7, trigger_message_id: 'W9' });
  assert.deepEqual([out.replied, out.brain_status, out.handoff.reason], [true, 'handoff', 'refund']);
});

test('a brain error is thrown so it reaches the debug console, and a missing key is reported plainly', async () => {
  const call = createBrainCaller({ url: 'https://p.supabase.co', serviceKey: 'srv', fetchFn: async () => json(500, { error: 'OpenAI returned 401' }) });
  await assert.rejects(call({ businessId: 'b', conversationId: 'c', contactId: 1, message: {} }), /500: OpenAI returned 401/);
  await assert.rejects(createBrainCaller({ url: '', serviceKey: '' })({ message: {} }), /cannot be called/);
});
