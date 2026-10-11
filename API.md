# FlyBot public API and webhooks

Managers and admins create API keys and webhooks under **Settings → API & Webhooks**.

## API (read-only)

Base URL: `https://YOUR_FLYBOT_DOMAIN/api/v1`

Send the key in a header:

```bash
curl -H "Authorization: Bearer fbk_..." https://YOUR_FLYBOT_DOMAIN/api/v1/cameras
```

`X-API-Key: fbk_...` also works. A key acts as the account that created it and sees the same cameras (its own, shared with it, and through its organizations). It cannot change anything. The key is shown once when it is created. Only a hash is stored, so a lost key cannot be recovered: revoke it and create a new one.

Limit: 120 requests per minute per key. Over the limit the answer is `429` with a `Retry-After` header.

Every answer is `{ "success": true, "data": ... }`. Errors are `{ "success": false, "message": "..." }` with status 400, 401 or 404.

| Request | Returns |
|---|---|
| `GET /me` | `{ email, role }` of the key's account |
| `GET /cameras` | Every camera: `deviceSerial`, `name`, `online`, `trapKind` (`sticky` glue card or `lure` without glue), `latitude`, `longitude`, `alertThreshold`, `farmId`, `plotId`, `organizationId`, `latest: { at, count, counts }` |
| `GET /cameras/{serial}` | One camera, same fields |
| `GET /cameras/{serial}/daily?days=30` | One row per day (farm time zone, up to 365 days): `day`, `scans`, `peak`, `total`, `species[{ name, peak, total }]` |
| `GET /cameras/{serial}/snapshots?limit=50&before=ISO` | Analyzed photos, newest first (up to 200): `id`, `at`, `count`, `counts`, `reviewed`, `imageIssues` |
| `GET /alerts?since=ISO&limit=100` | Your alerts, newest first (up to 500): `id`, `event`, `severity`, `deviceSerial`, `params`, `createdAt` |

`count` is the number of insects in a photo (people and other non-pests excluded). On a sticky trap it is cumulative until the card is replaced, so `peak` per day is the card's highest count and the day's catch is the rise over the day before. On a lure trap (no glue) it is the flies present at that moment, so use `total / scans` for the day's average.

## Webhooks

A webhook receives your alerts as they happen, as a JSON `POST` to an HTTPS address. Choose which events it gets:

`pest_threshold`, `pest_surge`, `plot_threshold`, `camera_offline`, `camera_online`, `ai_failure`, `card_due`, `card_change_detected`, `image_quality`

The **Test** button sends a `ping` event.

Body:

```json
{
  "id": "6650c1...",
  "event": "pest_threshold",
  "createdAt": "2026-10-10T07:30:00.000Z",
  "deviceSerial": "BC1001",
  "severity": "critical",
  "params": { "deviceName": "Mango plot A", "count": 18, "threshold": 15 }
}
```

`params` depends on the event. Alerts muted for a camera are not sent; quiet hours do not apply to webhooks.

### Checking the signature

Each request has these headers:
- `X-FlyBot-Event`
- `X-FlyBot-Timestamp`: unix seconds
- `X-FlyBot-Signature`: `sha256=` followed by the hex HMAC-SHA256 of `timestamp + "." + raw body`, keyed with the webhook's secret (`whsec_...`, shown once when created)

Compare it in constant time, and reject old timestamps (for example older than 5 minutes) so a captured request cannot be replayed.

```js
const crypto = require('crypto');

function verify(req, rawBody, secret) {
    const timestamp = req.headers['x-flybot-timestamp'];
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const given = String(req.headers['x-flybot-signature'] || '');
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
    return fresh && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

### Delivery
- Answer with any `2xx` within 5 seconds. Redirects are not followed.
- Network errors, `429` and `5xx` answers are retried after 10 seconds, 1 minute and 5 minutes. Other `4xx` answers are not retried.
- After 15 failed deliveries in a row the webhook is switched off. Switch it back on in Settings.
- Only public addresses are called: addresses on private, loopback or link-local networks are refused, including when a public name resolves to one. For a local receiver during development, set `WEBHOOK_ALLOW_PRIVATE=true` on the server. This is ignored when `NODE_ENV=production`.
