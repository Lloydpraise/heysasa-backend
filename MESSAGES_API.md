# Messages API (your app writes the message, HeySasa sends it and reports back)

For apps that run their own sequences (Lashtribe first): the app decides who gets what and when, HeySasa sends it from
the business's WhatsApp number and posts every change back to the app's webhook. The HeySasa dashboard is only the
settings pad: the key, the webhook address and which WhatsApp account sends.

Setup in HeySasa: **Preferences → Integrations → Website** → create a key (pick the WhatsApp account), then under that
key set the **webhook address** and copy the **signing secret** (shown once).

## Send

```
POST https://api.heysasa.co.ke/v1/messages
Authorization: Bearer hs_live_...
Content-Type: application/json

{
  "phone": "+254712345678",
  "name": "Amina",
  "text": "Day 2: here is how a classic set is done",
  "media": { "type": "video", "url": "https://.../classic.mp4" },
  "external_id": "enrollment_81:step_2",
  "send_at": "2026-11-10T10:00:00+03:00",
  "metadata": { "enrollment_id": "81", "step": 2 }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `phone` | yes | WhatsApp number: `+254712345678`, `254712345678` or `0712345678` |
| `text` | `text` or `media` | Up to 4096 characters. With media it becomes the caption |
| `media` | no | `{ type: "image" \| "video" \| "document", url: "https://...", caption?, file_name?, mime_type? }`. The link must be public; WhatsApp limits video to about 16 MB |
| `external_id` | no, but use it | Your id for this message. Sending the same one twice is one message (safe to retry); you can also `GET`/`DELETE` by it |
| `send_at` | no | Send later (at most 7 days ahead). Default now |
| `respect_quiet_hours` | no | `true` holds it until the business's working hours |
| `metadata` | no | Any JSON (2 KB), returned in every webhook about this message |
| `name` | no | Saved on the HeySasa contact |

Answers: `202 { id, external_id, status: "scheduled", send_at, ... }`, `200` with `duplicate: true`, `400` (`invalid_phone`,
`empty_message`, `invalid_media`, `invalid_send_at`, `invalid_metadata`, `text_too_long`), `401`, `409 opted_out` (the
person wrote STOP), `429` (120 a minute per key).

`GET /v1/messages/:id` (HeySasa id or your `external_id`): `status` `scheduled | sending | sent | failed | cancelled | skipped`,
with `sent_at`, `delivered_at`, `read_at`, `replied_at`, `error`.
`DELETE /v1/messages/:id`: cancel one that has not gone out (`409` once it is sending or sent).

HeySasa still applies its own WhatsApp safety, whoever calls it: the antiban pacing shared with follow-ups on that
number, a WhatsApp check before the first message to a new number, the wallet (each send is billed like a follow-up),
do-not-contact, and a 48-hour limit after `send_at` (a message that could not go out by then fails as `expired`).

## Webhooks (HeySasa → your app)

`POST <your webhook address>` with JSON:

```json
{ "type": "message.delivered", "created_at": "...", "delivery_id": "...",
  "data": { "id": "...", "external_id": "enrollment_81:step_2", "phone": "+254712345678", "status": "delivered",
            "error": null, "metadata": { "enrollment_id": "81", "step": 2 },
            "sent_at": "...", "delivered_at": "...", "read_at": null } }
```

| type | when |
| --- | --- |
| `message.sent` | WhatsApp accepted it |
| `message.delivered` / `message.read` | the person's phone got it / they opened it |
| `message.failed` | it could not be sent (`data.error`: `number_not_on_whatsapp`, `expired`, `whatsapp_delivery_error`, ...) |
| `message.skipped` / `message.cancelled` | not sent (do-not-contact; cancelled by you or by an opt-out) |
| `message.received` | the person wrote back within 30 days of your last message; `data.reply = { text, type, received_at }`. `data` describes your latest message to them |
| `contact.opted_out` | they wrote STOP / UNSUBSCRIBE / ACHA: HeySasa marks them do-not-contact and cancels what is waiting |
| `ping` | the dashboard's "Send a test" |

Headers: `X-Heysasa-Event`, `X-Heysasa-Delivery` (unique; use it to ignore repeats), `X-Heysasa-Timestamp` (unix seconds),
`X-Heysasa-Signature: v1=<hex>` = HMAC-SHA256 of `"<timestamp>.<raw body>"` with your signing secret. Check it, and
refuse timestamps older than 5 minutes.

Answer `2xx` within 10 seconds. Anything else is retried after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h and 12 h, then
dropped. Receipts can arrive out of order (a `read` before its `delivered`): never move a message backwards.

Who answers when the person writes back is a HeySasa setting: the chat AI (if it is on for that account) or a person in
the HeySasa inbox. Your app only hears about it (`message.received`) so it can pause its own sequence.

## Inside HeySasa

- `src/events/messages.js`: the routes. A message is a `business_events` row with `event_type = 'message'`, `media` and
  your `metadata` in `payload`.
- `followup-engine/src/sender-baileys/eventSender.js` sends it (text, or `sendMedia` with the text as caption).
- `supabase/migrations/20261109000000_messages_api_webhooks.sql`: triggers write `webhook_deliveries` rows for status
  changes, WhatsApp receipts (`messages.status`) and inbound replies / STOP.
- `followup-engine/src/sender-baileys/webhookDispatcher.js` posts them, signed, with retries (realtime + one timer).
- Tests: `npm run test:events`.

## Deploy

1. SQL: `20261030000000_events_api.sql` (already live) then `20261109000000_messages_api_webhooks.sql`.
2. Deploy the backend and the follow-up engine (`pm2 restart`).
3. Deploy the dashboard (webhook settings on the Website card).
