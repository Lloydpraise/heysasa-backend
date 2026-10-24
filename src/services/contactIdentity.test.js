import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';
import { findContactsForIds, identityPatch, sortSyncedContacts, linkFoundContacts, phoneKeyOf } from './contactIdentity.js';

// phone_key is a generated column in the database; the fake has to carry it by hand.
const contact = (row) => ({ alt_social_ids: [], social_platform: row.social_id ? 'whatsapp' : null, phone_key: row.phone ? row.phone.replace(/\D/g, '').slice(-9) : null, ...row });

function db() {
    return fakeSupabase({
        contacts: [
            contact({ id: 1, business_id: 'biz', name: 'Susan Dorika', phone: '0700324159', social_id: null }),
            contact({ id: 2, business_id: 'biz', name: 'Wanjiru', phone: '+254110905400', social_id: '194252797685859@lid', alt_social_ids: ['254110905400@s.whatsapp.net'] }),
            contact({ id: 3, business_id: 'biz', name: 'Ann', phone: '+254711000001', social_id: '254711000001@s.whatsapp.net' }),
            contact({ id: 4, business_id: 'biz', name: 'Twin A', phone: '0722000002', social_id: null }),
            contact({ id: 5, business_id: 'biz', name: 'Twin B', phone: '0722000002', social_id: null }),
            contact({ id: 6, business_id: 'other', name: 'Not yours', phone: '0733000003', social_id: null }),
        ],
    });
}

test('a phone id has a number key, a LID does not', () => {
    assert.equal(phoneKeyOf('254700324159@s.whatsapp.net'), '700324159');
    assert.equal(phoneKeyOf('194252797685859@lid'), null);
});

test('finds a person by WhatsApp id, by an id they were merged from, and by the number the owner typed', async () => {
    const found = await findContactsForIds(db(), 'biz', [
        '254711000001@s.whatsapp.net', '254110905400@s.whatsapp.net', '254700324159@s.whatsapp.net', '254799999999@s.whatsapp.net',
    ]);
    assert.equal(found.get('254711000001@s.whatsapp.net').id, 3);
    assert.equal(found.get('254110905400@s.whatsapp.net').id, 2);
    assert.equal(found.get('254700324159@s.whatsapp.net').id, 1);
    assert.equal(found.has('254799999999@s.whatsapp.net'), false);
});

test('two contacts with the same number are never guessed, and other businesses are never matched', async () => {
    const found = await findContactsForIds(db(), 'biz', ['254722000002@s.whatsapp.net', '254733000003@s.whatsapp.net']);
    assert.equal(found.size, 0);
});

test('an imported contact takes the WhatsApp id; a WhatsApp contact keeps it as an extra id', () => {
    assert.deepEqual(identityPatch({ id: 1, social_id: null, name: 'Susan Dorika', phone: '0700324159' }, ['254700324159@s.whatsapp.net'], { name: 'Sue' }),
        { social_platform: 'whatsapp', social_id: '254700324159@s.whatsapp.net' });
    assert.deepEqual(identityPatch({ id: 3, social_id: '254711000001@s.whatsapp.net', alt_social_ids: [], name: '' }, ['1234@lid'], { name: 'Ann W' }),
        { alt_social_ids: ['1234@lid'], name: 'Ann W' });
    assert.deepEqual(identityPatch({ id: 2, social_id: '9@lid', alt_social_ids: ['254110905400@s.whatsapp.net'], name: 'Wanjiru', phone: '+254110905400' }, ['9@lid', '254110905400@s.whatsapp.net']), {});
});

test('a history sync links imported people instead of adding them again', async () => {
    const d = db();
    const synced = [
        { id: '254700324159@s.whatsapp.net', notify: 'Sue' },   // imported by the owner
        { id: '254711000001@s.whatsapp.net', notify: 'Ann' },   // already this contact
        { id: '254788000004@s.whatsapp.net', notify: 'New' },   // new person
    ];
    const { known, fresh, links, contactIdBySocialId } = await sortSyncedContacts(d, 'biz', synced);
    assert.deepEqual(known.map((c) => c.id), ['254711000001@s.whatsapp.net']);
    assert.deepEqual(fresh.map((c) => c.id), ['254788000004@s.whatsapp.net']);
    assert.equal(contactIdBySocialId['254700324159@s.whatsapp.net'], 1);
    assert.equal(await linkFoundContacts(d, links), 1);
    const susan = d.tables.contacts.find((c) => c.id === 1);
    assert.equal(susan.social_id, '254700324159@s.whatsapp.net');
    assert.equal(susan.name, 'Susan Dorika');
    assert.equal(d.tables.contacts.length, 6);
});

test('before the migration adds alt_social_ids, lookups still work and never write the missing column', async () => {
    const d = db();
    const real = d.from.bind(d);
    d.from = (name) => {
        const api = real(name);
        const select = api.select;
        api.select = (cols, opts) => {
            if (String(cols).includes('alt_social_ids')) {
                const failing = { eq: () => failing, in: () => failing, overlaps: () => failing, then: (ok) => ok({ data: null, error: { code: '42703', message: 'column contacts.alt_social_ids does not exist' } }) };
                return failing;
            }
            return select(cols, opts);
        };
        return api;
    };
    const found = await findContactsForIds(d, 'biz', ['254711000001@s.whatsapp.net', '1234@lid']);
    assert.equal(found.get('254711000001@s.whatsapp.net').id, 3);
    assert.deepEqual(identityPatch(found.get('254711000001@s.whatsapp.net'), ['254711000001@s.whatsapp.net', '1234@lid']), {});
});
