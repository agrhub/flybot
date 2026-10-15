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

`pest_threshold`, `pest_surge`, `plot_threshold`, `camera_offline`, `camera_online`, `ai_failure`, `card_due`, `card_change_detected`, `image_quality`, `harvest_ready` (a pre-harvest interval ends; `params.date` is when harvest is allowed), `weather_risk` (the next days suit fruit flies and a wave of adults is due; `params.days`, `params.waveDate`), `snapshot_analyzed` (every analyzed photo, see below)

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

`params` depends on the event. For `pest_threshold` on a lure trap, `count` is the day's average per photo and `params.basis` is `"dailyAverage"`; on a sticky trap it is the count in the latest photo. Alerts muted for a camera are not sent; quiet hours do not apply to webhooks.

### `snapshot_analyzed`

Not an alert: one event for every photo of a camera you can see (yours or shared with you), sent once its AI count and its photo quality check are both stored. It is meant for systems that process each photo (for example FlyBot Sentinel). It does not appear in the app's notifications and is not emailed. Muting a camera does not stop it.

- Sent once per photo: at capture, or, when the AI failed at capture, when the later automatic retry succeeds (then `quality` is the one measured at capture). Photos the AI never analyzed send nothing. A manual re-analysis does not send it again.
- `id` is `snap_` + the snapshot id, the same on every retry of the delivery: use it to drop duplicates.
- `imageUrl` is a presigned S3 link valid for 1 hour (`imageUrlExpiresAt`); the bucket itself is private. Download the photo within the hour, or `null` when the link could not be made.
- `count` is the number of pests (people, vehicles and animals excluded, as in the API); `counts` is the AI's full summary per label, non-pests included.
- `boxes` are in pixels of the photo, `[xmin, ymin, xmax, ymax]` (`boxFormat: "xyxy_pixels"`). Divide by `width` and `height` for 0–1 values. At most 200 are sent, highest confidence first: then `truncated` is `true` and `boxesTotal` tells how many there were. `width`/`height` are `null` when the photo's size could not be read.
- `provider` is `ezviz` or `camos`; `aiSource` is `cloud` (FlyBot's AI, `aiProvider` `vertex` or `roboflow`) or `device` (counted on the AI camera itself).
- `quality` has the measurements of the photo quality check (`brightness` 0–255, `contrast`, `sharpness`, `clipped` share of white pixels, `coverage` share of the photo under boxes or `null`) and `issues` (`dark`, `overexposed`, `blurry`, `low_contrast`, `card_full`), or is `null` when the photo could not be checked.
- `previousSnapshotId` is the camera's previous analyzed photo (by capture time), `null` for the first one. `cardReplacedAt` is when the sticky card was last replaced (`null` if never logged).
- No account data is included (no emails or user names).

```json
{
  "id": "snap_6651a2f0c3b9e81d2a4f7c10",
  "event": "snapshot_analyzed",
  "createdAt": "2026-10-15T01:30:12.480Z",
  "deviceSerial": "BC1001",
  "severity": "info",
  "params": {
    "snapshotId": "6651a2f0c3b9e81d2a4f7c10",
    "deviceSerial": "BC1001",
    "deviceName": "Mango plot A",
    "provider": "ezviz",
    "trapKind": "sticky",
    "farmId": "664f0b1e9a2c3d4e5f607182",
    "plotId": "664f0b2a9a2c3d4e5f607190",
    "latitude": 10.3521,
    "longitude": 106.3644,
    "capturedAt": "2026-10-15T01:30:04.112Z",
    "imageUrl": "https://S3_ENDPOINT/BUCKET/snapshots/BC1001/BC1001_1791941404112.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=...",
    "imageUrlExpiresAt": "2026-10-15T02:30:12.480Z",
    "width": 1920,
    "height": 1080,
    "count": 18,
    "counts": { "fruit fly": 18 },
    "aiSource": "cloud",
    "aiProvider": "roboflow",
    "boxFormat": "xyxy_pixels",
    "boxes": [
      { "label": "fruit fly", "confidence": 0.93, "bbox": [812, 402, 841, 430] },
      { "label": "fruit fly", "confidence": 0.88, "bbox": [1104, 655, 1131, 684] }
    ],
    "boxesTotal": 18,
    "truncated": false,
    "quality": {
      "brightness": 142.6,
      "contrast": 48.1,
      "sharpness": 311.4,
      "clipped": 0.012,
      "coverage": 0.006,
      "issues": [],
      "checkedAt": "2026-10-15T01:30:11.950Z"
    },
    "previousSnapshotId": "66519bd8c3b9e81d2a4f7b02",
    "cardReplacedAt": "2026-10-08T02:00:00.000Z",
    "alertThreshold": 15
  }
}
```

(The example values are illustrative; `boxes` is shortened to 2 of its 18 entries.)

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
