# FlyBot on AWS

How FlyBot runs on AWS, what each AWS service does, the permissions it needs, and how to work on it from your computer. The one-command deployment itself lives in the **flybot-aws** repository (`./deploy.sh`); this page explains what it sets up for FlyBot. The deployment steps are in [DEPLOY.md](../DEPLOY.md).

## What runs where

| Part | AWS service | Notes |
|---|---|---|
| FlyBot (API and web app) | EC2 (Graviton, `t4g.small`), Node.js 22 under systemd | Built on your computer and shipped as a release archive through S3; the instance never builds anything |
| HTTPS | Caddy on the same instance | Automatic certificate for your domain |
| Database | MongoDB on the same instance | |
| Photos | Amazon S3, private bucket | Read and written with the instance role; photos reach the browser only through FlyBot's access checks |
| Counting and the vision agent | AWS Lambda (arm64 container, OpenCV 5) | `AI_PROVIDER=opencv-lambda`; FlyBot invokes it for every photo and for the assistant's deep analysis |
| Trap cameras | AWS IoT Core | Device Shadow (schedule, live view request, clock, remote settings such as Wi-Fi or 4G and the GPS satellites), RPC topics, connection events; certificates for self-registered cameras |
| Live view | Kinesis Video Streams WebRTC | One signaling channel per camera (`cam-<serial>`); the browser joins as viewer with 15-minute credentials |
| Secrets | AWS Secrets Manager | `FLYBOT_SECRETS` names the secrets FlyBot reads at start-up |

EZVIZ cameras, alerts, reports and the assistant work the same as anywhere else.

## Settings on AWS

flybot-aws writes the settings into the instance's environment. The ones that matter on AWS:

| Variable | Typical value | Meaning |
|---|---|---|
| `AI_PROVIDER` | `opencv-lambda` | Count with the vision Lambda |
| `VISION_LAMBDA_NAME` | `flybot-vision-<stage>` | The Lambda function |
| `S3_BUCKET_NAME` | the stack's photo bucket | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` stay empty: the instance role is used |
| `AWS_REGION` | the stack's region | Every AWS client uses it |
| `IOT_ENDPOINT` | `xxxxxxxx-ats.iot.<region>.amazonaws.com` | `aws iot describe-endpoint --endpoint-type iot:Data-ATS` |
| `IOT_EVENTS` | `mqtt` | FlyBot subscribes to the cameras' messages over MQTT/WebSocket (on the instance with `ENABLE_CRON=true`). `rule`: an IoT rule posts them to `POST /api/device/events` with `IOT_RULE_SECRET` instead |
| `KVS_VIEWER_ROLE_ARN` | the stack's viewer role | Without it, CamOS live view answers "not set up" |
| `FLYBOT_SECRETS` | `flybot-<stage>-app` | A Secrets Manager secret holding `JWT_SECRET`, `APP_KEY`, `SECRET_KEY`, `SMTP_PASS`, `TELEGRAM_BOT_TOKEN`... as JSON |
| `APP_MODE` | `hybrid` | Personal workspaces with open sign-up, organizations alongside |
| `PAYMENTS_ENABLED` | `false` until the providers are set up | Online payment of plans ([Payments](#payments)); the provider keys go in the `FLYBOT_SECRETS` secret |
| `TRUST_PROXY`, `COOKIE_SECURE` | `1`, `true` | Behind Caddy over HTTPS |

Every setting is listed in the [README](../README.md#configuration).

## Permissions of the instance role

| For | Actions |
|---|---|
| Counting | `lambda:InvokeFunction` on the vision Lambda |
| Photos | `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the photo bucket |
| Cameras | `iot:GetThingShadow`, `iot:UpdateThingShadow`, `iot:Publish` (RPC topics), `iot:Connect`, `iot:Subscribe`, `iot:Receive` |
| Self-registration | `iot:CreateCertificateFromCsr`, `iot:CreateThing`, `iot:DescribeThing`, `iot:AttachPolicy`, `iot:AttachThingPrincipal`, `iot:DetachThingPrincipal`, `iot:DetachPolicy`, `iot:UpdateCertificate`, `iot:DeleteCertificate`, `iot:DeleteThing` |
| Live view | `kinesisvideo:CreateSignalingChannel`, `DescribeSignalingChannel`, `GetSignalingChannelEndpoint`, `GetIceServerConfig`, `DeleteSignalingChannel`; `sts:AssumeRole` on the viewer role (which allows `kinesisvideo:ConnectAsViewer` on the cameras' channels) |
| Secrets | `secretsmanager:GetSecretValue` on the FlyBot secrets |

## CamOS cameras

### A camera with the public firmware (self-registration)

1. Flash the public firmware release. On first boot the camera picks its serial (`ESP` + its MAC) and a 6-character code, and shows both on its setup page and as a QR code.
2. It connects to the network, makes its own key pair, and registers with FlyBot (`POST /api/device/register`). FlyBot asks AWS IoT to sign the camera's certificate, creates its IoT thing and live view channel, and keeps it **unclaimed**: one photo an hour, analyzed but shown to nobody, deleted after 24 hours.
3. The grower signs in, opens **Cameras → Claim a camera** (or the link in the QR code), scans the QR or types the serial and code, and picks the trap kind (lure or sticky), the farm and the photo schedule. The camera is theirs at once; its first photo shows on the page, and at its next wake it takes the grower's schedule and the farm's time zone.
4. A camera nobody claims within 7 days is removed (certificate, IoT thing, channel and photos). Deleting a claimed camera does the same, so it can register again.
5. A claimed camera that lost its registration (its NVS was erased) can register again in place: an administrator calls `POST /api/admin/cameras/{serial}/reregister` with the camera's new code ([API.md](../API.md#administration)). The old certificate is revoked; the camera keeps its owner, farm, photos and history.

### A camera from your own fleet (pairing)

1. In FlyBot: **Cameras → Add camera**, platform **CamOS**, the serial and the code from the label, the trap kind. FlyBot shows a pairing token (valid 24 hours, shown once), its address, the AWS IoT endpoint and the live view channel.
2. In the camera's setup page (its own Wi-Fi `CAM-xxxx`, `http://192.168.4.1`): the network, the IoT endpoint, the device certificate, FlyBot's address and the pairing token.
3. The camera pairs once (`POST /api/device/pair`), then uploads photos on its schedule and sleeps in between. FlyBot shows "sleeping, next wake HH:MM"; **Request live at next wake** asks it to start live view when it wakes.

Every CamOS photo goes through the same steps as an EZVIZ photo: storage, counting, alerts, webhooks, the Sentinel screen.

### Clock and time zone

Cameras ask `GET /api/device/time` for the time, their time zone and its POSIX form. FlyBot takes the time zone from the camera's farm, else its last GPS position, else the country of its network address, else `DEVICE_DEFAULT_TIMEZONE`. When it changes (the camera is claimed into a farm, the farm's time zone is edited, the camera moves), FlyBot updates the camera's shadow.

## Payments

Workspace owners can pay for PRO or ENTERPRISE online. The step-by-step guide to the PayOS and Stripe accounts, keys and webhooks is [docs/payments.md](payments.md) ([tiếng Việt](payments.vi.md)); the behavior is in the [API reference](../API.md#payments). In short: **PayOS** (VietQR bank transfer, VND) and **Stripe** (cards, renews automatically). Use test keys everywhere except production, and keep every key out of git: `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` go in the `FLYBOT_SECRETS` secret. `APP_BASE_URL` must be the public address, because the providers send the buyer back to `<APP_BASE_URL>/billing/return`.

1. **Prices.** **Settings → Plans**: give each paid plan its price per month and per year, and per extra camera, in VND and/or USD. A plan without a price is not sold online and stays "Contact us".
2. **PayOS.** In my.payos.vn, create a payment channel linked to the bank account and copy its Client ID, API key and checksum key. Set its webhook to `https://<your domain>/api/payments/webhooks/payos` and confirm it. PayOS sends a sample payload, which FlyBot acknowledges. PayOS has no separate sandbox, so test on a dedicated channel with a small price.
3. **Stripe.** In test mode, copy the `sk_test_...` key. Add a webhook endpoint (payload format **Snapshot**) `https://<your domain>/api/payments/webhooks/stripe` for `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed` and `customer.subscription.deleted`, and copy its `whsec_...` secret. Pay with card `4242 4242 4242 4242`. Card `4000 0000 0000 0341` is accepted at checkout but fails later charges, which shows a failed renewal. On your computer, `stripe listen --forward-to localhost:3000/api/payments/webhooks/stripe` prints the `whsec_` to use.
4. **Turn it on.** Set `PAYMENTS_ENABLED=true` and restart. The pricing page shows the prices and a **Pay** button for workspace owners. **Settings → Plan & usage** shows the receipts and how the plan renews. **Settings → Revenue** shows what was paid, per currency, month, payment method and plan.
5. **Upgrade requests.** An administrator can approve a request with **Pay online**. The owner then sees **Pay now** next to the request, and the plan starts when the payment arrives.

A Stripe subscription renews by itself. With PayOS the owner pays each period, and FlyBot reminds them 7 days and 1 day before the end, and when the plan has ended (daily at 08:15). A failed or missing renewal keeps the plan for `PAYMENTS_GRACE_DAYS` (7). After that the workspace is on FREE, and its data is kept. A payment of the wrong amount waits in **Settings → Revenue** as "Being checked": settle it with the customer, then assign the plan by hand in **Settings → Workspaces**. With `APP_MODE=b2b` invoices stay manual and online payment is off.

To go live, put the live PayOS channel and the live Stripe keys and webhook secret in the secret, set `PAYMENTS_ALLOW_LIVE=true` on the production instance only, and restart. Without it, FlyBot refuses a live Stripe key.

## Working on it from your computer

1. Run the vision Lambda locally from flybot-aws (it answers `http://localhost:9001/invoke`); its README has the commands.
2. In FlyBot's `.env`: `AI_PROVIDER=opencv-lambda`, `VISION_LAMBDA_URL=http://localhost:9001/invoke`, and either MinIO (`S3_ENDPOINT`, keys, `PHOTOS_BY_REFERENCE=false`) or an S3 bucket with AWS credentials in the environment. For CamOS cameras and live view, also `AWS_REGION`, `IOT_ENDPOINT` and `KVS_VIEWER_ROLE_ARN`.
3. `npm run dev`, open `http://localhost:3000`, sign up (the first account is the administrator), add a camera and press **Capture now**: the count comes from the local Lambda, and the photo appears on the Sentinel screen.

No test calls AWS: `npm test` replaces the AWS clients with fakes and the Lambda with a local stub.

## Checks after a deploy

- `https://<your domain>/health` answers `{"status":"ok"}`.
- `https://<your domain>/api/device/time` answers the time and a time zone (the camera API is up).
- Signed in as the administrator, **Settings → Capture pipeline** shows the background jobs running, and **Capture now** on a camera ends with a count and an entry on the Sentinel screen.
- On the instance: `systemctl status flybot caddy mongod`, and `journalctl -u flybot -f` for the server log (it reports when the IoT Core subscriber starts and each photo the Lambda counts).

## Read-only reviewer accounts

To let someone look without changing anything (an auditor, a partner): they sign up, the camera owner shares the cameras with their email, and an administrator turns on `sentinelViewer` for the account (`PUT /api/admin/users/{id}` with `{"sentinelViewer": true}`; there is no switch for it in the app yet). They see the photos, counts and the Sentinel screen for the shared cameras, but cannot decide proposals or change cameras. Turn it off, or remove the shares, when they are done.

## Third-party data

- Network address to country: `ip3country` (ISC), which includes IP2Location LITE data available from https://lite.ip2location.com (CC BY-SA 4.0). Keep this attribution with FlyBot's notices.
- GPS position to time zone: `@photostructure/tz-lookup` (CC0). Country to time zone: `countries-and-timezones` (MIT).
- Time zone rules for the cameras: `server/src/data/posixTz.json`, generated from Node's time zone data (`node server/scripts/build_posix_tz.js`; run it again after a Node upgrade).
