import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmbedder, makeStreamingModel } from './openai.js';

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const streamOf = (text, size = 13) => new ReadableStream({
  start(controller) {
    const enc = new TextEncoder();
    for (let i = 0; i < text.length; i += size) controller.enqueue(enc.encode(text.slice(i, i + size)));
    controller.close();
  },
});
const okResponse = (text) => ({ ok: true, status: 200, body: streamOf(text) });

const completed = { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello there' }] }] } };

test('streams text deltas and resolves with the completed response, even when chunks split events', async () => {
  const body = sse([
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_text.delta', delta: 'Hello ' },
    { type: 'response.output_text.delta', delta: 'there' },
    completed,
  ]);
  let sent;
  const call = makeStreamingModel({ apiKey: 'k', fetchFn: async (url, init) => { sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return okResponse(body); } });
  const deltas = [];
  const res = await call({ model: 'gpt-5-mini', input: [] }, (d) => deltas.push(d));
  assert.deepEqual(deltas, ['Hello ', 'there']);
  assert.equal(res.id, 'resp_1');
  assert.equal(sent.body.stream, true);
  assert.equal(sent.auth, 'Bearer k');
  assert.match(sent.url, /\/responses$/);
});

test('a failed stream becomes an error', async () => {
  const call = makeStreamingModel({ apiKey: 'k', fetchFn: async () => okResponse(sse([{ type: 'response.failed', response: { error: { message: 'boom' } } }])) });
  await assert.rejects(call({}), /boom/);
});

test('a stream with no result is an error', async () => {
  const call = makeStreamingModel({ apiKey: 'k', fetchFn: async () => okResponse(sse([{ type: 'response.output_text.delta', delta: 'x' }])) });
  await assert.rejects(call({}), /without a result/);
});

test('a rate limit becomes a typed error and does not latch the gate', async () => {
  const call = makeStreamingModel({ apiKey: 'k', fetchFn: async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => '{"error":{"code":"rate_limit_exceeded"}}' }) });
  await assert.rejects(call({}), (e) => e.kind === 'rate_limit');
  const again = makeStreamingModel({ apiKey: 'k', sleepFn: async () => {}, fetchFn: async () => okResponse(sse([completed])) });
  assert.equal((await again({})).id, 'resp_1');
});

test('embedder returns the vector and reports token usage with the business id', async () => {
  const used = [];
  const embed = makeEmbedder({ apiKey: 'k', onUsage: (u) => used.push(u), fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 7 } }) }) });
  assert.deepEqual(await embed('hello', 'b1'), [0.1, 0.2]);
  assert.deepEqual(used, [{ businessId: 'b1', model: 'text-embedding-3-small', promptTokens: 7 }]);
});

test('no API key is a clear error', async () => {
  await assert.rejects(makeEmbedder({})('x', 'b1'), /OPENAI_API_KEY/);
  await assert.rejects(makeStreamingModel({})({}), /OPENAI_API_KEY/);
});
