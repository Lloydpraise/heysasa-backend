# HeySasa product discovery

Extract this zip straight into the repo root (heysasa-backend). Every file lands in its correct folder.

| File | Action |
|---|---|
| supabase/migrations/20261003000000_products_discovery.sql | NEW (run in Supabase BEFORE anything else) |
| discover-products.js | NEW (repo root, next to run-local.js) |
| src/productDiscovery.js | NEW |
| src/productRoutes.js | NEW |
| src/services/productDiscoveryRunner.js | NEW |
| src/productDiscovery.test.js | NEW |
| src/services/productDiscoveryRunner.test.js | NEW |
| supabase/audit/products_invariants.sql | NEW (set the business id on the params line) |
| run-local.js | REPLACE (analyser: runs discovery, uses approved catalog, grounds products) |
| generate-persona-pack.js | REPLACE (persona pack: approved, AI-visible products only) |
| src/aiPromptCatalog.js | REPLACE (4 new prompts (adds product_categorizer), tighter product rules in the analyser prompt) |
| src/index.js | REPLACE (live code: product routes, and admin /debug/businesses now reports product runs; redeploy the backend) |
| src/services/aiPromptConfig.test.js | REPLACE (catalog size 17 to 21) |
| public/debug.html | REPLACE (admin: Run product discovery + dry run in the Run menu, progress bar) |

## Categories
Each run also sorts new products (and any product with no category yet) into short categories like "Lash extensions". It reuses categories you already have, never overwrites one you set, and the analyser and persona pack now see products grouped by category.

## Admin
Admin console > Businesses > pick a business > Run product discovery (or Product discovery dry run, which writes nothing and prints what it would add into the live log under area "products").

## Order
1. Run `20261003000000_products_discovery.sql` in the Supabase SQL editor.
2. Extract the zip into the repo root and redeploy the backend.
3. `node --test src/productDiscovery.test.js src/services/productDiscoveryRunner.test.js` (28 tests pass).
4. Preview, writes nothing: `BUSINESS_ID=lashesbyshazz node discover-products.js --dry-run`
5. Real run: `BUSINESS_ID=lashesbyshazz node discover-products.js` (or `POST /products/discover`).
6. Review what it found, approve, then run the analyser again with `force` so existing chats are re-analysed against real products.

The analyser now runs discovery by itself after it has separated customers from everyone else and before it analyses them. A business that has never been analysed must go through the analyser first: discovery refuses to read chats that are not yet marked as customers (vendors, staff and personal chats would pollute the catalog).

## Review and approve before the Products page exists
```sql
select id, title, price, discovery_confidence, mention_count, source
from products where business_id = 'lashesbyshazz' and status = 'discovered'
order by mention_count desc;

-- approve everything fairly sure of
update products set status = 'approved'
where business_id = 'lashesbyshazz' and status = 'discovered' and discovery_confidence >= 0.6;

-- reject one for good
update products set status = 'dismissed' where id = 'prd_...';
```
Approving a product also runs the same vectorize and polish edge functions a manually added product gets. Discovered products do not (they cost nothing until approved).

## API (same shape as /persona/generate)
```
POST /products/discover      headers: Authorization: Bearer <jwt>, X-Business-Id
                             body: { "force": false, "dryRun": false }
GET  /products/discover/status
```
Status returns `state` (idle, running, ready, failed, insufficient_data), the latest run with phase and progress, and `discovered_waiting_for_review`.

## Settings (all optional)
| Name | Default | What it does |
|---|---|---|
| PRODUCT_MAX_IMAGES | 150 | distinct images read per run; the rest wait for the next run |
| OPENAI_VISION_MODEL | same as OPENAI_MODEL | model that reads images (must support images) |
| FORCE_PRODUCT_DISCOVERY | off | `1` makes the analyser re-read everything, not just what is new |
| SKIP_PRODUCT_DISCOVERY | off | `1` stops the analyser running discovery |
| AI_BILLING_MULTIPLIER | 5.0 | only for discover-products.js on its own; the analyser uses its own constant |

## What it reads, and what it refuses to
- Text: lines written by the owner or staff (`agent_role = human`) in chats marked as customers. Lines about price, availability or an answer to a "do you have / how much" question are sent in batches. The same template sent to 100 people counts at most 3 times.
- Every item the model returns must quote the owner's exact words, the name must appear in those lines, and a price must literally appear in the line, otherwise it is dropped. One unpriced mention is not enough; a priced mention, an image, or two mentions is.
- Images: only images the owner sent. Each distinct picture is read once (a campaign image sent to 100 customers is one read). The picture is fetched from our own stored copy, or from WhatsApp and decrypted here with the key stored in the message, or as a last resort the tiny preview (prices are ignored from previews).
- Photos of payments, documents, screenshots and people are never stored and produce no products. Only product photos, price lists, menus and posters are copied into the `product-images` bucket.
- Products you dismissed are never suggested again. Approved products are never renamed or re-priced; they only collect evidence and a mention count. A price the owner edited on a discovered product is kept.
- Discovered products are created with `is_visible = false`, so they cannot appear on a storefront.

## For the Products page (next step)
- Approve: `status = 'approved'`. Dismiss: `status = 'dismissed'`. The database stamps approved_at and dismissed_at.
- When the owner edits a price or name, also set `price_source = 'owner'` so discovery never overwrites it.
- `ai_visible` is the switch for "let the AI use this product". `is_visible` stays the storefront switch.
- Manual add and CSV/XML import insert with `status = 'approved'` (the new default) and `source` of `manual`, `csv` or `xml`.
- Evidence for the review screen: `product_mentions` (quote, image_url, price, contact_count) joined on `product_id`.

## Things to know
- WhatsApp image links expire. Recent images decrypt fine; older ones may only be readable as small previews or not at all. The run summary counts `images_unreachable` and `images_low_res` so you can see how much was lost. Storing every image as it arrives (in the webhook) would fix this for good and is worth doing next.
- Customer-sent images are not read (receipts, ID photos). Products they ask about still come through the owner's replies.
- Rough cost per business, first run: about 30 text calls and up to 150 image reads, in the order of a few cents at gpt-4.1-mini prices. Later runs read only new messages and unread images.
- A failed discovery never stops the analyser, except an OpenAI key or credit problem, which would stop it anyway.
