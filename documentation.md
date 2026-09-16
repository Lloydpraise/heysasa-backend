# HeySasa Backend Documentation

This repository contains two cooperating Node.js services:

1. **Main backend**: receives Evolution API webhooks, normalizes WhatsApp data, and writes contacts, conversations, and messages to Supabase.
2. **Follow-up engine**: reads that data, generates and quality-checks follow-up drafts, manages approval, schedules work, and sends approved messages through Evolution API.

## 1. Runtime Overview

### Main backend

- Entry point: `src/index.js`
- Default port: `3000` (`PORT` overrides it)
- Start: `npm start`
- JSON body limit: `50mb`
- Also starts the follow-up engine as a child process on `FOLLOWUP_ENGINE_PORT`, default `3001`.
- `GET /health` returns `{ "status": "ok", "mode": "single-tenant" }`.

### Follow-up engine

- Entry point: `followup-engine/src/index.js`
- Default API port: `3001` (`PORT` overrides it)
- Starts the scheduler, sender, and authenticated API in one process.
- Direct package commands:
  - `npm run start:all`
  - `npm run start:scheduler`
  - `npm run start:sender-baileys`
  - `npm run start:api`

### End-to-end flow

```text
WhatsApp
  -> Evolution API
  -> POST /webhook/evolution
  -> main backend normalization
  -> Supabase contacts/conversations/messages
  -> follow-up scheduler
  -> follow_up_queue
  -> approval or automatic routing
  -> Evolution API sendText endpoint
  -> Supabase message and outcome bookkeeping
```

## 2. Evolution API Integration

Evolution API is the WhatsApp transport. The main backend receives Evolution events. The follow-up engine and WhatsApp connection routes make outbound Evolution requests.

### Evolution configuration

Main backend variables are read by `src/config/evolution.js`:

| Variable | Default | Purpose |
|---|---|---|
| `EVOLUTION_URL` | `http://localhost:8080` | Evolution API base URL for the main backend |
| `EVOLUTION_API_KEY` | empty | Sent as the `apikey` header |
| `EVOLUTION_WEBHOOK_URL` | empty | Public webhook URL registered with Evolution |
| `SINGLE_BUSINESS_ID` | `lashesbyshazz` | Default business for local analysis |

The follow-up engine reads its own configuration in `followup-engine/src/config.js`. Its Evolution default is `http://129.213.33.173:8080`; set `EVOLUTION_URL` explicitly so both services use the same server.

### Configure Evolution webhook

Set the Evolution webhook URL to the publicly reachable main-backend URL:

```text
https://your-domain.example/webhook/evolution
```

The registered events should include:

- `MESSAGES_UPSERT`
- `MESSAGES_UPDATE`
- `MESSAGING_HISTORY_SET`
- `CONNECTION_UPDATE`
- `PRESENCE_UPDATE`

The connection helper also requests `base64: true` for webhook media-related fields.

### Receiving WhatsApp history

Use the main backend endpoint:

```http
POST /webhook/evolution
Content-Type: application/json
```

The payload must identify the business through `instance`. That value must equal `businesses.evolution_instance_id` in Supabase. The handler also accepts `data.instance` for resolution.

Recommended history body:

```json
{
  "event": "MESSAGING_HISTORY_SET",
  "instance": "heysasa-business-instance",
  "data": {
    "contacts": [
      {
        "id": "254712345678@s.whatsapp.net",
        "name": "John Doe",
        "notify": "John Doe"
      }
    ],
    "chats": [
      {
        "id": "254712345678@s.whatsapp.net",
        "unreadCount": 0
      }
    ],
    "messages": [
      {
        "key": {
          "id": "message-id-123",
          "remoteJid": "254712345678@s.whatsapp.net",
          "fromMe": false
        },
        "messageTimestamp": 1756108800,
        "pushName": "John Doe",
        "message": {
          "conversation": "Hi, I am interested"
        }
      }
    ]
  }
}
```

Accepted history event names are case-insensitive after normalization:

- `MESSAGING_HISTORY_SET`
- `MESSAGING.HISTORY.SET`
- `MESSAGES_SET`

The handler returns `200 OK` after resolving the business and then processes the records. A request with an unknown or missing Evolution instance returns `400`. Processing errors are logged after the acknowledgement, so a `200` does not guarantee every record was stored.

### History data rules

- `data.contacts` creates or updates contacts.
- `data.chats` creates or updates direct-message conversations.
- `data.messages` creates or updates messages in batches of 100.
- `contacts[].id`, `chats[].id`, and `messages[].key.remoteJid` must match for the records to connect.
- `messageTimestamp` must be Unix time in seconds.
- Groups (`@g.us`), broadcasts, newsletters, `status@broadcast`, and JIDs containing `lid` are skipped.
- Stub messages are skipped.
- Existing records are safely repeatable because contacts, conversations, and messages are upserted.

### Message content shapes

`src/services/dataCleaner.js` normalizes these Evolution message fields:

| Evolution field | Stored `type` | Main extracted value |
|---|---|---|
| `message.conversation` | `text` | `text` |
| `message.extendedTextMessage.text` | `text` | `text` |
| `message.imageMessage` | `image` | caption |
| `message.audioMessage` | `audio` or `voice_note` | duration |
| `message.videoMessage` | `video` | caption |
| `message.documentMessage` | `document` | file name |
| `message.stickerMessage` | `sticker` | none |
| `message.reactionMessage` | `reaction` | emoji/text |
| `message.locationMessage` | `location` | latitude/longitude |
| `message.contactMessage` | `contact` | display name |
| `message.buttonsResponseMessage` | `button_response` | selected display text |
| `message.listResponseMessage` | `list_response` | title |

Stored content is a JSON object, commonly `{ "text": "...", "type": "text" }`. The original Evolution message is retained in `messages.raw_payload`.

### Live messages

Live inbound and outbound events use the same endpoint:

```http
POST /webhook/evolution
Content-Type: application/json
```

The handler accepts any of these layouts:

```json
{ "event": "MESSAGES_UPSERT", "instance": "name", "data": [ /* messages */ ] }
```

```json
{ "event": "MESSAGES_UPSERT", "instance": "name", "data": { /* one message with key */ } }
```

```json
{ "event": "MESSAGES_UPSERT", "instance": "name", "data": { "messages": [ /* messages */ ] } }
```

Each message needs `key.id`, `key.remoteJid`, `key.fromMe`, and a supported `message` object. Inbound messages update lead state and cancel pending follow-ups for that contact. Ad click attribution is read from `contextInfo.externalAdReply` when present.

### Message status updates

Use the same webhook with `event: "MESSAGES_UPDATE"`. The payload can contain `data` as an array or a single update object. Each update needs a message ID at `key.id` and a status such as `SERVER_ACK`, `DELIVERY_ACK`, `READ`, or `ERROR`. The status is stored on the matching `messages` record.

`READ` also sets `messages.is_read` to `true`. Delivery is currently represented by `messages.status` (`SERVER_ACK` or `DELIVERY_ACK`); there are no separate delivery/read timestamp columns.

### Contact presence updates

Use the same webhook with `event: "PRESENCE_UPDATE"`. Presence payloads are matched by WhatsApp JID and stored on the matching contact as `presence_status` and `presence_updated_at`. Common values include `available`, `composing`, `recording`, and `paused`.

### Connection updates

Use the same webhook with `event: "CONNECTION_UPDATE"`. The handler reads:

- State from `data.state`, `data.status`, or `data.connection`
- QR data from `data.qrcode.base64`, `data.qrCode`, or `data.base64`
- Pairing code from `data.pairingCode` or `data.pairing_code`
- Error information from `data.reason` or `data.error`

It upserts `whatsapp_sessions` by `instance_name` and stores the complete event in `session_data`.

### Evolution outbound requests

All requests from this codebase use:

```http
apikey: YOUR_EVOLUTION_API_KEY
Content-Type: application/json
```

#### Create an instance

```http
POST {EVOLUTION_URL}/instance/create
```

Body includes:

```json
{
  "instanceName": "heysasa-business-instance",
  "instance": "heysasa-business-instance",
  "integration": "WHATSAPP-BAILEYS",
  "qrcode": true,
  "webhook": {
    "url": "https://your-domain.example/webhook/evolution",
    "events": [
      "MESSAGES_UPSERT",
      "MESSAGES_UPDATE",
      "MESSAGING_HISTORY_SET",
      "CONNECTION_UPDATE"
    ],
    "base64": true
  }
}
```

#### Connect by QR or phone pairing

```http
GET {EVOLUTION_URL}/instance/connect/{instanceName}
GET {EVOLUTION_URL}/instance/connect/{instanceName}?number=254712345678
```

Use the query parameter only for phone pairing. The phone number is stripped to digits before the request.

#### Read connection state

```http
GET {EVOLUTION_URL}/instance/connectionState/{instanceName}
```

#### Delete an instance

```http
DELETE {EVOLUTION_URL}/instance/delete/{instanceName}
```

#### Send a text message

```http
POST {EVOLUTION_URL}/message/sendText/{instanceName}
```

Body:

```json
{
  "number": "254712345678",
  "text": "Hello from HeySasa"
}
```

`number` must not contain the leading `+`. Business follow-ups use the business Evolution instance. Platform alerts use `PLATFORM_EVOLUTION_INSTANCE`.

#### Send customer media

Follow-up queue rows support an optional `media` JSONB value. The frontend should upload the file to the Supabase Storage bucket `customer_images`, then save the resulting public URL or a signed URL that will remain valid until the scheduled send:

```json
{
  "type": "image",
  "url": "https://project.supabase.co/storage/v1/object/public/customer_images/business-id/file.jpg",
  "mime_type": "image/jpeg",
  "file_name": "product.jpg",
  "caption": "Here is the product we discussed"
}
```

The frontend stores this object in `follow_up_queue.media` alongside `final_message` (the caption may also be kept in `final_message` for queue previews). Supported `type` values are `image`, `video`, `audio`, and `document`; the current UI request is `image`. URLs must be `http` or `https`, and the backend rejects invalid media before approval or dispatch.

When a queued row has `media`, the follow-up sender calls Evolution's media endpoint instead of the text endpoint:

```http
POST {EVOLUTION_URL}/message/sendMedia/{instanceName}
```

```json
{
  "number": "254712345678",
  "mediatype": "image",
  "mimetype": "image/jpeg",
  "caption": "Here is the product we discussed",
  "media": "https://project.supabase.co/storage/v1/object/public/customer_images/business-id/file.jpg",
  "fileName": "product.jpg"
}
```

The sender records the successful outbound row in `messages` with `type: "image"` and the same media object in `content`. Platform owner alerts are still text-only and do not use customer follow-up media.

### Browser CORS policy

The main backend allows configured origins from `CORS_ORIGINS` (defaulting to `https://heysasa.co.ke`, `https://www.heysasa.co.ke`, and `http://localhost:5173`) for `GET`, `POST`, and `OPTIONS`, with `Content-Type` and `Authorization` headers. During local development, any `localhost` or `127.0.0.1` HTTP origin is also allowed so alternate dev-server ports work.

The follow-up API allows configured production origins and any HTTP/HTTPS `localhost` or `127.0.0.1` origin for local development. It permits `GET`, `POST`, `PUT`, `DELETE`, and `OPTIONS`, because settings and materials routes use `PUT` and `DELETE`. Set `FOLLOWUP_CORS_ORIGINS` or `CORS_ORIGINS` to a comma-separated list for deployed production origins.

### External request requirements

- Use JSON for POST requests.
- Send the `apikey` header to Evolution.
- Make the webhook publicly reachable by Evolution; local development requires a tunnel or public reverse proxy.
- Preserve the Evolution field names and nesting. Do not send a custom flat history format to `/webhook/evolution`.
- Use a valid instance name in every webhook payload.
- The current webhook route has no separate application-level auth check; protect it at the network/reverse-proxy level if the deployment requires signed or secret webhooks.

## 3. Main Backend Reference

### `src/index.js`

Express entry point and process supervisor.

Routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/debug/analysis/status` | Analysis worker status |
| `POST` | `/debug/analysis/start` | Starts `run-local.js`; optional body `{ "businessId": "..." }` |
| `POST` | `/analysis/start` | Authenticated scoped analysis; accepts optional `businessId` and `contactIds` |
| `GET` | `/analysis/status` | Authenticated status for the caller's analysis |
| `GET` | `/debug/followup/status` | Follow-up child-process status |
| `GET` | `/debug/events` | Server-Sent Events debug stream |
| `GET` | `/debug/evolution` | Checks `EVOLUTION_URL` |
| `POST` | `/webhook/evolution` | Evolution event receiver |

The server acknowledges valid webhooks before dispatching event processing. It starts `run-local.js` only when requested and passes the authenticated business plus optional contact scope through `ANALYSIS_CONFIG`.

### Analysis API

`POST /analysis/start` requires the Supabase access token:

```http
Authorization: Bearer SUPABASE_ACCESS_TOKEN
Content-Type: application/json
```

Analyze the whole authenticated business:

```json
{}
```

Analyze one or more contacts. `contacts.id` is a `bigint`, so send positive integer values (JSON numbers or numeric strings):

```json
{
  "contactIds": [12345, 12346]
}
```

The optional `businessId` must match the authenticated owner's `businesses.business_id`; it is validated server-side and is not trusted for authorization:

```json
{
  "businessId": "lashesbyshazz",
  "contactIds": [12345]
}
```

Successful requests return `202 Accepted`:

```json
{
  "ok": true,
  "message": "Analysis started",
  "running": true,
  "businessId": "lashesbyshazz",
  "contactIds": [12345]
}
```

An omitted or empty `contactIds` array means the complete business. The backend verifies every requested contact belongs to that business before starting the worker.

### `src/config/evolution.js`

Loads Evolution URL/API key, webhook URL, and single-business fallback.

### `src/config/supabase.js`

Creates and exports the service-role Supabase client. Requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`; the process exits if either is missing. It also logs Supabase HTTP activity for tracing.

### `src/services/dataCleaner.js`

Pure normalization and classification helpers:

- `isGroupOrBroadcast(jid)`: rejects non-direct-message JIDs.
- `extractPhone(jid)`: converts a WhatsApp JID to a `+digits` phone number.
- `extractMessageContent(msg)`: converts Evolution message variants into stored content.
- `extractAdAttribution(msg)`: reads Meta ad reply metadata.
- `classifyLeadType(text, hasAdAttribution)`: identifies ad/business leads or leaves analysis pending.
- `extractProductInterests(...)`: gets an interest from ad headline/body.
- `preScanPayload(payload)`: counts eligible leads and outbound image signals before a history import.

### `src/services/dbService.js`

Database helpers for the ingestion path:

- Finds or creates contacts by `(business_id, social_platform, social_id)`.
- Finds or creates conversations by business and contact.
- Records ad attribution.
- Moves replying contacts into `engaged` where appropriate.
- Cancels pending follow-ups when a lead replies.
- Provides sentiment/dashboard aggregation helpers.

### `src/services/webhookHandler.js`

Event dispatch implementations:

- `resolveBusinessId(payload)`: maps `instance` to `businesses.business_id` using `businesses.evolution_instance_id`.
- `processConnectionUpdate(...)`: persists connection state.
- `processLiveMessage(...)`: normalizes and upserts live messages.
- `processHistorySync(...)`: imports contacts, chats, and messages.
- `processMessageStatusUpdate(...)`: updates message delivery status.

Message rows contain `whatsapp_message_id`, `business_id`, `contact_id`, `conversation_id`, `direction`, `role`, `agent_role`, `type`, `content`, `created_at`, `status`, `is_read`, and `raw_payload`.

### `src/services/evolutionConnections.js`

Shared Evolution connection client and persistence helper. It creates, connects, checks, and deletes Evolution instances, and persists state in `whatsapp_sessions`.

### `src/services/debugConsole.js`

Maintains an in-memory buffer of up to 500 debug events and broadcasts them to `/debug/events` clients over Server-Sent Events. It does not persist logs in Supabase.

### `run-local.js`

One-shot enrichment worker started manually through `/debug/analysis/start` or directly with Node.

It performs:

1. Structural enrichment: read receipts, media flags, intent score, and lead quality.
2. NLP enrichment: conversation stage, next action, competitors, objections, questions, sentiment, price objection, product information, contact summary, and related profile fields.

It reads contacts, messages, businesses, products, conversations, persona/profile data, and existing enrichment. It keeps the latest 40 messages in an AI transcript.

External request:

```http
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer YOUR_OPENAI_API_KEY
Content-Type: application/json
```

The worker uses `gpt-4o-mini`, JSON response mode, and writes usage to `ai_usage_log`.

## 4. Follow-up Engine Reference

### Authentication

All follow-up API routes use `requireBusinessAuth`.

Required header:

```http
Authorization: Bearer SUPABASE_AUTH_ACCESS_TOKEN
```

The middleware calls Supabase Auth `getUser`, finds `businesses.owner_user_id`, and sets `req.userId` and `req.businessId`. Every route scopes database access to that business.

### `followup-engine/src/index.js`

Starts scheduler loops, the Evolution sender loop, and the API server. The main backend normally starts this file as a child process.

### `followup-engine/src/config.js`

Important settings:

| Variable | Default/purpose |
|---|---|
| `SUPABASE_URL` | Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role database key |
| `EVOLUTION_URL` | `http://129.213.33.173:8080` |
| `EVOLUTION_API_KEY` | Evolution API key |
| `PLATFORM_EVOLUTION_INSTANCE` | Instance used for platform alerts |
| `EVOLUTION_WEBHOOK_URL` | Webhook registered during instance creation |
| `OPENAI_API_KEY` | OpenAI key |
| `FOLLOWUP_CORS_ORIGINS` / `CORS_ORIGINS` | Comma-separated allowed origins; defaults to `http://localhost:5173` |
| `SCHEDULER_POLL_INTERVAL_MS` | `30000` |
| `SENDER_POLL_INTERVAL_MS` | `5000` |

Defaults include a daily cap of 40, maximum 12 follow-ups per lead, quiet hours 21:00-08:00 UTC, a 20-second minimum send gap plus up to 45 seconds jitter, and a hard ceiling of 15 sends per hour per business.

### `followup-engine/src/supabaseClient.js`

Creates the follow-up engine service-role Supabase client. It warns when credentials are absent rather than immediately exiting.

### Follow-up API routes

All routes below require the bearer token described above.

#### Queue approval: `queueRoutes.js`

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/queue/pending` | none | Pending approval items |
| `POST` | `/queue/:id/approve` | optional `{ "text": "..." }` | Marks item `ready_to_send` |
| `POST` | `/queue/:id/edit` | `{ "text": "..." }` | Updates draft; remains awaiting approval |
| `POST` | `/queue/:id/regenerate` | none | Regenerates draft and QC |
| `POST` | `/queue/:id/reject` | none | Marks item rejected/skipped |

Queue operations require ownership and `approval_status: "awaiting_approval"`.

#### Follow-up settings: `followupSettingsRoutes.js`

| Method | Path | Body |
|---|---|---|
| `GET` | `/settings/followup` | none |
| `PUT` | `/settings/followup` | Preferences object |

Supported preference keys:

```json
{
  "followup_enabled": true,
  "max_per_lead": 12,
  "daily_cap": 40,
  "quiet_start": 21,
  "quiet_end": 8,
  "active_days": [1, 2, 3, 4, 5],
  "zone_recent_days": 7,
  "zone_recent_mode": "approval",
  "zone_medium_days": 14,
  "zone_medium_mode": "manual",
  "zone_old_mode": "auto",
  "stop_at_stage": "won",
  "alert_at_stage": "hot"
}
```

Valid modes are `approval`, `manual`, and `auto`. Hours must be 0-23, active days must be 0-6, and recent-zone days must be less than medium-zone days.

#### Materials: `materialsRoutes.js`

| Method | Path | Body |
|---|---|---|
| `GET` | `/materials` | none |
| `POST` | `/materials` | `{ type, title, content, is_active?, expires_at?, image_url? }` |
| `PUT` | `/materials/:id` | Any editable fields |
| `DELETE` | `/materials/:id` | none |

Valid `type` values: `testimonial`, `tip`, `offer`, `story`, `educational`. `title` and `content` are required when creating. The API exposes `type` while the database column is `material_type`.

#### WhatsApp connection: `whatsappRoutes.js`

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/whatsapp/connection` | none | Read saved state |
| `POST` | `/whatsapp/connection` | `{ "mode": "qr" }` | Start QR connection |
| `POST` | `/whatsapp/connection` | `{ "mode": "phone", "phoneNumber": "254712345678" }` | Start phone pairing |
| `POST` | `/whatsapp/connection/refresh` | none | Refresh Evolution state |
| `DELETE` | `/whatsapp/connection` | none | Delete instance and saved state |

The route ensures an Evolution instance exists, delegates HTTP calls to the main backend's `evolutionConnections.js`, and persists the response.

### `followup-engine/src/lib/db.js`

Shared query layer for businesses, contacts, persona packs, conversations, messages, sequences, steps, materials, bot configuration, billing configuration, queue items, and nudge logs. Recent messages are returned in chronological order for draft generation.

### `followup-engine/src/lib/ai.js`

OpenAI wrapper. It reads optional model and prompt overrides from `ai_bots_config` and falls back to configured prompts.

External request:

```http
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer YOUR_OPENAI_API_KEY
Content-Type: application/json
```

Default model is `gpt-4.1-mini`; requests time out after 30 seconds. The helper returns trimmed assistant text or `null`.

### `followup-engine/src/lib/qc.js`

Checks generated WhatsApp text against the persona and recent messages. It returns pass/fail, issues, a suggested fix, final text, and attempt count. A malformed or unavailable QC response defaults to pass.

### `followup-engine/src/lib/billing.js`

Checks balances, charges message/consent/stage events, writes balance transactions, and can disable follow-ups when funds are insufficient. It uses `business_balances`, `balance_transactions`, `followup_billing_events`, and billing configuration tables.

### `followup-engine/src/lib/timing.js`

Calculates lead age, elapsed hours, send times, and the next active day. It
stores timestamps in UTC while evaluating active days and quiet hours in the
business timezone.

The business timezone is used when evaluating active days and quiet hours. The
business `timezone` is preferred and `Africa/Nairobi` is the default. Stored
timestamps and queue `scheduled_at` values remain ISO timestamps.

## 5. Scheduler

### `scheduler/run.js`

Starts independent, guarded polling loops for:

- Standalone queue scheduler: every `SCHEDULER_POLL_INTERVAL_MS`.
- Campaign scheduler: every `SCHEDULER_POLL_INTERVAL_MS`.
- Post-send reconciliation: every `SCHEDULER_POLL_INTERVAL_MS`.
- Consent: every five minutes.
- Opt-in classifier: every two minutes.
- Stage classifier: every minute.
- Activity patterns: every hour.

Each loop runs once at startup, prevents overlapping runs of itself, and logs
errors without stopping the other loops.

### `scheduler/scheduler.js`

Loads up to 50 due queue rows where `status = pending` and `approval_status = approved`, then runs the worker. It does not send WhatsApp messages itself.

### `scheduler/campaignScheduler.js`

Seeds active campaigns from their `list_members` records, subject to the
one-active-campaign-per-lead database rule. It then finds due
`campaign_enrollments`, creates the next `follow_up_queue` row from the
matching `campaign_steps.content` and optional `campaign_steps.media`, and advances the enrollment after a send.
Campaign rows are pre-written and do not need AI drafting. Campaign seeding
defaults to every five minutes and can be changed with
`CAMPAIGN_SEED_INTERVAL_MS`.

### `scheduler/worker.js`

Performs eligibility checks, draft generation, QC, and queue routing. It checks consent, opt-out, subscription, lead state, stage limits, per-lead limits, balance, daily cap, persona, active day, quiet hours, recent activity, and sentiment.

Possible routing results are:

- `ready_to_send`: approved automatic work.
- `awaiting_approval`: owner review required.
- `skipped`: permanently or temporarily ineligible.
- `rescheduled`: not eligible at the current time.

Active-day and quiet-hour failures keep the row pending and move
`scheduled_at` to a later time. A lead reply within two hours, a negative or
aggressive latest inbound sentiment, an inactive campaign, and a reached
follow-up limit can prevent dispatch. Human-authored messages with AI rewrite
disabled bypass the age-zone approval rules. Standalone AI content uses the
recent, medium, and old lead-age zones; campaign content uses the campaign's
`auto_approve` setting, which defaults to enabled.

### `scheduler/generateDraft.js`

Builds context from the conversation, persona, contact, business, active materials, and previous follow-ups. It calls the OpenAI wrapper and QC. It returns draft data but does not write the queue row.

### `scheduler/consent.js`

Finds eligible silent leads without consent and queues a `touchpoint_type: "consent"` item at sequence step `0`. Consent billing and the sent timestamp are applied only after successful sending.

Consent items are inserted directly as `ready_to_send` and approved. The
consent generator uses the business persona and recent conversation. The
`optInClassifier.js` loop classifies new inbound replies as opt-in, opt-out, or
neutral; opt-in reactivates awaiting campaign enrollments, while opt-out sets
`do_not_contact` and completes active enrollments.

### `scheduler/reconciliation.js`

Processes sent queue rows and creates the next sequence step. It also sends hot-lead owner alerts through the platform Evolution instance.

Campaign step advancement is performed by the sender after a confirmed send;
the reconciliation loop handles post-send work for the regular follow-up
sequence and owner alerts.

### `scheduler/stageClassifier.js`

Classifies recently active open conversations using up to 15 messages and updates `lead_stage_ecom` or `lead_stage_service`. Stage advancement may create a billing event.

### `scheduler/activityPatterns.js`

Counts inbound message activity by UTC hour, stores `contact_activity_patterns`, and updates each contact's `optimal_contact_hour`.

## 6. Sender

### `sender-baileys/antiban.js`

In-memory pacing per business. It enforces the randomized minimum gap and hourly ceiling. State is lost when the process restarts.

### `sender-baileys/evolutionSender.js`

Sends text through:

```http
POST {EVOLUTION_URL}/message/sendText/{instanceName}
```

Headers:

```http
apikey: YOUR_EVOLUTION_API_KEY
Content-Type: application/json
```

Body:

```json
{
  "number": "254712345678",
  "text": "Follow-up text"
}
```

It returns `{ ok: true }` or `{ ok: false, error: "..." }` and uses a 15-second request timeout.

### `sender-baileys/worker.js`

Selects up to 25 oldest due queue rows with `status: "ready_to_send"` and
`channel: "baileys"`. It verifies the business and phone, then selects the
newest connected and open `whatsapp_sessions` instance for that business. It
does not rely only on the denormalized `businesses.evolution_instance_id`.
The in-memory anti-ban gate can defer a row without counting a failed attempt.
Evolution failures retry up to five dispatch attempts; after that the row is
marked `failed`. Rows can remain ready while the WhatsApp instance is closed.

### `sender-baileys/postSend.js`

Persists successful sends to `messages`, marks queue rows sent, records
outcomes, updates contact and business counters, updates daily capacity and
campaign step events, advances campaign enrollments, and charges the balance.
Consent sends have separate bookkeeping and cost configuration. Failed sends
store retry state and the last error. These writes are not wrapped in one
database transaction.

### `sender-baileys/run.js`

Starts the sender polling loop using `SENDER_POLL_INTERVAL_MS`, default five seconds, with overlap protection.

## 7. Queue and Database Contracts

The follow-up queue is the handoff between scheduling, owner approval, and
outbound sending. The queue `status` values are `pending`, `ready_to_send`,
`sending`, `sent`, `failed`, `skipped`, and `cancelled`. Approval is tracked separately
through `approval_status`; an item awaiting owner review normally remains
`status = pending` with `approval_status = awaiting_approval`.

Typical transitions are:

```text
pending + approved -> ready_to_send -> sent
pending + needs review -> awaiting_approval -> ready_to_send -> sent
pending -> skipped
ready_to_send -> failed after five dispatch failures
```

Rows are rescheduled by changing `scheduled_at` while retaining `pending`.
Owner rejection sets `approval_status = rejected` and `status = skipped`.
Inbound replies cancel pending follow-ups through the main backend. Sender
success writes and balance/counter updates are separate database operations,
not one transaction.

The repository includes these migrations, which must be applied to the target
Supabase project in filename order:

- `20260824000000_add_whatsapp_connections.sql`
- `20260826000000_add_whatsapp_sessions_update_policy.sql`
- `20260827000000_add_contact_presence.sql`
- `20260903000000_enforce_one_active_campaign_per_lead.sql`
- `20260903000100_align_campaign_enrollments_to_contacts.sql`
- `20260903000200_fix_followup_queue_statuses.sql`
- `20260903000300_normalize_campaign_queue_noise.sql`
- `20260903000400_add_evolution_message_new_column.sql`
- `20260904000000_add_sending_queue_status.sql`

The other tables below must already exist in the target Supabase project.

Main ingestion tables:

- `businesses`
- `contacts`
- `conversations`
- `messages`
- `ad_attributions`
- `whatsapp_sessions`

Follow-up tables:

- `follow_up_queue`
- `follow_up_sequences`
- `follow_up_steps`
- `follow_up_outcomes`
- `followup_materials`
- `persona_packs`
- `ai_bots_config`
- `global_config`
- `followup_billing_config`
- `followup_billing_stage_weights`
- `business_balances`
- `balance_transactions`
- `followup_billing_events`
- `followup_nudge_log`
- `contact_activity_patterns`
- `conversation_enrichment`
- `sentiment_snapshots`
- `ai_usage_log`
- `campaigns`
- `campaign_steps`
- `campaign_enrollments`
- `campaign_step_events`
- `list_members`
- `daily_send_counters`

Important identity fields:

- Business Evolution mapping: `businesses.evolution_instance_id`.
- Contact identity: `business_id + social_platform + social_id`.
- Conversation identity: `business_id + contact_id`.
- Message idempotency: `messages.whatsapp_message_id`.

## 8. Local Setup

Minimum main-backend variables:

```text
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
OPENAI_API_KEY=...
EVOLUTION_URL=...
EVOLUTION_API_KEY=...
EVOLUTION_WEBHOOK_URL=...
SINGLE_BUSINESS_ID=...
PORT=3000
FOLLOWUP_ENGINE_PORT=3001
```

Follow-up engine additionally needs:

```text
SUPABASE_SERVICE_ROLE_KEY=...
PLATFORM_EVOLUTION_INSTANCE=...
FOLLOWUP_CORS_ORIGINS=http://localhost:...
SCHEDULER_POLL_INTERVAL_MS=30000
SENDER_POLL_INTERVAL_MS=5000
CAMPAIGN_SEED_INTERVAL_MS=300000
DEFAULT_PHONE_COUNTRY_CODE=254
```

Start the main backend:

```bash
npm install
npm start
```

The main backend starts the follow-up engine automatically. Do not commit service keys to source control. Use a secret manager or local environment file excluded from version control.
