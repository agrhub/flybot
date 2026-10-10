# EZVIZ Manager - Backend Server

Backend API service for EZVIZ camera management, AI insect detection (Vertex AI & Roboflow), and S3 snapshot storage.

## Running
```bash
npm install
npm run build
npm start
```

## Required configuration
Set these in the root `.env`:

- `JWT_SECRET`: at least 32 random characters. The server refuses to start without it.
- `MONGO_URI`, `APP_KEY`, `SECRET_KEY`, the `S3_*` settings, and `ROBOFLOW_API_KEY` when `AI_PROVIDER=roboflow`.

Optional:

- `COOKIE_SECURE=true` when served over HTTPS.
- `TRUST_PROXY=1` when running behind a reverse proxy, so rate limits see the real client IP.
- `CORS_ORIGINS`: comma-separated extra origins allowed to call the API.
- `ALLOW_REGISTRATION=false` to close public sign-up. Admins can also change this, the snapshot retention and the default alert threshold in Settings → System settings; saved values override the environment.

## Roles and sharing
- **admin**: everything: all cameras, all accounts (Settings → Users / All cameras) and system settings. The first account ever created is the admin.
- **manager**: adds cameras, edits, deletes and shares the cameras they own, builds dashboards.
- **user** (viewer): sees only cameras and dashboards shared with them.

A device serial can be registered only once. Others get access when the owner shares the camera by email (Settings → Camera management → Share). Sharing with an email that has no account sends an invitation; access starts once that person signs up and confirms the address.

On startup the server assigns roles to accounts created before roles existed: the earliest account becomes admin, accounts that own cameras become managers, the rest viewers.

Databases from before this change may hold the same serial on several accounts. The server logs a warning; merge them (the earliest record keeps ownership, the others are shared with) before the unique index can be built:
```bash
node scripts/merge_duplicate_cameras.js          # preview
node scripts/merge_duplicate_cameras.js --apply  # merge and build the index
```

## Custom dashboards
Admins and managers build dashboards (Dashboards in the sidebar) from widgets: key figures, daily trend, species, camera ranking and latest snapshots. A dashboard can be shared by email (read-only) or published with a public link (`/d/<token>`, no sign-in). A public link only shows cameras the owner owns (an admin owner: any camera), and a new link can be created at any time to stop the old one.

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
