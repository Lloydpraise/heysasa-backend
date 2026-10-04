// Pure helpers for product discovery. No database, no network, no OpenAI in this file,
// so every rule here is covered by src/productDiscovery.test.js.
import crypto from 'node:crypto';

// ─── Names ────────────────────────────────────────────────────────────────────
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'with', 'set', 'pcs', 'pc', 'piece', 'pieces', 'new', 'kes', 'ksh', 'kshs']);
export const MATCH_THRESHOLD = 0.88;

export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function singular(token) {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  // lashes -> lash, boxes -> box, glasses -> glass, watches -> watch
  if (token.length > 4 && /(shes|ches|xes|zes|sses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function nameTokens(value) {
  const tokens = normalizeName(value).split(' ').filter(Boolean)
    .filter((t) => !STOP_WORDS.has(t))
    .map(singular);
  return [...new Set(tokens)];
}

// Word-order independent key, stored in products.dedupe_key.
export function dedupeKey(value) {
  const tokens = nameTokens(value);
  return tokens.length ? [...tokens].sort().join(' ') : normalizeName(value);
}

export function nameSimilarity(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const sb = new Set(tb);
  const inter = ta.filter((t) => sb.has(t)).length;
  if (!inter) return 0;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = inter / union;
  // One-word names only match on equality ("lash" must never swallow "lash lift").
  if (Math.min(ta.length, tb.length) === 1) return jaccard;
  const containment = inter / Math.min(ta.length, tb.length);
  return 0.5 * jaccard + 0.5 * containment;
}

// Best existing product for a candidate name, comparing against title and aliases.
export function findBestProductMatch(name, products, threshold = MATCH_THRESHOLD) {
  let best = null;
  for (const product of products) {
    const names = [product.title, ...(Array.isArray(product.aliases) ? product.aliases : [])].filter(Boolean);
    for (const candidate of names) {
      const score = nameSimilarity(name, candidate);
      if (score >= threshold && (!best || score > best.score)) best = { product, score };
    }
  }
  return best;
}

// ─── Prices ───────────────────────────────────────────────────────────────────
export function parsePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value < 1e8 ? Math.round(value * 100) / 100 : null;
  let s = String(value).toLowerCase().trim();
  if (/\d\s*[-–]\s*\d/.test(s)) return null; // a range is not one price
  s = s.replace(/\b(kes|ksh|kshs|sh|shs|bob)\b\.?/g, '').replace(/[/=]+-?\s*$/g, '').trim();
  const kilo = s.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kilo) return parsePrice(Number(kilo[1]) * 1000);
  s = s.replace(/(\d)[,\s](?=\d{3}(\D|$))/g, '$1');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return parsePrice(Number(s));
}

// A price the model returned must actually appear in the line it came from.
export function priceAppearsIn(text, price) {
  const p = parsePrice(price);
  if (p === null) return false;
  const t = String(text ?? '').toLowerCase().replace(/(\d)[,\s](?=\d{3}(\D|$))/g, '$1');
  const whole = Number.isInteger(p) ? String(p) : String(p);
  const forms = [whole];
  if (p >= 1000 && p % 100 === 0) forms.push(`${p / 1000}k`);
  return forms.some((f) => new RegExp(`(^|[^\\d.])${f.replace('.', '\\.')}($|[^\\d])`).test(t));
}

export function addObservedPrice(list, price, seenAt = null) {
  const p = parsePrice(price);
  const out = Array.isArray(list) ? list.map((x) => ({ ...x })) : [];
  if (p === null) return out;
  const hit = out.find((x) => Number(x.price) === p);
  if (hit) {
    hit.count = (Number(hit.count) || 0) + 1;
    if (seenAt && (!hit.last_seen || seenAt > hit.last_seen)) hit.last_seen = seenAt;
  } else {
    out.push({ price: p, count: 1, last_seen: seenAt || null });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 8);
}

export function mergeObservedPrices(a, b) {
  let out = Array.isArray(a) ? a.map((x) => ({ ...x })) : [];
  for (const item of Array.isArray(b) ? b : []) {
    const p = parsePrice(item.price);
    if (p === null) continue;
    const hit = out.find((x) => Number(x.price) === p);
    if (hit) {
      hit.count = (Number(hit.count) || 0) + (Number(item.count) || 1);
      if (item.last_seen && (!hit.last_seen || item.last_seen > hit.last_seen)) hit.last_seen = item.last_seen;
    } else {
      out.push({ price: p, count: Number(item.count) || 1, last_seen: item.last_seen || null });
    }
  }
  return out.sort((x, y) => y.count - x.count).slice(0, 8);
}

// Most often seen price wins; a tie goes to the most recent one.
export function pickPrice(observed) {
  const list = (Array.isArray(observed) ? observed : []).filter((x) => parsePrice(x.price) !== null);
  if (!list.length) return { price: null, spread: null };
  const sorted = [...list].sort((x, y) => (y.count - x.count) || String(y.last_seen || '').localeCompare(String(x.last_seen || '')));
  const prices = list.map((x) => Number(x.price));
  const spread = list.length > 1 ? Math.round((Math.max(...prices) / Math.min(...prices)) * 100) / 100 : 1;
  return { price: Number(sorted[0].price), spread };
}

// ─── Text safety ──────────────────────────────────────────────────────────────
// Same idea as the persona pack: nothing personal reaches a prompt or the database.
export function redact(text) {
  return String(text ?? '')
    .replace(/\b[AP]\d{9}[A-Z]\b/g, '[pin]')
    .replace(/(?:\+?254|\b0)[17]\d{8}\b/g, '[phone]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10}\b/g, '[code]')
    .replace(/\b\d{9,}\b/g, '[number]');
}

export function squash(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// The model must quote the line it got the product from, word for word.
export function verifyQuote(quote, source) {
  const q = squash(quote);
  if (q.length < 3) return false;
  return squash(source).includes(q);
}

// ─── Which owner messages are worth showing the model ────────────────────────
const PRICE_RE = /(?:\b(?:kes|ksh|kshs|sh|shs|bob)\b\.?\s*\d)|(?:\d[\d,.\s]*\s*(?:\/=|\/-|k\b|bob\b|kes\b|ksh\b|shs?\b))|(?:\b\d{3,6}\b)/i;
const INQUIRY_RE = /\b(how much|price|prices|cost|do you have|do u have|available|availability|in stock|bei|ngapi|mnauza|unauza|mna|tuna|catalog|catalogue|menu|pricelist|price list|what do you (?:sell|offer)|picha|photos?)\b/i;
const OFFER_RE = /\b(we have|we do|we offer|we sell|available|in stock|new arrival|restock|tunauza|tuna|inapatikana|ipo|package|packages|starts? at|from kes|from ksh)\b/i;
const GREETING_RE = /^(hi|hello|hey|hallo|habari|sasa|mambo|good (morning|afternoon|evening)|thanks?|thank you|asante|ok(ay)?|sawa|noted|karibu|welcome)\b[\s!.,😊🙏👍❤️✨]*$/iu;

export function isProductRelevantOwnerMessage(ownerText, prevCustomerText = '', isCaption = false) {
  const text = String(ownerText ?? '').trim();
  if (text.length < 8) return false;
  if (GREETING_RE.test(text)) return false;
  if (PRICE_RE.test(text)) return true;
  if (OFFER_RE.test(text)) return true;
  if (isCaption && text.length >= 10) return true;
  if (INQUIRY_RE.test(String(prevCustomerText ?? ''))) return true;
  return false;
}

// ─── WhatsApp media ───────────────────────────────────────────────────────────
export function toBuffer(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') {
    try { const b = Buffer.from(value, 'base64'); return b.length ? b : null; } catch { return null; }
  }
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'object') {
    // Evolution stores binary fields as {"0": 94, "1": 164, ...}
    const keys = Object.keys(value).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    if (!keys.length) return null;
    return Buffer.from(keys.map((k) => Number(value[k]) & 255));
  }
  return null;
}

export function unwrapRawMessage(raw) {
  let m = raw?.message;
  if (!m) return null;
  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
    if (m[wrapper]?.message) m = m[wrapper].message;
  }
  return m;
}

export function waImageRef(raw) {
  const img = unwrapRawMessage(raw)?.imageMessage;
  if (!img) return null;
  return {
    url: typeof img.url === 'string' ? img.url : null,
    directPath: typeof img.directPath === 'string' ? img.directPath : null,
    mediaKey: toBuffer(img.mediaKey),
    fileSha256: toBuffer(img.fileSha256),
    fileEncSha256: toBuffer(img.fileEncSha256),
    thumbnail: toBuffer(img.jpegThumbnail),
    mimetype: img.mimetype || 'image/jpeg',
    caption: typeof img.caption === 'string' ? img.caption : '',
  };
}

// One key per distinct picture, so an image sent to 100 customers is read once.
export function imageKeyFor(message) {
  const ref = waImageRef(message?.raw_payload);
  if (ref?.fileSha256?.length) return `wa:${ref.fileSha256.toString('hex')}`;
  const url = message?.content?.media?.url;
  if (typeof url === 'string' && url) return `url:${url}`;
  if (ref?.thumbnail?.length) return `th:${crypto.createHash('sha1').update(ref.thumbnail).digest('hex')}`;
  return null;
}

const MEDIA_INFO = { image: 'WhatsApp Image Keys', video: 'WhatsApp Video Keys', audio: 'WhatsApp Audio Keys', document: 'WhatsApp Document Keys' };

function expandMediaKey(mediaKey, kind) {
  const info = MEDIA_INFO[kind] || MEDIA_INFO.image;
  const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), info, 112));
  return { iv: expanded.subarray(0, 16), cipherKey: expanded.subarray(16, 48), macKey: expanded.subarray(48, 80) };
}

// WhatsApp CDN files are AES-256-CBC encrypted with a key derived from mediaKey, followed by a 10 byte MAC.
export function decryptWhatsAppMedia(encrypted, mediaKey, kind = 'image') {
  if (!Buffer.isBuffer(encrypted) || encrypted.length <= 10) throw new Error('encrypted media too short');
  if (!Buffer.isBuffer(mediaKey) || mediaKey.length !== 32) throw new Error('media key must be 32 bytes');
  const { iv, cipherKey, macKey } = expandMediaKey(mediaKey, kind);
  const body = encrypted.subarray(0, encrypted.length - 10);
  const mac = encrypted.subarray(encrypted.length - 10);
  const expected = crypto.createHmac('sha256', macKey).update(iv).update(body).digest().subarray(0, 10);
  if (!crypto.timingSafeEqual(expected, mac)) throw new Error('media MAC mismatch');
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// Used by the tests to prove the decrypt path against the same algorithm.
export function encryptWhatsAppMedia(plain, mediaKey, kind = 'image') {
  const { iv, cipherKey, macKey } = expandMediaKey(mediaKey, kind);
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(body).digest().subarray(0, 10);
  return Buffer.concat([body, mac]);
}

export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function extensionFor(mime) {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

// ─── Candidates → clusters ────────────────────────────────────────────────────
// candidate: { name, kind, price, description, source: { kind, ref, ... } }
export function clusterCandidates(candidates, threshold = MATCH_THRESHOLD) {
  const clusters = [];
  for (const cand of candidates) {
    const name = String(cand.name || '').trim();
    if (!name) continue;
    const key = dedupeKey(name);
    let target = clusters.find((c) => c.key === key);
    if (!target) {
      let bestScore = 0;
      for (const c of clusters) {
        const score = Math.max(...c.names.map((n) => nameSimilarity(name, n.name)));
        if (score >= threshold && score > bestScore) { bestScore = score; target = c; }
      }
    }
    if (!target) {
      target = { key, names: [], kind: cand.kind === 'service' ? 'service' : 'product', sources: [], description: null, nameSources: new Set() };
      clusters.push(target);
    }
    const seen = target.names.find((n) => n.name.toLowerCase() === name.toLowerCase());
    if (seen) seen.count += 1; else target.names.push({ name, count: 1 });
    target.sources.push({ ...cand.source, price: parsePrice(cand.price), name });
    if (cand.nameSource) target.nameSources.add(cand.nameSource);
    if (cand.description && (!target.description || cand.description.length > target.description.length)) target.description = String(cand.description).slice(0, 300);
    if (cand.kind === 'service') target.kind = 'service';
  }
  return clusters.map(finalizeCluster);
}

function finalizeCluster(cluster) {
  const names = [...cluster.names].sort((a, b) => (b.count - a.count) || (a.name.length - b.name.length));
  let observed = [];
  for (const s of cluster.sources) observed = addObservedPrice(observed, s.price, s.observedAt || null);
  return {
    name: names[0].name,
    aliases: names.slice(1).map((n) => n.name),
    kind: cluster.kind,
    description: cluster.description,
    sources: cluster.sources,
    nameSources: [...cluster.nameSources],
    observedPrices: observed,
  };
}

// Applies the model's merge groups, but only ones that reference real clusters and real names.
export function applyConsolidation(clusters, groups) {
  const used = new Set();
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const members = [...new Set((Array.isArray(group?.members) ? group.members : []).map(Number))]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < clusters.length && !used.has(i));
    if (members.length < 2) continue;
    const memberClusters = members.map((i) => clusters[i]);
    const memberNames = memberClusters.flatMap((c) => [c.name, ...c.aliases]);
    const chosen = memberNames.find((n) => n.toLowerCase() === String(group.name || '').trim().toLowerCase())
      || memberClusters[0].name;
    members.forEach((i) => used.add(i));
    let observed = [];
    for (const c of memberClusters) observed = mergeObservedPrices(observed, c.observedPrices);
    const aliasSet = new Map();
    for (const n of memberNames) if (n.toLowerCase() !== chosen.toLowerCase()) aliasSet.set(n.toLowerCase(), n);
    out.push({
      name: chosen,
      aliases: [...aliasSet.values()],
      kind: memberClusters.some((c) => c.kind === 'service') ? 'service' : 'product',
      description: memberClusters.map((c) => c.description).filter(Boolean).sort((a, b) => b.length - a.length)[0] || null,
      sources: memberClusters.flatMap((c) => c.sources),
      nameSources: [...new Set(memberClusters.flatMap((c) => c.nameSources))],
      observedPrices: observed,
    });
  }
  clusters.forEach((c, i) => { if (!used.has(i)) out.push(c); });
  return out;
}

// Weighs how sure we are the business really sells this. 0 to 1.
export function clusterConfidence(cluster) {
  const textSources = cluster.sources.filter((s) => s.kind === 'text');
  const imageSources = cluster.sources.filter((s) => s.kind === 'image');
  let score = 0.2;
  score += Math.min(0.35, textSources.length * 0.12);
  if (imageSources.length) score += 0.25;
  if (cluster.observedPrices.length) score += 0.15;
  if (cluster.nameSources.includes('visible_text')) score += 0.1;
  const contacts = new Set(cluster.sources.map((s) => s.contactId).filter(Boolean));
  if (contacts.size >= 3) score += 0.1;
  return Math.min(1, Math.round(score * 100) / 100);
}

// A suggestion needs real evidence: a stated price, a read image, or a repeat.
export function passesEvidenceBar(cluster, { minMentionsWithoutPrice = 2 } = {}) {
  const hasImage = cluster.sources.some((s) => s.kind === 'image');
  if (hasImage) return true;
  const hasPrice = cluster.observedPrices.length > 0;
  const mentions = cluster.sources.length;
  return hasPrice ? mentions >= 1 : mentions >= minMentionsWithoutPrice;
}

// ─── Catalog for the analyser and the persona pack ───────────────────────────
export function formatMoney(price, currency) {
  const p = parsePrice(price);
  if (p === null) return null;
  const n = Number.isInteger(p) ? p.toLocaleString('en-US') : p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency || 'KES'} ${n}`;
}

export function formatCatalogForPrompt(products, { currency = 'KES', maxLines = 300, maxChars = 14000 } = {}) {
  const lines = [];
  let chars = 0;
  let shown = 0;
  for (const p of products) {
    const parts = [`ID: ${p.id}`, `Name: ${String(p.title || '').replace(/\s+/g, ' ').trim()}`];
    const money = formatMoney(p.price, currency);
    if (money) parts.push(`Price: ${money}`);
    if (p.type === 'service') parts.push('Type: service');
    if (p.category) parts.push(`Category: ${String(p.category).replace(/\s+/g, ' ').trim()}`);
    const aliases = (Array.isArray(p.aliases) ? p.aliases : []).slice(0, 4);
    if (aliases.length) parts.push(`Also called: ${aliases.join(', ')}`);
    const line = `- ${parts.join(' | ')}`;
    if (shown >= maxLines || chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
    shown++;
  }
  if (shown < products.length) lines.push(`- (${products.length - shown} more products not shown)`);
  return lines.join('\n');
}

// ─── Keeping the analyser honest about products ──────────────────────────────
// catalog: Map(id -> { title, aliases }). fullText: both sides of the chat.
export function groundNlpProducts(nlp, { catalog, fullText }) {
  const flags = [];
  const chatTokens = new Set(nameTokens(fullText));
  const grounded = (name) => nameTokens(name).some((t) => chatTokens.has(t));

  const matched = [];
  for (const entry of Array.isArray(nlp?.matched_products) ? nlp.matched_products : []) {
    const name = String(entry?.product_name ?? '').trim();
    const id = entry?.product_id === null || entry?.product_id === undefined ? null : String(entry.product_id);
    const hit = id ? catalog.get(id) : null;
    if (hit) {
      const names = [hit.title, ...(hit.aliases || [])];
      if (!names.some(grounded)) { flags.push('product_match_ungrounded'); continue; }
      matched.push({ product_id: id, product_name: hit.title, match_status: 'matched' });
    } else {
      if (id) flags.push('product_id_not_in_catalog');
      if (!name || !grounded(name)) { flags.push('product_name_ungrounded'); continue; }
      matched.push({ product_id: null, product_name: name.slice(0, 120), match_status: 'no match' });
    }
  }

  const tags = [];
  for (const tag of Array.isArray(nlp?.product_tags) ? nlp.product_tags : []) {
    const t = String(tag ?? '').trim();
    if (!t) continue;
    if (!grounded(t)) { flags.push('product_tag_ungrounded'); continue; }
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t.slice(0, 80));
  }
  return { matched_products: matched, product_tags: tags.slice(0, 5), flags: [...new Set(flags)] };
}

// ─── Categories ──────────────────────────────────────────────────────────────
export const MAX_CATEGORY_LENGTH = 40;

export function cleanCategory(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 2 || text.length > MAX_CATEGORY_LENGTH) return null;
  if (/^(other|others|misc|miscellaneous|general|products?|services?|items?|uncategori[sz]ed|none|n\/a)$/i.test(text)) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Turns the model's {assignments:[{i, category}]} into a Map(index -> category).
// A category the business already uses is reused with its existing spelling, so "lash sets" and
// "Lash sets" never become two groups. Anything unusable is skipped (the product stays uncategorised).
export function applyCategories(count, assignments, existingCategories = []) {
  const known = new Map();
  for (const c of existingCategories) { const clean = cleanCategory(c); if (clean) known.set(clean.toLowerCase(), clean); }
  const out = new Map();
  for (const a of Array.isArray(assignments) ? assignments : []) {
    const i = Number(a?.i);
    if (!Number.isInteger(i) || i < 0 || i >= count || out.has(i)) continue;
    const clean = cleanCategory(a?.category);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!known.has(key)) known.set(key, clean);
    out.set(i, known.get(key));
  }
  return out;
}
