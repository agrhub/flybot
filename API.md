# FlyBot API reference

| Audience | Base URL | Sign-in | Section |
|---|---|---|---|
| The web app and other signed-in clients | `/api` | Session cookie or `Authorization: Bearer <token>` | [App API](#app-api) |
| Other systems (read-only data, alerts) | `/api/v1`, webhooks | API key `fbk_...` | [Integrations: API keys and webhooks](#integrations-api-keys-and-webhooks) |
| CamOS cameras | `/api/device` | Device token (after pairing or self-registration) | [Camera device API](#camera-device-api) |
| The vision Lambda and an external vision agent | Lambda request, `/api/sentinel` | AWS IAM, HMAC signature | [Vision and agent](#vision-and-agent) |
| Administrators | `/api/admin` | Session of an `admin` (`support`: read only) | [Administration](#administration) |

Answers are JSON. Errors are `{ "success": false, "code": "...", "message": "..." }` (the device API uses `{ "ok": false, "error": "...", "message": "..." }`). Messages for people come back in the language the client asks for (`X-Language: vi` or `en`). Limits answer `429` with `Retry-After`. Replace `YOUR_FLYBOT_DOMAIN` with your address.

## App API

What the web app calls. Every request carries the person's session; `X-Workspace-Id` picks the current workspace.

### Workspaces, plans and limits

Three separate things decide what a person may do:

| Concept | Where | Values |
|---|---|---|
| System role | `User.role` | `admin` (the platform operator: every workspace, plans, settings), `support` (reads the admin pages: every `GET /api/admin/*`), `user`. Older databases may still hold `manager`; it reads as `user` |
| Workspace and role in it | `Organization` (`kind: personal \| organization`, `members[].role: owner \| manager \| member`) | Every account has a personal workspace (APP_MODE `b2c` / `hybrid`, made at sign-up or on first use); organizations are made by the admin. Cameras, farms and dashboards belong to one (`Camera.orgId`, `Farm.orgId`, `Dashboard.orgId`) |
| Plan | `Organization.plan: {code: free \| pro \| enterprise, addonCameras, expiresAt, assignedBy, assignedAt, note}` + the `Plan` collection | What the workspace may use (`services/entitlements.js`) |

**The current workspace** is the `X-Workspace-Id` header (the web client sends it), else the account's saved choice (`PUT /api/workspaces/current`), else the personal one, else the first. For someone in more than one workspace it scopes the camera, farm and dashboard lists (personal: its own items plus things shared with the person directly; organization: that organization's items) and every limit; with one workspace the lists are exactly as before. Owners and managers of the current workspace add cameras, farms and dashboards there; members view. The owner of a camera always manages it; organization owners and managers manage the organization's cameras.

**APP_MODE** (`.env`): `hybrid` (default): open sign-up makes a personal workspace on FREE, organizations exist alongside, pricing page with an "Organization / Business: contact us" card. `b2c`: personal workspaces only (organizations stay out of the switcher). `b2b`: organizations only, sign-up only for an email an organization invited (`ALLOW_SIGNUP=true` opens it), no personal workspaces, no pricing page, a member's upgrade request goes to the organization's owner first.

#### Plans

Configured by the administrator (**Settings → Plans**), seeded on first start with placeholder numbers (FREE from the `DEMO_*` settings). `0` means no limit for `maxCameras` and `maxMembers`.

| Field | FREE (seed) | PRO (seed) | ENTERPRISE (seed) |
|---|---|---|---|
| `maxCameras` per workspace (+ the workspace's `addonCameras`) | 3 | 10 | 100 |
| `snapshotsPerDay` per camera (CamOS uploads and the scheduled capture) | 48 | 96 | 288 |
| `retentionDays` (enforced only with `PLAN_RETENTION=true`) | 30 | 180 | 730 |
| `deepAnalysisPerMonth` (the chatbot's `analyze_photo_deep`, per workspace, calendar month UTC) | 20 | 300 | 5000 |
| `liveMinutesPerRequest` (CamOS live view) | 5 | 15 | 30 |
| `maxMembers` (owner included) | 1 | 5 | 0 |
| `features.telegram` / `pdfReports` / `apiAndWebhooks` | yes / no / no | yes / yes / yes | yes / yes / yes |
| `priceNote` (free text, no prices invented; empty = the app says "Free" / "Contact us" in the reader's language), `description`, `visible`, `order` | empty | empty | empty |

A paid plan past `expiresAt` falls back to FREE (data kept, adding blocked). Admins and `DEMO_EXEMPT_EMAILS` have no limits. A limit answers `403 {"code": "UPGRADE_REQUIRED", "limit": "cameras" | "members" | "deepAnalysis" | "apiAndWebhooks" | ..., "used", "max", "plan", "message"}`; the web client turns it into the upgrade dialog. API keys and webhooks need `apiAndWebhooks` on a workspace the person owns or manages (webhooks stop firing when the plan loses it).

| Request | Answer |
|---|---|
| `GET /api/plans` (no sign-in) | `{appMode, pricing, plans: [...]}` (the visible plans; empty in b2b) |
| `GET /api/me/entitlements` | `{appMode, workspace, entitlements: {plan, planName, exempt, expired, expiresAt, addonCameras, maxCameras, snapshotsPerDay, retentionDays, deepAnalysisPerMonth, liveMinutes, maxMembers, features}, usage: {cameras, members, deepAnalyses, month}}` for the current workspace |
| `GET /api/workspaces` | `{appMode, workspaces: [{id, name, kind, role, plan}], current}` |
| `PUT /api/workspaces/current {workspaceId}` | Saves the choice (`404` for a workspace the person is not in) |
| `PUT /api/workspaces/{id}/settings {allowMemberPersonalWorkspaces}` | An organization's owner: `false` hides its members' personal workspaces (their data stays) |
| `POST /api/upgrade-requests {type?: plan \| organization, targetPlan?, extraCameras?, message?, reason?, organization?: {name, cameras, members, phone}}` | `201 {request}`: `pending` (to the admin; admins are notified in-app, by email and Telegram as their settings say) or, b2b member, `pending_owner`. `type: organization` only in hybrid. `409 ALREADY_PENDING`. 10 an hour |
| `GET /api/upgrade-requests` | The person's own, plus (b2b owner) the ones waiting for them |
| `POST /api/upgrade-requests/{id}/cancel` | The requester withdraws a waiting one |
| `POST /api/upgrade-requests/{id}/forward {forward: true \| false, note?}` | b2b organization owner: on to the admin, or turned down |

`GET /api/auth/me` (and sign-in) also carry `appMode`, `workspace`, `workspaceCount`, `plan: {code, name, expired, expiresAt}` and `capabilities: {addCameras, buildDashboards, createFarms, claimCameras, integrations, pdfReports, telegram, pricing, upgradeRequests, requestOrganization}`; the client uses these instead of the role. `POST /api/orgs` is for administrators; `GET /api/orgs` lists organizations (not personal workspaces) with `kind`, `plan` and `settings`.

### Cameras on every platform

Each camera has a `platform` (`Camera.platform`, default `ezviz`): how FlyBot reaches it (`server/src/platforms/`). Every platform answers the same calls (list, snapshot, live session, playback, capture schedule, status), so the rest of FlyBot works the same for all of them.

| Platform | Camera | Snapshot | Live view | Playback | Capture schedule |
|---|---|---|---|---|---|
| `ezviz` | EZVIZ Open Platform camera | FlyBot polls the camera on its schedule | EZVIZ live URL (HLS / ezopen) | EZVIZ SD-card records | FlyBot's capture job |
| `camos` | CamOS trap camera (ESP32-S3, AMB82) on AWS IoT Core | The camera uploads on its own schedule (device API below); "capture now" = RPC `snapshot.now` and a wait for the upload | KVS WebRTC viewer config; a camera on battery joins at its next wake (`live.requested` in its shadow) | The snapshot timeline | Shadow `capture.intervalMin` |
| `kinesis` | A KVS signaling channel only | none | KVS WebRTC viewer config | none | none |

`GET /api/user/cameras` returns `platform` and, for CamOS cameras, `device` (`paired`, `fw`, `net`, `rssi`, `battery {mv, pct, charging, solarMv}`, `location`, `power {mode: auto|battery|powered}`, `sleeping`, `wakeAt`, `nextWakeAt`, `lastSeenAt`, `liveRequested`, `kvsChannelName`; never its token hashes).

#### Camera endpoints

| Request | Answer |
|---|---|
| `GET /api/cameras/{serial}/live` | EZVIZ: the same answer as `POST /api/live` (`{code, data: {url, accessToken, ...}}`). CamOS / KVS: `{success, platform: "kinesis", channelARN, channelName, region, signalingEndpoints: {WSS, HTTPS}, iceServers: [...], clientId, credentials: {accessKeyId, secretAccessKey, sessionToken, expiration}, expiresAt, camera: <status>, live: {requested, sent, nextWakeAt}}`; the browser joins the channel as viewer. The credentials come from `KVS_VIEWER_ROLE_ARN` assumed for 15 minutes with a policy limited to that channel; without the role: `503 LIVE_NOT_CONFIGURED` |
| `POST /api/cameras/{serial}/live/request` `{minutes?}` | CamOS only: `live.requested` (and `minutes`, 1-30, default 5) in the shadow for the next wake, plus RPC `live.start` when the camera is awake. `{success, requested, sent, nextWakeAt}` |
| `GET /api/cameras/{serial}/playback?from&to` | EZVIZ: `{kind: "video", records}`; CamOS: `{kind: "snapshots", items: [{id, at, imageKey, count, trigger, issues, traceId}]}` |
| `GET /api/cameras/{serial}/status` | `{status: {platform, online, power: {mode}, sleeping, wakeAt, nextWakeAt, lastSeenAt, battery, net, rssi, fw, ...}}` |
| `POST /api/user/add-camera` `{deviceSerial, validateCode, deviceName?, trapKind?, platform: "camos"}` | Registers a CamOS camera from its label (no cloud call) and answers with `provisioning: {provisionToken, expiresAt, pairUrl, apiBase, iotEndpoint, kvs: {region, channelName}, qr}`, shown once; the owner types it into the camera's setup portal. `platform` omitted or `ezviz`: unchanged |
| `POST /api/user/camera/provision` `{deviceSerial}` | A new provisioning token for a CamOS camera (manage rights) |
| `GET /api/cameras/{serial}/firmware` | `{platform, model, channel, current, latest: {version, channel, notes, size, publishedAt, minBatteryPct} or null, updateAvailable, update: <last update> or null, canUpdate, autoUpdate, autoHour, battery, power, state}`; notes in the `X-Language` language. EZVIZ: `{current: deviceVersion, managedBy: "ezviz", canUpdate: false}` (updated in the EZVIZ app) |
| `POST /api/cameras/{serial}/firmware/check` | The same, read again (EZVIZ: from the EZVIZ cloud), with `checkedAt` |
| `POST /api/cameras/{serial}/firmware/update` `{confirm: true}` | Owners and managers: install the release the camera's channel takes. `{success, state, update}`; `400 CONFIRM`, `409 UP_TO_DATE` / `BUSY`, `404 NO_RELEASE`. Audited `firmware.update_requested` |
| `PUT /api/cameras/{serial}/firmware/auto` `{enabled, hour?}` | Automatic updates around `hour` (0-23, farm time, default 12) when a newer release is current. `{success, autoUpdate, autoHour, queued}` |

**Remote console log** (CamOS, firmware 0.8.0; admins and the camera's owners and managers, never people it is shared with or demo visitors):

| Request | Answer |
|---|---|
| `POST /api/cameras/{serial}/log/start` `{level?: error\|warn\|info\|debug, minutes?: 1-60}` | Shadow desired `log {level, until}` (a sleeping camera starts at its next wake) and RPC `log.start {level, minutes, backlog: true}` when it is awake. `{success, level, until, sent, nextWakeAt}`. Audited `camera.log_started` |
| `POST /api/cameras/{serial}/log/stop` | Desired `log: null` and RPC `log.stop`. Audited `camera.log_stopped` |
| `GET /api/cameras/{serial}/log?since&before&level&q&limit` | `{state: {on, requested, level, until, lastLineAt, lastCrash}, lines: [{at, lvl (1 error ... 5 verbose), tag, msg, session}]}`, oldest first (the newest `limit`, 500 by default, or the next ones after `since`) |
| `POST /api/cameras/{serial}/log/watch` `{watching}` | For 90 s new lines also arrive on the notification stream as SSE event `camera_log {deviceSerial, lines, dropped, end, crash?}` |
| `GET /api/cameras/{serial}/log/download` | The last 24 h as text |
| `GET /api/cameras/{serial}/crashes` | The last 30 days of restarts after an error: `{crashes: [{at, reason, detail, fw, logTail, coredump: {task, pc, backtrace, corrupted, elfSha256} or null, source}]}` |

Lines are kept 24 h (TTL), 20,000 per camera at most; secrets are removed on the camera before they leave it.

A camera an administrator paused (`adminDisabled: {at, reason}` in the camera list) takes no photo (`403 CAMERA_DISABLED` on capture), opens no live view or SD playback (`403 CAMERA_DISABLED`) and its uploads are refused; its photos and history stay readable.

### Claiming a self-registered camera

A camera with the public firmware registers itself ([Camera device API](#self-registration-public-firmware)) and waits, unclaimed, until someone claims it with its serial and code (the **Claim a camera** page).

**`POST /api/cameras/claim`** (signed in) `{"serial", "verifyCode", "trapKind?": "lure"|"sticky", "farmId?", "captureIntervalMinutes?": 15|30|60|120, "deviceName?"}`

- `200 {"success":true, "camera":{deviceSerial, deviceName, trapKind, farmId, captureIntervalMinutes, platform, model}, "shadowSynced", "preview":{snapshotId, imageUrl, at, count}}`: the camera goes into the person's current workspace (they own and run it), its photos are kept, the shadow gets `claimed: true` and `capture.intervalMin`, and `tz` from the farm. Claiming again by the same person: `200` with `alreadyClaimed: true`. Audited as `camera.claimed`.
- `404 NOT_FOUND` for a wrong code, an unknown serial or a camera someone else claimed (the same answer for all three). Five failures for a serial within an hour lock it for an hour: `429 LOCKED` with `Retry-After` (also for a serial that does not exist). `403 UPGRADE_REQUIRED {limit: "cameras", used, max, plan}` past the current workspace plan's camera limit, `403 NO_WORKSPACE` when the person does not run the current workspace; `400 BAD_FARM`. 20 tries a minute per person.

**Limits** come from the workspace plan ([Workspaces, plans and limits](#workspaces-plans-and-limits)): a claimed camera counts toward the claimer's current workspace `maxCameras` (`403 UPGRADE_REQUIRED`), uploads are capped at `snapshotsPerDay` per camera in any 24 h (`429 daily_limit` with `nextWakeAt`), live view at `liveMinutesPerRequest`, and LLM deep analysis is never run for an unclaimed camera. Admins and `DEMO_EXEMPT_EMAILS` are unlimited. System limit: `DEMO_MAX_UNCLAIMED` (200).

### Sentinel screen

The **Sentinel** screen (Overview, Traces, Approvals, Devices) shows what the vision agent saw and proposed. It reads FlyBot's own database: a *trace* is a photo analyzed by the vision Lambda, an *approval* is a `SentinelProposal` (the confirm card), a *device* is a camera. On when `AI_PROVIDER=opencv-lambda`, or `SENTINEL_CONSOLE=true` on a server that keeps old traces with another provider; otherwise every route answers `503 {"code":"SENTINEL_DISABLED"}` and `GET /api/auth/me` reports `sentinelEnabled: false` so the client hides the menu. People, not machines: sign in as usual (Bearer JWT or the session cookie, so evidence pictures work as `<img src>`).

Base URL: `https://YOUR_FLYBOT_DOMAIN/api/sentinel/ui`

#### Who may use it

| Account | Read (every `GET`) | Approve / reject |
|---|---|---|
| admin; owner or manager of the current workspace | yes | yes (for cameras they manage) |
| account with `sentinelViewer` (a read-only reviewer; set by an admin) | yes | no (`403 FORBIDDEN`) |
| a member who does not run the current workspace | no (`403 FORBIDDEN`) | no |

Everyone sees the cameras they may see in FlyBot (owned, shared with them, the read-only demo cameras below, or every camera for an admin). Each approval carries `can_decide`: `false` when the person manages none of its cameras (a shared or demo camera), so the client shows it read-only. `GET /api/auth/me` carries `sentinelEnabled` and `sentinelCanDecide`; `GET /api/system/info` has the same as `info.sentinel: { enabled, canDecide }`. An admin sets `sentinelViewer` with `PUT /api/admin/users/{id} {"sentinelViewer": true|false}` (audited as `user.sentinel_access_changed`).

#### Routes

| Request | Answer |
|---|---|
| `GET /summary?hours=` (1-168, default 24) | `{role: operator|judge (judge = read-only), hours, photos, photos_by_source: {ezviz, camos}, decisions: {<action>: n, no_op: n}, proposals_pending, devices: {online, total}, planner_mode: rule|llm, last_photo_at, kill_switch: {global: false, cameras: []}, provider, lambda}` |
| `GET /traces?camera=&since=&until=&limit=&cursor=` | `{items: [slim trace], next}` newest first; `next` is a time cursor. A slim trace: `event_id` (the Lambda's `traceId`, or `snap_<id>`), `snapshot_id`, `camera`, `camera_name`, `source` (platform), `trap_kind`, `created_at`, `captured_at`, `state` (`done` \| `failed`), `outcome`, `counts: {opencv, npu: null, production}`, `quality: {ok, issues}` (the Lambda's flags), `decisions: [{rule, action, reasons, params}]` (its proposals), `approval: {approval_id, kind, status}`, `planner: {name, model}`, `image` (storage key) |
| `GET /traces/{event_id}` | `{trace: {...slim, opencv_outputs: {<serial>: {counts, by_class, quality: {ok, issues, scores: {blur, exposure}}, new_catch: {new_count, disappeared_count, persisted_count, card_change_suspected}, density, image, previous_image, evidence: [keys], analyzer, vision_ms, battery_percent, boxes}}, planner: {name, model, llm_turns, tokens}, reasoning_summary, tool_calls: [{index, name, status, ms, args, result}] (the trace steps), events, approval, approvals, deep: [{at, question, answer, trace_id}], timings, model}, media: {}}` |
| `GET /approvals?status=&limit=` (`pending`, `approved`, `rejected`, `expired`) | `{items: [{approval_id, event_id, kind, status, cameras, created_at, expires_at, decided_at, decided_by, on_timeout, source, flybot_proposal_id, payload: {action, params, reason, result}, evidence}], next: null}` (`confirmed` → `approved`; `failed` → `rejected`; a pending one past its time reads as `expired`) |
| `GET /approvals/{id}` | `{approval, media: {}}` |
| `POST /approvals/{id}/decide` `{"decision": "approve" \| "reject"}` | Admins, and people who manage one of the proposal's cameras. Runs (or drops) the proposal's confirm card as its owner would in the chat panel (claimed once): `202 {queued: true, applied: true, approval_id, decision, state: done|cancelled|failed|expired, message, by}` with `by` always the signed-in person; `409 CONFLICT` when it was already decided. Audited as `sentinel.approval_decided` |
| `GET /devices`, `GET /devices/{serial}` | `{items: [...]}` / `{device, media: {}}`: `serial`, `name`, `online`, `trap_kind`, `source`, `fw`, `net`, `battery_percent`, `rssi`, `telemetry`, `last_seen_at`, `last_photo: {key, at, count}`, `lat`, `lon`, `power_mode`, `sleeping`, `wake_at`, `reported` / `desired` (the shadow), `reported_version`, `desired_version`, `capture_interval_min`, `agent_state: {budgets: {captures_used, captures_limit}}`; the detail adds `telemetry_history` (battery and signal from the last 60 CamOS uploads) |
| `GET /evidence?key=` | The picture itself from FlyBot's bucket (`snapshots/<serial>/...`, `evidence/<serial>/...`, `frames/<serial>/...`; jpg/png/webp, at most 25 MB) for a camera the person may see (`Cache-Control: private, max-age=3600`) |

Any other path or method answers `404 NOT_FOUND`; a listed query parameter with a bad value `400 BAD_REQUEST`. JSON answers carry `Cache-Control: no-store`.

#### Errors, limits

`{ "success": false, "code": "...", "message": "..." }`: `400 BAD_REQUEST`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `413 TOO_LARGE`, `502 SENTINEL_STORAGE` (the bucket did not answer), `503 SENTINEL_DISABLED`. Limits per person: 120 reads, 300 evidence files and 20 decisions per minute (`429` with `Retry-After`).

## Integrations: API keys and webhooks

Owners and managers of a workspace whose plan includes API and webhooks create API keys and webhooks under **Settings → API & Webhooks**.

### Read-only API

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

### Webhooks

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

#### `snapshot_analyzed`

Not an alert: one event for every photo of a camera you can see (yours or shared with you), sent once its AI count and its photo quality check are both stored. It is meant for systems that process each photo (for example FlyBot Sentinel). It does not appear in the app's notifications and is not emailed. Muting a camera does not stop it.

- Sent once per photo: at capture, or, when the AI failed at capture, when the later automatic retry succeeds (then `quality` is the one measured at capture). Photos the AI never analyzed send nothing. A manual re-analysis does not send it again.
- `id` is `snap_` + the snapshot id, the same on every retry of the delivery: use it to drop duplicates.
- `imageUrl` is a presigned S3 link valid for 1 hour (`imageUrlExpiresAt`); the bucket itself is private. Download the photo within the hour, or `null` when the link could not be made.
- `count` is the number of pests (people, vehicles and animals excluded, as in the API); `counts` is the AI's full summary per label, non-pests included.
- `boxes` are in pixels of the photo, `[xmin, ymin, xmax, ymax]` (`boxFormat: "xyxy_pixels"`). Divide by `width` and `height` for 0–1 values. At most 200 are sent, highest confidence first: then `truncated` is `true` and `boxesTotal` tells how many there were. `width`/`height` are `null` when the photo's size could not be read.
- `provider` is `ezviz` or `camos`; `aiSource` is `cloud` (FlyBot's AI, `aiProvider` `opencv-lambda`, `roboflow` or `vertex`) or `device` (counted on the AI camera itself).
- `quality` has the measurements of the photo quality check (`brightness` 0–255, `contrast`, `sharpness`, `clipped` share of white pixels, `coverage` share of the photo under boxes or `null`) and `issues` (`dark`, `overexposed`, `blurry`, `low_contrast`, `card_full`), or is `null` when the photo could not be checked.
- `previousSnapshotId` is the camera's previous analyzed photo (by capture time), `null` for the first one. `cardReplacedAt` is when the sticky card was last replaced (`null` if never logged).
- `trigger` is `"sentinel"` for an extra photo the vision agent asked for (`POST /api/sentinel/capture`), else `null`.
- With `AI_PROVIDER=sentinel` (see "Signed vision agent API") the event is sent once the quality check is stored, before any count: `aiSource` is `"pending"`, `count` is `null`, `counts` is `{}` and `boxes` is empty. It is not sent again when Sentinel posts its analysis.
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

#### Checking the signature

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

#### Delivery
- Answer with any `2xx` within 5 seconds. Redirects are not followed.
- Network errors, `429` and `5xx` answers are retried after 10 seconds, 1 minute and 5 minutes. Other `4xx` answers are not retried.
- After 15 failed deliveries in a row the webhook is switched off. Switch it back on in Settings.
- Only public addresses are called: addresses on private, loopback or link-local networks are refused, including when a public name resolves to one. For a local receiver during development, set `WEBHOOK_ALLOW_PRIVATE=true` on the server. This is ignored when `NODE_ENV=production`.

## Camera device API

What the ESP32 / AMB82 cameras call over HTTPS. No user session: every call but `/pair` and `/events` carries `X-Device-Serial` and `X-Device-Token` (the token from pairing; FlyBot stores its SHA-256 only). Base URL: `DEVICE_API_BASE_URL/api/device`.

| Request | Answer |
|---|---|
| `POST /pair` `{serial, verifyCode, provisionToken}` | `200 {ok, deviceToken, iot: {endpoint, thingName}, kvs: {region, channelName}}`; `401` on an unknown camera, a wrong label code or an expired/used provisioning token (24 h, one use). 10 tries a minute per IP |
| `POST /snapshot` multipart/form-data: part `image` (`image/jpeg`, at most 2 MB), part `meta` (`application/json`: `{v, serial, capturedAt, trigger: schedule|rpc|boot, battery: {mv, pct, charging, solarMv}, net: wifi|4g, rssi, location: {lat, lng, fixAt}, fw}`) | `200 {ok, snapshotId, nextWakeAt}` as soon as the photo is stored (`403 {error: "disabled", nextWakeAt}` while an administrator pauses the camera) (the analysis, alerts, quality check and webhook run in the background); `413` too large, `415` not a JPEG, `400` bad meta, `401` bad token, `429` more than 12 photos a minute. The photo goes through the same pipeline as EZVIZ photos (storage, AI provider, alerts, `snapshot_analyzed`); `capturedAt` is kept when it is within a week of the server clock |
| `GET /time` | No auth: `{now, epoch, timezone, posix, tzSource, publicIp}` (below) |
| `GET /ota` | The build of the camera's open firmware update: `{fw, url, sha256}`, `url` a signed link to `GET /firmware/{id}` valid an hour; else the `DEVICE_OTA_*` offer, or `204`. Never `401` for a known camera (the firmware takes a `401` here as a lost registration) |
| `GET /firmware/{id}?sn&exp&sig` | The image (`application/octet-stream`, `X-Fw-Sha256`) for the signed link, or for a camera sending its own token, while it has an open update to that build; `401` bad link, `404` no such update |
| `POST /logs` `{v, kind: crash \| diag, fw, uptimeMs, lines, crash}` | What a camera that cannot reach MQTT sends: its crash report, or the latest log as a diagnosis (once an hour). `{ok, stored}`; 4 a minute per camera |
| `POST /events` `{topic, payload}` with `X-IoT-Rule-Secret` | The IoT-rule fallback for camera->cloud messages (`IOT_EVENTS=rule`); `401` bad secret, `503` when `IOT_RULE_SECRET` is empty |

Limits: 120 calls a minute per client IP, 30 a minute per camera. A photo uploaded while FlyBot waits on `snapshot.now` answers that request (the "Capture now" button, a confirmed `capture_now` card, the vision agent's `POST /api/sentinel/capture`).

### Self-registration (public firmware)

Anyone may flash the public CamOS release; the camera joins FlyBot by itself and a person claims it on `/claim`. No secret is in the public image: FlyBot is the only party that talks to AWS IoT.

**`POST /api/device/register`** (no auth) `{"v":1, "serial":"ESP1234567890AB", "verifyCode":"K7Q2MX", "model":"AIC-FREENOVE-S3CAM", "fw":"0.3.0", "csr":"<PEM PKCS#10, ECDSA P-256, made on the device>"}`

- Checks: `serial` = `ESP` + 12 hex digits (the MAC), `verifyCode` = 6 Crockford base32 characters, `csr` a PEM certificate request of at most 4 KB (a body with a private key is refused).
- Then: AWS IoT `CreateThing` (`<serial>`, type `IOT_THING_TYPE`, attribute `flybot=self-registered`), `CreateCertificateFromCsr` (`setAsActive`), `AttachPolicy` (`IOT_POLICY_NAME`), `AttachThingPrincipal`, the KVS channel `cam-<serial>`, and the camera stored **unclaimed** with a hashed device token. A failure undoes every step.
- `201 {"ok":true, "certificatePem", "deviceToken", "iot":{"endpoint","thingName"}, "kvs":{"region","channelName"}, "claimUrl":"https://<APP_BASE_URL>/claim?sn=<serial>", "claimed":false}`. FlyBot never makes or returns a private key; the device token is shown only in this answer.
- Same serial + code again before the camera's first MQTT connection: the same certificate (a different CSR gets a new certificate and the old one is deleted) and a new device token (the old one stops working). After the first connection, with another code, for a serial an owner already has, or for an AWS thing FlyBot did not make: `409 {"error":"serial_taken"}`. Deleting the camera in FlyBot (its owner) removes the certificate, thing and channel, so the camera can register again.
- A serial in the [serial registry](#camera-fleet-serial-registry-and-firmware) must come with its registered code (`409 serial_taken` otherwise) and not be blocked (`403 disabled`); unregistered serials still register.
- Other answers: `400 bad_request | bad_serial | bad_csr`, `429` (`REGISTER_MAX_PER_IP_HOUR` per client IP, `REGISTER_MAX_PER_HOUR` in total), `502 aws_failed`, `503 capacity` (`DEMO_MAX_UNCLAIMED` cameras already wait for a claim) / `busy` (a registration of that serial is running) / `disabled` (`SELF_REGISTRATION=false`).

**Unclaimed mode.** The camera may upload 1 photo an hour (`POST /snapshot` answers `nextWakeAt` an hour later, and `429 {"error":"rate_limited","nextWakeAt"}` before that). Its photos are analysed with the rule planner only (the Lambda request carries `camera.claimed: false` and `options: {"planner":"rule","llm":false}`), make no confirm cards, alerts, quality notices or webhooks, are hidden from every account (admins too) and deleted after 24 h. Cameras never claimed are removed after 7 days (certificate detached, deactivated and deleted, thing and KVS channel deleted, photos deleted) by the hourly job (`ENABLE_CRON`; pipeline monitor id `selfRegistered`).

### Clock and time zone: `GET /api/device/time`

No auth (works before registration), 30 a minute per IP. `{"now":"2026-10-16T08:00:00.000Z", "epoch":1792137600, "timezone":"Asia/Ho_Chi_Minh", "posix":"<+07>-7", "tzSource":"farm|gps|ip|default", "publicIp":"115.72.212.239"}`.

Timezone, first that answers: the camera's farm (`Farm.timezone`; for a camera without a farm, the owner's only farm with a timezone), the camera's last GPS fix (offline lookup, `@photostructure/tz-lookup`), the request's public IP (offline country database `ip3country`, IP2Location LITE data, then the country's main zone), `DEVICE_DEFAULT_TIMEZONE` (`Asia/Ho_Chi_Minh`). The camera is looked up only when it sends `X-Device-Serial` and a valid `X-Device-Token`. `publicIp` is the client address FlyBot saw (behind a proxy, with `TRUST_PROXY=1`), `null` for a private one. `posix` is the POSIX TZ string for the zone (for `setenv("TZ")` on the camera).

When a camera's zone changes (claimed into a farm, the farm's timezone edited with `PUT /api/farms/{id} {"timezone"}`, cameras moved to a farm, a GPS fix in another zone), FlyBot writes shadow desired `tz: {iana, posix}` (only farm or GPS answers; nothing when unchanged).

### AWS IoT Core messages

Messages FlyBot handles (over its MQTT subscription, or posted by an IoT rule to `/api/device/events`): `camos/<serial>/state`, `camos/<serial>/event` (`goodbye` with `sleeping`/`wakeAt`, `boot`, `low_power`, ...), `camos/<serial>/telemetry`, `camos/<serial>/rpc/res`, the shadow's reported side (`$aws/things/<serial>/shadow/update/accepted`) and the lifecycle events (`$aws/events/presence/connected|disconnected/<clientId>`). Shadow keys written by FlyBot: `capture.intervalMin`, `capture.requestNow`, `live.requested`, `live.minutes`, `video.image` (from a confirmed `set_isp`). RPC methods sent: `snapshot.now`, `live.start {minutes}`, `live.stop`, `gps.fix`, `reboot`, `ota.apply`. Shadow `disabled: true|false` follows an administrator's pause. From `state` FlyBot keeps `model`, `fw`, `hw`, `mac` and the 4G modem's `net.cell {imei, iccid, operator}`. `camos/<serial>/log` carries the remote log batches `{session, seq, uptimeMs, at, lines, dropped, end}` and the event `crash` a restart after an error (both stored by `services/cameraLogService.js`).

**Firmware updates** (`services/firmwareService.js`). An update waits (`waitReason`) until the camera is online and awake, on mains power, charging or above the release's `minBatteryPct` (or 3.7 V), and for an automatic update within three hours after its `autoHour`. It is sent when the camera shows up (`state`, `boot`, telemetry, a photo upload) and by a 5-minute job (pipeline id `firmware`). Then: RPC `ota.apply` (rpc/res `ok` -> `installing`, `OLD_VERSION` -> `succeeded`, `LOW_BATTERY` -> waits again, other errors -> `failed`; no answer: tried again, 5 times at most), the camera downloads the signed image, event `ota_progress {pct}` (firmware 0.7.0+), `ota_result {ok, stage, error, detail}` (`rebooting` or `failed`), and `boot {fw}`: the new version -> `succeeded`, the old one after an install -> `rolled_back` (the bootloader went back). Installing or rebooting for 30 minutes without a report: `failed TIMEOUT`. The owner is told how it ended (`firmware_updated` / `firmware_failed`).

## Vision and agent

### Counting with the vision Lambda (`AI_PROVIDER=opencv-lambda`)

Every photo is analyzed by the vision Lambda (OpenCV 5 detection and the planning agent, deployed by flybot-aws): `Lambda.Invoke` on `VISION_LAMBDA_NAME` with the instance role, or, for local development, the same JSON posted to `VISION_LAMBDA_URL` (a Lambda running on your computer, for example `http://localhost:9001/invoke`; the URL wins when both are set). Timeout `VISION_LAMBDA_TIMEOUT_S` (120 s).

The photo travels by reference: `{s3Bucket, s3Key}` when the bucket is real S3 (`PHOTOS_BY_REFERENCE`, default true when `S3_ENDPOINT` is empty or an `amazonaws.com` endpoint), otherwise a signed URL valid an hour. The request also carries the previous analyzed photo of the camera (`prevPhoto`), the camera (`id`, `name`, `trapKind` sticky|lure, `platform`, `location`), the last 14 counts (`history`) and the locale.

Stored on the snapshot: `aiProvider: "opencv-lambda"`, counts as `aiResults.summary` / `pestCount` (statistics, alerts and the history page read them as with any provider), boxes in pixels as `aiResults.insects`, and the full answer under `lambda` (`traceId`, `model`, `counts`, `boxes` normalised, `quality`, `diff`, `density`, `proposals`, `trace`, `evidence`, `timings`, `width`, `height`, `status`, `attempts`). `snapshot_analyzed` is sent unchanged (`aiProvider: "opencv-lambda"`, `aiSource: "cloud"`).

On an error (`FunctionError`, HTTP 4xx/5xx, timeout) the photo is kept, `lambda.status` is `failed` with `lambda.error {code, message}`, and the call is retried once after 30 s in the background; a success then runs the alerts (latest photo only) and the webhook. After that the usual AI retry job takes over.

**Proposals.** Each `proposals[]` item (`capture_now`, `set_interval {minutes}`, `set_isp {brightness, wdr}`, `review_request`, `notify {message}`) becomes a confirm card in the camera owner's **Sentinel** conversation (session `sentinel`), a `SentinelProposal` row (`source: "lambda"`, `traceId`, `snapshotId`, `confidence`) and a Telegram message with Confirm / Reject. Nothing runs until the owner confirms (`POST /api/ai/chat/confirm`, Telegram, or the Sentinel screen): `capture_now` takes a photo now (a sleeping CamOS camera takes it at its next wake), `set_interval` sets the camera's interval for 24 hours (`Camera.sentinelInterval`; CamOS: the shadow too), `set_isp` writes `video.image` to a CamOS shadow (refused for EZVIZ), `review_request` flags the photo for a person, `notify` writes a notification. The assistant proposes the same actions with its `propose_action` tool.

**Deep analysis.** The assistant's `analyze_photo_deep` tool sends `mode: "deep"` with the user's question (photo id, or a camera's latest photo) and answers with the Lambda's `answer` (markdown) and counts; the question, answer and trace are kept under `lambda.deep` (last 10). Gemini remains the chat model. Limits: the workspace plan's `deepAnalysisPerMonth` (`UPGRADE_REQUIRED` past it; never for an unclaimed camera) and 20 photo looks per person per hour (shared with `inspect_photo`).

### Signed vision agent API

Machine-to-machine API for an external vision agent (for example one running on AWS next to the vision Lambda). It is not for people or API keys: every request is signed with a key shared with the agent, and the answers are in English only.

Base URL: `https://YOUR_FLYBOT_DOMAIN/api/sentinel`

#### Settings

| Variable | Default | Meaning |
|---|---|---|
| `SENTINEL_API_SECRET` | (empty) | HMAC key shared with the agent, at least 32 characters. Empty or shorter: every request answers `503 SENTINEL_DISABLED`. |
| `SENTINEL_CAPTURE_BUDGET` | `4` | Extra captures Sentinel may ask for, per camera per farm day (Asia/Ho_Chi_Minh). `0` turns `/capture` off. |
| `SENTINEL_PROPOSAL_TTL_HOURS` | `24` | Hours a proposal waits for Confirm before it expires (1 to 168). |
| `AI_PROVIDER` | `vertex` | `sentinel`: no cloud model at capture; the photo waits for `POST /analysis` (see the end of this section). |

#### Signature

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

Audit log (Settings → Audit log, category "FlyBot Sentinel"), with the actor `sentinel-agent`: `sentinel.capture`, `sentinel.capture_interval`, `sentinel.proposal_created`, `sentinel.review_requested`, `sentinel.analysis` (only when it sets the photo's count, `AI_PROVIDER=sentinel`), and `sentinel.proposal_decided` with the person who confirmed or rejected as the actor.

#### `POST /capture`

An extra photo now, through the normal capture path (EZVIZ capture, S3, the AI unless `AI_PROVIDER=sentinel`, alerts, quality check, `snapshot_analyzed` with `trigger: "sentinel"`). It does not move the camera's schedule. The answer comes once the photo is stored and analyzed (allow 60 s).

- Refused with `409 QUIET_HOURS` when the camera is set to "daytime only" and it is not 06:00–18:00 farm time.
- At most `SENTINEL_CAPTURE_BUDGET` attempts per camera per farm day (an attempt counts even when the camera is offline), and 3 per camera per minute.

```
POST /api/sentinel/capture
{"deviceSerial":"BE4111159"}

200 {"success":true,"snapshotId":"6ad055a5e7d4265cb30ede37","status":"analyzed","capturedAt":"2026-10-15T04:25:09.024Z","count":3,"budget":{"used":1,"limit":4,"day":"2026-10-15"}}
```

`status`: `analyzed`, `awaiting_analysis` (`AI_PROVIDER=sentinel`) or `analysis_failed` (stored; the AI failed and is retried automatically). Errors: `404 CAMERA_NOT_FOUND`, `409 QUIET_HOURS`, `429 BUDGET_EXHAUSTED` (with `budget`), `429 RATE_LIMITED`, `502 CAPTURE_FAILED` (the camera did not answer; with `budget`).

#### `POST /capture-interval`

A temporary capture interval that replaces the camera's own until `untilISO` (at most 72 hours ahead); then the camera's setting applies again by itself. `intervalMinutes` is one of `15`, `30`, `60`, `120`, or `null` to end it now. The camera's "daytime only" setting still applies.

```
POST /api/sentinel/capture-interval
{"deviceSerial":"BE4111159","intervalMinutes":15,"untilISO":"2026-10-15T10:25:09.349Z","reason":"catch rose 3x at the neighbour trap"}

200 {"success":true,"deviceSerial":"BE4111159","sentinelInterval":{"minutes":15,"until":"2026-10-15T10:25:09.349Z"},"cameraIntervalMinutes":30,"daytimeOnly":false}
```

Errors: `400 INVALID_INTERVAL`, `400 INVALID_UNTIL`, `404 CAMERA_NOT_FOUND`.

#### `POST /proposals`

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

#### `GET /proposals/{proposalId}`

```
GET /api/sentinel/proposals/6ad055a5e7d4265cb30ede3a

200 {"success":true,"proposalId":"6ad055a5e7d4265cb30ede3a","cardId":"e73ef835-e9b1-4f84-8b72-fce9773628ef","type":"treatment","deviceSerials":["BE4111159"],"state":"pending","result":null,"decidedAt":null,"decidedVia":null,"expiresAt":"2026-10-16T04:25:09.401Z","createdAt":"2026-10-15T04:25:09.517Z"}
```

`state`: `pending`, `confirmed` (recorded), `rejected`, `expired` (not decided in time; it can no longer be confirmed) or `failed` (confirmed, but the record was refused, for example the camera was removed meanwhile; `result` says why). `decidedVia`: `app` or `telegram`.

#### `POST /review-request`

Asks the camera's owner to check a photo's count: the photo is flagged (`review.requested`) and the owner gets a `review_requested` notification in the app (at most one per camera per hour; the flag is set every time). A photo already reviewed or already flagged is left as it is. `GET /api/ai/results?review=requested` (signed in) lists the flagged photos not reviewed yet. Optional `deviceSerial`, `image` and `evidence` are accepted; their `https` links (up to 4) are kept with the flag (`review.requested.evidence`).

```
POST /api/sentinel/review-request
{"snapshotId":"6ad055a5e7d4265cb30ede37","reason":"NPU 3 vs OpenCV 11: please count this photo"}

200 {"success":true,"snapshotId":"6ad055a5e7d4265cb30ede37","status":"requested","requestedAt":"2026-10-15T04:25:09.925Z","notified":1}
```

`status`: `requested`, `already_requested` or `already_reviewed` (with `reviewStatus`). Errors: `400 INVALID_REQUEST`, `404 NOT_FOUND`, `422` without `reason`.

#### `POST /analysis`

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

#### `AI_PROVIDER=sentinel`

Runs FlyBot with the external agent as its only counter (`AI_PROVIDER=opencv-lambda` is the usual setup on AWS). The capture job stores each photo and checks its quality but calls no cloud model, and the automatic AI retry is off. `snapshot_analyzed` is sent right away with `aiSource: "pending"` so Sentinel can fetch the photo, and the photo gets its count when Sentinel posts `/analysis`. Until then it shows as not analyzed; if Sentinel never answers it stays so, and no "AI failing" alert is raised for it. The assistant's photo questions still use Vertex AI.

## Administration

Every route below needs an administrator's session; `support` accounts may read (`GET`) them all. Plans, workspaces and upgrade requests:

| Request | Answer |
|---|---|
| `GET /api/admin/plans`, `PUT /api/admin/plans/{code}` | Read (admin, support) / edit (admin) a plan |
| `GET /api/admin/workspaces?q=&kind=&plan=` | Every workspace with owner, members, cameras, plan, billing note |
| `POST /api/admin/workspaces {name, ownerEmail, plan?}` | A new organization (b2b / hybrid); an owner without an account yet joins on verification |
| `PUT /api/admin/workspaces/{id}/plan {plan, addonCameras?, expiresAt?, note?, billingNote?}` | Assign a plan (audited `workspace.plan_changed`) |
| `GET /api/admin/upgrade-requests?status=` | All requests |
| `POST /api/admin/upgrade-requests/{id}/approve {plan?, addonCameras?, expiresAt?, paid?, adminNote?}` | Sets the workspace's plan (an organization request makes the organization with the requester as owner); the requester is notified. Payment is manual (`paid` is the admin's checkbox) |
| `POST /api/admin/upgrade-requests/{id}/reject {adminNote}` | Turned down with a note the requester sees |

#### Demo access for visitors

The admin can open a few cameras to every account, read-only, so visitors such as competition judges see real traps without anyone sharing them by hand (`services/demoView.js`). `PUT /api/admin/settings` takes:

| Field | Value | Environment default |
|---|---|---|
| `demoViewEnabled` | `true` / `false` | `DEMO_VIEW_ENABLED` (`false`) |
| `demoViewShares` | up to 20 `{ deviceSerial, live, playback, location, device, realSerial }` (booleans, missing = `false`): each shared camera and what visitors may do with it | from `demoViewCameras` |
| `demoViewCameras` | up to 20 serials (follows `demoViewShares`; saved alone, it keeps the permissions of the cameras still listed) | `DEMO_VIEW_CAMERAS` (comma-separated) |
| `demoViewSince` | `"YYYY-MM-DD"`: only accounts created on or after it; `null`: every account | `DEMO_VIEW_SINCE` |
| `demoViewLive` | live view and playback of a newly added camera (admin page); saved without `demoViewShares` it opens or closes them for every camera | `DEMO_VIEW_LIVE` (`false`) |

Until `demoViewShares` is saved, each camera of `demoViewCameras` has live view and playback as `demoViewLive` says and shows its location, device details and serial (`GET /api/admin/settings` returns the entries built that way). Photos and counts of a shared camera are always shown; each permission opens one more thing:

| Permission | Opens | Closed |
|---|---|---|
| `live` | Live view (`POST /api/live`, `GET /api/cameras/{serial}/live`, the live request of a sleeping CamOS camera) | `403 {"code":"DEMO_READ_ONLY"}` |
| `playback` | Recorded video (`POST /api/records`, `POST /api/playback`, EZVIZ `GET /api/cameras/{serial}/playback`) | `403 {"code":"DEMO_READ_ONLY"}` |
| `location` | `latitude`, `longitude`, `locationAddress`, the GPS / cell fix | the fields are dropped from every answer (camera list, map data, Sentinel, the assistant), coordinates are removed from the camera log |
| `device` | The CamOS status (battery, signal, network, power), firmware version and model, `GET /api/cameras/{serial}/firmware`, the camera log (`GET .../log`, `.../log/download`, `.../crashes`; never start, stop or watch) | the fields are dropped (`device` keeps only sleep and wake), firmware and log answer `404` |
| `realSerial` | The real serial | every answer shows an alias `DEMO-` + 10 hex digits instead (also in photo paths, file names, events and the assistant); requests may use the alias. The live and playback answers keep the real serial for the player (EZVIZ and KVS need it) |

Such a camera behaves as if it were shared with the visitor: the camera list (`access: "demo"`, `canManage: false`, no `owner`, `liveOpen`, `playbackOpen`, `demo`: its permissions), photos, statistics, dashboards, the Sentinel screen and the assistant include it. Every change (settings, capture, delete, share, maintenance, treatments, approvals) answers `403`/`404` as for any camera the person does not manage. Only signed-in requests get the access: alerts, emails, reports and webhooks never mention demo cameras to visitors. Admins are not affected. Nothing is stored on the cameras or accounts, so turning it off ends the access within the settings cache (30 s). `GET /api/auth/config` carries `demoView: true` while it is offered (the sign-up form says so) and `GET /api/auth/me` `demoView: { cameras, live }`.

#### Guest access

`POST /api/auth/guest` (no body) signs in to one shared account (`guest@flybot.invalid`, `User.guest`) while `guestAccessEnabled` is on (`GUEST_ACCESS`), and answers like `/api/auth/login` (`token`, `user` with `guest: true`, `guestUntil`, every capability off but `buildDashboards`). `403 GUEST_ACCESS_OFF` when it is off; `429` past 20 sessions an hour per address or 300 in total. `GET /api/auth/config` carries `guestAccess` (the sign-in page shows the button).

- The session lasts 2 hours and is never extended; turning guest access off ends every guest session.
- Read-only: every request other than `GET`/`HEAD`/`OPTIONS`, `POST /api/auth/logout`, `POST /api/ai/diagnose` (it computes and saves nothing), the assistant (`/api/ai/chat`, `/chat/stream`, `/chat/feedback`, `/chat/clear`), opening and stopping a stream (`POST /api/live`, `/api/live/disable`, `/api/records`, `/api/playback`, `/api/cameras/{serial}/live/request`, each within the camera's demo permissions) and its own reports (below) answers `403 {"code":"GUEST_READ_ONLY"}`, and so do `GET /api/auth/export` and `/api/integrations`. Its assistant conversations are kept per guest session.
- Reports: a guest makes its own (`POST /api/dashboards`, `PUT`/`DELETE /api/dashboards/{id}`, `POST /api/dashboards/{id}/public-token`) on the cameras it sees, up to 5 per guest session (`400 {"code":"REPORT_LIMIT"}`). Each belongs to its session (`Dashboard.guestSession`): other guest sessions never list, read or change it, and it is removed at sign-out or, by a job every 15 minutes, once the session has expired or guest access is off. No sharing by email, sending or schedule (`400 {"code":"GUEST_READ_ONLY"}` for a schedule); a public link only for cameras whose real serial visitors see, and the simulated farm's (`400 PUBLIC_FOREIGN_CAMERA` otherwise). The simulated farm's sample reports stay read-only.
- The guest account sees the demo cameras and, with `demoViewSimulated`, the simulated demo farm. Other accounts see them only by `demoViewAudience` (`DEMO_VIEW_AUDIENCE`): `guest` (nobody else, the default), `all`, or `since` (accounts created on or after `demoViewSince`).

#### Simulated demo farm

`server/scripts/demo_sim.js` (DEPLOY.md) builds an organization of simulated farms, plots and traps (every province of Vietnam and a dozen fruit regions abroad, English names, `Farm.simKey` / `Plot.simKey` as stable keys) and releases labeled synthetic trap photos at their times, each analyzed by the vision Lambda. Every document it writes has `simulated: true` (Organization, Farm, Plot, Camera, Snapshot, Treatment, MaintenanceEvent, SentinelProposal, DailyStat). Its cameras are on the `simulated` platform: no device, so capture answers `409 {"code":"SIMULATED_CAMERA"}` and live view `403 {"code":"SIMULATED_CAMERA"}`; its Sentinel proposals are decided by the simulation (`409 SIMULATED`). A snapshot carries `simulation: { photoId, poolPhotoId, truth }` (`truth`: the flies drawn on the synthetic photo, beside the detector's `pestCount`); Sentinel traces carry `simulated` and `simulated_truth`.

- Only signed-in requests see it (admins, and visitors when `demoViewSimulated` is on, read-only); a background job never does, so emailed and scheduled reports, alerts and webhooks contain no simulated data. `GET /api/auth/me` has `simulatedData: true` when the person sees any (the app shows a banner); a public dashboard answers `simulated: true` and its page and PDF say so.
- `PUT /api/admin/settings` takes `demoViewSimulated` (`DEMO_VIEW_SIMULATED`), `demoSimEnabled` (`DEMO_SIM_ENABLED`) and `demoSimUntil` (`DEMO_SIM_UNTIL`, a date or `null`); `GET /api/admin/demo-sim` reports `{ exists, name, farms, cameras, photos, proposals, lastPhotoAt }`.

#### Camera fleet, serial registry and firmware

Admins only (support may read the lists, never reveal a code). Every change and every revealed code is audited.

| Request | Answer |
|---|---|
| `GET /api/admin/fleet?q&platform&state&model&channel&fw&outdated&page&limit` | Every camera (EZVIZ and CamOS, not simulated): `{deviceSerial, deviceName, platform, state: online/offline/sleeping, disabled: {at, reason} or null, unclaimed, owner, sharedCount, farm, location: {lat, lng, address}, verifyCodeMasked, model, hw, fw, channel, latestFw, outdated, update, imei, iccid, operator, mac, net, rssi, battery, power, registry: {disabled, batch} or null, lastSeenAt, lastCaptureAt, addedAt}`; `q` matches serial, name, place, model, IMEI, ICCID and the owner's email or name; `state` also `disabled` / `unclaimed` |
| `POST /api/admin/fleet/{serial}/reveal-code` | `{verifyCode}` (audited `camera.verify_code_revealed`) |
| `PUT /api/admin/fleet/channel` `{serials: [...], channel}` | Release channel of up to 1000 CamOS cameras: `alpha`, `beta` or `stable` (the default). Cameras with automatic updates get their new channel's release. `{channel, changed, scheduled}`, audited `camera.channel_changed` |
| `PUT /api/admin/fleet/{serial}/disabled` `{disabled, reason?}` | Pause or resume a camera: no captures, uploads (`403 disabled`), live view or Sentinel actions; shadow `disabled`; the owner and the people it is shared with get `camera_disabled` / `camera_enabled` with the reason. `{changed, disabled, deviceSynced}` |
| `GET /api/admin/registry?q&status&batch&page&limit` | `status`: `available`, `claimed` or `disabled`. `{mode, counts, batches, entries: [{serial, verifyCodeMasked, model, hwVersion, batch, note, status, disabled, disabledReason, claimedAt, claimedBy, camera}]}` |
| `POST /api/admin/registry` `{serial, verifyCode, model?, hwVersion?, batch?, note?}` | One serial (`409 EXISTS`); an `ESP` serial needs a 6-character Crockford code |
| `PUT /api/admin/registry/{serial}` `{verifyCode?, model?, hwVersion?, batch?, note?, disabled?, disabledReason?}` | Edit or block; the code of a camera already in an account cannot change (`409 CLAIMED`) |
| `DELETE /api/admin/registry/{serial}` | Only a serial nobody added (`409 CLAIMED`) |
| `POST /api/admin/registry/{serial}/reveal-code` | `{verifyCode}` (audited) |
| `POST /api/admin/registry/import` `{csv, dryRun?, overwrite?, batch?}` | Up to 5,000 lines of `serial,verifyCode,model,hwVersion,batch,note` (header optional, `,` or `;`) or label QR text `CAMOS:1;SN:..;VC:..;M:..;;`. `{rows, created, updated, skipped, errors: [{line, serial, error}], errorCount}`; a dry run writes nothing |
| `POST /api/admin/registry/backfill` | Every CamOS camera already known goes into the registry with its code (claimed ones marked), before turning on strict mode |
| `GET /api/admin/firmware` | `{releases: [{id, model, version, channel, size, sha256, source, notes: {en, vi}, current, minBatteryPct, cameras, updates: {total, succeeded, failed, open}}], models, boards, channels, cameraChannels: {alpha, beta, stable}}`. Release channels: a release is `alpha`, `beta` or `stable` and may be the current one of its model in that channel; a camera takes the newest current release of its own channel or a more stable one (same version: the more stable channel). Releases and cameras from before channels are stable |
| `POST /api/admin/firmware` | multipart (`file`, `model`, `version`, `sha256?`, `notesEn?`, `notesVi?`, `minBatteryPct?`, `channel?`), or `{url, model, version, sha256?, channel?}`, or `{githubTag, repo?, channel?}` (a GitHub pre-release defaults to `beta`, others to `stable`) (default `agrhub/camos-esp32-trap`: each board's `-update.bin`, checked against the release's `SHA256SUMS`). The image must start with `0xE9` and fit the model's OTA slot (3 MB; 1.69 MB on `AIC-ESP32CAM`); FlyBot stores it under `firmware/` and serves it to cameras itself |
| `PUT /api/admin/firmware/{id}` `{current?, channel?, notes?, minBatteryPct?}` | `current: true` takes the mark off the model's other builds in the same channel, tells the owners of older cameras that take this build once (`firmware_available`, in-app and by their alert settings) and schedules automatic updates: `{announced: {notified, scheduled}}`. A new `channel` promotes the build (alpha to beta to stable): it becomes current there and is announced |
| `DELETE /api/admin/firmware/{id}` | Not the current build, no open update to it |
| `POST /api/admin/firmware/{id}/rollout` `{serials: [...]}` or `{allOfModel: true}` (the model's cameras whose channel takes this build), `outdatedOnly?` (default true) | One update per camera with a shared `batchId`; `{created, skipped: [{deviceSerial, reason}]}`, reasons `up_to_date`, `model_mismatch`, `not_camos`, `simulated`, `busy`, `not_found`, `already_queued` |
| `GET /api/admin/firmware/updates?batchId&state&serial&page&limit` | `state` one state or `open`. `{updates: [{id, deviceSerial, deviceName, fromVersion, toVersion, source (admin, owner, auto), state (pending, sent, installing, rebooting, succeeded, failed, rolled_back, cancelled), waitReason, progress, attempts, error, detail}], batches}` |
| `POST /api/admin/firmware/updates/{id}/cancel`, `/retry` | Cancel before the install starts; try a failed or cancelled update again |

**Serial registry mode** (`PUT /api/admin/settings {registryMode}`, env `REGISTRY_MODE`, default `open`): in both modes a registered serial joins an account (claim, or Add camera before the camera registered) only with its registered code (a wrong code counts toward the claim lock) and not while blocked (`403 SERIAL_DISABLED`); in `strict` mode an unregistered serial joins no account (`403 SERIAL_NOT_REGISTERED`). EZVIZ cameras are checked by the EZVIZ cloud as before.

Users: `GET /api/admin/users`, `PUT /api/admin/users/{id}` (`role`: `admin`, `support` or `user`; `disabled`; `emailVerified`; `sentinelViewer`), `DELETE /api/admin/users/{id}`. Cameras: `GET /api/admin/cameras`, `PUT /api/admin/cameras/{serial}/owner`. System: `GET`/`PUT /api/admin/settings`, `GET /api/admin/audit` (and `/audit/export`), `GET /api/admin/pipeline`, `GET /api/admin/usage`.
