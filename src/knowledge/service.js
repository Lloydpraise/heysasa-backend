// Knowledge sources: save first, then analyse. The original file is already in storage when a source is created (the
// browser uploads it), so nothing is lost if analysis fails; the row just says why and can be retried.
//
// create() returns at once with status 'processing'. analyse() does the work: read the file, extract text the way its
// type needs, cut it into pieces, turn the pieces into vectors, save them, and mark the source 'ready'. Every AI call is
// billed to the business (runner `knowledge_analysis`).

import { chunkPages } from './chunker.js';
import { FAILURE_TEXT, FILE_TYPES, inferFileType } from './extract.js';

export const BUCKET = 'business-knowledge';
export const KINDS = ['procedure', 'catalogue', 'policy', 'product_info', 'faq', 'other'];
export const USED_BY = ['chat', 'followup', 'both'];
const STUCK_AFTER_MS = 4 * 60_000;

const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

export function cleanInput(raw = {}) {
    return {
        title: clip(raw.title, 120),
        use_case: clip(raw.use_case, 600),
        kind: oneOf(raw.kind, KINDS, 'other'),
        used_by: oneOf(raw.used_by, USED_BY, 'both'),
        is_active: raw.is_active === undefined ? true : raw.is_active === true,
    };
}

// makeAi(businessId) -> { ai, extractor }: built per source so every AI call is billed to the business that owns the file.
export function createKnowledgeService({ supabase, makeAi, canAfford, log = () => {}, now = () => new Date() }) {
    const fail = (id, code, detail) => supabase.from('knowledge_sources').update({
        status: 'failed', status_detail: detail || FAILURE_TEXT[code] || 'This file could not be analysed.', updated_at: now().toISOString(),
    }).eq('id', id);

    async function download(path) {
        const { data, error } = await supabase.storage.from(BUCKET).download(path);
        if (error || !data) throw Object.assign(new Error(error?.message || 'download failed'), { code: 'download_failed' });
        return Buffer.from(await data.arrayBuffer());
    }

    // The slow part. Never throws: any problem becomes status 'failed' with a plain-words reason.
    async function analyse(sourceId) {
        const { data: source, error } = await supabase.from('knowledge_sources').select('*').eq('id', sourceId).maybeSingle();
        if (error || !source) return { ok: false, error: 'not_found' };
        try {
            if (canAfford && !(await canAfford(source.business_id))) { await fail(sourceId, 'no_balance'); return { ok: false, error: 'no_balance' }; }

            const { ai, extractor } = makeAi(source.business_id);
            let buffer = null;
            if (source.file_type !== 'text' || !source.raw_text) buffer = await download(source.storage_path);
            const { pages, method } = await extractor.extract({
                fileType: source.file_type, buffer, fileName: source.file_name, mime: source.mime_type, rawText: source.raw_text,
            });

            const { chunks, truncated, total } = chunkPages(pages);
            if (!chunks.length) { await fail(sourceId, 'no_text'); return { ok: false, error: 'no_text' }; }

            const vectors = await ai.embedMany(chunks.map((c) => c.content));
            const fullText = chunks.map((c) => c.content).join('\n');
            const summary = await ai.summarise(fullText).catch(() => '');

            // Replace the old pieces (a retry or an edited note) only after the new ones are ready to go in.
            await supabase.from('knowledge_chunks').delete().eq('source_id', sourceId);
            const rows = chunks.map((c, i) => ({
                source_id: sourceId, business_id: source.business_id, chunk_index: c.index, page: c.page, content: c.content, embedding: vectors[i],
            }));
            for (let i = 0; i < rows.length; i += 50) {
                const { error: insertError } = await supabase.from('knowledge_chunks').insert(rows.slice(i, i + 50));
                if (insertError) throw new Error(`could not save the pieces: ${insertError.message}`);
            }
            await supabase.from('knowledge_sources').update({
                status: 'ready',
                status_detail: truncated ? `Only the first ${chunks.length} of ${total} pieces were saved (the file is very long).` : null,
                summary: summary || null, chunk_count: chunks.length, content_chars: fullText.length,
                processed_at: now().toISOString(), updated_at: now().toISOString(),
            }).eq('id', sourceId);
            log('info', `knowledge ${sourceId} ready (${method}, ${chunks.length} pieces)`, { businessId: source.business_id });
            return { ok: true, chunks: chunks.length, method };
        } catch (error) {
            const code = error?.code || (error?.kind === 'too_large' ? 'too_large_to_transcribe' : error?.kind === 'unavailable' || error?.kind === 'quota' || error?.kind === 'auth' ? 'unavailable' : null);
            log('error', `knowledge ${sourceId} failed: ${error?.message}`, { businessId: source.business_id });
            await fail(sourceId, code, code ? null : 'This file could not be analysed. Press Retry, or upload it again.');
            return { ok: false, error: code || 'failed' };
        }
    }

    return {
        process: analyse,

        async list(businessId) {
            const { data, error } = await supabase.from('knowledge_sources')
                .select('id, title, use_case, kind, file_type, used_by, is_active, status, status_detail, file_name, mime_type, size_bytes, summary, chunk_count, content_chars, raw_text, created_at, updated_at, processed_at')
                .eq('business_id', businessId).order('created_at', { ascending: false });
            if (error) throw new Error(error.message);
            return data ?? [];
        },

        // input: { title, use_case, kind, used_by, is_active } plus either { text } (a typed note) or
        // { storage_path, file_name, mime_type, size_bytes, file_type? } (a file the browser already uploaded).
        async create({ businessId, userId = null, input }) {
            const base = cleanInput(input);
            if (!base.title) return { ok: false, status: 400, error: 'title_required' };

            let row;
            if (typeof input.text === 'string' && !input.storage_path) {
                const text = input.text.trim();
                if (text.length < 10) return { ok: false, status: 400, error: 'text_too_short' };
                if (text.length > 200_000) return { ok: false, status: 400, error: 'text_too_long' };
                row = { ...base, file_type: 'text', raw_text: text, size_bytes: Buffer.byteLength(text) };
            } else {
                const path = String(input.storage_path ?? '');
                // A file can only be attached from this business's own folder.
                if (!path.startsWith(`${businessId}/`) || path.includes('..')) return { ok: false, status: 400, error: 'bad_storage_path' };
                const fileType = FILE_TYPES.includes(input.file_type) ? input.file_type : inferFileType({ mime: input.mime_type, fileName: input.file_name });
                if (!fileType) return { ok: false, status: 400, error: 'unsupported_file_type' };
                row = {
                    ...base, file_type: fileType, storage_path: path, file_name: clip(input.file_name, 200) || null,
                    mime_type: clip(input.mime_type, 100) || null, size_bytes: Number.isFinite(Number(input.size_bytes)) ? Number(input.size_bytes) : null,
                };
            }
            const { data, error } = await supabase.from('knowledge_sources')
                .insert({ ...row, business_id: businessId, created_by: userId, status: 'processing' }).select('id').single();
            if (error) return { ok: false, status: 500, error: 'could_not_save' };
            setImmediate(() => { analyse(data.id).catch((e) => log('error', `knowledge analysis crashed: ${e.message}`)); });
            return { ok: true, id: data.id };
        },

        async update({ businessId, id, patch }) {
            const { data: source } = await supabase.from('knowledge_sources').select('id, file_type, raw_text').eq('id', id).eq('business_id', businessId).maybeSingle();
            if (!source) return { ok: false, status: 404, error: 'not_found' };
            const update = { updated_at: now().toISOString() };
            const clean = cleanInput({ ...source, ...patch });
            if (patch.title !== undefined) update.title = clean.title || undefined;
            if (patch.use_case !== undefined) update.use_case = clean.use_case;
            if (patch.kind !== undefined) update.kind = clean.kind;
            if (patch.used_by !== undefined) update.used_by = clean.used_by;
            if (patch.is_active !== undefined) update.is_active = patch.is_active === true;
            let reprocess = false;
            if (source.file_type === 'text' && typeof patch.text === 'string' && patch.text.trim() !== (source.raw_text ?? '').trim()) {
                if (patch.text.trim().length < 10) return { ok: false, status: 400, error: 'text_too_short' };
                update.raw_text = patch.text.trim();
                update.status = 'processing';
                reprocess = true;
            }
            const { error } = await supabase.from('knowledge_sources').update(update).eq('id', id).eq('business_id', businessId);
            if (error) return { ok: false, status: 500, error: 'could_not_save' };
            if (reprocess) setImmediate(() => { analyse(id).catch(() => {}); });
            return { ok: true };
        },

        async retry({ businessId, id }) {
            const { data: source } = await supabase.from('knowledge_sources').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
            if (!source) return { ok: false, status: 404, error: 'not_found' };
            await supabase.from('knowledge_sources').update({ status: 'processing', status_detail: null, updated_at: now().toISOString() }).eq('id', id);
            setImmediate(() => { analyse(id).catch(() => {}); });
            return { ok: true };
        },

        async remove({ businessId, id }) {
            const { data: source } = await supabase.from('knowledge_sources').select('id, storage_path').eq('id', id).eq('business_id', businessId).maybeSingle();
            if (!source) return { ok: false, status: 404, error: 'not_found' };
            const { error } = await supabase.from('knowledge_sources').delete().eq('id', id).eq('business_id', businessId);   // pieces go with it
            if (error) return { ok: false, status: 500, error: 'could_not_delete' };
            if (source.storage_path) await supabase.storage.from(BUCKET).remove([source.storage_path]).catch(() => {});
            return { ok: true };
        },

        // A link to the original file that works for ten minutes.
        async signedUrl({ businessId, id }) {
            const { data: source } = await supabase.from('knowledge_sources').select('storage_path, file_name').eq('id', id).eq('business_id', businessId).maybeSingle();
            if (!source?.storage_path) return { ok: false, status: 404, error: 'not_found' };
            const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(source.storage_path, 600, { download: source.file_name || true });
            if (error || !data?.signedUrl) return { ok: false, status: 500, error: 'could_not_sign' };
            return { ok: true, url: data.signedUrl };
        },

        // After a restart or a crash, sources still marked 'processing' are picked up again.
        async resumeStuck() {
            const cutoff = new Date(now().getTime() - STUCK_AFTER_MS).toISOString();
            const { data } = await supabase.from('knowledge_sources').select('id').eq('status', 'processing').lt('updated_at', cutoff).limit(20);
            for (const row of data ?? []) await analyse(row.id);
            return (data ?? []).length;
        },
    };
}
