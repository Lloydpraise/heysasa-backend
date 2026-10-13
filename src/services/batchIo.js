// Batch I/O helpers for the analyser (run-local.js).
//
// The analyser used to ask Supabase for one contact's messages at a time (4 stages x every contact)
// and wrote every contact/conversation row with its own request. With thousands of leads that is
// tens of thousands of calls. These helpers read in bulk (messages for hundreds of contacts per
// request) and write in bulk (one call per ~500 rows).

export const chunk = (items, size) => {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};

export function isMissingRpc(error) {
    return error?.code === 'PGRST202' || error?.code === '42883'
        || /could not find the function|function .* does not exist/i.test(error?.message || '');
}

const MESSAGE_SELECT = 'id, contact_id, direction, type, content, status, raw_payload, created_at';

// ─── Messages ────────────────────────────────────────────────────────────────
// preload(ids) loads the full history of many contacts together; get(id) then answers from memory.
// Full history is kept on purpose: ad attribution needs the very first inbound message.
// The cache is capped (rows, not contacts); when it is full it is emptied before the next preload.
export function createMessageStore({
    supabase,
    businessId = null,
    pageSize = 1000,
    idChunkSize = 200,
    maxCachedRows = Number(process.env.ANALYSER_MESSAGE_CACHE_ROWS) || 60000,
    select = MESSAGE_SELECT,
} = {}) {
    const cache = new Map();
    let cachedRows = 0;
    const stats = { requests: 0, rowsRead: 0, hits: 0, misses: 0 };
    const scope = () => (typeof businessId === 'function' ? businessId() : businessId);

    async function preload(contactIds) {
        const wanted = [...new Set(contactIds)];
        let need = wanted.filter((id) => !cache.has(id));
        if (!need.length) return;
        if (cachedRows >= maxCachedRows) { cache.clear(); cachedRows = 0; need = wanted; }

        for (const ids of chunk(need, idChunkSize)) {
            const byContact = new Map(ids.map((id) => [id, []]));
            let from = 0;
            for (;;) {
                let query = supabase.from('messages').select(select).in('contact_id', ids);
                const biz = scope();
                if (biz) query = query.eq('business_id', biz);
                query = query
                    .order('contact_id', { ascending: true })
                    .order('created_at', { ascending: true })
                    .order('id', { ascending: true })
                    .range(from, from + pageSize - 1);
                const { data, error } = await query;
                stats.requests++;
                if (error) throw new Error(`Fetch messages failed: ${error.message}`);
                if (!data || data.length === 0) break;
                stats.rowsRead += data.length;
                for (const row of data) byContact.get(row.contact_id)?.push(row);
                from += data.length;
                // A short page means the end, unless the server caps rows below pageSize; one more
                // (empty) request is cheap insurance against silently truncating a chat.
                if (data.length < Math.min(pageSize, 100)) break;
            }
            for (const [id, list] of byContact) { cache.set(id, list); cachedRows += list.length; }
        }
    }

    async function get(contactId) {
        if (cache.has(contactId)) { stats.hits++; return cache.get(contactId); }
        stats.misses++;
        await preload([contactId]);
        return cache.get(contactId) || [];
    }

    return { preload, get, stats, clear: () => { cache.clear(); cachedRows = 0; } };
}

// ─── Patch buffer ────────────────────────────────────────────────────────────
// add(key, patch) merges patches for the same row; flush() sends everything with one RPC per chunk
// (public.bulk_patch_rows). If that function has not been installed yet, or a chunk is rejected,
// rows are written one by one so nothing is lost and a single bad row cannot sink the rest.
export function createPatchBuffer({ supabase, table, keyColumn = 'id', chunkSize = 500, onRowError = () => {}, onNotice = () => {} }) {
    const pending = new Map();
    let rpcMissing = false;
    const stats = { rows: 0, bulkCalls: 0, rowCalls: 0, failed: 0 };

    return {
        add(key, patch) { pending.set(key, { ...(pending.get(key) || {}), ...patch }); },
        size: () => pending.size,
        stats,
        async flush() {
            if (!pending.size) return { written: 0, failed: 0 };
            const entries = [...pending.entries()];
            pending.clear();
            let written = 0, failed = 0;
            for (const part of chunk(entries, chunkSize)) {
                if (!rpcMissing) {
                    const { error } = await supabase.rpc('bulk_patch_rows', {
                        p_table: table, p_key: keyColumn, p_rows: part.map(([k, patch]) => ({ k, patch })),
                    });
                    stats.bulkCalls++;
                    if (!error) { written += part.length; stats.rows += part.length; continue; }
                    if (isMissingRpc(error)) {
                        rpcMissing = true;
                        onNotice('bulk_patch_rows is not installed yet; writing row by row. Run supabase/migrations/20261012000000_bulk_patch_rows.sql.');
                    } else {
                        onNotice(`Bulk write of ${part.length} ${table} rows failed (${error.message}); retrying them one by one.`);
                    }
                }
                for (const [k, patch] of part) {
                    const { error } = await supabase.from(table).update(patch).eq(keyColumn, k);
                    stats.rowCalls++;
                    if (error) { failed++; stats.failed++; await onRowError(k, error.message); } else { written++; stats.rows++; }
                }
            }
            return { written, failed };
        },
    };
}

// ─── Bulk insert / upsert / delete ───────────────────────────────────────────
// rows with the same dedupeKey inside one call collapse to the last one (an upsert cannot touch the
// same row twice in a single statement). Falls back to row-by-row if the bulk call is rejected.
export async function bulkWrite({ supabase, table, rows, mode = 'insert', onConflict = null, dedupeKey = null, chunkSize = 500, onRowError = () => {}, onNotice = () => {} }) {
    if (!rows.length) return { written: 0, failed: 0 };
    let list = rows;
    if (dedupeKey) {
        const map = new Map();
        for (const row of rows) map.set(dedupeKey(row), row);
        list = [...map.values()];
    }
    const send = (payload) => (mode === 'upsert'
        ? supabase.from(table).upsert(payload, { onConflict })
        : supabase.from(table).insert(payload));
    let written = 0, failed = 0;
    for (const part of chunk(list, chunkSize)) {
        const { error } = await send(part);
        if (!error) { written += part.length; continue; }
        onNotice(`Bulk ${mode} of ${part.length} ${table} rows failed (${error.message}); retrying them one by one.`);
        for (const row of part) {
            const { error: rowError } = await send(row);
            if (rowError) { failed++; await onRowError(dedupeKey ? dedupeKey(row) : null, `${table}: ${rowError.message}`); } else written++;
        }
    }
    return { written, failed };
}

export async function bulkDelete({ supabase, table, column, ids, chunkSize = 200, onRowError = () => {} }) {
    const list = [...new Set(ids)];
    let deleted = 0, failed = 0;
    for (const part of chunk(list, chunkSize)) {
        const { error } = await supabase.from(table).delete().in(column, part);
        if (error) { failed += part.length; await onRowError(null, `${table} cleanup failed: ${error.message}`); } else deleted += part.length;
    }
    return { deleted, failed };
}
