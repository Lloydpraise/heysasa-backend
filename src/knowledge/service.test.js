import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeService, cleanInput } from './service.js';
import { createExtractor, inferFileType, splitPageMarkers } from './extract.js';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';

const pdfText = 'Customer support SOP. '.repeat(40);
function setup({ tables = {}, storage = {}, ai = {}, canAfford } = {}) {
    const db = fakeSupabase({ knowledge_sources: [], knowledge_chunks: [], ...tables }, { storage });
    const fullAi = { embedMany: async (texts) => texts.map(() => [0.1, 0.2]), summarise: async () => 'A support procedure.', ...ai };
    const extractor = createExtractor({
        ai: fullAi,
        // pdf-parse calls pagerender once per page; this fake has one page of text
        loadPdfParse: async () => async (_buffer, opts) => {
            await opts.pagerender({ getTextContent: async () => ({ items: [{ str: pdfText, transform: [1, 0, 0, 1, 0, 700] }] }) });
            return { text: pdfText, numpages: 1 };
        },
        loadMammoth: async () => ({ extractRawText: async () => ({ value: 'Word text '.repeat(20) }) }),
    });
    const service = createKnowledgeService({ supabase: db, makeAi: () => ({ ai: fullAi, extractor }), canAfford });
    return { db, service };
}
const settle = () => new Promise((r) => setImmediate(() => setTimeout(r, 20)));

test('file types are worked out from the type or the name', () => {
    assert.equal(inferFileType({ mime: 'application/pdf' }), 'pdf');
    assert.equal(inferFileType({ fileName: 'Prices.PNG' }), 'image');
    assert.equal(inferFileType({ fileName: 'clip.mp4' }), 'video');
    assert.equal(inferFileType({ fileName: 'a.docx' }), 'document');
    assert.equal(inferFileType({ fileName: 'a.exe' }), null);
    assert.deepEqual(splitPageMarkers('--- page 1 ---\nA\n--- page 2 ---\nB').map((p) => p.page), [1, 2]);
});

test('input is cleaned: unknown values fall back, long values are cut', () => {
    const c = cleanInput({ title: ' SOP ', use_case: 'x'.repeat(900), kind: 'weird', used_by: 'nobody' });
    assert.deepEqual([c.title, c.use_case.length, c.kind, c.used_by, c.is_active], ['SOP', 600, 'other', 'both', true]);
});

test('a PDF is saved first, then read, cut into pieces, turned into vectors, and marked ready', async () => {
    const { db, service } = setup({ storage: { 'b1/sop.pdf': new Uint8Array([1, 2, 3]).buffer } });
    const made = await service.create({ businessId: 'b1', input: { title: 'Support SOP', use_case: 'Use for support issues', used_by: 'chat', storage_path: 'b1/sop.pdf', file_name: 'sop.pdf', mime_type: 'application/pdf', size_bytes: 3 } });
    assert.equal(made.ok, true);
    assert.equal(db.tables.knowledge_sources[0].status, 'processing', 'saved before it is analysed');
    await settle();
    const row = db.tables.knowledge_sources[0];
    assert.deepEqual([row.status, row.summary, row.file_type, row.used_by], ['ready', 'A support procedure.', 'pdf', 'chat']);
    assert.ok(db.tables.knowledge_chunks.length >= 1 && db.tables.knowledge_chunks.every((c) => c.business_id === 'b1' && c.embedding.length === 2));
    assert.equal(row.chunk_count, db.tables.knowledge_chunks.length);
});

test('a file from another business\'s folder, or a path with .., is refused', async () => {
    const { service, db } = setup();
    for (const storage_path of ['b2/x.pdf', 'b1/../b2/x.pdf', '']) {
        const r = await service.create({ businessId: 'b1', input: { title: 'x', storage_path, mime_type: 'application/pdf' } });
        assert.equal(r.ok, false);
    }
    assert.equal(db.tables.knowledge_sources.length, 0);
});

test('a typed note works without a file, and editing its text re-reads it', async () => {
    const { db, service } = setup();
    const { id } = await service.create({ businessId: 'b1', input: { title: 'Delivery', text: 'We deliver within Nairobi in one day for KES 300.' } });
    await settle();
    assert.equal(db.tables.knowledge_sources[0].status, 'ready');
    assert.equal((await service.create({ businessId: 'b1', input: { title: 'Tiny', text: 'hi' } })).error, 'text_too_short');
    await service.update({ businessId: 'b1', id, patch: { text: 'Delivery is free over KES 5,000 in Nairobi.' } });
    assert.equal(db.tables.knowledge_sources[0].status, 'processing');
    await settle();
    assert.equal(db.tables.knowledge_sources[0].status, 'ready');
    assert.match(db.tables.knowledge_chunks.map((c) => c.content).join(' '), /free over KES 5,000/);
    assert.doesNotMatch(db.tables.knowledge_chunks.map((c) => c.content).join(' '), /KES 300/, 'old pieces are replaced');
});

test('failures become a plain reason on the file, not a crash: empty balance, nothing readable, file missing', async () => {
    const broke = setup({ canAfford: async () => false, storage: { 'b1/a.pdf': new ArrayBuffer(1) } });
    const { id } = await broke.service.create({ businessId: 'b1', input: { title: 'A', storage_path: 'b1/a.pdf', mime_type: 'application/pdf' } });
    await settle();
    assert.match(broke.db.tables.knowledge_sources[0].status_detail, /balance is empty/);
    assert.equal(broke.db.tables.knowledge_sources[0].status, 'failed');

    const missing = setup();
    await missing.service.create({ businessId: 'b1', input: { title: 'B', storage_path: 'b1/gone.pdf', mime_type: 'application/pdf' } });
    await settle();
    assert.match(missing.db.tables.knowledge_sources[0].status_detail, /could not be opened/);
    assert.ok(id);
});

test('deleting removes the file from storage and the pieces with it, only for the owner business', async () => {
    const { db, service } = setup({ storage: { 'b1/sop.pdf': new ArrayBuffer(1) } });
    const { id } = await service.create({ businessId: 'b1', input: { title: 'SOP', storage_path: 'b1/sop.pdf', mime_type: 'application/pdf' } });
    await settle();
    assert.equal((await service.remove({ businessId: 'b2', id })).status, 404);
    assert.equal((await service.remove({ businessId: 'b1', id })).ok, true);
    assert.deepEqual(db.removed, ['b1/sop.pdf']);
    assert.equal(db.tables.knowledge_sources.length, 0);
});

test('a source stuck on "processing" after a restart is picked up again', async () => {
    const { db, service } = setup({ tables: { knowledge_sources: [{ id: 's1', business_id: 'b1', title: 'Old', file_type: 'text', raw_text: 'A long enough note about delivery times.', status: 'processing', updated_at: '2020-01-01T00:00:00Z' }] } });
    assert.equal(await service.resumeStuck(), 1);
    assert.equal(db.tables.knowledge_sources[0].status, 'ready');
});

test('a scanned PDF (no text inside) is read by the model instead, keeping its page numbers', async () => {
    const db = fakeSupabase({ knowledge_sources: [], knowledge_chunks: [] }, { storage: { 'b1/scan.pdf': new ArrayBuffer(1) } });
    const ai = { embedMany: async (t) => t.map(() => [0]), summarise: async () => '', readPdf: async () => '--- page 1 ---\nPrice list: lashes KES 3,500 for the classic set.\n--- page 2 ---\nDelivery within Nairobi is KES 300.' };
    const extractor = createExtractor({ ai, loadPdfParse: async () => async () => ({ text: '', numpages: 2 }), loadMammoth: async () => ({}) });
    const service = createKnowledgeService({ supabase: db, makeAi: () => ({ ai, extractor }) });
    await service.create({ businessId: 'b1', input: { title: 'Scan', storage_path: 'b1/scan.pdf', mime_type: 'application/pdf' } });
    await settle();
    assert.equal(db.tables.knowledge_sources[0].status, 'ready');
    assert.deepEqual(db.tables.knowledge_chunks.map((c) => c.page), [1, 2]);
});
