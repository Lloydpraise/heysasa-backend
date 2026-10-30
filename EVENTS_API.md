# Events API (websites → WhatsApp messages)

A client's website tells HeySasa that something happened (an abandoned cart, a paid order) and HeySasa sends that
customer a WhatsApp message from the business's number. The owner sets it up in the dashboard under
**Preferences → Integrations → Website**.

## For the website's developer

One HTTPS call from the website's **server** (never from the shopper's browser: the key must stay secret).

```
POST https://api.heysasa.co.ke/v1/events
Authorization: Bearer hs_live_...
Content-Type: application/json

{
  "event": "order.paid",
  "event_id": "order_1042",
  "phone": "+254712345678",
  "name": "Wanjiku",
  "data": {
    "order_id": "1042",
    "total": 2500,
    "currency": "KES",
    "items": [{ "name": "Lash kit", "qty": 1 }],
    "cart_url": "https://shop.example/cart/88213",
    "tracking_url": "https://courier.example/t/123"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `event` | yes | `cart.abandoned`, `order.paid`, `order.shipped`, or an event the business added in the dashboard |
| `phone` | yes | The customer's WhatsApp number: `+254712345678`, `254712345678` or `0712345678` |
| `name` | no | The customer's name, used for `{{first_name}}` |
| `event_id` | no, but use it | Your cart or order id. The same `event` + `event_id` twice is one event (safe to retry) |
| `data` | no | Anything the message uses: `order_id`, `total`, `currency`, `items`, `cart_url`, `order_url`, `tracking_url`, or your own fields as `{{data.field}}` |

Answers:

- `202` `{ ok, id, event, event_id, status: "scheduled", send_at }`: accepted.
- `200` with `duplicate: true`: that `event_id` was already received; nothing new is sent.
- `400` `invalid_event` / `invalid_phone` / `invalid_body`, `401` `missing_api_key` / `invalid_api_key`,
  `413` `payload_too_large` (20 KB), `422` `event_not_enabled` (switched off, or no message for that event),
  `429` `rate_limited` (120 events a minute per key).

`GET /v1/events/:id` (same key) returns `status`: `scheduled`, `sending`, `sent`, `failed`, `cancelled` or `skipped`,
and `error` when it was not sent.

When to send:

- `cart.abandoned` as soon as the shopper has entered a phone number at checkout. HeySasa waits (60 minutes by default)
  and cancels the reminder if an `order.paid` for the same phone arrives first, or if the shopper writes to the business.
- `order.paid` when payment is confirmed (M-Pesa / card callback). Sent straight away.
- `order.shipped` when the order leaves.

## How it works inside HeySasa

1. **Backend** (`src/events/routes.js`): checks the key (only its SHA-256 hash is stored), finds or creates the contact
   by phone on the key's WhatsApp account (the business's primary account when the key has none), writes the message
   from the business's template (`event_templates`, built-in defaults in `src/events/templates.js`) and saves a
   `business_events` row with `send_at = now + delay`. An `order.paid` cancels waiting `cart.abandoned` rows of the
   same contact.
2. **Engine** (`followup-engine/src/sender-baileys/eventSender.js`): woken by a realtime INSERT on `business_events`
   and by one timer for the next due row (no polling; the 3-minute heartbeat is the safety net). It sends through
   Evolution with the **built-in antiban** (`antiban.js`), sharing the gap, hourly ceiling and cool-down with
   follow-ups on the same number. A number that never wrote in is checked on WhatsApp first (`numberCheck.js`).
   It does not use the follow-up daily cap or the follow-up switch: a receipt is owed. Quiet hours apply only when the
   template says so (abandoned cart by default).
3. Each sent message is billed like a follow-up send (`bill_send`, reason `event_<type>`, runner `event_send`) and saved
   in `messages` with `agent_role = 'events_api'`, so the chat AI sees it if the customer replies.
4. An event not sent within 48 hours is dropped (`expired`). Send failures retry by the same rules as follow-ups
   (`sendFailures.js`); a row left in `sending` by a crash is failed, never sent twice.

## Later: official WhatsApp Business API

The website's call does not change. `event_templates` already has `waba_template_name` and `waba_language`; when an
account moves to the official API, `eventSender.js` sends the approved template with the same fields instead of
calling `sendContentViaEvolution`.

## Deploy

1. Run `supabase/migrations/20261030000000_events_api.sql` in the Supabase SQL editor.
2. Deploy the backend and the follow-up engine (`pm2 restart`). Optional env: `PUBLIC_API_URL` (shown in the
   dashboard's code examples; default `https://api.heysasa.co.ke`).
3. Deploy the dashboard.
4. Tests: `npm run test:events`.
