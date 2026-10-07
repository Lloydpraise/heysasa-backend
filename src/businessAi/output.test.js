import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamParser, parseModelOutput, draftAsText } from './output.js';

function stream(text, size) {
  const events = [];
  const parser = createStreamParser({ onReply: (t) => events.push(['reply', t]), onDraftStart: () => events.push(['draft_start']) });
  for (let i = 0; i < text.length; i += size) parser.feed(text.slice(i, i + size));
  parser.finish();
  return events;
}

test('the chat reply streams and the draft is held back, for any chunk size', () => {
  const text = 'Here is a softer one.\n<draft>Hi {{first_name}}, still keen on the pan?</draft>';
  for (const size of [1, 2, 3, 5, 9, 100]) {
    const events = stream(text, size);
    const reply = events.filter((e) => e[0] === 'reply').map((e) => e[1]).join('');
    assert.equal(reply.trim(), 'Here is a softer one.', `chunk size ${size}`);
    assert.equal(events.filter((e) => e[0] === 'draft_start').length, 1);
    assert.ok(!reply.includes('<draft'), 'draft tag must never reach the chat');
  }
});

test('a "<" that is not a draft tag is still shown', () => {
  const reply = stream('Is 5 < 6 true? <b>yes</b>', 2).filter((e) => e[0] === 'reply').map((e) => e[1]).join('');
  assert.equal(reply, 'Is 5 < 6 true? <b>yes</b>');
});

test('text with no draft is all reply', () => {
  const events = stream('Which product is this for?', 4);
  assert.equal(events.some((e) => e[0] === 'draft_start'), false);
  assert.equal(events.map((e) => e[1]).join(''), 'Which product is this for?');
});

test('parseModelOutput: plain draft, quotes and fences stripped', () => {
  assert.deepEqual(parseModelOutput('Done.\n<draft>"Hi there"</draft>'), { reply: 'Done.', draft: { type: 'text', text: 'Hi there' } });
  assert.equal(parseModelOutput('x <draft>```\nHello\n```</draft>').draft.text, 'Hello');
});

test('parseModelOutput: a cut-off draft (no closing tag) is kept', () => {
  assert.equal(parseModelOutput('Ok <draft>Hello there').draft.text, 'Hello there');
});

test('parseModelOutput: no draft, or an empty one', () => {
  assert.equal(parseModelOutput('Just a question?').draft, null);
  assert.equal(parseModelOutput('Ok <draft>  </draft>').draft, null);
});

test('parseModelOutput: flow draft with skill keys filtered to valid ones', () => {
  const raw = 'Here you go. <draft><name>Ad leads</name><goal>Get the location</goal><instructions>Ask what they need.\nShow products.</instructions><skills>price_question, bogus_skill, Not Valid</skills></draft>';
  const out = parseModelOutput(raw, { draftType: 'flow', validSkillKeys: ['price_question', 'delivery'] });
  assert.deepEqual(out.draft, { type: 'flow', name: 'Ad leads', goal: 'Get the location', instructions: 'Ask what they need.\nShow products.', skill_keys: ['price_question'] });
});

test('parseModelOutput: a flow with no instructions is not a draft', () => {
  assert.equal(parseModelOutput('x <draft><name>A</name></draft>', { draftType: 'flow' }).draft, null);
});

test('draftAsText', () => {
  assert.equal(draftAsText({ type: 'text', text: 'hi' }), 'hi');
  assert.match(draftAsText({ type: 'flow', name: 'N', goal: 'G', instructions: 'I', skill_keys: ['a'] }), /Skills: a/);
  assert.equal(draftAsText(null), '');
});
