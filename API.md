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

Runs FlyBot with Sentinel as its only counter (the first competition build;  below replaces it). The capture job stores each photo and checks its quality but calls no cloud model, and the automatic AI retry is off. `snapshot_analyzed` is sent right away with `aiSource: "pending"` so Sentinel can fetch the photo, and the photo gets its count when Sentinel posts `/analysis`. Until then it shows as not analyzed; if Sentinel never answers it stays so, and no "AI failing" alert is raised for it. The assistant's photo questions still use Vertex AI.

## Camera platforms (EZVIZ, CamOS on AWS IoT Core, Kinesis Video Streams)

Each camera has a `platform` (`Camera.platform`, default `ezviz`): how FlyBot reaches it (`server/src/platforms/`). Every adapter answers the same calls — list, snapshot, live session, playback, capture schedule, status — and the rest of FlyBot does not care which one it talks to.

| Platform | Camera | Snapshot | Live view | Playback | Capture schedule |
|---|---|---|---|---|---|
| `ezviz` | EZVIZ Open Platform camera (unchanged) | FlyBot polls the camera on its schedule | EZVIZ live URL (HLS / ezopen) | EZVIZ SD-card records | FlyBot's capture job |
| `camos` | CamOS trap camera (ESP32-S3, AMB82) on AWS IoT Core | The camera uploads on its own schedule (device API below); "capture now" = RPC `snapshot.now` and a wait for the upload | KVS WebRTC viewer config; a camera on battery joins at its next wake (`live.requested` in its shadow) | The snapshot timeline | Shadow `capture.intervalMin` |
| `kinesis` | A KVS signaling channel only | none | KVS WebRTC viewer config | none | none |

`GET /api/user/cameras` returns `platform` and, for CamOS cameras, `device` (`paired`, `fw`, `net`, `rssi`, `battery {mv, pct, charging, solarMv}`, `location`, `power {mode: auto|battery|powered}`, `sleeping`, `wakeAt`, `nextWakeAt`, `lastSeenAt`, `liveRequested`, `kvsChannelName`; never its token hashes).

### Platform-aware endpoints (session sign-in)

| Request | Answer |
|---|---|
| `GET /api/cameras/{serial}/live` | EZVIZ: the same answer as `POST /api/live` (`{code, data: {url, accessToken, ...}}`). CamOS / KVS: `{success, platform: "kinesis", channelARN, channelName, region, signalingEndpoints: {WSS, HTTPS}, iceServers: [...], clientId, credentials: {accessKeyId, secretAccessKey, sessionToken, expiration}, expiresAt, camera: <status>, live: {requested, sent, nextWakeAt}}` — the browser joins the channel as VIEWER (`client/src/components/cameras/KvsViewer.vue`). The credentials come from `KVS_VIEWER_ROLE_ARN` assumed for 15 minutes with a policy limited to that channel; without the role: `503 LIVE_NOT_CONFIGURED` |
| `POST /api/cameras/{serial}/live/request` `{minutes?}` | CamOS only: `live.requested` (and `minutes`, 1-30, default 5) in the shadow for the next wake, plus RPC `live.start` when the camera is awake. `{success, requested, sent, nextWakeAt}` |
| `GET /api/cameras/{serial}/playback?from&to` | EZVIZ: `{kind: "video", records}`; CamOS: `{kind: "snapshots", items: [{id, at, imageKey, count, trigger, issues, traceId}]}` |
| `GET /api/cameras/{serial}/status` | `{status: {platform, online, power: {mode}, sleeping, wakeAt, nextWakeAt, lastSeenAt, battery, net, rssi, fw, ...}}` |
| `POST /api/user/add-camera` `{deviceSerial, validateCode, deviceName?, trapKind?, platform: "camos"}` | Registers a CamOS camera from its label (no cloud call) and answers with `provisioning: {provisionToken, expiresAt, pairUrl, apiBase, iotEndpoint, kvs: {region, channelName}, qr}` — shown once; the owner types it into the camera's setup portal. `platform` omitted or `ezviz`: unchanged |
| `POST /api/user/camera/provision` `{deviceSerial}` | A new provisioning token for a CamOS camera (manage rights) |

### Settings

| Variable | Meaning |
|---|---|
| `AWS_REGION` | Region of every AWS client (default `ap-southeast-2`). Credentials: the EC2 instance role, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| `IOT_ENDPOINT` | The account's IoT data endpoint (`aws iot describe-endpoint --endpoint-type iot:Data-ATS`) |
| `IOT_EVENTS` | `mqtt` (default): FlyBot subscribes to the cameras' topics over MQTT/WebSocket with SigV4, on the `ENABLE_CRON` instance; `rule`: an IoT rule posts the messages to `POST /api/device/events`; `off` |
| `IOT_RULE_SECRET` | Shared secret of that rule (header `X-IoT-Rule-Secret`) |
| `KVS_VIEWER_ROLE_ARN` | IAM role the browser assumes (through FlyBot) to join a signaling channel as viewer |
| `DEVICE_API_BASE_URL` | Public base URL the cameras call (default `APP_BASE_URL`) |
| `DEVICE_OTA_FW`, `DEVICE_OTA_URL`, `DEVICE_OTA_SHA256` | Firmware offered by `GET /api/device/ota` (all three set = offered) |

IoT Core messages FlyBot handles (`platforms/camos.js handleMessage`): `camos/<serial>/state`, `camos/<serial>/event` (`goodbye` with `sleeping`/`wakeAt`, `boot`, `low_power`, ...), `camos/<serial>/telemetry`, `camos/<serial>/rpc/res`, the shadow's reported side (`$aws/things/<serial>/shadow/update/accepted`) and the lifecycle events (`$aws/events/presence/connected|disconnected/<clientId>`). Shadow keys written by FlyBot: `capture.intervalMin`, `capture.requestNow`, `live.requested`, `live.minutes`, `video.image` (from a confirmed `set_isp`). RPC methods sent: `snapshot.now`, `live.start {minutes}`, `live.stop`, `gps.fix`, `reboot`, `ota.apply`.

## Device API (CamOS cameras)

What the ESP32 / AMB82 cameras call over HTTPS (flybot-aws `docs/CONTRACTS.md` section 2). No user session: every call but `/pair` and `/events` carries `X-Device-Serial` and `X-Device-Token` (the token from pairing; FlyBot stores its SHA-256 only). Base URL: `DEVICE_API_BASE_URL/api/device`.

| Request | Answer |
|---|---|
| `POST /pair` `{serial, verifyCode, provisionToken}` | `200 {ok, deviceToken, iot: {endpoint, thingName}, kvs: {region, channelName}}`; `401` on an unknown camera, a wrong label code or an expired/used provisioning token (24 h, one use). 10 tries a minute per IP |
| `POST /snapshot` multipart/form-data: part `image` (`image/jpeg`, at most 2 MB), part `meta` (`application/json`: `{v, serial, capturedAt, trigger: schedule|rpc|boot, battery: {mv, pct, charging, solarMv}, net: wifi|4g, rssi, location: {lat, lng, fixAt}, fw}`) | `200 {ok, snapshotId, nextWakeAt}` as soon as the photo is stored (the analysis, alerts, quality check and webhook run in the background); `413` too large, `415` not a JPEG, `400` bad meta, `401` bad token, `429` more than 12 photos a minute. The photo goes through the same pipeline as EZVIZ photos (storage, AI provider, alerts, `snapshot_analyzed`); `capturedAt` is kept when it is within a week of the server clock |
| `GET /time` | No auth: `{now, epoch, timezone, posix, tzSource, publicIp}` (below) |
| `GET /ota` | `{fw, url, sha256}` or `204` when there is nothing newer than the camera's `fw` |
| `POST /events` `{topic, payload}` with `X-IoT-Rule-Secret` | The IoT-rule fallback for camera->cloud messages (`IOT_EVENTS=rule`); `401` bad secret, `503` when `IOT_RULE_SECRET` is empty |

Limits: 120 calls a minute per client IP, 30 a minute per camera. A photo uploaded while FlyBot waits on `snapshot.now` answers that request (the "capture now" button, a confirmed `capture_now` card, the Sentinel `POST /capture`).

### Zero-touch self-registration (public firmware, flybot-aws CONTRACTS 2a)

Anyone may flash the public CamOS release; the camera joins FlyBot by itself and a person claims it on `/claim`. No secret is in the public image: FlyBot is the only party that talks to AWS IoT.

**`POST /api/device/register`** (no auth) `{"v":1, "serial":"ESPF85B1B92877C", "verifyCode":"9WBYWY", "model":"AIC-FREENOVE-S3CAM", "fw":"0.3.0", "csr":"<PEM PKCS#10, ECDSA P-256, made on the device>"}`

- Checks: `serial` = `ESP` + 12 hex digits (the MAC), `verifyCode` = 6 Crockford base32 characters, `csr` a PEM certificate request of at most 4 KB (a body with a private key is refused).
- Then: AWS IoT `CreateThing` (`<serial>`, type `IOT_THING_TYPE`, attribute `flybot=self-registered`), `CreateCertificateFromCsr` (`setAsActive`), `AttachPolicy` (`IOT_POLICY_NAME`), `AttachThingPrincipal`, the KVS channel `cam-<serial>`, and the camera stored **unclaimed** with a hashed device token. A failure undoes every step.
- `201 {"ok":true, "certificatePem", "deviceToken", "iot":{"endpoint","thingName"}, "kvs":{"region","channelName"}, "claimUrl":"https://<APP_BASE_URL>/claim?sn=<serial>", "claimed":false}`. FlyBot never makes or returns a private key; the device token is shown only in this answer.
- Same serial + code again before the camera's first MQTT connection: the same certificate (a different CSR gets a new certificate and the old one is deleted) and a new device token (the old one stops working). After the first connection, with another code, for a serial an owner already has, or for an AWS thing FlyBot did not make: `409 {"error":"serial_taken"}`. Deleting the camera in FlyBot (its owner) removes the certificate, thing and channel, so the camera can register again.
- Other answers: `400 bad_request | bad_serial | bad_csr`, `429` (`REGISTER_MAX_PER_IP_HOUR` per client IP, `REGISTER_MAX_PER_HOUR` in total), `502 aws_failed`, `503 capacity` (`DEMO_MAX_UNCLAIMED` cameras already wait for a claim) / `busy` (a registration of that serial is running) / `disabled` (`SELF_REGISTRATION=false`).

**Unclaimed mode.** The camera may upload 1 photo an hour (`POST /snapshot` answers `nextWakeAt` an hour later, and `429 {"error":"rate_limited","nextWakeAt"}` before that). Its photos are analysed with the rule planner only (the Lambda request carries `camera.claimed: false` and `options: {"planner":"rule","llm":false}`), make no confirm cards, alerts, quality notices or webhooks, are hidden from every account (admins too) and deleted after 24 h. Cameras never claimed are removed after 7 days (certificate detached, deactivated and deleted, thing and KVS channel deleted, photos deleted) by the hourly job (`ENABLE_CRON`; pipeline monitor id `selfRegistered`).

**`POST /api/cameras/claim`** (signed in) `{"serial", "verifyCode", "trapKind?": "lure"|"sticky", "farmId?", "captureIntervalMinutes?": 15|30|60|120, "deviceName?"}`

- `200 {"success":true, "camera":{deviceSerial, deviceName, trapKind, farmId, captureIntervalMinutes, platform, model}, "shadowSynced", "preview":{snapshotId, imageUrl, at, count}}`: the camera is the person's (any account, whatever its role, may claim and then run its own claimed cameras), its photos are kept, the shadow gets `claimed: true` and `capture.intervalMin`, and `tz` from the farm. Claiming again by the same person: `200` with `alreadyClaimed: true`. Audited as `camera.claimed`.
- `404 NOT_FOUND` for a wrong code, an unknown serial or a camera someone else claimed (the same answer for all three). Five failures for a serial within an hour lock it for an hour: `429 LOCKED` with `Retry-After` (also for a serial that does not exist). `403 LIMIT_REACHED {limit, plan}` past the plan's camera limit; `400 BAD_FARM`. 20 tries a minute per person.

**Plan limits** (`services/entitlements.js getEntitlements(user)`, the one place every limit is read from; today from the `DEMO_*` settings): `maxCameras` self-registered cameras per account (`DEMO_MAX_CAMERAS_PER_USER`, 3), `snapshotsPerDay` per camera in any 24 h (`DEMO_MAX_SNAPSHOTS_PER_DAY`, 48; `429 daily_limit` with `nextWakeAt`), `liveMinutes` per live request (`DEMO_LIVE_MINUTES`, 5), `deepAnalysis` (the chatbot's `analyze_photo_deep`; never for an unclaimed camera). Admins and `DEMO_EXEMPT_EMAILS` are unlimited. System limit: `DEMO_MAX_UNCLAIMED` (200).

### `GET /api/device/time`

No auth (works before registration), 30 a minute per IP. `{"now":"2026-10-16T08:00:00.000Z", "epoch":1792137600, "timezone":"Asia/Ho_Chi_Minh", "posix":"<+07>-7", "tzSource":"farm|gps|ip|default", "publicIp":"115.72.212.239"}`.

Timezone, first that answers: the camera's farm (`Farm.timezone`; for a camera without a farm, the owner's only farm with a timezone), the camera's last GPS fix (offline lookup, `@photostructure/tz-lookup`), the request's public IP (offline country database `ip3country`, IP2Location LITE data, then the country's main zone), `DEVICE_DEFAULT_TIMEZONE` (`Asia/Ho_Chi_Minh`). The camera is looked up only when it sends `X-Device-Serial` and a valid `X-Device-Token`. `publicIp` is the address Express saw (`TRUST_PROXY=1`: the one Caddy forwards), `null` for a private one. `posix` comes from `server/src/data/posixTz.json` (IANA -> POSIX TZ in the quoted numeric form newlib accepts, built from Node's tzdata by `server/scripts/build_posix_tz.js`).

When a camera's zone changes (claimed into a farm, the farm's timezone edited with `PUT /api/farms/{id} {"timezone"}`, cameras moved to a farm, a GPS fix in another zone), FlyBot writes shadow desired `tz: {iana, posix}` (only farm or GPS answers; nothing when unchanged).

## `AI_PROVIDER=opencv-lambda`

Every photo is analyzed by the vision Lambda of flybot-aws (OpenCV 5 detection + the agent) with the request of `docs/CONTRACTS.md` section 1 (`services/visionLambda.js`): `Lambda.Invoke` (RequestResponse) on `VISION_LAMBDA_NAME` from the instance role, or — for local development — the same JSON posted to `VISION_LAMBDA_URL` (`http://localhost:9001/invoke`, `uv run python -m sentinel.lambda_local`; the URL wins when both are set). Timeout `VISION_LAMBDA_TIMEOUT_S` (120).

The photo travels by reference: `{s3Bucket, s3Key}` when the bucket is real S3 (`PHOTOS_BY_REFERENCE`, default true when `S3_ENDPOINT` is empty or an `amazonaws.com` endpoint), otherwise a signed URL valid an hour. The request also carries the previous analyzed photo of the camera (`prevPhoto`), the camera (`id`, `name`, `trapKind` sticky|lure, `platform`, `location`), the last 14 counts (`history`) and the locale.

Stored on the snapshot: `aiProvider: "opencv-lambda"`, counts as `aiResults.summary` / `pestCount` (statistics, alerts and the history page read them as with any provider), boxes in pixels as `aiResults.insects`, and the full answer under `lambda` (`traceId`, `model`, `counts`, `boxes` normalised, `quality`, `diff`, `density`, `proposals`, `trace`, `evidence`, `timings`, `width`, `height`, `status`, `attempts`). `snapshot_analyzed` is sent unchanged (`aiProvider: "opencv-lambda"`, `aiSource: "cloud"`).

On an error (`FunctionError`, HTTP 4xx/5xx, timeout) the photo is kept, `lambda.status` is `failed` with `lambda.error {code, message}`, and the call is retried once after 30 s in the background; a success then runs the alerts (latest photo only) and the webhook. After that the usual AI retry job takes over.

**Proposals.** Each `proposals[]` item (`capture_now`, `set_interval {minutes}`, `set_isp {brightness, wdr}`, `review_request`, `notify {message}`) becomes a confirm card in the camera owner's **Sentinel** conversation (session `sentinel`), a `SentinelProposal` row (`source: "lambda"`, `traceId`, `snapshotId`, `confidence`) and a Telegram message with Confirm / Reject. Nothing runs until the owner confirms (`POST /api/ai/chat/confirm`, Telegram, or the Sentinel console): `capture_now` takes a photo now (a sleeping CamOS camera takes it at its next wake), `set_interval` sets the camera's interval for 24 hours (`Camera.sentinelInterval`; CamOS: the shadow too), `set_isp` writes `video.image` to a CamOS shadow (refused for EZVIZ), `review_request` flags the photo for a person, `notify` writes a notification. The assistant proposes the same actions with its `propose_action` tool.

**Deep analysis.** The assistant's `analyze_photo_deep` tool sends `mode: "deep"` with the user's question (photo id, or a camera's latest photo) and answers with the Lambda's `answer` (markdown) and counts; the question, answer and trace are kept under `lambda.deep` (last 10). Gemini remains the chat model. Quota: 20 photo looks per person per hour (shared with `inspect_photo`).

## Sentinel console

The console (menu **Sentinel**: Overview, Traces, Approvals, Devices) reads FlyBot's own database: a *trace* is a photo analyzed by the vision Lambda, an *approval* is a `SentinelProposal` (the confirm card), a *device* is a camera. On when `AI_PROVIDER=opencv-lambda`, or `SENTINEL_CONSOLE=true` on a server that keeps old traces with another provider; otherwise every route answers `503 {"code":"SENTINEL_DISABLED"}` and `GET /api/auth/me` reports `sentinelEnabled: false` so the client hides the menu. People, not machines: sign in as usual (Bearer JWT or the session cookie, so evidence pictures work as `<img src>`).

Base URL: `https://YOUR_FLYBOT_DOMAIN/api/sentinel/ui`

### Who may use it

| Account | Read (every `GET`) | Approve / reject |
|---|---|---|
| admin, manager | yes | yes |
| user with `sentinelViewer` (e.g. a competition judge; set by an admin) | yes | no (`403 FORBIDDEN`) |
| any other user | no (`403 FORBIDDEN`) | no |

Everyone sees the cameras they may see in FlyBot (owned, shared with them, or every camera for an admin). `GET /api/auth/me` carries `sentinelEnabled` and `sentinelCanDecide`; `GET /api/system/info` has the same as `info.sentinel: { enabled, canDecide }`. An admin sets `sentinelViewer` with `PUT /api/admin/users/{id} {"sentinelViewer": true|false}` (audited as `user.sentinel_access_changed`).

### Routes

| Request | Answer |
|---|---|
| `GET /summary?hours=` (1-168, default 24) | `{role: operator|judge, hours, photos, photos_by_source: {ezviz, camos}, decisions: {<action>: n, no_op: n}, proposals_pending, devices: {online, total}, planner_mode: rule|llm, last_photo_at, kill_switch: {global: false, cameras: []}, provider, lambda}` |
| `GET /traces?camera=&since=&until=&limit=&cursor=` | `{items: [slim trace], next}` newest first; `next` is a time cursor. A slim trace: `event_id` (the Lambda's `traceId`, or `snap_<id>`), `snapshot_id`, `camera`, `camera_name`, `source` (platform), `trap_kind`, `created_at`, `captured_at`, `state` (`done` \| `failed`), `outcome`, `counts: {opencv, npu: null, production}`, `quality: {ok, issues}` (the Lambda's flags), `decisions: [{rule, action, reasons, params}]` (its proposals), `approval: {approval_id, kind, status}`, `planner: {name, model}`, `image` (storage key) |
| `GET /traces/{event_id}` | `{trace: {...slim, opencv_outputs: {<serial>: {counts, by_class, quality: {ok, issues, scores: {blur, exposure}}, new_catch: {new_count, disappeared_count, persisted_count, card_change_suspected}, density, image, previous_image, evidence: [keys], analyzer, vision_ms, battery_percent, boxes}}, planner: {name, model, llm_turns, tokens}, reasoning_summary, tool_calls: [{index, name, status, ms, args, result}] (the trace steps), events, approval, approvals, deep: [{at, question, answer, trace_id}], timings, model}, media: {}}` |
| `GET /approvals?status=&limit=` (`pending`, `approved`, `rejected`, `expired`) | `{items: [{approval_id, event_id, kind, status, cameras, created_at, expires_at, decided_at, decided_by, on_timeout, source, flybot_proposal_id, payload: {action, params, reason, result}, evidence}], next: null}` (`confirmed` → `approved`; `failed` → `rejected`; a pending one past its time reads as `expired`) |
| `GET /approvals/{id}` | `{approval, media: {}}` |
| `POST /approvals/{id}/decide` `{"decision": "approve" \| "reject"}` | Admins and managers. Runs (or drops) the proposal's confirm card as its owner would in the chat panel (claimed once): `202 {queued: true, applied: true, approval_id, decision, state: done|cancelled|failed|expired, message, by}` with `by` always the signed-in person; `409 CONFLICT` when it was already decided. Audited as `sentinel.approval_decided` |
| `GET /devices`, `GET /devices/{serial}` | `{items: [...]}` / `{device, media: {}}`: `serial`, `name`, `online`, `trap_kind`, `source`, `fw`, `net`, `battery_percent`, `rssi`, `telemetry`, `last_seen_at`, `last_photo: {key, at, count}`, `lat`, `lon`, `power_mode`, `sleeping`, `wake_at`, `reported` / `desired` (the shadow), `reported_version`, `desired_version`, `capture_interval_min`, `agent_state: {budgets: {captures_used, captures_limit}}`; the detail adds `telemetry_history` (battery and signal from the last 60 CamOS uploads) |
| `GET /evidence?key=` | The picture itself from FlyBot's bucket (`snapshots/<serial>/...`, `evidence/<serial>/...`, `frames/<serial>/...`; jpg/png/webp, at most 25 MB) for a camera the person may see (`Cache-Control: private, max-age=3600`) |

Any other path or method answers `404 NOT_FOUND`; a listed query parameter with a bad value `400 BAD_REQUEST`. JSON answers carry `Cache-Control: no-store`.

### Errors, limits

`{ "success": false, "code": "...", "message": "..." }`: `400 BAD_REQUEST`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `413 TOO_LARGE`, `502 SENTINEL_STORAGE` (the bucket did not answer), `503 SENTINEL_DISABLED`. Limits per person: 120 reads, 300 evidence files and 20 decisions per minute (`429` with `Retry-After`).
