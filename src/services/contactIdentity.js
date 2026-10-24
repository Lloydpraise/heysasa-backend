// One person, one contact. WhatsApp knows a person by up to two ids (phone JID and LID), the owner may have added
// them by number before they ever wrote, and merged copies leave their old ids in alt_social_ids. Everything that
// creates WhatsApp contacts asks here first, so a history sync or contacts sync never adds a second copy of someone
// the business already has.
import { extractPhone, isLidJid, isUsableContactName } from './dataCleaner.js';

const CHUNK = 200;
const IDENTITY_COLS = 'id, social_id, alt_social_ids, name, phone, phone_key';

// The last 9 digits of a phone JID: the same rule as contacts.phone_key. A LID has no number.
export function phoneKeyOf(jid) {
    if (!jid || isLidJid(jid)) return null;
    const digits = String(extractPhone(jid) || '').replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : null;
}

// Contacts belong to one WhatsApp account (ACCOUNTS.md): the same person writing to two of a business's numbers is
// two contacts. With an accountId every lookup stays inside that account; without one it spans the business.
const owned = (query, businessId, accountId) => (accountId ? query.eq('business_id', businessId).eq('account_id', accountId) : query.eq('business_id', businessId));

const chunks = (list) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

// Before the merge migration (20261024000200) is run there is no alt_social_ids column yet; lookups then simply skip
// merged ids instead of failing every incoming message.
const OLD_COLS = 'id, social_id, name, phone, phone_key';
const isMissingColumn = (error) => error?.code === '42703' || /alt_social_ids/.test(error?.message || '');

// Map(socialId -> contact) for every id that already belongs to a contact of this business: by its WhatsApp id, by an
// id it was merged from, or by its number when exactly one contact has that number (two is ambiguous, never guessed).
export async function findContactsForIds(db, businessId, socialIds, accountId = null) {
    const ids = [...new Set((socialIds || []).filter(Boolean))];
    const found = new Map();
    const rest = () => ids.filter((id) => !found.has(id));
    let cols = IDENTITY_COLS;

    for (const part of chunks(ids)) {
        let { data, error } = await owned(db.from('contacts').select(cols), businessId, accountId)
            .eq('social_platform', 'whatsapp').in('social_id', part);
        if (error && cols === IDENTITY_COLS && isMissingColumn(error)) {
            cols = OLD_COLS;
            ({ data, error } = await owned(db.from('contacts').select(cols), businessId, accountId)
                .eq('social_platform', 'whatsapp').in('social_id', part));
        }
        if (error) throw error;
        for (const row of data || []) found.set(row.social_id, row);
    }

    if (cols === IDENTITY_COLS) {
        for (const part of chunks(rest())) {
            const { data, error } = await owned(db.from('contacts').select(cols), businessId, accountId)
                .overlaps('alt_social_ids', part);
            if (error) throw error;
            for (const row of data || []) for (const alt of row.alt_social_ids || []) if (part.includes(alt) && !found.has(alt)) found.set(alt, row);
        }
    }

    const idsByKey = new Map();
    for (const id of rest()) {
        const key = phoneKeyOf(id);
        if (key) idsByKey.set(key, [...(idsByKey.get(key) || []), id]);
    }
    for (const part of chunks([...idsByKey.keys()])) {
        const { data, error } = await owned(db.from('contacts').select(cols), businessId, accountId)
            .in('phone_key', part);
        if (error) throw error;
        const rowsByKey = new Map();
        for (const row of data || []) rowsByKey.set(row.phone_key, [...(rowsByKey.get(row.phone_key) || []), row]);
        for (const [key, rows] of rowsByKey) if (rows.length === 1) for (const id of idsByKey.get(key)) found.set(id, rows[0]);
    }
    if (cols === OLD_COLS) for (const row of found.values()) row.alt_social_ids = null;
    return found;
}

// What to write on a contact that was found for `socialIds`: a contact the owner added by number takes the WhatsApp id
// (LID preferred, it never changes), any other id is remembered as an alternative. A real number and a usable name
// only fill gaps: the owner's own name for a customer is never replaced by a WhatsApp profile name.
export function identityPatch(contact, socialIds, { name = null, ownerNames = [] } = {}) {
    const ids = [...new Set((socialIds || []).filter(Boolean))];
    const patch = {};
    let primary = contact.social_id || null;
    if (!primary && ids.length) {
        primary = ids.find(isLidJid) || ids[0];
        Object.assign(patch, { social_platform: 'whatsapp', social_id: primary });
    }
    if (contact.alt_social_ids !== null) {   // null: the column does not exist yet
        const alt = new Set(contact.alt_social_ids || []);
        const before = alt.size;
        for (const id of ids) if (id !== primary) alt.add(id);
        if (alt.size !== before) patch.alt_social_ids = [...alt];
    }

    const phone = ids.map((id) => (isLidJid(id) ? null : extractPhone(id))).find(Boolean);
    if (phone && !contact.phone) patch.phone = phone;
    if (name && isUsableContactName(name, ownerNames) && !hasRealName(contact.name, ownerNames)) patch.name = String(name).trim();
    return patch;
}

export function hasRealName(name, ownerNames = []) {
    return isUsableContactName(name, ownerNames) && String(name).trim().toLowerCase() !== 'new lead';
}

// Writes identityPatch for each contact found under another id. links: Map(contactId -> { contact, ids: Set, name }).
export async function linkFoundContacts(db, links, { ownerNames = [] } = {}) {
    let updated = 0;
    for (const { contact, ids, name } of links.values()) {
        const patch = identityPatch(contact, [...ids], { name, ownerNames });
        if (!Object.keys(patch).length) continue;
        const { error } = await db.from('contacts').update(patch).eq('id', contact.id);
        if (error) throw error;
        Object.assign(contact, patch);
        updated++;
    }
    return updated;
}

// Splits a batch of WhatsApp contacts into: ids that are already this exact contact (known), ids that belong to a
// contact under another id or number (linked, written by linkFoundContacts), and people the business does not have yet.
export async function sortSyncedContacts(db, businessId, rawContacts, nameOf = (c) => c.name || c.notify || c.verifiedName || null, accountId = null) {
    const found = await findContactsForIds(db, businessId, rawContacts.map((c) => c?.id), accountId);
    const known = [];
    const fresh = [];
    const links = new Map();
    const contactIdBySocialId = {};
    for (const c of rawContacts) {
        if (!c?.id) continue;
        const contact = found.get(c.id);
        if (!contact) { fresh.push(c); continue; }
        contactIdBySocialId[c.id] = contact.id;
        if (contact.social_id === c.id) { known.push(c); continue; }
        const link = links.get(contact.id) || { contact, ids: new Set(), name: null };
        link.ids.add(c.id);
        link.name = link.name || nameOf(c);
        links.set(contact.id, link);
    }
    return { known, fresh, links, found, contactIdBySocialId };
}
