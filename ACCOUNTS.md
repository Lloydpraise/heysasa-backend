# HeySasa accounts (one per WhatsApp number)

A **business** owns one or more **accounts**. Each account is one WhatsApp number, locked to that number for
life. Everything that comes from or goes to WhatsApp belongs to an account. The business keeps people, billing,
default settings and the business-wide view.

## Words

| Word | Meaning |
|---|---|
| business | `businesses.business_id` (text). Owner = `businesses.user_id`. |
| account | `accounts.id` (uuid). One WhatsApp number. `accounts.business_id` points at its business. |
| instance | The Evolution connection currently serving an account (`accounts.instance_name`). Replaceable plumbing. |
| scope | What a request may see: `{ businessId, accountId \| null, role, accountIds, isAdmin }`. |
| business-wide | `accountId = null`. Only owners and admins. Reads every account of the business. |

## Rules

1. **Locked number.** `accounts.phone_number` is set the first time the number connects and never changes.
   Connecting a different phone to that account is refused (`phone_mismatch`); the owner creates a new account.
2. **A dropped instance never deletes the account.** The account goes to `status = 'disconnected'` and keeps all
   its data. Reconnecting the same number (same or new instance) brings it back.
3. **Every account-scoped row has `account_id`** (see the table list in the migration). `business_id` stays on
   every row too, for business-wide totals and access rules.
4. **Writes.** A database trigger fills a missing `account_id` in this order: the parent row (contact, lead,
   campaign, enrollment, conversation, list, playbook, knowledge source), then the `x-account-id` request header
   (dashboard), then the business's only account. If the business has several accounts and none of those apply,
   the insert fails with `account_id_required`. Code should still pass `account_id` whenever it knows it.
   An explicit `account_id` that belongs to another business is refused.
5. **Reads.** Backend (service role, no row security): every query on an account-scoped table adds
   `.eq('account_id', scope.accountId)` when `scope.accountId` is set. Use `forAccount(query, scope)`.
   Dashboard (signed-in user): row security already limits rows to accounts the user may see, and when the
   dashboard sends the `x-account-id` header, to that account plus business-level rows (`account_id is null`).
6. **Business-level rows** (`account_id is null`) are allowed only in: `products`, `persona_packs`,
   `knowledge_sources`, `knowledge_chunks`, `followup_materials`, `chat_ai_tools`, logs and billing records.
   They are the **business catalog**, shared by every account: an account reads its own rows plus the
   business-level ones (`account_id = X or account_id is null`, helper `forAccountOrShared`). An account can
   copy catalog items (or another account's items) into itself with `copy_business_items_to_account` to own and
   change them. Products discovered from chats belong to the account they were discovered on; hand-added
   products, knowledge files, materials and tools stay business-level unless added while one account is selected.
7. **Settings.** WhatsApp-related settings (follow-up caps, quiet hours, chat AI switches, persona status...)
   still live on `businesses` as the business default. `accounts.settings` (jsonb) overrides them per account.
   Read them with `account_settings(account_id)` (SQL) or `loadAccountSettings(db, accountId)` (JS).
8. **Persona.** Each account generates its own persona pack. A business-wide pack (`account_id is null`) is the
   fallback while an account has no chats yet; the persona screen then asks the owner to fill the gaps.

## People

| Role | Where | Can |
|---|---|---|
| owner | `businesses.user_id` | Everything, every account, business-wide view, billing, team. |
| admin | `business_users.role = 'admin'` | Same as owner except deleting the business. |
| member | `business_users.role = 'member'` | Only accounts listed in `business_user_accounts`. No business-wide view, billing or team. |

Invites are links: `business_users.invite_token`. The invitee signs in and opens the link; the backend claims it.

## Requests

The dashboard sends `X-Business-Id` and, when an account is selected, `X-Account-Id`.
`resolveScope` (backend `src/middleware/accessScope.js`, engine `followup-engine/src/api/accessScope.js`) checks:

- the user is the owner or an active `business_users` row of the business;
- `X-Account-Id`, if sent, belongs to the business and is in the user's `accountIds`;
- a member without `X-Account-Id` gets their only account, or `400 account_required` if they have several.

`req.scope` holds the result. `req.businessId` / `req.accountId` are kept for older code.

## Billing

- **Access fee:** KES 10,000 per account per month (`billing_prices.account_monthly_kes`). Invoices are rows in
  `account_invoices`, billed to the business or, for `billing_mode = 'separate'`, to the account itself.
  Enforcement is off until `billing_prices.enforce_account_subscription = 1`; then an account more than
  `account_grace_days` past due is `suspended` (no sending, no chat AI).
- **AI credit:** the existing wallet. `billing_mode = 'business'` accounts spend from `business_balances`;
  `separate` accounts spend from their own `account_balances` row. Every charge records `account_id`, so the
  business sees each account's spend either way.

## Deploy order

1. Migrations `20261024100000` (foundation), `…100100` (backfill), `…100200` (access and functions). Old code keeps
   working: every new argument is optional and the business-level unique keys still exist.
2. Deploy the backend, follow-up engine, edge functions and dashboard that pass `account_id`.
3. Migration `…100300` (part B): unique keys and primary keys move to `account_id`. Upserts must use the account
   columns from here on (`onConflict: 'account_id,social_platform,social_id'` etc.).
4. Only then may a business add a second account. The create-account route refuses until part B has run
   (it checks that `unique_social_lead` is gone).

## Instances

`accounts.instance_name` is the instance that serves the account now. When it changes, a trigger moves active
campaigns and pending follow-ups to the new instance. Senders look the instance up from the account, not from a
stored name, wherever they can.

## Backend helpers (for code that reads or writes account data)

- `src/middleware/accessScope.js`: `requireScope` (same as `requireBusinessAuth`), `requireAccountScope` (400
  `account_required` when no single account is selected), `requireBusinessAdmin`, `scopeOrRespond(req, res, opts)`,
  `forAccount(query, scope)`, `forAccountOrShared(query, scope)`, `accountIdFor(scope)`.
  The follow-up engine re-exports these from `followup-engine/src/api/authMiddleware.js`.
- `src/services/accounts.js`: `getAccount`, `listAccounts`, `resolveInstance(instanceName)` -> `{ businessId, accountId }`,
  `loadAccountSettings(db, accountId, businessId)` (business row with `accounts.settings` laid over it),
  `dbForAccount(accountId)` (service-role client that stamps `x-account-id`, so inserts get the account),
  `checkAccountPhone`, `createAccount`, `accountsOverview`.
- Upserts use the account keys: contacts `account_id, social_platform, social_id`; conversations
  `account_id, contact_id`; ad_attributions / ad_playbooks `account_id, ad_id`; lists / segmentation_rules /
  auto_campaign_configs `account_id, rule_id`; chat_ai_skills / followup_ai_skills `account_id, key`;
  daily_send_counters `account_id, send_date`; business_setup `account_id`; persona_packs `account_id, version`.
  These keys exist from migration `…100200`; include `account_id` in the row. `lead_ai_state` keeps
  `business_id, contact_id` (a contact belongs to one account anyway).
- Database functions with a new optional last argument `p_account_id`: `activate_auto_campaign`,
  `apply_auto_campaign_config`, `chat_ai_seed_skills`, `chat_ai_reset_skill`, `match_knowledge_chunks`,
  `bill_ai_usage`, `bill_send`, `deduct_balance`, `admin_credit_wallet`, `my_billing_overview`.
  New: `copy_business_items_to_account(p_account_id, p_kind, p_ids, p_from_account)`, `account_can_operate(p_account_id)`
  (false when the access fee is past grace and enforcement is on: no sending, no chat AI), `account_settings(p_account_id)`,
  `account_billing_daily()`, `admin_mark_account_invoice_paid(p_invoice_id, p_reference)`, `accounts_part_b_applied()`.
- Senders take the instance from the account (`accounts.instance_name`), falling back to the stored campaign / queue
  instance only for rows without an account.

## Dashboard contract

- Selected account: `localStorage.account_id` and `window.currentAccountId`; `null`/absent = "Business wide"
  (owners and admins only). Switching reloads the page, like switching business.
- Every backend call sends `X-Business-Id` and, when an account is selected, `X-Account-Id`.
- The Supabase client sends the header `x-account-id` (global header) so row security narrows direct table reads to
  the selected account (plus business-level catalog rows). Inserts get the account from that header too.
- Endpoints: `GET /accounts`, `POST /accounts`, `PATCH /accounts/:id`, `POST /accounts/:id/import`,
  `GET /accounts/overview`, `GET /team`, `POST /team/invite`, `PATCH /team/:id`, `DELETE /team/:id`,
  `POST /team/accept` (see `src/accounts/routes.js` for bodies). Billing page: RPC `my_billing_overview(p_business_id,
  p_account_id)` returns `by_account` and `invoices` for owners/admins.
- Connecting WhatsApp happens inside an account: `POST /wa/instance/create` needs the account selected (or the business
  has none yet). Errors: `account_required`, `account_already_connected`, `phone_mismatch` (409, with `expected`).
  A refused number shows on the account as `connect_error`.
- Admin (`public/admin.html`, debug token): `GET /admin/api/accounts/invoices`, `POST /admin/api/accounts/invoices/:id/paid`.
