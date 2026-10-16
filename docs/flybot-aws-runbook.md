# FlyBot on AWS — runbook (branch `feat/aws`)

FlyBot as the OpenCV AI Competition 2026 entry: the same app, with OpenCV 5 detection on a Lambda
(`AI_PROVIDER=opencv-lambda`), CamOS trap cameras on AWS IoT Core, live view over Kinesis Video
Streams WebRTC, and the Sentinel console read from FlyBot's own MongoDB. Everything else (EZVIZ
cameras, alerts, reports, chatbot) is unchanged. Contracts: flybot-aws `docs/CONTRACTS.md`.

## What runs where

| Part | Where | Code |
|---|---|---|
| FlyBot (API + Vue client) | EC2 t4g.small, `docker compose` (flybot-aws `docker-compose.yml`) behind Caddy (TLS for `flybot.agrhub.com`) | this repo |
| MongoDB | the same host, compose service `mongo` (volume `mongo-data`) | |
| Photos | S3 bucket of the stack (`PHOTOS_BUCKET`), read by the instance role | `server/src/config/s3.js` |
| Vision + agent | Lambda `flybot-vision-<stage>` (arm64 container, OpenCV 5) | `server/src/services/visionLambda.js` |
| Camera transport | AWS IoT Core (Device Shadow, RPC topics, lifecycle), the device API `/api/device` | `server/src/platforms/camos.js`, `iotEvents.js`, `routes/deviceRoutes.js` |
| Live view | KVS signaling channel `cam-<serial>` per camera, browser as VIEWER | `platforms/kinesis.js`, `client/src/components/cameras/KvsViewer.vue` |

## Environment variables

Read by `server/src/config/env.js`. On the EC2 host the stack's user-data writes the first group into `flybot-aws/.env`; secrets come from Secrets Manager (`FLYBOT_SECRETS`); the rest has defaults.

| Variable | Meaning |
|---|---|
| `AI_PROVIDER` | `opencv-lambda` for the competition setup (`vertex`, `roboflow`, `both`, `sentinel` still work) |
| `VISION_LAMBDA_NAME` | Lambda function name, invoked with the AWS SDK (RequestResponse, timeout `VISION_LAMBDA_TIMEOUT_S` = 120) |
| `VISION_LAMBDA_URL` | Local development: the same JSON posted here (`http://localhost:9001/invoke`, or `http://host.docker.internal:9001/invoke` from the container). Wins over the name |
| `PHOTOS_BY_REFERENCE` | `true` (default with S3): the Lambda gets `{s3Bucket, s3Key}`; `false` (MinIO): a signed URL |
| `S3_BUCKET_NAME` / `PHOTOS_BUCKET` | The photo bucket; `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` only for MinIO (empty = instance role, real S3) |
| `AWS_REGION` | `ap-southeast-2` (the account's only region) |
| `IOT_ENDPOINT` | `a38gyfo6dhqxf4-ats.iot.ap-southeast-2.amazonaws.com` (`aws iot describe-endpoint --endpoint-type iot:Data-ATS --profile sentinel`) |
| `IOT_EVENTS` | `mqtt` (default): FlyBot subscribes to `camos/+/{state,event,telemetry,rpc/res}`, the shadow updates and the lifecycle events over MQTT/WebSocket with SigV4, on the `ENABLE_CRON=true` instance. `rule`: an IoT rule posts the same messages to `POST /api/device/events` (header `X-IoT-Rule-Secret` = `IOT_RULE_SECRET`). `off` |
| `KVS_VIEWER_ROLE_ARN` | Role the browser assumes through FlyBot (STS, 15 min, policy limited to the one channel) to join as VIEWER. Empty: live view of CamOS cameras answers `503 LIVE_NOT_CONFIGURED` |
| `DEVICE_API_BASE_URL` | What the cameras call (default `APP_BASE_URL`) |
| `DEVICE_OTA_FW`, `DEVICE_OTA_URL`, `DEVICE_OTA_SHA256` | Firmware offered by `GET /api/device/ota` |
| `SELF_REGISTRATION`, `IOT_THING_TYPE`, `IOT_POLICY_NAME`, `REGISTER_MAX_PER_IP_HOUR` (5), `REGISTER_MAX_PER_HOUR` (60) | Zero-touch self-registration of the public firmware (`POST /api/device/register`, below) |
| `DEMO_MAX_CAMERAS_PER_USER` (3), `DEMO_MAX_SNAPSHOTS_PER_DAY` (48), `DEMO_MAX_UNCLAIMED` (200), `DEMO_LIVE_MINUTES` (5), `DEMO_EXEMPT_EMAILS` | Demo limits for self-registered cameras, read through `services/entitlements.js` (admins and the listed emails are exempt) |
| `DEVICE_DEFAULT_TIMEZONE` | Timezone of `GET /api/device/time` when neither farm, GPS nor IP tells (`Asia/Ho_Chi_Minh`) |
| `FLYBOT_SECRETS` | Comma-separated Secrets Manager secret names; each a JSON object (`JWT_SECRET`, `APP_KEY`, `SECRET_KEY`, `SMTP_PASS`, `TELEGRAM_BOT_TOKEN`, ...) filling in what the environment did not set. Read once at start-up with the instance role |
| `SENTINEL_CONSOLE` | `true` shows the Sentinel menu with another `AI_PROVIDER` (it is on with `opencv-lambda`) |
| `JWT_SECRET`, `APP_KEY`, `SECRET_KEY`, `VERTEX_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `SMTP_*`, `TELEGRAM_*` | As before (`.env.example`). `APP_KEY`/`SECRET_KEY` only matter for EZVIZ cameras; Vertex/Gemini only for the chatbot |

Self-registration additionally needs: `iot:CreateCertificateFromCsr`, `iot:CreateThing`, `iot:DescribeThing`, `iot:AttachPolicy`, `iot:AttachThingPrincipal`, `iot:DetachThingPrincipal`, `iot:DetachPolicy`, `iot:UpdateCertificate`, `iot:DeleteCertificate`, `iot:DeleteThing`, `kinesisvideo:DeleteSignalingChannel` (and `iam:PassRole` is not needed).

Instance role permissions FlyBot uses: `lambda:InvokeFunction` on the vision Lambda; `s3:GetObject/PutObject/DeleteObject/ListBucket` on the photo bucket; `iot:GetThingShadow`, `iot:UpdateThingShadow`, `iot:Publish` (`camos/*/rpc/req`), `iot:Connect`, `iot:Subscribe`, `iot:Receive`; `kinesisvideo:CreateSignalingChannel`, `DescribeSignalingChannel`, `GetSignalingChannelEndpoint`, `GetIceServerConfig`; `sts:AssumeRole` on `KVS_VIEWER_ROLE_ARN`; `secretsmanager:GetSecretValue` on `flybot-*`.

## Run it on a laptop (docker compose + the local Lambda)

1. Vision Lambda locally (flybot-aws): `cd lambda/vision && uv sync && uv run --env-file ../../.env python -m sentinel.lambda_local` → `http://localhost:9001/invoke`. With `PHOTOS_BY_REFERENCE=true` it reads photos from the S3 bucket with your `aws login --profile sentinel` session; with MinIO it reads the signed URL FlyBot sends.
2. `cd flybot-aws && cp .env.example .env`, then set: `DOMAIN_NAME=localhost`, `COOKIE_SECURE=false`, `APP_BASE_URL=http://localhost:8080`, `JWT_SECRET=<48 random chars>`, `VISION_LAMBDA_URL=http://host.docker.internal:9001/invoke`, `PHOTOS_BUCKET=<bucket>` and the three `AWS_*` credentials from `aws configure export-credentials --profile sentinel --format env` (12 h). For EZVIZ cameras also `APP_KEY` / `SECRET_KEY`.
3. `docker compose up -d --build mongo flybot` (the image builds the client and the server; arm64 and amd64). Open `http://localhost:8080`, register: the first account is the admin.
4. Add the two EZVIZ cameras (serial + verification code, trap kind **lure** for the orchard traps) or a CamOS camera (platform CamOS: you get the provisioning token for its portal). "Capture now" on an EZVIZ camera stores the photo, calls the local Lambda and shows the count; the Sentinel menu lists the trace.
5. Chatbot: "Why did the count on Lô A jump today?" → `analyze_photo_deep` → the Lambda's `deep` answer; its proposals become cards you confirm.

Without Docker: `npm install` at the repo root, `.env` at the root with the same values plus `MONGO_URI`, `npm run dev` (server :3003, client :3000).

## Run it on AWS

The SAM stack (flybot-aws `infra/deploy.sh`, agent L) creates the bucket, the Lambda, the IoT thing type/policy, the EC2 with its role and Elastic IP, and boots it with user-data that clones flybot-aws, writes `.env` and runs `docker compose up -d --build`. The owner points `flybot.agrhub.com` at the Elastic IP; Caddy obtains the certificate on first start.

Checks after a deploy: `curl -s https://flybot.agrhub.com/health` → `{"status":"ok"}`; `curl -s https://flybot.agrhub.com/api/device/time` → the time and the timezone (device API on); signed in as admin, `GET /api/system/info` → `info.ai.provider: "opencv-lambda"`, `info.sentinel.enabled: true`; a "Capture now" on an EZVIZ camera ends with a count and a trace in the Sentinel console. Logs: `docker compose logs -f flybot` on the host (`📡 IoT Core subscriber started`, `🤖 OpenCV Lambda processed snapshot ...`).

Update: `git -C /opt/flybot/flybot-aws pull --ff-only && git submodule update --init --recursive && docker compose up -d --build`.

## Public firmware: flash, register, claim

1. Flash the public release (GitHub Releases or the browser flasher). First boot: serial `ESP<MAC>`, a 6-character verify code kept in NVS, shown on the portal page and the label QR (`CAMOS:1;SN:...;VC:...;M:...;;`).
2. The camera generates its key pair and CSR, calls `POST https://flybot.agrhub.com/api/device/register`, stores the certificate and device token, connects to AWS IoT Core. It is **unclaimed**: 1 photo an hour, rule planner only, photos hidden and kept 24 h.
3. The person signs in (or registers) on FlyBot and opens `/claim` (the QR's `claimUrl`, or Cameras → **Claim a camera**), scans the label QR or types serial + code, picks lure/sticky, the farm and the schedule. The camera is theirs: shadow `claimed: true`, their interval, the farm's timezone (`tz`), and the first photo shows right away.
4. Not claimed within 7 days: the hourly job deletes the certificate, thing, channel and photos. Deleting a claimed camera in FlyBot does the same, so the device can register again.
5. Clock: `GET /api/device/time` (no auth) answers the time, the IANA timezone with its POSIX string for `setenv("TZ")`, where it came from (farm, GPS, IP, default) and the public IP.
6. Limits (demo plan): 3 claimed cameras per account, 48 photos per camera per day, 200 unclaimed cameras in total, 5 minutes per live request; admins and `DEMO_EXEMPT_EMAILS` are exempt.

Check on the server: `curl -s https://flybot.agrhub.com/api/device/time` → `{"timezone":"Asia/Ho_Chi_Minh",...,"tzSource":"ip"}`; `curl -s -X POST -H 'Content-Type: application/json' -d '{}' https://flybot.agrhub.com/api/device/register` → `400`.

## CamOS camera: from the box to a photo

1. In FlyBot: Cameras → Add → platform **CamOS**, the serial and the verification code printed on the label, trap kind. The dialog shows the provisioning token (24 h, once), FlyBot's address, the IoT endpoint and the channel name (`cam-<serial>`); "Settings → Provision again" makes a new token.
2. In the camera's setup portal (SoftAP `CAM-xxxx`, `http://192.168.4.1`): Wi-Fi/APN, the IoT endpoint, the device certificate and key (`infra/iot/provision-camera.sh`), FlyBot's address and the provisioning token.
3. The camera calls `POST /api/device/pair` once and receives its device token (stored hashed); then it uploads photos on its schedule (`POST /api/device/snapshot`, shadow `capture.intervalMin`), reports state/telemetry over MQTT, and sleeps. FlyBot shows "sleeping, next wake HH:MM"; "Request live at next wake" writes `live.requested` into its shadow.
4. Every uploaded photo goes through the same pipeline as an EZVIZ photo: storage, the Lambda, alerts, the `snapshot_analyzed` webhook, the Sentinel trace.

## How a judge logs in

1. Open `https://flybot.agrhub.com/auth/login` → **Register** with an email (public sign-up is on). New accounts have the role **user** (read-only). Confirm the email, or an admin confirms it: Admin → Users → the account (`PUT /api/admin/users/{id} {"emailVerified": true}`).
2. The owner of the orchard cameras shares them with the judge: Cameras → the trap → Share → the judge's email (`POST /api/user/camera/share`).
3. An admin turns on the Sentinel pages for the account: `PUT /api/admin/users/{id} {"sentinelViewer": true}` (or in mongosh `db.users.updateOne({email: "judge@..."}, {$set: {sentinelViewer: true}})`). The judge reloads: the **Sentinel** menu shows Overview, Traces, Approvals (read-only), Devices for the shared cameras; the camera pages show the photos, counts and the chatbot (`analyze_photo_deep` works for shared cameras; actions need manage rights the judge does not have).
4. After judging: `{"sentinelViewer": false}`, remove the shares, or disable the account.

## Tests

`npm test` at the repo root (server `node --test`, client `vitest`). Nothing calls AWS: the AWS clients are replaced with fakes (`server/src/platforms/aws.setClient`) and the Lambda with a local HTTP stub. On Windows with a full `C:` drive run the server tests with `TEMP=D:/some/dir` (mongodb-memory-server needs 500 MB free on the temp drive).

| File | Covers |
|---|---|
| `server/tests/platforms.test.js` | the adapter interface, EZVIZ unchanged, CamOS shadow/RPC/snapshot wait/messages/sleep, KVS channel + viewer config, the SigV4 WebSocket URL |
| `server/tests/deviceApi.test.js` | pair (hashed tokens), snapshot upload (limits, meta, pipeline), time, ota, the IoT-rule webhook |
| `server/tests/opencvLambda.test.js` | the CONTRACTS request, stored results, proposals → cards → confirm, retry after an error, deep mode, Lambda.Invoke |
| `server/tests/agentSentinelTools.test.js` | `analyze_photo_deep`, `propose_action` and every card action |
| `server/tests/sentinelUi.test.js` | the Sentinel console from MongoDB (access, summary, traces, approvals, devices, evidence) |

## Third-party data

- IP to country: `ip3country` (ISC), which "includes IP2Location LITE data available from https://lite.ip2location.com" (CC BY-SA 4.0). Keep this attribution wherever FlyBot's notices are shown.
- GPS to timezone: `@photostructure/tz-lookup` (CC0). Country to timezone: `countries-and-timezones` (MIT).
- IANA to POSIX TZ: `server/src/data/posixTz.json`, generated from Node's own tzdata (`node server/scripts/build_posix_tz.js`; run again after a Node upgrade).
