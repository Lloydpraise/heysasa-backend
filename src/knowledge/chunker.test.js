import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkPages, chunkText, MAX_CHUNKS } from './chunker.js';

test('short text stays one piece; empty text gives none', () => {
    assert.deepEqual(chunkText('Refunds take 3 days.'), ['Refunds take 3 days.']);
    assert.deepEqual(chunkText('  \n\n '), []);
});

test('long text is cut into pieces no bigger than the size, nothing is lost, and neighbours overlap', () => {
    const sentence = 'Step one is to greet the customer by name. ';
    const text = Array.from({ length: 80 }, (_, i) => `${sentence}Item ${i}.`).join('\n\n');
    const pieces = chunkText(text, { size: 400, overlap: 60 });
    assert.ok(pieces.length > 5);
    assert.ok(pieces.every((p) => p.length <= 400 + 60 + 4), 'a piece may carry the overlap on top of its size');
    for (let i = 0; i < 80; i += 9) assert.ok(pieces.some((p) => p.includes(`Item ${i}.`)), `Item ${i} is kept`);
    const tailOfFirst = pieces[0].slice(-30).split(' ').slice(-2).join(' ');
    assert.ok(pieces[1].includes(tailOfFirst), 'the next piece starts with the end of the last one');
});

test('one huge paragraph with no blank lines is still split', () => {
    const pieces = chunkText('word '.repeat(1000), { size: 300 });
    assert.ok(pieces.length >= 15);
    assert.ok(pieces.every((p) => p.length <= 300 + 120 + 4));
});

test('pages keep their page number, and the total is capped', () => {
    const { chunks } = chunkPages([{ page: 1, text: 'First page text here.' }, { page: 2, text: 'Second page text here.' }]);
    assert.deepEqual(chunks.map((c) => [c.index, c.page]), [[0, 1], [1, 2]]);
    const big = chunkPages([{ page: 1, text: Array.from({ length: MAX_CHUNKS + 50 }, (_, i) => `Paragraph number ${i} ${'x'.repeat(850)}`).join('\n\n') }]);
    assert.equal(big.chunks.length, MAX_CHUNKS);
    assert.equal(big.truncated, true);
});
