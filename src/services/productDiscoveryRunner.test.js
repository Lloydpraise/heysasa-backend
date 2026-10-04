// End to end: in-memory database, fake OpenAI, fake WhatsApp downloads.
// Proves the whole pipeline: scoping, text mining, image decrypt + read, matching, writes, re-runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runProductDiscovery } from './productDiscoveryRunner.js';
import { encryptWhatsAppMedia } from '../productDiscovery.js';

// ─── tiny in-memory Supabase ────────────────────────────────────────────────
class Query {
  constructor(db, table) { Object.assign(this, { db, table, op: 'select', filters: [], orders: [], range_: null, limit_: null, single: false }); }
  select() { return this; }
  insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows, opts) { this.op = 'upsert'; this.payload = rows; this.opts = opts; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  is(c, v) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
  or() { return this; }
  order(c) { this.orders.push(c); return this; }
  range(a, b) { this.range_ = [a, b]; return this; }
  limit(n) { this.limit_ = n; return this; }
  maybeSingle() { this.single = true; return this; }
  then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject?.(e); } }
  run() {
    const rows = this.db[this.table] || (this.db[this.table] = []);
    const match = (r) => this.filters.every((f) => f(r));
    if (this.op === 'insert') {
      for (const r of [].concat(this.payload)) rows.push({ id: crypto.randomUUID(), ...r });
      return { data: null, error: null };
    }
    if (this.op === 'upsert') {
      const keys = String(this.opts?.onConflict || 'id').split(',');
      for (const r of [].concat(this.payload)) {
        const hit = rows.find((x) => keys.every((k) => x[k] === r[k]));
        if (hit) Object.assign(hit, r); else rows.push({ id: crypto.randomUUID(), ...r });
      }
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      for (const r of rows.filter(match)) Object.assign(r, this.payload);
      return { data: null, error: null };
    }
    let out = rows.filter(match);
    for (const c of [...this.orders].reverse()) out = [...out].sort((a, b) => String(a[c] ?? '').localeCompare(String(b[c] ?? '')));
    if (this.range_) out = out.slice(this.range_[0], this.range_[1] + 1);
    if (this.limit_) out = out.slice(0, this.limit_);
    if (this.single) return { data: out[0] || null, error: null };
    return { data: out.map((r) => ({ ...r })), error: null };
  }
}
function fakeSupabase(db) {
  const uploads = [];
  return {
    uploads,
    from: (table) => new Query(db, table),
    storage: {
      from: (bucket) => ({
        upload: async (path, bytes, opts) => { uploads.push({ bucket, path, size: bytes.length, contentType: opts.contentType }); return { error: null }; },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://files.test/${bucket}/${path}` } }),
      }),
    },
  };
}

// ─── fixtures ───────────────────────────────────────────────────────────────
const bytesAsObject = (buf) => Object.fromEntries([...buf].map((b, i) => [String(i), b]));
const jpeg = (seed) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed), crypto.randomBytes(3000)]);

function makeWorld() {
  const sofaPlain = jpeg('sofa');
  const proofPlain = jpeg('proof');
  const sofaKey = crypto.randomBytes(32);
  const proofKey = crypto.randomBytes(32);
  const files = {
    'https://mmg.whatsapp.net/sofa': encryptWhatsAppMedia(sofaPlain, sofaKey),
    'https://mmg.whatsapp.net/proof': encryptWhatsAppMedia(proofPlain, proofKey),
  };
  const imgMsg = (id, contact, caption, url, key, plain, at) => ({
    id, contact_id: contact, business_id: 'biz1', direction: 'out', agent_role: 'human', type: 'image', created_at: at,
    content: { text: caption, type: 'image', caption },
    raw_payload: { message: { imageMessage: {
      url, mediaKey: bytesAsObject(key), mimetype: 'image/jpeg', caption,
      fileSha256: bytesAsObject(crypto.createHash('sha256').update(plain).digest()),
    } } },
  });
  const msg = (id, contact, direction, text, at, role) => ({
    id, contact_id: contact, business_id: 'biz1', direction, agent_role: role ?? (direction === 'out' ? 'human' : 'legacy_ai'),
    type: 'text', content: { text, type: 'text' }, created_at: at,
  });
  return {
    files,
    db: {
      businesses: [{ business_id: 'biz1', name: 'Test Lashes', industry: 'beauty', business_type: 'service', currency: 'KES' }],
      contacts: [
        { id: 1, business_id: 'biz1', lead_type: 'business' }, { id: 2, business_id: 'biz1', lead_type: 'business' },
        { id: 3, business_id: 'biz1', lead_type: 'business' }, { id: 4, business_id: 'biz1', lead_type: 'vendor' },
      ],
      products: [
        { id: 'p1', business_id: 'biz1', title: 'Hybrid Lash Set', aliases: [], status: 'approved', price: 3000, price_source: 'owner', type: 'product', images: [], observed_prices: [], mention_count: 0 },
        { id: 'p2', business_id: 'biz1', title: 'Gold Necklace', aliases: [], status: 'dismissed', price: null, price_source: null, type: 'product', images: [], observed_prices: [], mention_count: 0 },
      ],
      messages: [
        msg('m1', 1, 'in', 'How much for classic lashes?', '2026-09-01T08:00:00Z'),
        msg('m2', 1, 'out', 'Classic set is 2,500 only', '2026-09-01T08:01:00Z'),
        msg('m3', 2, 'out', 'Volume lashes 3500 kes', '2026-09-02T08:00:00Z'),
        msg('m4', 3, 'out', 'The classic lash set is 2500', '2026-09-03T08:00:00Z'),
        msg('m5', 3, 'out', 'Hybrid lashes are 3000', '2026-09-03T08:05:00Z'),
        msg('m6', 3, 'out', 'We also sell a gold necklace for 5000', '2026-09-03T08:06:00Z'),
        msg('m7', 3, 'out', 'Good morning', '2026-09-03T09:00:00Z'),
        msg('m8', 3, 'out', 'We have a mystery gadget at 7777 kes', '2026-09-03T09:10:00Z'),
        msg('m9', 4, 'out', 'Ads package 20000 for the month', '2026-09-04T08:00:00Z'),
        imgMsg('i1', 1, 'Black leather sofa', 'https://mmg.whatsapp.net/sofa', sofaKey, sofaPlain, '2026-09-05T08:00:00Z'),
        imgMsg('i2', 2, 'Black leather sofa', 'https://mmg.whatsapp.net/sofa', sofaKey, sofaPlain, '2026-09-05T09:00:00Z'),
        imgMsg('i3', 3, 'MPesa confirmation', 'https://mmg.whatsapp.net/proof', proofKey, proofPlain, '2026-09-05T10:00:00Z'),
        { ...imgMsg('i4', 3, 'Something gone', 'https://mmg.whatsapp.net/gone', crypto.randomBytes(32), jpeg('x'), '2026-09-05T11:00:00Z') },
      ],
      enrichment_runs: [], product_mentions: [], product_image_reads: [], ai_bots_config: [],
    },
  };
}

// ─── fake network ───────────────────────────────────────────────────────────
function installFetch(world, calls) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://mmg.whatsapp.net/')) {
      const file = world.files[u];
      if (!file) return new Response('gone', { status: 404 });
      return new Response(file, { status: 200, headers: { 'content-length': String(file.length) } });
    }
    if (u.startsWith('https://api.openai.com/')) {
      const body = JSON.parse(init.body);
      const system = body.messages[0].content;
      const user = body.messages[1].content;
      let result;
      if (system.includes('You find the products and services')) {
        calls.text++;
        const items = [];
        for (const m of String(user).matchAll(/\[(s\d+)\][\s\S]*?OWNER: ([^\n]+)/g)) {
          const [, id, owner] = m;
          if (/classic/i.test(owner)) items.push({ snippet_id: id, name: 'Classic Lash Set', kind: 'product', price: 2500, quote: owner.slice(0, 40) });
          if (/volume/i.test(owner)) items.push({ snippet_id: id, name: 'Volume Lashes', kind: 'product', price: 3500, quote: owner });
          if (/hybrid/i.test(owner)) items.push({ snippet_id: id, name: 'Hybrid Lashes', kind: 'product', price: 3000, quote: owner });
          if (/gold necklace/i.test(owner)) items.push({ snippet_id: id, name: 'Gold necklace', kind: 'product', price: 5000, quote: owner });
          if (/mystery/i.test(owner)) items.push({ snippet_id: id, name: 'Mystery gadget', kind: 'product', price: 9999, quote: owner });   // wrong price
          if (/ads package/i.test(owner)) items.push({ snippet_id: id, name: 'Ads package', kind: 'service', price: 20000, quote: owner });
        }
        items.push({ snippet_id: 's1', name: 'Invented thing', kind: 'product', price: 100, quote: 'this was never said by anyone' });   // must be dropped
        result = { items };
      } else if (system.includes('look at one image')) {
        calls.image++;
        const text = Array.isArray(user) ? user[0].text : '';
        const hasImage = Array.isArray(user) && user[1]?.image_url?.url?.startsWith('data:image/jpeg;base64,');
        assert.ok(hasImage, 'image must be sent as a base64 data url');
        result = /Black leather sofa/.test(text)
          ? { image_type: 'product_photo', confidence: 0.9, items: [{ name: 'Black leather sofa', kind: 'product', price: 45000, name_source: 'caption' }] }
          : { image_type: 'payment_proof', confidence: 0.95, items: [{ name: 'Should be ignored', kind: 'product', price: 1, name_source: 'described' }] };
      } else if (system.includes('You tidy a list')) {
        calls.merge++;
        result = { groups: [] };
      } else if (system.includes('You sort a business')) {
        calls.cat = (calls.cat || 0) + 1;
        const names = [...String(user).matchAll(/"i":(\d+),"name":"([^"]+)"/g)];
        result = { assignments: names.map(([, i, n]) => ({ i: Number(i), category: /lash/i.test(n) ? 'lash extensions' : 'Furniture' })) };
      } else {
        throw new Error('unexpected prompt');
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(url, init);
  };
  return () => { globalThis.fetch = real; };
}

const quiet = { log() {}, warn() {}, err() {} };
const baseCtx = (supabase, extra = {}) => ({ supabase, businessId: 'biz1', openaiKey: 'test', ...quiet, ...extra });

test('discovery finds products from chats and images, with proof, and leaves approved ones alone', async () => {
  const world = makeWorld();
  const supabase = fakeSupabase(world.db);
  const calls = { text: 0, image: 0, merge: 0 };
  const restore = installFetch(world, calls);
  const usage = [];
  try {
    const summary = await runProductDiscovery(baseCtx(supabase, { recordUsage: async (u) => usage.push(u) }));

    const discovered = world.db.products.filter((p) => p.status === 'discovered');
    const names = discovered.map((p) => p.title).sort();
    assert.deepEqual(names, ['Black leather sofa', 'Classic Lash Set', 'Volume Lashes']);

    const classic = discovered.find((p) => p.title === 'Classic Lash Set');
    assert.equal(classic.price, 2500);
    assert.equal(classic.price_source, 'chat');
    assert.equal(classic.source, 'chat');
    assert.equal(classic.mention_count, 2, 'two different customers were quoted this');
    assert.equal(classic.is_visible, false, 'discovered products must never reach a storefront');
    assert.equal(classic.stock_quantity, 0);
    assert.equal(classic.type, 'product');
    assert.ok(classic.id.startsWith('prd_'));
    assert.ok(classic.dedupe_key);

    const sofa = discovered.find((p) => p.title === 'Black leather sofa');
    assert.equal(sofa.source, 'image');
    assert.equal(sofa.price, 45000);
    assert.equal(sofa.price_source, 'image');
    assert.equal(sofa.images.length, 1);
    assert.match(sofa.images[0], /^https:\/\/files\.test\/product-images\/biz1\/[0-9a-f]{40}\.jpg$/);

    // dropped on purpose
    assert.ok(!world.db.products.some((p) => /Ads package/i.test(p.title)), 'vendor chat must not feed products');
    assert.ok(!world.db.products.some((p) => /Invented/i.test(p.title)), 'a line nobody said must be dropped');
    assert.ok(!world.db.products.some((p) => /Mystery/i.test(p.title)), 'one unpriced mention is not enough evidence');
    assert.equal(world.db.products.filter((p) => /necklace/i.test(p.title)).length, 1, 'dismissed product stays dismissed, no twin');
    assert.equal(summary.skipped_dismissed, 1);
    assert.equal(summary.text_price_dropped, 1, 'the 9999 price was not in the line');
    assert.ok(summary.text_dropped_unverified >= 1);

    // approved product: evidence and counters only
    const hybrid = world.db.products.find((p) => p.id === 'p1');
    assert.equal(hybrid.status, 'approved');
    assert.equal(hybrid.title, 'Hybrid Lash Set');
    assert.equal(hybrid.price, 3000);
    assert.equal(hybrid.mention_count, 1);
    assert.equal(summary.matched_approved, 1);

    // evidence
    const classicMentions = world.db.product_mentions.filter((m) => m.product_id === classic.id);
    assert.deepEqual(classicMentions.map((m) => m.message_id).sort(), ['m2', 'm4']);
    assert.ok(classicMentions.every((m) => m.kind === 'text' && m.quote));
    const sofaMention = world.db.product_mentions.find((m) => m.product_id === sofa.id);
    assert.equal(sofaMention.kind, 'image');
    assert.equal(sofaMention.contact_count, 2, 'the same picture went to two customers but is one piece of evidence');
    assert.equal(sofaMention.send_count, 2);

    // images: read once each, private one never stored
    const reads = Object.fromEntries(world.db.product_image_reads.map((r) => [r.image_type || r.status, r]));
    assert.equal(world.db.product_image_reads.length, 3);
    assert.equal(reads.product_photo.status, 'read');
    assert.equal(reads.payment_proof.items.length, 0);
    assert.equal(reads.unreachable.status, 'unreachable');
    assert.equal(supabase.uploads.length, 1, 'only the product photo is stored, never the payment proof');
    assert.equal(supabase.uploads[0].bucket, 'product-images');
    assert.equal(calls.image, 2, 'one vision call per distinct image that could be downloaded');
    assert.equal(summary.images_private_skipped, 1);
    assert.equal(summary.images_unreachable, 1);

    // categories: new products get one, an uncategorised approved product is filled, spelling is shared
    assert.equal(classic.category, 'Lash extensions');
    assert.equal(classic.category_source, 'ai');
    assert.equal(sofa.category, 'Furniture');
    assert.equal(hybrid.category, 'Lash extensions', 'a blank category on an approved product is filled in');
    assert.equal(hybrid.title, 'Hybrid Lash Set', 'but nothing else about it changes');
    assert.ok(summary.categorised >= 3);

    // run bookkeeping and cost logging
    const run = world.db.enrichment_runs[0];
    assert.equal(run.run_type, 'product_discovery');
    assert.equal(run.status, 'completed');
    assert.ok(usage.length >= 4);
    assert.ok(usage.some((u) => u.botId === 'product_image_reader' && u.inputType === 'image'));
  } finally { restore(); }
});

test('a second run adds nothing new and never reads the same image twice', async () => {
  const world = makeWorld();
  const supabase = fakeSupabase(world.db);
  const calls = { text: 0, image: 0, merge: 0 };
  const restore = installFetch(world, calls);
  try {
    await runProductDiscovery(baseCtx(supabase));
    const before = JSON.stringify(world.db.products.map((p) => [p.id, p.title, p.status]));
    const imageCallsAfterFirst = calls.image;
    const textCallsAfterFirst = calls.text;
    const mentionsBefore = world.db.product_mentions.length;

    const second = await runProductDiscovery(baseCtx(supabase));
    assert.equal(JSON.stringify(world.db.products.map((p) => [p.id, p.title, p.status])), before);
    assert.equal(world.db.product_mentions.length, mentionsBefore);
    assert.equal(calls.text, textCallsAfterFirst, 'no new owner messages, so no text calls');
    assert.equal(calls.image, imageCallsAfterFirst, 'already-read images are skipped; the unreachable one is retried but cannot be downloaded');
    assert.equal(second.new_discovered, 0);
  } finally { restore(); }
});

test('a product the owner dismisses is never suggested again, even when forced', async () => {
  const world = makeWorld();
  const supabase = fakeSupabase(world.db);
  const restore = installFetch(world, { text: 0, image: 0, merge: 0 });
  try {
    await runProductDiscovery(baseCtx(supabase));
    const classic = world.db.products.find((p) => p.title === 'Classic Lash Set');
    classic.status = 'dismissed';
    const countBefore = world.db.products.length;
    const again = await runProductDiscovery(baseCtx(supabase, { force: true }));
    assert.equal(world.db.products.length, countBefore, 'no twin created');
    assert.ok(again.skipped_dismissed >= 1);
    assert.equal(world.db.products.find((p) => p.id === classic.id).status, 'dismissed');
  } finally { restore(); }
});

test('an owner price edit on a discovered product survives the next run', async () => {
  const world = makeWorld();
  const supabase = fakeSupabase(world.db);
  const restore = installFetch(world, { text: 0, image: 0, merge: 0 });
  try {
    await runProductDiscovery(baseCtx(supabase));
    const classic = world.db.products.find((p) => p.title === 'Classic Lash Set');
    classic.price = 2800;
    classic.price_source = 'owner';
    await runProductDiscovery(baseCtx(supabase, { force: true }));
    assert.equal(world.db.products.find((p) => p.id === classic.id).price, 2800);
  } finally { restore(); }
});

test('dry run reads and reports but writes nothing', async () => {
  const world = makeWorld();
  const supabase = fakeSupabase(world.db);
  const restore = installFetch(world, { text: 0, image: 0, merge: 0 });
  try {
    const summary = await runProductDiscovery(baseCtx(supabase, { dryRun: true }));
    assert.equal(world.db.products.length, 2);
    assert.equal(world.db.product_mentions.length, 0);
    assert.equal(world.db.product_image_reads.length, 0);
    assert.equal(world.db.enrichment_runs.length, 0);
    assert.equal(supabase.uploads.length, 0);
    assert.equal(summary.new_discovered, 3);
    assert.ok(summary.preview.some((p) => p.decision === 'new_discovered'));
  } finally { restore(); }
});

test('with no customer chats yet it stops and says to run the analyser first', async () => {
  const world = makeWorld();
  world.db.contacts.forEach((c) => { c.lead_type = 'unknown'; });
  const supabase = fakeSupabase(world.db);
  const restore = installFetch(world, { text: 0, image: 0, merge: 0 });
  try {
    const summary = await runProductDiscovery(baseCtx(supabase));
    assert.equal(summary.reason, 'no_classified_customers');
    assert.equal(world.db.products.length, 2);
    assert.equal(world.db.enrichment_runs[0].status, 'insufficient_data');
  } finally { restore(); }
});
