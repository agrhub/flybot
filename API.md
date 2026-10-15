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
- `trigger` is `"sentinel"` for an extra photo FlyBot Sentinel asked for (`POST /api/sentinel/capture`), else `null`.
- With `AI_PROVIDER=sentinel` (see "Sentinel internal API") the event is sent once the quality check is stored, before any count: `aiSource` is `"pending"`, `count` is `null`, `counts` is `{}` and `boxes` is empty. It is not sent again when Sentinel posts its analysis.
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

## Sentinel internal API

Machine-to-machine API for the FlyBot Sentinel agent (AWS). It is not for people or API keys: every request is signed with a key shared with the agent, and the answers are in English only.

Base URL: `https://YOUR_FLYBOT_DOMAIN/api/sentinel`

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `SENTINEL_API_SECRET` | (empty) | HMAC key shared with the agent, at least 32 characters. Empty or shorter: every request answers `503 SENTINEL_DISABLED`. |
| `SENTINEL_CAPTURE_BUDGET` | `4` | Extra captures Sentinel may ask for, per camera per farm day (Asia/Ho_Chi_Minh). `0` turns `/capture` off. |
| `SENTINEL_PROPOSAL_TTL_HOURS` | `24` | Hours a proposal waits for Confirm before it expires (1 to 168). |
| `AI_PROVIDER` | `vertex` | `sentinel`: no cloud model at capture; the photo waits for `POST /analysis` (see the end of this section). |

### Signature

Same scheme as the webhooks FlyBot sends (see "Checking the signature" above), with the Sentinel key:

- `X-Sentinel-Timestamp`: unix seconds
- `X-Sentinel-Signature`: `sha256=` + hex HMAC-SHA256 of `timestamp + "." + raw body` (the exact bytes sent; an empty string for a `GET`). The bare hex is accepted too.
- `X-FlyBot-Timestamp` / `X-FlyBot-Signature` (the webhook header names) are read instead when neither `X-Sentinel-*` header is sent.
- `Content-Type: application/json` on every `POST` (else `415 JSON_REQUIRED`).

A timestamp more than 5 minutes from the server clock is refused, the signature is compared in constant time, and a signed `POST` is accepted once: sign every attempt again with a new timestamp, retries included. Refusals are `401` with `code` `MISSING_SIGNATURE`, `BAD_TIMESTAMP`, `STALE_TIMESTAMP`, `BAD_SIGNATURE` or `REPLAYED`.

```js
const crypto = require('crypto');

async function sentinelPost(path, body) {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = 'sha256=' + crypto.createHmac('sha256', process.env.SENTINEL_API_SECRET).update(`${ts}.${raw}`).digest('hex');
    return fetch(`https://YOUR_FLYBOT_DOMAIN/api/sentinel${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sentinel-Timestamp': String(ts), 'X-Sentinel-Signature': sig },
        body: raw
    });
}
```

Limits: 120 requests per minute per client IP before the signature check, and 240 per minute for the agent overall (`429` with `Retry-After`). Every answer is `{ "success": true, ... }` or `{ "success": false, "code": "...", "message": "..." }`.

Audit log (Admin → Audit log, category "FlyBot Sentinel"), with the actor `sentinel-agent`: `sentinel.capture`, `sentinel.capture_interval`, `sentinel.proposal_created`, `sentinel.review_requested`, `sentinel.analysis` (only when it sets the photo's count, `AI_PROVIDER=sentinel`), and `sentinel.proposal_decided` with the person who confirmed or rejected as the actor.

### `POST /capture`

An extra photo now, through the normal capture path (EZVIZ capture, S3, the AI unless `AI_PROVIDER=sentinel`, alerts, quality check, `snapshot_analyzed` with `trigger: "sentinel"`). It does not move the camera's schedule. The answer comes once the photo is stored and analyzed (allow 60 s).

- Refused with `409 QUIET_HOURS` when the camera is set to "daytime only" and it is not 06:00–18:00 farm time.
- At most `SENTINEL_CAPTURE_BUDGET` attempts per camera per farm day (an attempt counts even when the camera is offline), and 3 per camera per minute.

```
POST /api/sentinel/capture
{"deviceSerial":"BE4111159"}

200 {"success":true,"snapshotId":"6ad055a5e7d4265cb30ede37","status":"analyzed","capturedAt":"2026-10-15T04:25:09.024Z","count":3,"budget":{"used":1,"limit":4,"day":"2026-10-15"}}
```

`status`: `analyzed`, `awaiting_analysis` (`AI_PROVIDER=sentinel`) or `analysis_failed` (stored; the AI failed and is retried automatically). Errors: `404 CAMERA_NOT_FOUND`, `409 QUIET_HOURS`, `429 BUDGET_EXHAUSTED` (with `budget`), `429 RATE_LIMITED`, `502 CAPTURE_FAILED` (the camera did not answer; with `budget`).

### `POST /capture-interval`

A temporary capture interval that replaces the camera's own until `untilISO` (at most 72 hours ahead); then the camera's setting applies again by itself. `intervalMinutes` is one of `15`, `30`, `60`, `120`, or `null` to end it now. The camera's "daytime only" setting still applies.

```
POST /api/sentinel/capture-interval
{"deviceSerial":"BE4111159","intervalMinutes":15,"untilISO":"2026-10-15T10:25:09.349Z","reason":"catch rose 3x at the neighbour trap"}

200 {"success":true,"deviceSerial":"BE4111159","sentinelInterval":{"minutes":15,"until":"2026-10-15T10:25:09.349Z"},"cameraIntervalMinutes":30,"daytimeOnly":false}
```

Errors: `400 INVALID_INTERVAL`, `400 INVALID_UNTIL`, `404 CAMERA_NOT_FOUND`.

### `POST /proposals`

Proposes a sticky card change or a logbook treatment to the cameras' owner. Nothing is recorded until the owner presses **Confirm**. The proposal is the same confirm card the assistant makes (`propose_card_change` / `propose_treatment`, with the same checks), shown in the owner's assistant panel with the reason and the evidence, plus a Telegram message (when the owner linked Telegram) with the first evidence picture and **Confirm** / **Reject** buttons. Both go through the assistant's confirm flow (`POST /api/ai/chat/confirm`, session `sentinel`), which records the maintenance event or the treatment as if the owner had entered it.

- `type`: `card_change` (one sticky-trap camera, `deviceSerial`; lure traps are refused) or `treatment`.
- Cameras: `deviceSerial` or `deviceSerials` (all of the same owner), or `plot`: a plot id (its traps; the plot name becomes the area), or a plot name together with one `deviceSerial` of the same owner.
- `payload`: for `card_change` `{ at?, note? }`; for `treatment` `{ type, at?, product?, activeIngredient?, dose?, area?, operator?, preHarvestDays?, note? }` (`type` one of `spray`, `bait`, `lure`, `biological`, `sanitation`, `bagging`, `other`; a spray needs `product`). Without `type`, the agent's `action` is mapped: `bait_before_wave` → `bait`, `sanitation` → `sanitation`, `treat_now` → `spray` when a `product` is given, else `other`; `date` (suggested day) and `rotateFrom` go into the note. For `card_change`, `kind` (`card_full`, `card_replaced_detected`) becomes the note when there is none.
- `evidence` (required, 1 to 4 items): `{ url, caption? }` with an `https` picture link (Telegram fetches it and the app shows it, so it must stay valid while the proposal is open), or `{ snapshotId, caption? }` for a photo of the proposal's cameras. A bare string is read as one of these (an `https` link, or a 24-character photo id) or else kept as a text reference (for example an `s3://` key; stored, not shown as a picture). Up to 20 items are accepted and cut to 4, pictures first.
- `reason` (required; `payload.reason` is used when it is missing): why, shown to the owner.

```
POST /api/sentinel/proposals
{"type":"treatment","deviceSerials":["BE4111159"],"payload":{"type":"bait","product":"Ento-Pro 150SL","dose":"1 L/ha"},"evidence":[{"url":"https://sentinel-evidence.s3.ap-southeast-2.amazonaws.com/tr-1/crop.jpg","caption":"BE4111159: 38 flies, 3x yesterday"}],"reason":"Lure trap average rose from 12 to 38 flies per photo in 3 days."}

201 {"success":true,"proposalId":"6ad055a5e7d4265cb30ede3a","cardId":"e73ef835-e9b1-4f84-8b72-fce9773628ef","sessionId":"sentinel","cardIndex":0,"state":"pending","expiresAt":"2026-10-16T04:25:09.401Z","telegram":"sent"}
```

`telegram`: `sent`, `not_linked`, `disabled` (no bot on this server) or `failed`. Errors: `400 INVALID_REQUEST`, `404 CAMERA_NOT_FOUND`, `409` (the owner's account is disabled), `422 INVALID_EVIDENCE`, `422 INVALID_PROPOSAL` (the assistant's check, in `message`):

```
POST /api/sentinel/proposals
{"type":"card_change","deviceSerial":"BE4111159","evidence":[{"url":"https://e.example.com/a.jpg"}],"reason":"Card looks full."}

422 {"success":false,"code":"INVALID_PROPOSAL","message":"This is a lure trap: it has no sticky card."}
```

### `GET /proposals/{proposalId}`

```
GET /api/sentinel/proposals/6ad055a5e7d4265cb30ede3a

200 {"success":true,"proposalId":"6ad055a5e7d4265cb30ede3a","cardId":"e73ef835-e9b1-4f84-8b72-fce9773628ef","type":"treatment","deviceSerials":["BE4111159"],"state":"pending","result":null,"decidedAt":null,"decidedVia":null,"expiresAt":"2026-10-16T04:25:09.401Z","createdAt":"2026-10-15T04:25:09.517Z"}
```

`state`: `pending`, `confirmed` (recorded), `rejected`, `expired` (not decided in time; it can no longer be confirmed) or `failed` (confirmed, but the record was refused, for example the camera was removed meanwhile; `result` says why). `decidedVia`: `app` or `telegram`.

### `POST /review-request`

Asks the camera's owner to check a photo's count: the photo is flagged (`review.requested`) and the owner gets a `review_requested` notification in the app (at most one per camera per hour; the flag is set every time). A photo already reviewed or already flagged is left as it is. `GET /api/ai/results?review=requested` (signed in) lists the flagged photos not reviewed yet. Optional `deviceSerial`, `image` and `evidence` are accepted; their `https` links (up to 4) are kept with the flag (`review.requested.evidence`).

```
POST /api/sentinel/review-request
{"snapshotId":"6ad055a5e7d4265cb30ede37","reason":"NPU 3 vs OpenCV 11: please count this photo"}

200 {"success":true,"snapshotId":"6ad055a5e7d4265cb30ede37","status":"requested","requestedAt":"2026-10-15T04:25:09.925Z","notified":1}
```

`status`: `requested`, `already_requested` or `already_reviewed` (with `reviewStatus`). Errors: `400 INVALID_REQUEST`, `404 NOT_FOUND`, `422` without `reason`.

### `POST /analysis`

Sentinel's own analysis of a photo, stored under `aiResults.sentinel` as `{ source, counts, count, boxFormat, boxes, width, height, quality, evidence, estimates, model, traceId, receivedAt }`. It never sends `snapshot_analyzed` again, so Sentinel is not called back about its own result.

- `counts`: label → whole number (labels without `.`; a label with `null` is left out). `count` is their pest total (people and other non-pests excluded, as everywhere), so send labels, not one number per counting method: those go in `estimates` (an object, at most 2 KB, stored as sent).
- `boxes`: up to 1000 `{ label?, confidence? (0–1), bbox: [xmin, ymin, xmax, ymax] }` (a bare `[xmin, ymin, xmax, ymax]` is accepted too); `boxFormat` `xyxy_pixels` (default) or `xyxy_normalized` (0–1; send `width` and `height` so they can be stored in pixels).
- `quality` (an object, at most 8 KB) and `evidence` (a list, at most 20 items, 16 KB) are stored as sent; `model` and `traceId` are optional strings.
- With the usual `AI_PROVIDER` the photo's own count does not change (`summaryUpdated: false`). With `AI_PROVIDER=sentinel` it becomes the photo's result (count, boxes in pixels, `aiProvider: "sentinel"`), the daily statistics are updated and, the first time and for the camera's latest photo, its alerts run (threshold, card change, plot, surge). A photo a person reviewed is never changed.

```
POST /api/sentinel/analysis
{"snapshotId":"6ad055a5e7d4265cb30ede37","source":"sentinel","counts":{"fruit_fly":4},"boxFormat":"xyxy_pixels","width":2304,"height":1296,"boxes":[{"label":"fruit_fly","confidence":0.91,"bbox":[812,402,841,430]}],"quality":{"sharpness":311.4,"glare":0.01,"issues":[]},"evidence":[{"kind":"crop","url":"s3://sentinel-evidence/tr-1/crop.jpg"}],"model":"yolov7-tiny@opencv-5.0.0","traceId":"tr-1"}

200 {"success":true,"snapshotId":"6ad055a5e7d4265cb30ede37","stored":true,"summaryUpdated":false,"count":4}
```

Errors: `400 INVALID_REQUEST` (`snapshotId`, a `source` other than `sentinel`, `boxFormat`), `404 NOT_FOUND`, `422 INVALID_ANALYSIS`.

### `AI_PROVIDER=sentinel`

Runs FlyBot with Sentinel as its only counter (a minimal mode for the competition setup). The capture job stores each photo and checks its quality but calls no cloud model, and the automatic AI retry is off. `snapshot_analyzed` is sent right away with `aiSource: "pending"` so Sentinel can fetch the photo, and the photo gets its count when Sentinel posts `/analysis`. Until then it shows as not analyzed; if Sentinel never answers it stays so, and no "AI failing" alert is raised for it. The assistant's photo questions still use Vertex AI.
