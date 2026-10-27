# FlyBot API server

The FlyBot API server: cameras (EZVIZ, CamOS on AWS IoT Core, Kinesis Video Streams), insect counting (the OpenCV 5 vision Lambda, Roboflow or Vertex AI), photo storage on S3, alerts, reports, workspaces and plans, and the FlyBot assistant (Gemini on Vertex AI). Every setting is listed in the [README](../README.md#configuration).

## Running
```bash
npm install
npm run build
npm start
```

## Required configuration
Set these in the root `.env`:

- `JWT_SECRET`: at least 32 random characters. The server refuses to start without it.
- `MONGO_URI` and the photo bucket (`S3_BUCKET_NAME`, plus `S3_ENDPOINT` and keys for MinIO).
- For counting: `VISION_LAMBDA_NAME` (or `VISION_LAMBDA_URL`) with `AI_PROVIDER=opencv-lambda`, or `ROBOFLOW_API_KEY` with `AI_PROVIDER=roboflow`.
- For EZVIZ cameras: `APP_KEY` and `SECRET_KEY`. For CamOS cameras and live view: `AWS_REGION`, `IOT_ENDPOINT`, `KVS_VIEWER_ROLE_ARN`.

Optional:

- `COOKIE_SECURE=true` when served over HTTPS.
- `TRUST_PROXY=1` when running behind a reverse proxy, so rate limits see the real client IP.
- `CORS_ORIGINS`: comma-separated extra origins allowed to call the API.
- `ALLOW_REGISTRATION=false` to close public sign-up. Admins can also change this, the snapshot retention and the default alert threshold in Settings → System settings; saved values override the environment.

## Push notifications and the installable app
The web app can be installed (Chrome/Edge: install button in the address bar or Settings → Notifications; iPhone/iPad: Safari → Share → Add to Home Screen) and can show alerts on the device even when it is closed.
1. Create the key pair once and put it in the root `.env` (keep it: new keys cut off every device already subscribed):
   ```bash
   node scripts/generate_vapid_keys.js
   ```
   This prints `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (set a real `mailto:` address).
2. Users turn it on per device in Settings → Notifications → "Push notifications on this device".

Push needs HTTPS (or `localhost`). The alerts that are also emailed (pests, cameras going offline, failing AI analysis, card due, photo quality, harvest and weather, field-log reminders, the organization digest, firmware, a critical trap camera battery, a paused camera, upgrade requests), new shares and a finished firmware update are pushed; "back online" stays in-app. Signing out removes the device, so the next person on a shared phone does not get the previous account's alerts.

## Accounts, workspaces and sharing
- **System roles:** **admin** (everything: every workspace, every account, plans and system settings; the first account ever created), **support** (reads the admin pages) and **user**.
- **Workspaces:** every account has a personal workspace; organizations (made by an admin) have members who are **owner**, **manager** or **member**. Owners and managers add cameras, farms and reports to the workspace; members view them. The owner of a camera always manages it.
- **Plans:** each workspace is on FREE, PRO or ENTERPRISE, which set how many cameras, photos a day, deep analyses and members it may have. Admins edit the plans under Settings → Plans and approve upgrade requests under Settings → Upgrade requests.

A device serial can be registered only once. Others get access when the owner shares the camera by email (Settings → Camera management → Share). Sharing with an email that has no account sends an invitation; access starts once that person signs up and confirms the address.

When a database from an older version starts for the first time, it is moved to workspaces once (see [DEPLOY.md](../DEPLOY.md#upgrading-an-existing-database)); nothing is deleted.

Databases from before this change may hold the same serial on several accounts. The server logs a warning; merge them (the earliest record keeps ownership, the others are shared with) before the unique index can be built:
```bash
node scripts/merge_duplicate_cameras.js          # preview
node scripts/merge_duplicate_cameras.js --apply  # merge and build the index
```

## Daily statistics
Charts over days, weeks and months (Statistics, dashboards, comparison, diagnosis, the assistant) read a per-camera daily summary (`DailyStat`) instead of every snapshot. It is updated whenever a scan is analyzed or a result is corrected, and built from the existing history in the background the first time the server starts with background jobs on. Hourly charts (up to 7 days) still read snapshots. To rebuild it by hand (for example after restoring snapshots from a backup):
```bash
node scripts/rebuild_daily_stats.js
```

## Activity log
Sign-ins (including failed ones), password changes, account changes, camera and dashboard sharing, ownership transfers and system settings changes are recorded with the actor, IP and time. Admins see them in Settings → Activity log and can export CSV. Entries expire after 12 months (MongoDB TTL index). Verification codes and passwords are never recorded.

## Custom reports
Owners and managers of a workspace build reports (Reports in the sidebar) from widgets: key figures, daily trend, species, camera ranking and latest snapshots. A report can be shared by email (read-only) or published with a public link (`/d/<token>`, no sign-in). A public link only shows cameras the owner owns (an admin owner: any camera), and a new link can be created at any time to stop the old one.

## Email (password reset, email confirmation, alerts)
- `APP_BASE_URL`: public URL of the web app, used in email links (e.g. `https://flybot.example.com`). Required in production; links are never built from request headers.
- `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` (`true` for port 465), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (e.g. `FlyBot <no-reply@agrhub.com>`).
- Without `SMTP_HOST`, emails are printed to the server log in development (handy for testing reset links) and dropped in production.
- Google Workspace: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` = the sending mailbox, `SMTP_PASS` = an app password for it.
- Alert emails go only to users who confirmed their address and left email alerts on (Settings → Notifications).

## Telegram alerts
1. In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token and the bot username.
2. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` (without @).
3. Users connect in Settings → Notifications → "Connect Telegram", then press Start in the bot chat.

The bot receives messages by long polling on the instance with `ENABLE_CRON=true` (Telegram allows only one consumer per bot), so no public webhook is needed. Use a separate bot for development, otherwise your dev server and production will compete for updates.
