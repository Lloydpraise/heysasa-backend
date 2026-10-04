import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  dedupeKey, nameSimilarity, findBestProductMatch, parsePrice, priceAppearsIn,
  addObservedPrice, mergeObservedPrices, pickPrice, redact, verifyQuote,
  isProductRelevantOwnerMessage, toBuffer, waImageRef, imageKeyFor,
  decryptWhatsAppMedia, encryptWhatsAppMedia, sniffImageType,
  clusterCandidates, applyConsolidation, clusterConfidence, passesEvidenceBar,
  formatCatalogForPrompt, groundNlpProducts, applyCategories, cleanCategory,
} from './productDiscovery.js';

// ─── names ───────────────────────────────────────────────────────────────────
test('dedupe key ignores case, word order, plural and filler words', () => {
  assert.equal(dedupeKey('Classic Lash Set'), dedupeKey('lash classic'));
  assert.equal(dedupeKey('Impano sandals'), dedupeKey('impano Sandal'));
});

test('similar names match, different products do not', () => {
  assert.ok(nameSimilarity('Volume Lash Set', 'volume lashes') >= 0.88);
  assert.ok(nameSimilarity('Classic Lash', 'Classic Lash Lift') < 0.88, 'a lift is not a lash set');
  assert.ok(nameSimilarity('2 door fridge', '3 door fridge') < 0.88);
  assert.ok(nameSimilarity('Lash', 'Lash Lift') < 0.88, 'one word must not swallow two');
  assert.equal(nameSimilarity('', 'Lash'), 0);
});

test('best match looks at aliases too and ignores weak matches', () => {
  const products = [
    { id: 'p1', title: 'Hybrid Lash Set', aliases: ['hybrid lashes'] },
    { id: 'p2', title: 'Lash Lift & Tint', aliases: [] },
  ];
  assert.equal(findBestProductMatch('Hybrid lash', products)?.product.id, 'p1');
  assert.equal(findBestProductMatch('brow lamination', products), null);
});

// ─── prices ──────────────────────────────────────────────────────────────────
test('parsePrice reads the formats Kenyan owners type', () => {
  assert.equal(parsePrice('2,500'), 2500);
  assert.equal(parsePrice('KES 2500'), 2500);
  assert.equal(parsePrice('Ksh 1,500/='), 1500);
  assert.equal(parsePrice('2.5k'), 2500);
  assert.equal(parsePrice('3k'), 3000);
  assert.equal(parsePrice(1800), 1800);
  assert.equal(parsePrice('2000-3000'), null);
  assert.equal(parsePrice('call us'), null);
  assert.equal(parsePrice(0), null);
  assert.equal(parsePrice(-5), null);
});

test('a price must appear in the line it came from', () => {
  assert.ok(priceAppearsIn('Classic set is 2,500 only', 2500));
  assert.ok(priceAppearsIn('Classic set kes 2500', 2500));
  assert.ok(priceAppearsIn('It is 2.5k', 2500));
  assert.ok(!priceAppearsIn('Classic set is 25000', 2500), '25000 is not 2500');
  assert.ok(!priceAppearsIn('Classic set is 3500', 2500));
  assert.ok(!priceAppearsIn('no number here', 2500));
});

test('observed prices count repeats, pick the most common, tie goes to latest', () => {
  let obs = [];
  obs = addObservedPrice(obs, 2500, '2026-09-01');
  obs = addObservedPrice(obs, 3000, '2026-09-10');
  obs = addObservedPrice(obs, 2500, '2026-09-12');
  assert.equal(pickPrice(obs).price, 2500);
  assert.equal(pickPrice(obs).spread, 1.2);
  const tie = addObservedPrice(addObservedPrice([], 2000, '2026-01-01'), 2500, '2026-05-01');
  assert.equal(pickPrice(tie).price, 2500);
  assert.equal(pickPrice([]).price, null);
  const merged = mergeObservedPrices(obs, [{ price: 3000, count: 5, last_seen: '2026-10-01' }]);
  assert.equal(merged[0].price, 3000);
});

// ─── safety ──────────────────────────────────────────────────────────────────
test('redact removes personal data but keeps prices', () => {
  const out = redact('Pay 2500 to 0712345678 or mail a@b.co, code SJK2L3M4N5, PIN A123456789Z, acct 123456789012');
  assert.ok(out.includes('2500'));
  assert.ok(!out.includes('0712345678'));
  assert.ok(!out.includes('a@b.co'));
  assert.ok(!out.includes('SJK2L3M4N5'));
  assert.ok(!out.includes('A123456789Z'));
  assert.ok(!out.includes('123456789012'));
});

test('quote check is word for word but ignores punctuation and case', () => {
  assert.ok(verifyQuote('classic set is 2,500', 'Hi! The *Classic set* is 2,500 only 😊'));
  assert.ok(!verifyQuote('classic set is 2,000', 'The Classic set is 2,500 only'));
  assert.ok(!verifyQuote('ok', 'ok'));
});

// ─── message relevance ───────────────────────────────────────────────────────
test('only product-like owner messages go to the model', () => {
  assert.ok(isProductRelevantOwnerMessage('Classic set is 2500', ''));
  assert.ok(isProductRelevantOwnerMessage('Tunauza sandals za aina nyingi', ''));
  assert.ok(isProductRelevantOwnerMessage('Yes we can do that for you', 'do you have the black one?'));
  assert.ok(isProductRelevantOwnerMessage('Lash lift and tint package', '', true));
  assert.ok(!isProductRelevantOwnerMessage('Good morning', ''));
  assert.ok(!isProductRelevantOwnerMessage('ok', ''));
  assert.ok(!isProductRelevantOwnerMessage('I will call you later today', 'hello'));
});

// ─── whatsapp media ──────────────────────────────────────────────────────────
const bytesAsObject = (buf) => Object.fromEntries([...buf].map((b, i) => [String(i), b]));

test('binary fields stored as {"0":..} objects, base64 and arrays all become buffers', () => {
  const buf = Buffer.from([1, 2, 3, 250]);
  assert.deepEqual(toBuffer(bytesAsObject(buf)), buf);
  assert.deepEqual(toBuffer(buf.toString('base64')), buf);
  assert.deepEqual(toBuffer([1, 2, 3, 250]), buf);
  assert.equal(toBuffer(null), null);
  assert.equal(toBuffer({}), null);
});

test('image key prefers the file hash, then the storage url, then the thumbnail', () => {
  const sha = crypto.randomBytes(32);
  const raw = { message: { imageMessage: { fileSha256: bytesAsObject(sha), url: 'https://mmg.whatsapp.net/x' } } };
  assert.equal(imageKeyFor({ raw_payload: raw, content: {} }), `wa:${sha.toString('hex')}`);
  assert.equal(imageKeyFor({ raw_payload: null, content: { media: { url: 'https://x.supabase.co/a.png' } } }), 'url:https://x.supabase.co/a.png');
  const thumbRaw = { message: { imageMessage: { jpegThumbnail: bytesAsObject(Buffer.from([9, 9, 9, 9])) } } };
  assert.match(imageKeyFor({ raw_payload: thumbRaw, content: {} }), /^th:[0-9a-f]{40}$/);
  assert.equal(imageKeyFor({ raw_payload: null, content: {} }), null);
});

test('image reference is found through ephemeral and view-once wrappers', () => {
  const inner = { imageMessage: { url: 'https://mmg.whatsapp.net/y', mediaKey: bytesAsObject(crypto.randomBytes(32)), mimetype: 'image/jpeg' } };
  const ref = waImageRef({ message: { ephemeralMessage: { message: { viewOnceMessage: { message: inner } } } } });
  assert.equal(ref.url, 'https://mmg.whatsapp.net/y');
  assert.equal(ref.mediaKey.length, 32);
});

test('whatsapp media decrypts back to the original and rejects tampering', () => {
  const key = crypto.randomBytes(32);
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5000)]);
  const enc = encryptWhatsAppMedia(plain, key, 'image');
  assert.deepEqual(decryptWhatsAppMedia(enc, key, 'image'), plain);
  const tampered = Buffer.from(enc); tampered[10] ^= 1;
  assert.throws(() => decryptWhatsAppMedia(tampered, key, 'image'), /MAC/);
  assert.throws(() => decryptWhatsAppMedia(enc, crypto.randomBytes(32), 'image'), /MAC/);
  assert.throws(() => decryptWhatsAppMedia(enc, Buffer.alloc(5), 'image'), /32 bytes/);
});

test('image type is sniffed from the bytes', () => {
  assert.equal(sniffImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)])), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])), 'image/png');
  assert.equal(sniffImageType(Buffer.from('<html>not an image at all</html>')), null);
});

// ─── clustering ──────────────────────────────────────────────────────────────
const cand = (name, price, ref, extra = {}) => ({
  name, kind: 'product', price,
  source: { kind: extra.kind || 'text', ref, contactId: extra.contactId || 1, observedAt: extra.at || '2026-09-01' },
  ...extra,
});

test('variants of one product collapse into a single cluster with the common name first', () => {
  const clusters = clusterCandidates([
    cand('Classic Lash Set', 2500, 'a'),
    cand('classic lashes', 2500, 'b', { contactId: 2 }),
    cand('Classic Lash Set', 2800, 'c', { contactId: 3 }),
    cand('Brow Lamination', 2000, 'd'),
  ]);
  assert.equal(clusters.length, 2);
  const classic = clusters.find((c) => c.name === 'Classic Lash Set');
  assert.ok(classic);
  assert.deepEqual(classic.aliases, ['classic lashes']);
  assert.equal(classic.sources.length, 3);
  assert.equal(pickPrice(classic.observedPrices).price, 2500);
});

test('lash lift stays separate from classic lashes', () => {
  const clusters = clusterCandidates([cand('Classic Lash', 2500, 'a'), cand('Classic Lash Lift', 1800, 'b')]);
  assert.equal(clusters.length, 2);
});

test('model merge groups only apply to real clusters and never invent a name', () => {
  const clusters = clusterCandidates([cand('Steel trolley', 4500, 'a'), cand('Kitchen trolley', 4500, 'b'), cand('Gas cooker', 20000, 'c')]);
  const merged = applyConsolidation(clusters, [
    { members: [0, 1], name: 'Kitchen trolley' },
    { members: [2, 99], name: 'Gas cooker' },       // 99 does not exist, so no merge
    { members: [0, 2], name: 'Anything' },          // 0 already used
  ]);
  assert.equal(merged.length, 2);
  const trolley = merged.find((c) => c.name === 'Kitchen trolley');
  assert.ok(trolley);
  assert.deepEqual(trolley.aliases, ['Steel trolley']);
  assert.ok(merged.some((c) => c.name === 'Gas cooker'));
  const invented = applyConsolidation(clusters, [{ members: [0, 1], name: 'Super trolley deluxe' }]);
  assert.ok(['Steel trolley', 'Kitchen trolley'].includes(invented.find((c) => c.aliases.length)?.name));
});

test('evidence bar: a lone unpriced text mention is not enough, a priced one or an image is', () => {
  const lone = clusterCandidates([cand('Mystery item', null, 'a')])[0];
  assert.equal(passesEvidenceBar(lone), false);
  const twice = clusterCandidates([cand('Mystery item', null, 'a'), cand('Mystery item', null, 'b', { contactId: 2 })])[0];
  assert.equal(passesEvidenceBar(twice), true);
  const priced = clusterCandidates([cand('Classic set', 2500, 'a')])[0];
  assert.equal(passesEvidenceBar(priced), true);
  const image = clusterCandidates([cand('Black sofa', null, 'img1', { kind: 'image' })])[0];
  assert.equal(passesEvidenceBar(image), true);
});

test('confidence rises with price, repeats, image proof and several customers', () => {
  const weak = clusterCandidates([cand('Thing', null, 'a')])[0];
  const strong = clusterCandidates([
    cand('Thing', 2500, 'a', { contactId: 1 }), cand('Thing', 2500, 'b', { contactId: 2 }),
    cand('Thing', 2500, 'c', { contactId: 3 }), cand('Thing', 2500, 'img', { kind: 'image', contactId: 4, nameSource: 'visible_text' }),
  ])[0];
  assert.ok(clusterConfidence(strong) > clusterConfidence(weak));
  assert.ok(clusterConfidence(strong) <= 1);
});

// ─── catalog and grounding ───────────────────────────────────────────────────
test('catalog lines carry id, price, aliases and are bounded', () => {
  const text = formatCatalogForPrompt([
    { id: 'p1', title: 'Classic Lash Set', price: 2500, aliases: ['classic lashes'], type: 'product' },
    { id: 'p2', title: 'UV Training', price: null, aliases: [], type: 'service', status: 'discovered' },
  ], { currency: 'KES' });
  assert.match(text, /ID: p1 \| Name: Classic Lash Set \| Price: KES 2,500 \| Also called: classic lashes/);
  assert.match(text, /ID: p2 \| Name: UV Training \| Status: discovered, unreviewed \| Type: service/);
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, title: `Item ${i}`, price: 100 }));
  const capped = formatCatalogForPrompt(many, { maxLines: 3 });
  assert.match(capped, /7 more products not shown/);
});

test('analyser product output is held to the catalog and the chat', () => {
  const catalog = new Map([
    ['p1', { title: 'Classic Lash Set', aliases: ['classic lashes'] }],
    ['p2', { title: 'Brow Lamination', aliases: [] }],
  ]);
  const fullText = 'Hi do you have classic lashes? I also want a gold necklace';
  const out = groundNlpProducts({
    matched_products: [
      { product_id: 'p1', product_name: 'whatever the model typed', match_status: 'matched' }, // real, mentioned
      { product_id: 'p1', product_name: 'classic lashes', match_status: 'matched' },          // duplicate ID is collapsed
      { product_id: 'p2', product_name: 'Brow Lamination', match_status: 'matched' },          // real id, never mentioned
      { product_id: 'p99', product_name: 'Gold necklace', match_status: 'matched' },           // invented id, mentioned
      { product_id: null, product_name: 'Diamond ring', match_status: 'no match' },            // never mentioned
    ],
    product_tags: ['classic lashes', 'jewellery', 'gold necklace', 'classic lashes'],
  }, { catalog, fullText });
  assert.deepEqual(out.matched_products, [
    { product_id: 'p1', product_name: 'Classic Lash Set', match_status: 'matched' },
    { product_id: null, product_name: 'Gold necklace', match_status: 'no match' },
  ]);
  assert.deepEqual(out.product_tags, ['Classic Lash Set', 'gold necklace']);
  for (const f of ['product_match_ungrounded', 'product_id_not_in_catalog', 'product_name_ungrounded', 'product_tag_ungrounded']) {
    assert.ok(out.flags.includes(f), `missing flag ${f}`);
  }
});

test('analyser can ground a discovered product identified in a conversation image', () => {
  const catalog = new Map([
    ['p1', { title: 'Gas Cooker 2 Burner', aliases: [], status: 'discovered' }],
    ['p2', { title: 'Gas Cooker 4 Burner', aliases: [], status: 'discovered' }],
  ]);
  const out = groundNlpProducts({
    matched_products: [
      { product_id: 'p1', product_name: 'Gas Cooker 2 Burner' },
      { product_id: 'p2', product_name: 'Gas Cooker 4 Burner' },
    ],
  }, {
    catalog,
    fullText: 'CUSTOMER: Do you have gas cookers?',
    conversationImageProductIds: new Set(['p1', 'p2']),
  });
  assert.deepEqual(out.matched_products, [
    { product_id: 'p1', product_name: 'Gas Cooker 2 Burner', match_status: 'matched' },
    { product_id: 'p2', product_name: 'Gas Cooker 4 Burner', match_status: 'matched' },
  ]);
  assert.deepEqual(out.flags, []);
});

test('analyser canonicalizes grounded product aliases with discovery matching rules', () => {
  const catalog = new Map([
    ['p1', { title: 'Classic Lash Set', aliases: ['classic lashes'], status: 'discovered' }],
  ]);
  const out = groundNlpProducts({
    matched_products: [],
    product_tags: ['classic lashes', 'classic lash set'],
  }, { catalog, fullText: 'CUSTOMER: Do you have classic lashes?' });
  assert.deepEqual(out.matched_products, [
    { product_id: 'p1', product_name: 'Classic Lash Set', match_status: 'matched' },
  ]);
});

test('analyser does not guess which catalog variants a broad category refers to', () => {
  const catalog = new Map([
    ['p1', { title: 'Gas Cooker 2 Burner', aliases: [] }],
    ['p2', { title: 'Gas Cooker 4 Burner', aliases: [] }],
  ]);
  const out = groundNlpProducts({
    matched_products: [],
    product_tags: ['gas cookers'],
  }, { catalog, fullText: 'CUSTOMER: Do you have gas cookers?' });
  assert.deepEqual(out.matched_products, []);
  assert.deepEqual(out.product_tags, ['gas cookers']);
});

test('an empty catalog and empty output are safe', () => {
  const out = groundNlpProducts({}, { catalog: new Map(), fullText: '' });
  assert.deepEqual(out, { matched_products: [], product_tags: [], flags: [] });
});

test('categories: reuse existing spelling, drop vague buckets, ignore bad indexes', () => {
  const picked = applyCategories(4, [
    { i: 0, category: 'lash sets' },
    { i: 1, category: 'Lash Sets' },
    { i: 2, category: 'Other' },
    { i: 9, category: 'Ghost' },
    { i: 3, category: 'x'.repeat(60) },
  ], ['Lash sets']);
  assert.equal(picked.get(0), 'Lash sets');
  assert.equal(picked.get(1), 'Lash sets');
  assert.equal(picked.has(2), false);
  assert.equal(picked.has(3), false);
  assert.equal(picked.size, 2);
  assert.equal(cleanCategory('aftercare'), 'Aftercare');
});
