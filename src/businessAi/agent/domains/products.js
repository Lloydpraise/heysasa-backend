// Products: what HeySasa found the business sells, what the AI may talk about, and prices.
import { ToolError, asText, chunk, clip, fetchAll, must, plural, uniq } from '../helpers.js';

const STATUS_WORDS = { discovered: 'found in chats, not yet approved', approved: 'approved (the AI can sell it)', dismissed: 'dismissed' };
const MAX_BATCH = 200;

const view = (p) => ({ id: p.id, title: p.title, status: p.status, price: p.price ?? null, old_price: p.old_price ?? null, category: p.category ?? null, ai_can_talk_about_it: Boolean(p.ai_visible), in_stock: p.stock_quantity ?? null, mentioned_in_chats: p.mention_count ?? 0, short_description: clip(p.description_short, 160) || undefined });

const list_products = {
  name: 'list_products', area: 'products', kind: 'read', status: 'Looking at your products…',
  description: 'The business\'s products: those HeySasa found in chats (status discovered), approved ones the AI sells, and dismissed ones. Optionally filter by status or a word in the title. Use the ids with change_products.',
  parameters: { type: 'object', properties: { status: { type: 'string', enum: ['discovered', 'approved', 'dismissed'] }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
  async run(ctx, args) {
    const rows = await fetchAll((from, to) => {
      let q = ctx.db.from('products').select('*').eq('business_id', ctx.businessId);
      if (args.status) q = q.eq('status', args.status);
      return q.order('mention_count', { ascending: false }).range(from, to);
    }, { max: 3000 });
    const needle = asText(args.query).toLowerCase();
    const hits = needle ? rows.filter((r) => String(r.title || '').toLowerCase().includes(needle)) : rows;
    const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
    return { counts, what_statuses_mean: STATUS_WORDS, showing: Math.min(hits.length, args.limit ?? 20), products: hits.slice(0, args.limit ?? 20).map(view) };
  },
};

async function ownProducts(ctx, ids) {
  const out = [];
  for (const part of chunk(ids, 200)) out.push(...(must(await ctx.db.from('products').select('id, title, status, ai_visible, price, old_price, category, description_short, stock_quantity').eq('business_id', ctx.businessId).in('id', part), 'products') ?? []));
  return out;
}

const ACTIONS = {
  approve: { patch: { status: 'approved', ai_visible: true }, verb: 'Approve', done: 'Approved', note: 'The AI will be able to talk about and sell these.' },
  dismiss: { patch: { status: 'dismissed', ai_visible: false }, verb: 'Dismiss', done: 'Dismissed', note: 'The AI will not talk about these.' },
  restore: { patch: { status: 'discovered' }, verb: 'Move back to "found"', done: 'Moved back to found', note: 'They go back to the not-yet-approved pile.' },
  show_to_ai: { patch: { ai_visible: true }, verb: 'Let the AI talk about', done: 'Let the AI talk about', note: 'The AI can mention these in chats.' },
  hide_from_ai: { patch: { ai_visible: false }, verb: 'Hide from the AI', done: 'Hid from the AI', note: 'The AI will not mention these.' },
};

const change_products = {
  name: 'change_products', area: 'products', kind: 'propose', risk: 'normal',
  description: 'Approve, dismiss or restore products, or choose whether the AI may talk about them. Pass product ids from list_products (up to 200). Only approve what is really sold by the business.',
  parameters: { type: 'object', properties: { product_ids: { type: 'array', items: { type: ['string', 'number'] }, minItems: 1, maxItems: MAX_BATCH }, action: { type: 'string', enum: Object.keys(ACTIONS) } }, required: ['product_ids', 'action'], additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const a = ACTIONS[args.action];
    if (!a) throw new ToolError('I do not know that action.');
    const ids = uniq(args.product_ids).slice(0, MAX_BATCH);
    const rows = await ownProducts(ctx, ids);
    if (!rows.length) throw new ToolError('I could not find those products.');
    const changing = rows.filter((r) => Object.entries(a.patch).some(([k, v]) => r[k] !== v));
    if (!changing.length) throw new ToolError('They are all already like that.');
    return { title: `${a.verb} ${plural(changing.length, 'product')}`, params: { ids: changing.map((r) => r.id), action: args.action }, preview: { headline: `${a.verb} ${plural(changing.length, 'product')}`, lines: [...changing.slice(0, 6).map((r) => r.title), ...(changing.length > 6 ? [`and ${changing.length - 6} more`] : []), a.note] } };
  },
  async execute(ctx, params) {
    const a = ACTIONS[params.action];
    const rows = await ownProducts(ctx, params.ids);
    if (!rows.length) throw new ToolError('Those products are gone, so nothing was changed.');
    for (const part of chunk(rows.map((r) => r.id), 200)) must(await ctx.db.from('products').update(a.patch).eq('business_id', ctx.businessId).in('id', part), 'update products');
    return { summary: `${a.done} ${plural(rows.length, 'product')}.`, result: { count: rows.length }, before: { rows: rows.map((r) => ({ id: r.id, status: r.status, ai_visible: r.ai_visible })) } };
  },
  async undo(ctx, action) {
    for (const r of action.before?.rows ?? []) must(await ctx.db.from('products').update({ status: r.status, ai_visible: r.ai_visible }).eq('business_id', ctx.businessId).eq('id', r.id), 'undo product');
    return { summary: 'Put the products back as they were.' };
  },
};

const EDITABLE = { price: 'Price', old_price: 'Old price', stock_quantity: 'Stock', description_short: 'Short description', category: 'Category' };

const edit_product = {
  name: 'edit_product', area: 'products', kind: 'propose', risk: 'normal',
  description: 'Change one product\'s price, old price, stock, short description or category. Only use numbers the owner gave you. Prices matter: the AI quotes them to customers.',
  parameters: { type: 'object', properties: { product_id: { type: ['string', 'number'] }, price: { type: 'number' }, old_price: { type: ['number', 'null'] }, stock_quantity: { type: 'integer', minimum: 0 }, description_short: { type: 'string' }, category: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx, args) {
    const [p] = await ownProducts(ctx, [args.product_id]);
    if (!p) throw new ToolError('I could not find that product.');
    const patch = {};
    if (args.price !== undefined) { const n = Number(args.price); if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw new ToolError('That price does not look right.'); patch.price = n; patch.price_source = 'owner'; }
    if (args.old_price !== undefined) { if (args.old_price === null) patch.old_price = null; else { const n = Number(args.old_price); if (!Number.isFinite(n) || n < 0) throw new ToolError('That old price does not look right.'); patch.old_price = n; } }
    if (args.stock_quantity !== undefined) { const n = Number(args.stock_quantity); if (!Number.isInteger(n) || n < 0) throw new ToolError('Stock must be a whole number.'); patch.stock_quantity = n; }
    if (args.description_short !== undefined) patch.description_short = asText(args.description_short).slice(0, 300) || null;
    if (args.category !== undefined) { patch.category = asText(args.category).slice(0, 60) || null; patch.category_source = patch.category ? 'owner' : null; }
    const keys = Object.keys(patch).filter((k) => k in EDITABLE && String(p[k] ?? '') !== String(patch[k] ?? ''));
    if (!keys.length) throw new ToolError('Nothing to change.');
    return { title: `Change "${p.title}"`, params: { id: p.id, patch }, preview: { headline: p.title, changes: keys.map((k) => ({ label: EDITABLE[k], from: String(p[k] ?? 'not set'), to: String(patch[k] ?? 'not set') })) } };
  },
  async execute(ctx, params) {
    const [p] = await ownProducts(ctx, [params.id]);
    if (!p) throw new ToolError('That product is gone, so nothing was changed.');
    const full = must(await ctx.db.from('products').select('*').eq('business_id', ctx.businessId).eq('id', p.id).maybeSingle(), 'product');
    must(await ctx.db.from('products').update(params.patch).eq('business_id', ctx.businessId).eq('id', p.id), 'edit product');
    return { summary: `Updated "${p.title}".`, result: { id: p.id }, before: { patch: Object.fromEntries(Object.keys(params.patch).map((k) => [k, full?.[k] ?? null])) } };
  },
  async undo(ctx, action) {
    must(await ctx.db.from('products').update(action.before.patch).eq('business_id', ctx.businessId).eq('id', action.result.id), 'undo product edit');
    return { summary: 'Put the product back as it was.' };
  },
};

const run_product_discovery = {
  name: 'run_product_discovery', area: 'products', kind: 'propose', risk: 'critical',
  description: 'Look through the WhatsApp chats again for products the business sells. Uses a little of the balance. Only needed when the owner asks or no products have been found yet.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  status: 'Getting that ready…',
  async plan(ctx) {
    if (!(await ctx.canAfford())) throw new ToolError('The balance is empty, so I cannot start this. Top up first.');
    return { title: 'Look for your products in your chats', params: {}, preview: { headline: 'HeySasa will search your chats for products you sell.', lines: ['It takes a few minutes and uses a little of your balance.', 'Nothing is approved for you: you or I will review what it finds.'] } };
  },
  async execute(ctx) {
    const res = await ctx.selfCall('POST', '/products/discover', {});
    if (res.status === 409) throw new ToolError('A search is already running. Wait for it to finish.');
    if (!res.ok) throw new ToolError('I could not start the search right now.');
    return { summary: 'Started looking for your products. Come back in a few minutes to review them.', result: { started: true }, undoable: false };
  },
};

export default [list_products, change_products, edit_product, run_product_discovery];
