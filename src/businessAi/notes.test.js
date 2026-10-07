import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotes, fitPinned, PIN_BUDGET } from './notes.js';
import { fakeEmbed, fakeStore } from './fakes.js';

const make = (embed = fakeEmbed) => { const store = fakeStore(); return { store, notes: createNotes({ store, embed }) }; };

test('saving stores the note with an embedding', async () => {
  const { store, notes } = make();
  const r = await notes.save({ businessId: 'b1', text: 'Sells non-stick pan sets', pinned: true });
  assert.equal(r.status, 'saved');
  assert.equal(store.db.notes[0].embedding.length, 4);
  assert.equal(store.db.notes[0].pinned, true);
});

test('a near-duplicate updates the old note instead of adding another', async () => {
  const { store, notes } = make();
  await notes.save({ businessId: 'b1', text: 'Best seller is the pan' });
  const r = await notes.save({ businessId: 'b1', text: 'The pan is the best seller, 28cm' });
  assert.equal(r.status, 'updated');
  assert.equal(store.db.notes.length, 1);
  assert.match(store.db.notes[0].text, /28cm/);
});

test('notes are scoped to their business', async () => {
  const { store, notes } = make();
  await notes.save({ businessId: 'b1', text: 'pan facts' });
  assert.deepEqual(await notes.recall({ businessId: 'b2', query: 'pan' }), []);
  assert.equal((await notes.recall({ businessId: 'b1', query: 'pan' })).length, 1);
  assert.equal(store.db.notes.length, 1);
});

test('recall finds by meaning and ignores unrelated notes', async () => {
  const { notes } = make();
  await notes.save({ businessId: 'b1', text: 'Delivery is free in Nairobi' });
  await notes.save({ businessId: 'b1', text: 'Owner likes Swahili greetings' });
  const found = await notes.recall({ businessId: 'b1', query: 'what is our delivery policy' });
  assert.deepEqual(found.map((n) => n.text), ['Delivery is free in Nairobi']);
});

test('if embedding fails the note is still saved, and recall falls back to recent notes', async () => {
  const { store, notes } = make(async () => { throw new Error('openai down'); });
  const r = await notes.save({ businessId: 'b1', text: 'Opens at 8am' });
  assert.equal(r.status, 'saved');
  assert.equal(store.db.notes[0].embedding, null);
  assert.equal((await notes.recall({ businessId: 'b1', query: 'hours' })).length, 1);
});

test('pinned notes beyond the budget are un-pinned, not deleted, and the newest stays pinned', async () => {
  let n = 0;
  const distinct = async () => { const v = [0, 0, 0, 0, 0, 0, 0]; v[n++ % 7] = 1; return v; };
  const { store, notes } = make(distinct);
  const chunk = 'x'.repeat(380);
  for (let i = 0; i < 6; i++) await notes.save({ businessId: 'b1', text: `${i} ${chunk}`, pinned: true });
  const pinned = store.db.notes.filter((n) => n.pinned);
  assert.ok(pinned.reduce((s, n) => s + n.text.length, 0) <= PIN_BUDGET);
  assert.equal(store.db.notes.length, 6);
  assert.ok(pinned.some((n) => n.text.startsWith('5 ')), 'the note just saved must stay pinned');
});

test('fitPinned respects the budget', () => {
  const rows = [{ text: 'a'.repeat(900), updated_at: '2' }, { text: 'b'.repeat(900), updated_at: '1' }];
  const { keep, overflow } = fitPinned(rows, 1000);
  assert.equal(keep.length, 1);
  assert.equal(overflow.length, 1);
});

test('too-short notes are ignored; owner edits re-embed', async () => {
  const { store, notes } = make();
  assert.equal((await notes.save({ businessId: 'b1', text: 'a' })).status, 'ignored');
  await notes.save({ businessId: 'b1', text: 'pan' , pinned: false});
  const id = store.db.notes[0].id;
  await notes.edit({ businessId: 'b1', id, text: 'delivery is free' });
  assert.deepEqual(store.db.notes[0].embedding, [0, 1, 0, 0]);
  assert.equal((await notes.edit({ businessId: 'b2', id, text: 'hijack attempt' })).status, 'not_found');
});
