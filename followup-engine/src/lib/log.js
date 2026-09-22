// Emits one machine-readable line per event on stdout. The parent process
// (heysasa-backend/src/index.js, which spawns this service as a child)
// reads stdout line by line, recognizes the "@@LOG " prefix, parses the
// JSON, and feeds it into the same live/persisted log the rest of the
// backend uses — so a follow-up engine event shows up in the console
// exactly like a webhook or analysis event, filterable by area and level.
//
// If this service is ever run standalone (not spawned by the root
// process), these lines just print as plain text — still readable, just
// not parsed into the console.
function safeDetails(details) {
    try {
        return JSON.parse(JSON.stringify(details));
    } catch {
        return { note: 'unserializable_details' };
    }
}

export function log(level, area, event, message, ctx = {}) {
    const row = {
        level,
        area,
        event,
        message,
        business_id: ctx.business_id ?? ctx.businessId ?? null,
        contact_id: ctx.contact_id ?? ctx.contactId ?? null,
        entity_id: ctx.entity_id ?? ctx.entityId ?? null,
        duration_ms: ctx.duration_ms ?? ctx.durationMs ?? null,
        details: safeDetails(ctx.details !== undefined ? ctx.details : ctx),
    };
    console.log(`@@LOG ${JSON.stringify(row)}`);
}
