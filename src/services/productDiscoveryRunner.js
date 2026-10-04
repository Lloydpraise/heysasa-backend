// Product discovery: reads a business's customer chats and the images the owner sent,
// and turns what it finds into DISCOVERED products with proof, for the owner to approve.
//
// Used two ways, same code:
//   * inside the analyser (run-local.js), after chats are separated and before they are analysed
//   * on its own, through discover-products.js / POST /products/discover
import crypto from 'node:crypto';
import {
  redact, squash, nameTokens, dedupeKey, parsePrice, priceAppearsIn, verifyQuote,
  isProductRelevantOwnerMessage, waImageRef, imageKeyFor, decryptWhatsAppMedia, sniffImageType, extensionFor,
  clusterCandidates, applyConsolidation, clusterConfidence, passesEvidenceBar, findBestProductMatch,
  mergeObservedPrices, pickPrice, nameSimilarity, applyCategories,
} from '../productDiscovery.js';
import { AI_PROMPT_CATALOG } from '../aiPromptCatalog.js';
import { getAiPromptConfig } from './aiPromptConfig.js';
import {
  classifyOpenAIFailure, getOpenAIAvailabilityState, getOpenAICooldownMs,
  noteOpenAIRateLimited, setOpenAIUnavailable, shouldPauseOpenAIRequest,
} from './openAiGate.js';
import { FatalRunError } from '../leadClassification.js';

export const RUN_TYPE = 'product_discovery';
export class AlreadyRunningError extends Error {}

const PAGE_SIZE = 1000;
const TEXT_BATCH_SIZE = 40;
const MAX_TEXT_SNIPPETS = 1200;
const MAX_REPEATS_OF_ONE_LINE = 3;       // the same template sent to 100 people counts 3 times, not 100
const MAX_IMAGES_PER_RUN = Number(process.env.PRODUCT_MAX_IMAGES) || 150;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CONSOLIDATE = 200;
const MAX_NEW_PRODUCTS_PER_RUN = 300;
const LIVE_WINDOW_MS = 3 * 60 * 1000;
const DEAD_AFTER_MS = 15 * 60 * 1000;
const FAIL_RATIO_LIMIT = 0.4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOutbound = (m) => m.direction === 'out' || m.direction === 'outbound';
const isInbound = (m) => m.direction === 'in' || m.direction === 'inbound';
const isOwnerLine = (m) => isOutbound(m) && m.agent_role === 'human';

const NON_PRODUCT_RE = /\b(deliver(y|ies)?|transport|shipping|courier|deposit|booking fee|discount|offer code|m-?pesa|paybill|till( number)?|bank|account|payment|location|opening hours|appointment|balance|receipt|refund|thank|welcome)\b/i;
const KEEP_IMAGE_TYPES = new Set(['product_photo', 'price_list', 'menu', 'poster']);
const ALL_IMAGE_TYPES = new Set([...KEEP_IMAGE_TYPES, 'screenshot', 'payment_proof', 'document', 'personal', 'other']);

function messageText(m) {
  const c = m.content;
  if (typeof c === 'string') return c;
  return String(c?.text || c?.caption || c?.media?.caption || '');
}

function evenSample(list, max) {
  if (list.length <= max) return list;
  const step = list.length / max;
  return Array.from({ length: max }, (_, i) => list[Math.floor(i * step)]);
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
// ctx: { supabase, businessId, openaiKey, textModel, visionModel, force, dryRun,
//        log, warn, err, progress, recordUsage }
export async function runProductDiscovery(ctx) {
  const {
    supabase, businessId, openaiKey, force = false, dryRun = false,
    log = () => {}, warn = () => {}, err = () => {},
  } = ctx;
  if (!businessId) throw new Error('businessId is required');
  const textModel = ctx.textModel || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const visionModel = ctx.visionModel || process.env.OPENAI_VISION_MODEL || textModel;

  const run = await startRun(ctx);
  const state = { cacheStats: { prompt: 0, cached: 0, calls: 0 } };
  const summary = {
    dry_run: dryRun, forced: force,
    customer_chats: 0, snippets_read: 0, text_candidates: 0, text_dropped_unverified: 0, text_price_dropped: 0,
    images_seen: 0, images_unique: 0, images_without_key: 0, images_read: 0, images_unreachable: 0,
    images_low_res: 0, images_private_skipped: 0, images_left_for_next_run: 0,
    clusters: 0, matched_approved: 0, matched_discovered: 0, skipped_dismissed: 0, dropped_weak: 0,
    new_discovered: 0, failed_batches: 0, notes: [],
  };

  try {
    // ── load ────────────────────────────────────────────────────────────────
    log('Products', 'Loading business, existing products and customer chats.');
    await setProgress(ctx, run, 'loading', 0, 1);
    const business = await loadBusiness(supabase, businessId);
    const products = await loadProducts(supabase, businessId);
    const contactIds = await loadCustomerContactIds(supabase, businessId);
    summary.customer_chats = contactIds.size;
    log('Products', `Loaded business "${business.name}", ${products.length} products and ${contactIds.size} customer chats.`);
    if (!contactIds.size) {
      summary.reason = 'no_classified_customers';
      summary.notes.push('No chats are marked as customers yet. Run the analyser first so vendors, staff and personal chats are kept out.');
      warn('Products', summary.notes[0]);
      await finishRun(ctx, run, 'insufficient_data', summary);
      return summary;
    }
    const since = force ? null : await lastCompletedRunStart(supabase, businessId);
    log('Products', `${contactIds.size} customer chats, ${products.length} products on file${since ? `, reading messages since ${since}` : ', reading all messages'}.`);

    const messages = await loadMessages(supabase, businessId, contactIds, false);
    const byContact = groupByContact(messages);
    log('Products', `Loaded ${messages.length} customer-chat messages across ${byContact.size} chats.`);

    // ── text ────────────────────────────────────────────────────────────────
    const candidates = [];
    const snippets = buildSnippets(byContact, since);
    summary.snippets_read = snippets.length;
    log('Products', `Selected ${snippets.length} product-relevant owner messages for text extraction.`, { snippets: snippets.length });
    if (snippets.length) {
      const textResult = await mineText(ctx, run, state, business, snippets, textModel);
      candidates.push(...textResult.candidates);
      summary.text_candidates = textResult.candidates.length;
      summary.text_dropped_unverified = textResult.droppedUnverified;
      summary.text_price_dropped = textResult.priceDropped;
      summary.failed_batches += textResult.failedBatches;
      log('Products', `Text extraction finished: ${textResult.candidates.length} candidates, ${textResult.droppedUnverified} rejected as unverified, ${textResult.priceDropped} unsupported prices removed, ${textResult.failedBatches} failed batches.`);
    } else {
      log('Products', 'No new product-like owner messages to read.');
    }

    // ── images ──────────────────────────────────────────────────────────────
    const imageResult = await mineImages(ctx, run, state, business, byContact, contactIds, visionModel, summary);
    candidates.push(...imageResult.candidates);
    log('Products', `Evidence collection finished with ${candidates.length} product candidates (${summary.text_candidates} from text, ${imageResult.candidates.length} from images).`);

    // ── cluster, consolidate, match, save ───────────────────────────────────
    await setProgress(ctx, run, 'consolidating', 0, 1);
    log('Products', `Clustering ${candidates.length} candidates into product groups.`);
    let clusters = clusterCandidates(candidates);
    log('Products', `Initial clustering produced ${clusters.length} product groups.`);
    clusters = await consolidate(ctx, state, clusters, textModel, summary);
    summary.clusters = clusters.length;
    log('Products', `Consolidation finished with ${clusters.length} product groups.`);

    await setProgress(ctx, run, 'saving', 0, clusters.length || 1);
    log('Products', `Matching ${clusters.length} groups against ${products.length} existing products and planning changes.`);
    const plan = planWrites(clusters, products, summary);
    log('Products', `Write plan: ${plan.newProducts.length} new products, ${plan.touched.size} existing products to update, ${plan.mentions.length} evidence records, ${summary.dropped_weak} weak-evidence groups dropped.`);
    await categorize(ctx, state, plan, products, textModel, summary);
    if (dryRun) {
      const catByTitle = new Map(plan.newProducts.map((r) => [r.title, r.category]));
      summary.preview = plan.preview.map((p) => (p.decision === 'new_discovered' ? { ...p, category: catByTitle.get(p.name) || null } : p));
      log('Products', `Dry run: would add ${plan.newProducts.length} discovered, update ${plan.touched.size} existing. Nothing was written.`);
    } else {
      log('Products', 'Writing discovered products, evidence and refreshed product counts.');
      await writePlan(ctx, run, businessId, plan, imageResult.imageUploads);
    }
    summary.new_discovered = plan.newProducts.length;

    const cache = state.cacheStats;
    if (cache.calls) log('Products', `Prompt cache: ${cache.cached}/${cache.prompt} input tokens cached across ${cache.calls} calls.`);
    log('Products', `Done: ${summary.new_discovered} new discovered, ${summary.matched_approved} matched approved, ${summary.matched_discovered} matched already discovered, ${summary.skipped_dismissed} dismissed skipped, ${summary.dropped_weak} dropped for weak evidence.`);
    await finishRun(ctx, run, 'completed', summary);
    return summary;
  } catch (e) {
    await failRun(ctx, run, e);
    throw e;
  }
}

// ─── Run tracking (enrichment_runs, run_type = product_discovery) ────────────
async function startRun(ctx) {
  const { supabase, businessId, dryRun, warn = () => {} } = ctx;
  if (dryRun) return { id: null };
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  try {
    await supabase.from('enrichment_runs')
      .update({ status: 'failed', finished_at: new Date().toISOString(), fatal_error: 'stale: process ended without finishing' })
      .eq('run_type', RUN_TYPE).eq('business_id', businessId).eq('status', 'running')
      .or(`heartbeat_at.lt.${ago(DEAD_AFTER_MS)},and(heartbeat_at.is.null,started_at.lt.${ago(DEAD_AFTER_MS)})`);
  } catch (e) { warn('Products', `Stale-run sweep failed: ${e.message}`); }

  const { data: running } = await supabase.from('enrichment_runs')
    .select('id, started_at, heartbeat_at').eq('run_type', RUN_TYPE).eq('business_id', businessId).eq('status', 'running');
  const live = (running || []).find((r) => Date.now() - new Date(r.heartbeat_at || r.started_at).getTime() < LIVE_WINDOW_MS);
  if (live) throw new AlreadyRunningError(`Product discovery is already running for ${businessId} (run ${String(live.id).slice(0, 8)}).`);

  const id = crypto.randomUUID();
  const { error } = await supabase.from('enrichment_runs').insert({
    id, run_type: RUN_TYPE, business_id: businessId, started_at: new Date().toISOString(), status: 'running', phase: 'loading',
    heartbeat_at: new Date().toISOString(),
  });
  if (error) warn('Products', `Could not create run record: ${error.message}`);
  return { id, lastWrite: 0, lastQuartile: {} };
}

async function setProgress(ctx, run, phase, done, total) {
  if (ctx.progress) {
    try { await ctx.progress('products', done, total, phase); }
    catch (error) { if (ctx.warn) ctx.warn('Products', `Could not report ${phase} progress: ${error.message}`); }
  }
  if (!run.id) return;
  const now = Date.now();
  const finished = total > 0 && done >= total;
  if (!finished && done !== 0 && now - (run.lastWrite || 0) < 4000) return;
  run.lastWrite = now;
  try {
    const { error } = await ctx.supabase.from('enrichment_runs').update({
      phase, progress_done: done, progress_total: total, heartbeat_at: new Date().toISOString(),
    }).eq('id', run.id);
    if (error && ctx.warn) ctx.warn('Products', `Could not save ${phase} progress: ${error.message}`);
  } catch (error) {
    if (ctx.warn) ctx.warn('Products', `Could not save ${phase} progress: ${error.message}`);
  }
}

async function finishRun(ctx, run, status, summary) {
  if (!run.id) return;
  const { error } = await ctx.supabase.from('enrichment_runs').update({
    status, phase: 'done', progress_done: 1, progress_total: 1,
    finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), summary,
  }).eq('id', run.id);
  if (error && ctx.warn) ctx.warn('Products', `Could not save run summary: ${error.message}`);
}

async function failRun(ctx, run, e) {
  if (!run.id) return;
  try {
    const { error } = await ctx.supabase.from('enrichment_runs').update({
      status: 'failed', finished_at: new Date().toISOString(), fatal_error: String(e?.message || e).slice(0, 1000),
    }).eq('id', run.id);
    if (error && ctx.warn) ctx.warn('Products', `Could not save failed run status: ${error.message}`);
  } catch (error) {
    if (ctx.warn) ctx.warn('Products', `Could not save failed run status: ${error.message}`);
  }
}

async function lastCompletedRunStart(supabase, businessId) {
  const { data } = await supabase.from('enrichment_runs').select('started_at')
    .eq('run_type', RUN_TYPE).eq('business_id', businessId).eq('status', 'completed')
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  return data?.started_at || null;
}

// ─── Loading ─────────────────────────────────────────────────────────────────
async function fetchAllPages(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function loadBusiness(supabase, businessId) {
  const { data, error } = await supabase.from('businesses')
    .select('business_id, name, industry, business_type, currency').eq('business_id', businessId).maybeSingle();
  if (error) throw new Error(`Business lookup failed: ${error.message}`);
  if (!data) throw new Error(`Business ${businessId} not found`);
  return data;
}

async function loadProducts(supabase, businessId) {
  return fetchAllPages((from, to) => supabase.from('products')
    .select('id, title, aliases, status, price, price_source, type, images, observed_prices, mention_count, discovery_confidence, category, category_source, description_short')
    .eq('business_id', businessId).order('id').range(from, to));
}

async function loadCustomerContactIds(supabase, businessId) {
  const rows = await fetchAllPages((from, to) => supabase.from('contacts')
    .select('id').eq('business_id', businessId).eq('lead_type', 'business').order('id').range(from, to));
  return new Set(rows.map((r) => r.id));
}

async function loadMessages(supabase, businessId, contactIds, withRaw) {
  const columns = withRaw
    ? 'id, contact_id, direction, agent_role, type, content, raw_payload, created_at'
    : 'id, contact_id, direction, agent_role, type, content, created_at';
  const rows = await fetchAllPages((from, to) => {
    let q = supabase.from('messages').select(columns).eq('business_id', businessId);
    if (withRaw) q = q.eq('type', 'image').in('direction', ['out', 'outbound']);
    return q.order('created_at', { ascending: true }).order('id').range(from, to);
  });
  return rows.filter((m) => contactIds.has(m.contact_id));
}

function groupByContact(messages) {
  const map = new Map();
  for (const m of messages) {
    if (!map.has(m.contact_id)) map.set(m.contact_id, []);
    map.get(m.contact_id).push(m);
  }
  return map;
}

// ─── Text ────────────────────────────────────────────────────────────────────
function buildSnippets(byContact, since) {
  const raw = [];
  for (const [contactId, list] of byContact) {
    let prevCustomer = '';
    for (const m of list) {
      if (isInbound(m)) { prevCustomer = messageText(m); continue; }
      if (!isOwnerLine(m)) continue;
      if (m.type && !['text', 'image', 'chat', null].includes(m.type)) continue;
      if (since && m.created_at <= since) continue;
      const text = messageText(m).trim();
      const isCaption = m.type === 'image';
      if (!isProductRelevantOwnerMessage(text, prevCustomer, isCaption)) continue;
      raw.push({
        messageId: m.id, contactId, createdAt: m.created_at,
        ownerText: redact(text).replace(/\s+/g, ' ').slice(0, 500),
        prevCustomer: redact(prevCustomer).replace(/\s+/g, ' ').slice(0, 200),
        priced: /\d/.test(text),
      });
    }
  }
  // one template sent to many people is evidence once or twice, not a hundred times
  const seen = new Map();
  const unique = [];
  for (const s of raw) {
    const key = squash(s.ownerText);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n <= MAX_REPEATS_OF_ONE_LINE) unique.push(s);
  }
  const priced = unique.filter((s) => s.priced);
  const unpriced = unique.filter((s) => !s.priced);
  const room = Math.max(0, MAX_TEXT_SNIPPETS - priced.length);
  const chosen = [...evenSample(priced, MAX_TEXT_SNIPPETS), ...evenSample(unpriced, room)]
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return chosen.map((s, i) => ({ ...s, id: `s${i + 1}` }));
}

async function mineText(ctx, run, state, business, snippets, model) {
  const { log = () => {}, warn = () => {} } = ctx;
  const batches = chunk(snippets, TEXT_BATCH_SIZE);
  const bySnippet = new Map(snippets.map((s) => [s.id, s]));
  const candidates = [];
  let droppedUnverified = 0;
  let priceDropped = 0;
  let failedBatches = 0;
  log('Products', `Starting text extraction: ${snippets.length} selected owner messages in ${batches.length} batches using ${model}.`);

  for (let i = 0; i < batches.length; i++) {
    await setProgress(ctx, run, 'text', i, batches.length);
    const batch = batches[i];
    const beforeCandidates = candidates.length;
    const beforeUnverified = droppedUnverified;
    const beforePriceDropped = priceDropped;
    log('Products', `Text batch ${i + 1}/${batches.length}: extracting products from ${batch.length} owner messages.`);
    const user = [
      `BUSINESS: ${business.name || 'unknown'} | industry: ${business.industry || 'unknown'} | type: ${business.business_type || 'unknown'} | currency: ${business.currency || 'KES'}`,
      'SNIPPETS:',
      ...batch.map((s) => `[${s.id}]${s.prevCustomer ? ` CUSTOMER: ${s.prevCustomer}\n` : ' '}OWNER: ${s.ownerText}`),
    ].join('\n');
    try {
      const result = await callOpenAiJson(ctx, state, {
        promptId: 'product_text_extractor', model, user, maxTokens: 3500, cacheKey: `products:text:${business.business_id}`,
      });
      for (const item of Array.isArray(result.json?.items) ? result.json.items : []) {
        const snippet = bySnippet.get(String(item?.snippet_id));
        const name = String(item?.name ?? '').replace(/\s+/g, ' ').trim();
        if (!snippet || name.length < 2 || name.length > 80 || NON_PRODUCT_RE.test(name)) { droppedUnverified++; continue; }
        if (!verifyQuote(item.quote, snippet.ownerText)) { droppedUnverified++; continue; }
        const context = new Set(nameTokens(`${snippet.ownerText} ${snippet.prevCustomer}`));
        if (!nameTokens(name).some((t) => context.has(t))) { droppedUnverified++; continue; }
        let price = parsePrice(item.price);
        if (price !== null && !priceAppearsIn(snippet.ownerText, price)) { price = null; priceDropped++; }
        candidates.push({
          name, kind: item.kind === 'service' ? 'service' : 'product', price,
          description: item.description ? String(item.description).slice(0, 200) : null,
          nameSource: 'text',
          source: {
            kind: 'text', ref: snippet.messageId, messageId: snippet.messageId, contactId: snippet.contactId,
            observedAt: snippet.createdAt, quote: String(item.quote).slice(0, 240),
          },
        });
      }
      log('Products', `Text batch ${i + 1}/${batches.length} complete: ${candidates.length - beforeCandidates} candidates retained, ${droppedUnverified - beforeUnverified} unverified results rejected, ${priceDropped - beforePriceDropped} unsupported prices removed.`);
    } catch (e) {
      if (e instanceof FatalRunError) throw e;
      failedBatches++;
      warn('Products', `Text batch ${i + 1}/${batches.length} failed, skipping it: ${e.message}`);
      if (failedBatches / batches.length > FAIL_RATIO_LIMIT && failedBatches >= 3) {
        throw new Error(`${failedBatches} of ${batches.length} text batches failed. Stopping instead of saving a partial result.`);
      }
    }
  }
  await setProgress(ctx, run, 'text', batches.length, batches.length);
  return { candidates, droppedUnverified, priceDropped, failedBatches };
}

// ─── Images ──────────────────────────────────────────────────────────────────
async function mineImages(ctx, run, state, business, byContact, contactIds, model, summary) {
  const { supabase, businessId, force, dryRun, log = () => {}, warn = () => {} } = ctx;
  const out = { candidates: [], imageUploads: new Map() };

  const imageMessages = await loadMessages(supabase, businessId, contactIds, true);
  summary.images_seen = imageMessages.length;
  if (!imageMessages.length) {
    log('Products', 'No owner-sent images were found in customer chats.');
    return out;
  }

  const groups = new Map();
  for (const m of imageMessages) {
    const key = imageKeyFor(m);
    if (!key) { summary.images_without_key++; continue; }
    let g = groups.get(key);
    if (!g) { g = { key, messages: [], contacts: new Set() }; groups.set(key, g); }
    g.messages.push(m);
    g.contacts.add(m.contact_id);
  }
  summary.images_unique = groups.size;

  const done = new Map();
  if (!force) {
    for (const keys of chunk([...groups.keys()], 100)) {
      const { data } = await supabase.from('product_image_reads').select('image_key, status')
        .eq('business_id', businessId).in('image_key', keys);
      for (const row of data || []) done.set(row.image_key, row.status);
    }
  }
  const todo = [...groups.values()]
    .filter((g) => done.get(g.key) !== 'read')
    .sort((a, b) => (b.contacts.size - a.contacts.size) || String(b.messages.at(-1).created_at).localeCompare(String(a.messages.at(-1).created_at)));
  const batch = todo.slice(0, MAX_IMAGES_PER_RUN);
  summary.images_left_for_next_run = todo.length - batch.length;
  log('Products', `${imageMessages.length} owner-sent images grouped into ${groups.size} distinct images; ${groups.size - todo.length} already read, ${todo.length} need reading, processing ${batch.length} this run${summary.images_left_for_next_run ? `, ${summary.images_left_for_next_run} deferred by the per-run limit` : ''}.`);

  for (let i = 0; i < batch.length; i++) {
    await setProgress(ctx, run, 'images', i, batch.length);
    const group = batch[i];
    log('Products', `Image ${i + 1}/${batch.length}: resolving source (${group.messages.length} sends across ${group.contacts.size} chats).`);
    try {
      const resolved = await resolveImage(group, warn);
      if (!resolved) {
        summary.images_unreachable++;
        if (!dryRun) await saveImageRead(supabase, businessId, group, { status: 'unreachable', error: 'image could not be downloaded or decrypted' });
        warn('Products', `Image ${i + 1}/${batch.length}: no usable original or thumbnail; marked unreachable.`);
        continue;
      }
      log('Products', `Image ${i + 1}/${batch.length}: resolved ${resolved.source}${resolved.lowRes ? ' (thumbnail/low resolution)' : ''}; sending to image classifier.`);
      const hints = imageHints(group, byContact);
      const read = await readImage(ctx, state, resolved, hints, model);
      log('Products', `Image ${i + 1}/${batch.length}: classified as ${read.imageType}, ${read.items.length} product candidates, confidence ${read.confidence}.`);
      if (resolved.lowRes) summary.images_low_res++;
      if (!KEEP_IMAGE_TYPES.has(read.imageType) || !read.items.length) {
        if (['payment_proof', 'document', 'personal', 'screenshot'].includes(read.imageType)) summary.images_private_skipped++;
        if (!dryRun) await saveImageRead(supabase, businessId, group, { status: 'read', imageType: read.imageType, items: [], source: resolved.source, lowRes: resolved.lowRes });
        summary.images_read++;
        log('Products', `Image ${i + 1}/${batch.length}: no product candidates retained${KEEP_IMAGE_TYPES.has(read.imageType) ? '' : ` (classified as ${read.imageType})`}.`);
        continue;
      }
      let imageUrl = resolved.url || null;
      if (!imageUrl && resolved.bytes && !resolved.lowRes && !dryRun) imageUrl = await uploadProductImage(supabase, businessId, group.key, resolved, warn);
      if (imageUrl) out.imageUploads.set(group.key, imageUrl);

      const last = group.messages.at(-1);
      for (const item of read.items) {
        out.candidates.push({
          name: item.name, kind: item.kind, price: item.price, description: item.description, nameSource: item.nameSource,
          source: {
            kind: 'image', ref: group.key, contactId: group.messages[0].contact_id, messageId: last.id,
            observedAt: last.created_at, imageUrl, quote: hints.caption ? hints.caption.slice(0, 240) : null,
            sendCount: group.messages.length, contactCount: group.contacts.size, lowRes: resolved.lowRes, confidence: read.confidence,
          },
        });
      }
      if (!dryRun) await saveImageRead(supabase, businessId, group, {
        status: 'read', imageType: read.imageType, items: read.items, imageUrl, source: resolved.source, lowRes: resolved.lowRes,
      });
      summary.images_read++;
      log('Products', `Image ${i + 1}/${batch.length}: retained ${read.items.length} candidates${dryRun ? '' : ' and saved image-read result'}.`);
    } catch (e) {
      if (e instanceof FatalRunError) throw e;
      warn('Products', `Image ${group.key.slice(0, 24)} failed: ${e.message}`);
      if (!dryRun) await saveImageRead(supabase, businessId, group, { status: 'failed', error: e.message });
    }
    await sleep(300 + Math.floor(Math.random() * 300));
  }
  await setProgress(ctx, run, 'images', batch.length, batch.length || 1);
  return out;
}

async function fetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > MAX_IMAGE_BYTES) throw new Error('image too large');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('image too large');
  return bytes;
}

// Best source first: our own stored copy, then the WhatsApp file (decrypted here), then the tiny thumbnail.
async function resolveImage(group, warn) {
  const newestFirst = [...group.messages].reverse();

  for (const m of newestFirst.slice(0, 3)) {
    const url = m.content?.media?.url;
    if (typeof url !== 'string' || !url) continue;
    try {
      const bytes = await fetchBytes(url);
      const mime = sniffImageType(bytes) || m.content?.media?.mime_type;
      if (mime) return { bytes, mime, url, source: 'storage', lowRes: false };
    } catch (e) { warn('Products', `Stored image not reachable (${e.message}).`); }
  }

  const tried = new Set();
  for (const m of newestFirst.slice(0, 4)) {
    const ref = waImageRef(m.raw_payload);
    if (!ref?.mediaKey) continue;
    const source = ref.url || (ref.directPath ? `https://mmg.whatsapp.net${ref.directPath}` : null);
    if (!source || tried.has(source)) continue;
    tried.add(source);
    try {
      const encrypted = await fetchBytes(source);
      const bytes = decryptWhatsAppMedia(encrypted, ref.mediaKey, 'image');
      if (ref.fileSha256?.length && !crypto.createHash('sha256').update(bytes).digest().equals(ref.fileSha256)) throw new Error('file hash mismatch');
      const mime = sniffImageType(bytes);
      if (mime) return { bytes, mime, url: null, source: 'whatsapp', lowRes: false };
    } catch (e) { warn('Products', `WhatsApp image not usable (${e.message}).`); }
  }

  for (const m of newestFirst) {
    const ref = waImageRef(m.raw_payload);
    if (ref?.thumbnail && sniffImageType(ref.thumbnail)) {
      return { bytes: ref.thumbnail, mime: sniffImageType(ref.thumbnail), url: null, source: 'thumbnail', lowRes: true };
    }
  }
  return null;
}

// Words that help name the item: the caption, the owner's next line, what the customer asked.
function imageHints(group, byContact) {
  const first = group.messages[0];
  const caption = redact(messageText(first)).replace(/\s+/g, ' ').trim();
  let ownerNext = '';
  let customerBefore = '';
  const list = byContact.get(first.contact_id) || [];
  const idx = list.findIndex((m) => m.id === first.id);
  if (idx >= 0) {
    for (let j = idx - 1; j >= 0 && j >= idx - 3; j--) if (isInbound(list[j])) { customerBefore = messageText(list[j]); break; }
    for (let j = idx + 1; j < list.length && j <= idx + 3; j++) if (isOwnerLine(list[j]) && list[j].type !== 'image') { ownerNext = messageText(list[j]); break; }
  }
  return {
    caption: caption.slice(0, 300),
    ownerNext: redact(ownerNext).replace(/\s+/g, ' ').slice(0, 300),
    customerBefore: redact(customerBefore).replace(/\s+/g, ' ').slice(0, 200),
  };
}

async function readImage(ctx, state, resolved, hints, model) {
  const text = [
    `Caption: ${hints.caption || '(none)'}`,
    `Owner's next words: ${hints.ownerNext || '(none)'}`,
    `Customer asked before: ${hints.customerBefore || '(none)'}`,
    resolved.lowRes ? 'This is a very small preview image: do not read prices from it.' : '',
  ].filter(Boolean).join('\n');
  const dataUrl = `data:${resolved.mime};base64,${resolved.bytes.toString('base64')}`;
  const user = [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: dataUrl, detail: resolved.lowRes ? 'low' : 'auto' } },
  ];
  const result = await callOpenAiJson(ctx, state, {
    promptId: 'product_image_reader', model, user, maxTokens: 2500, inputType: 'image', cacheKey: `products:image:${ctx.businessId}`,
  });
  const json = result.json || {};
  const imageType = ALL_IMAGE_TYPES.has(json.image_type) ? json.image_type : 'other';
  const confidence = Math.max(0, Math.min(1, Number(json.confidence) || 0));
  const context = new Set(nameTokens(`${hints.caption} ${hints.ownerNext} ${hints.customerBefore}`));
  const items = [];
  if (KEEP_IMAGE_TYPES.has(imageType) && confidence >= (resolved.lowRes ? 0.5 : 0.4)) {
    for (const raw of (Array.isArray(json.items) ? json.items : []).slice(0, 40)) {
      const name = redact(String(raw?.name ?? '')).replace(/\s+/g, ' ').trim();
      if (name.length < 2 || name.length > 80 || NON_PRODUCT_RE.test(name)) continue;
      let nameSource = ['visible_text', 'caption', 'described'].includes(raw.name_source) ? raw.name_source : 'described';
      if (nameSource === 'caption' && !nameTokens(name).some((t) => context.has(t))) nameSource = 'described';
      let price = parsePrice(raw.price);
      if (resolved.lowRes && price !== null && !priceAppearsIn(`${hints.caption} ${hints.ownerNext}`, price)) price = null;
      items.push({
        name, kind: raw.kind === 'service' ? 'service' : 'product', price, nameSource,
        description: raw.description ? redact(String(raw.description)).slice(0, 200) : null,
      });
    }
  }
  return { imageType, confidence, items };
}

async function uploadProductImage(supabase, businessId, key, resolved, warn) {
  try {
    const name = crypto.createHash('sha1').update(key).digest('hex');
    const path = `${businessId}/${name}.${extensionFor(resolved.mime)}`;
    const { error } = await supabase.storage.from('product-images').upload(path, resolved.bytes, { contentType: resolved.mime, upsert: true });
    if (error) throw new Error(error.message);
    return supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;
  } catch (e) {
    warn('Products', `Could not store product image: ${e.message}`);
    return null;
  }
}

async function saveImageRead(supabase, businessId, group, { status, imageType = null, items = [], imageUrl = null, source = null, lowRes = false, error = null }) {
  const { error: dbError } = await supabase.from('product_image_reads').upsert({
    business_id: businessId, image_key: group.key, image_type: imageType, items, image_url: imageUrl, low_res: lowRes, source,
    send_count: group.messages.length, contact_count: group.contacts.size, status, error: error ? String(error).slice(0, 500) : null,
    read_at: new Date().toISOString(),
  }, { onConflict: 'business_id,image_key' });
  if (dbError) throw new Error(`product_image_reads write failed: ${dbError.message}`);
}

// ─── Consolidation (model suggests merges, code checks them) ─────────────────
async function consolidate(ctx, state, clusters, model, summary) {
  const { log = () => {}, warn = () => {} } = ctx;
  if (clusters.length < 2) {
    log('Products', `Skipping AI consolidation: only ${clusters.length} product group${clusters.length === 1 ? '' : 's'}.`);
    return clusters;
  }
  const ranked = [...clusters].sort((a, b) => b.sources.length - a.sources.length);
  const head = ranked.slice(0, MAX_CONSOLIDATE);
  const tail = ranked.slice(MAX_CONSOLIDATE);
  if (tail.length) log('Products', `${tail.length} groups exceed the AI consolidation limit and will be left as-is.`);
  const list = head.map((c, i) => ({ i, name: c.name, others: c.aliases.slice(0, 3), kind: c.kind, price: pickPrice(c.observedPrices).price, mentions: c.sources.length }));
  try {
    const result = await callOpenAiJson(ctx, state, {
      promptId: 'product_consolidator', model, user: `CANDIDATES:\n${JSON.stringify(list)}`, maxTokens: 2500,
      cacheKey: `products:merge:${ctx.businessId}`,
    });
    const merged = applyConsolidation(head, result.json?.groups);
    log('Products', `Consolidation: ${head.length} candidates became ${merged.length}.`);
    return [...merged, ...tail];
  } catch (e) {
    if (e instanceof FatalRunError) throw e;
    summary.notes.push(`Consolidation skipped: ${e.message}`);
    warn('Products', `Consolidation skipped (${e.message}); using exact and close name matches only.`);
    return clusters;
  }
}

// ─── Categories (model suggests, code checks) ────────────────────────────────
const CATEGORY_BATCH = 100;
const MAX_CATEGORISE_PER_RUN = 300;
async function categorize(ctx, state, plan, products, model, summary) {
  const { warn = () => {}, log = () => {} } = ctx;
  summary.categorised = 0;
  const existing = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const items = [
    ...plan.newProducts.map((row) => ({ kind: 'new', row, name: row.title, description: row.description_short, price: row.price })),
    ...products.filter((p) => p.status !== 'dismissed' && !p.category)
      .map((p) => ({ kind: 'existing', product: p, name: p.title, description: p.description_short, price: p.price })),
  ].slice(0, MAX_CATEGORISE_PER_RUN);
  if (!items.length) {
    log('Products', 'No uncategorised products need category assignment.');
    return;
  }
  const categories = [...existing];
  let failed = 0;
  log('Products', `Categorising ${items.length} products in batches of ${CATEGORY_BATCH}.`);
  for (let from = 0; from < items.length; from += CATEGORY_BATCH) {
    const batch = items.slice(from, from + CATEGORY_BATCH);
    const batchNumber = Math.floor(from / CATEGORY_BATCH) + 1;
    const batchCount = Math.ceil(items.length / CATEGORY_BATCH);
    log('Products', `Category batch ${batchNumber}/${batchCount}: assigning categories to ${batch.length} products.`);
    const list = batch.map((it, i) => ({ i, name: it.name, ...(it.description ? { about: String(it.description).slice(0, 80) } : {}), ...(it.price != null ? { price: it.price } : {}) }));
    try {
      const result = await callOpenAiJson(ctx, state, {
        promptId: 'product_categorizer', model, maxTokens: 2500, cacheKey: `products:cat:${ctx.businessId}`,
        user: `EXISTING CATEGORIES: ${JSON.stringify(categories)}\n\nITEMS:\n${JSON.stringify(list)}`,
      });
      const picked = applyCategories(batch.length, result.json?.assignments, categories);
      for (const [i, category] of picked) {
        if (!categories.includes(category)) categories.push(category);
        const it = batch[i];
        if (it.kind === 'new') { it.row.category = category; it.row.category_source = 'ai'; }
        else plan.categoryUpdates.push({ id: it.product.id, category });
        summary.categorised++;
      }
      log('Products', `Category batch ${batchNumber}/${batchCount} complete: ${picked.size} categories assigned.`);
    } catch (e) {
      if (e instanceof FatalRunError) throw e;
      failed++;
      warn('Products', `Categorising a batch failed, skipping it: ${e.message}`);
    }
  }
  if (failed) summary.notes.push(`${failed} category batch(es) failed; those products stay uncategorised until the next run.`);
  log('Products', `Categories: ${summary.categorised} products sorted into ${categories.length} categories.`);
}

// ─── Decide what to write ────────────────────────────────────────────────────
function planWrites(clusters, products, summary) {
  const newProducts = [];
  const mentions = [];                     // { productId | tempIndex, ... }
  const touched = new Map();               // productId -> { observed, aliases, ... }
  const preview = [];
  const now = new Date().toISOString();
  const taken = [...products];             // grows as new ones are planned, so two clusters never create twins

  for (const cluster of clusters) {
    const names = [cluster.name, ...cluster.aliases];
    let best = null;
    for (const n of names) {
      const hit = findBestProductMatch(n, taken);
      if (hit && (!best || hit.score > best.score)) best = hit;
    }

    if (best) {
      const p = best.product;
      if (p.status === 'dismissed') { summary.skipped_dismissed++; preview.push({ name: cluster.name, decision: 'skipped_dismissed', matches: p.title }); continue; }
      if (p.status === 'approved') summary.matched_approved++; else summary.matched_discovered++;
      const entry = touched.get(p.id) || { product: p, observed: [], aliases: [], images: [], confidence: 0, sources: [] };
      entry.observed = mergeObservedPrices(entry.observed, cluster.observedPrices);
      entry.aliases.push(...names.filter((n) => nameSimilarity(n, p.title) < 1));
      entry.images.push(...cluster.sources.map((s) => s.imageUrl).filter(Boolean));
      entry.confidence = Math.max(entry.confidence, clusterConfidence(cluster));
      entry.sources.push(...cluster.sources);
      touched.set(p.id, entry);
      mentions.push(...cluster.sources.map((s) => ({ productId: p.id, source: s, name: s.name })));
      preview.push({ name: cluster.name, decision: `matched_${p.status}`, matches: p.title });
      continue;
    }

    if (!passesEvidenceBar(cluster)) { summary.dropped_weak++; preview.push({ name: cluster.name, decision: 'dropped_weak_evidence', mentions: cluster.sources.length }); continue; }
    if (newProducts.length >= MAX_NEW_PRODUCTS_PER_RUN) { summary.notes.push(`More than ${MAX_NEW_PRODUCTS_PER_RUN} new products found; the rest will appear on the next run.`); continue; }

    const id = `prd_${crypto.randomBytes(8).toString('hex')}`;
    const { price, spread } = pickPrice(cluster.observedPrices);
    const textSources = cluster.sources.filter((s) => s.kind === 'text');
    const imageSources = cluster.sources.filter((s) => s.kind === 'image');
    const pricedFromImage = imageSources.some((s) => s.price !== null && s.price !== undefined);
    const pricedFromText = textSources.some((s) => s.price !== null && s.price !== undefined);
    const lastSeen = cluster.sources.map((s) => s.observedAt).filter(Boolean).sort().at(-1) || now;
    const row = {
      id, title: cluster.name.slice(0, 120), type: cluster.kind,
      description_short: cluster.description ? cluster.description.slice(0, 200) : null,
      price, price_source: price === null ? null : (pricedFromText || !pricedFromImage ? 'chat' : 'image'),
      observed_prices: cluster.observedPrices, aliases: cluster.aliases.slice(0, 8), dedupe_key: dedupeKey(cluster.name),
      status: 'discovered',
      source: textSources.length && imageSources.length ? 'chat_image' : imageSources.length ? 'image' : 'chat',
      is_visible: false, ai_visible: true, stock_quantity: 0,
      images: [...new Set(cluster.sources.map((s) => s.imageUrl).filter(Boolean))].slice(0, 4),
      discovered_at: now, mention_count: cluster.sources.length, last_mentioned_at: lastSeen,
      discovery_confidence: clusterConfidence(cluster),
      discovery_meta: {
        text_mentions: textSources.length, image_mentions: imageSources.length,
        customers: new Set(cluster.sources.map((s) => s.contactId).filter(Boolean)).size,
        price_spread: spread, name_sources: cluster.nameSources, low_res: imageSources.length > 0 && imageSources.every((s) => s.lowRes),
      },
    };
    newProducts.push(row);
    taken.push({ id, title: row.title, aliases: row.aliases, status: 'discovered' });
    mentions.push(...cluster.sources.map((s) => ({ productId: id, source: s, name: s.name })));
    preview.push({ name: row.title, decision: 'new_discovered', price, confidence: row.discovery_confidence, mentions: cluster.sources.length });
  }
  return { newProducts, mentions, touched, categoryUpdates: [], preview: preview.slice(0, 80) };
}

// ─── Write ───────────────────────────────────────────────────────────────────
async function writePlan(ctx, run, businessId, plan, imageUploads) {
  const { supabase, log = () => {} } = ctx;
  const runId = run.id;
  const productBatches = chunk(plan.newProducts.map((r) => ({ ...r, business_id: businessId, discovery_run_id: runId })), 50);

  for (let i = 0; i < productBatches.length; i++) {
    const rows = productBatches[i];
    log('Products', `Saving new-product batch ${i + 1}/${productBatches.length} (${rows.length} rows).`);
    const { error } = await supabase.from('products').insert(rows);
    if (error) throw new Error(`Saving discovered products failed: ${error.message}`);
  }
  if (!productBatches.length) log('Products', 'No new product rows to insert.');

  // evidence: one row per message, or per distinct image
  const seen = new Set();
  const mentionRows = [];
  for (const m of plan.mentions) {
    const s = m.source;
    const dedupe = `${m.productId}|${s.kind}|${s.ref}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    mentionRows.push({
      business_id: businessId, product_id: m.productId, run_id: runId, kind: s.kind, source_ref: String(s.ref),
      message_id: s.kind === 'text' ? s.messageId : null, contact_id: s.contactId || null,
      quote: s.quote ? redact(s.quote).slice(0, 240) : null, observed_name: String(m.name || '').slice(0, 120),
      observed_price: s.price ?? null, image_url: s.imageUrl || imageUploads.get(s.ref) || null,
      send_count: s.sendCount || 1, contact_count: s.contactCount || 1, observed_at: s.observedAt || null,
    });
  }
  const mentionBatches = chunk(mentionRows, 200);
  for (let i = 0; i < mentionBatches.length; i++) {
    const rows = mentionBatches[i];
    log('Products', `Saving evidence batch ${i + 1}/${mentionBatches.length} (${rows.length} rows).`);
    const { error } = await supabase.from('product_mentions').upsert(rows, { onConflict: 'product_id,kind,source_ref' });
    if (error) throw new Error(`Saving product evidence failed: ${error.message}`);
  }
  if (!mentionBatches.length) log('Products', 'No evidence rows to save.');

  // refresh counters on everything this run touched (recounted, so re-runs never double count)
  const touchedIds = [...new Set([...plan.touched.keys(), ...plan.newProducts.map((p) => p.id)])];
  const counts = new Map();
  for (const ids of chunk(touchedIds, 100)) {
    const rows = await fetchAllPages((from, to) => supabase.from('product_mentions')
      .select('product_id, observed_at').in('product_id', ids).order('id').range(from, to));
    for (const r of rows) {
      const c = counts.get(r.product_id) || { n: 0, last: null };
      c.n++;
      if (r.observed_at && (!c.last || r.observed_at > c.last)) c.last = r.observed_at;
      counts.set(r.product_id, c);
    }
  }
  const newIds = new Set(plan.newProducts.map((p) => p.id));
  for (const [productId, entry] of plan.touched) {
    const p = entry.product;
    const c = counts.get(productId) || { n: 0, last: null };
    const update = {
      mention_count: c.n, last_mentioned_at: c.last,
      observed_prices: mergeObservedPrices(p.observed_prices, entry.observed),
    };
    if (p.status === 'discovered') {
      // never overwrite an edit the owner made
      if (p.price === null || p.price === undefined || p.price_source === 'chat' || p.price_source === 'image') {
        const picked = pickPrice(update.observed_prices);
        if (picked.price !== null) { update.price = picked.price; update.price_source = p.price_source || 'chat'; }
      }
      update.discovery_confidence = Math.max(Number(p.discovery_confidence) || 0, entry.confidence);
      const merged = [...new Set([...(Array.isArray(p.aliases) ? p.aliases : []), ...entry.aliases])].slice(0, 8);
      update.aliases = merged;
      if (!(p.images || []).length && entry.images.length) update.images = [...new Set(entry.images)].slice(0, 4);
    }
    const { error } = await supabase.from('products').update(update).eq('id', productId);
    if (error) throw new Error(`Updating product ${productId} failed: ${error.message}`);
  }
  log('Products', `Refreshed counts and evidence-derived fields for ${plan.touched.size} existing products.`);
  for (const id of newIds) {
    const c = counts.get(id);
    if (c) await supabase.from('products').update({ mention_count: c.n, last_mentioned_at: c.last }).eq('id', id);
  }
  for (const u of plan.categoryUpdates) {
    // only fills a blank: a category the owner (or an earlier run) set is never replaced
    await supabase.from('products').update({ category: u.category, category_source: 'ai' }).eq('id', u.id).is('category', null);
  }
  log('Products', `Finished category backfill for ${plan.categoryUpdates.length} existing products.`);
  log('Products', `Saved ${plan.newProducts.length} discovered products and ${mentionRows.length} pieces of evidence; updated ${plan.touched.size} existing products.`);
}

// ─── OpenAI (JSON, text or vision) ───────────────────────────────────────────
async function callOpenAiJson(ctx, state, { promptId, model, user, maxTokens, inputType = 'text', cacheKey = null, attempts = 4 }) {
  const { supabase, openaiKey, businessId } = ctx;
  const { log = () => {}, warn = () => {}, err = () => {} } = ctx;
  log('Products', `Loading AI prompt configuration for ${promptId}.`);
  const config = await getAiPromptConfig(supabase, promptId);
  const system = config.prompt ?? AI_PROMPT_CATALOG[promptId].prompt;
  const resolvedModel = config.model ?? model;
  let lastError;
  if (shouldPauseOpenAIRequest()) {
    const message = getOpenAIAvailabilityState().message || 'OpenAI Unavailable';
    err('Products', `OpenAI request for ${promptId} stopped before sending: ${message}`);
    throw new FatalRunError(message);
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const cooldown = getOpenAICooldownMs();
      if (cooldown > 0) {
        log('Products', `Waiting ${Math.min(cooldown, 30_000)}ms for OpenAI cooldown before ${promptId}.`);
        await sleep(Math.min(cooldown, 30_000));
      }
      if (shouldPauseOpenAIRequest()) {
        const message = getOpenAIAvailabilityState().message || 'OpenAI Unavailable';
        err('Products', `OpenAI request for ${promptId} stopped before attempt ${attempt}: ${message}`);
        throw new FatalRunError(message);
      }
      log('Products', `Calling OpenAI ${resolvedModel} for ${promptId} (attempt ${attempt}/${attempts}, ${inputType}).`);
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          model: resolvedModel,
          max_tokens: config.max_tokens ?? maxTokens,
          temperature: config.temperature ?? 0.1,
          response_format: { type: 'json_object' },
          ...(cacheKey ? { prompt_cache_key: String(cacheKey).slice(0, 64) } : {}),
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        const failure = classifyOpenAIFailure({ status: res.status, bodyText: body, headers: res.headers });
        if (failure.kind === 'quota' || failure.kind === 'auth') {
          setOpenAIUnavailable({ status: res.status, reason: body.slice(0, 300) || 'OpenAI rejected the request', message: "cant call ai on debug 'openai 429 or 401 error'" });
          throw new FatalRunError(`OpenAI rejected the request (${res.status}, ${failure.kind}): ${body.slice(0, 200)}. Check OPENAI_API_KEY, credits and the project's spend limit.`);
        }
        if (failure.kind === 'rate_limit') { noteOpenAIRateLimited(failure.retryAfterMs); throw new Error(`OpenAI rate limited (${res.status}); retrying after cooldown`); }
        throw new Error(`OpenAI API returned ${res.status}: ${body.slice(0, 300)}`);
      }
      const body = await res.json();
      // Bill the moment OpenAI answers. Truncated or unparseable responses (and retries) are still
      // charged by OpenAI, so they are billed too. Image tokens are inside usage.prompt_tokens.
      if (ctx.recordUsage) {
        const u = body.usage || {};
        try {
          await ctx.recordUsage({
            businessId, botId: promptId, model: resolvedModel, inputType,
            promptTokens: u.prompt_tokens || 0, cachedTokens: u.prompt_tokens_details?.cached_tokens || 0,
            completionTokens: u.completion_tokens || 0,
          });
        } catch (error) {
          warn('Products', `Could not record AI usage for ${promptId}: ${error.message}`);
        }
      }
      const choice = body.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('response truncated (finish_reason=length)');
      const raw = choice?.message?.content?.trim() || '';
      const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const usage = body.usage || {};
      state.cacheStats.calls += 1;
      state.cacheStats.prompt += usage.prompt_tokens || 0;
      state.cacheStats.cached += usage.prompt_tokens_details?.cached_tokens || 0;
      log('Products', `OpenAI ${promptId} completed: ${usage.prompt_tokens || 0} input and ${usage.completion_tokens || 0} output tokens.`);
      return { json: JSON.parse(clean), promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0 };
    } catch (e) {
      if (e instanceof FatalRunError) throw e;
      lastError = e;
      if (attempt < attempts) {
        const waitMs = Math.max(1500 * attempt, getOpenAICooldownMs());
        warn('Products', `OpenAI ${promptId} attempt ${attempt}/${attempts} failed (${e.message}); retrying in ${waitMs}ms.`);
        await sleep(waitMs);
      } else {
        err('Products', `OpenAI ${promptId} failed after ${attempts} attempts: ${e.message}`);
      }
    }
  }
  throw lastError;
}
