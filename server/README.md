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
- `ALLOW_REGISTRATION=false` to close public sign-up.

## Email (password reset, email confirmation, alerts)
- `APP_BASE_URL`: public URL of the web app, used in email links (e.g. `https://flybot.example.com`). Required in production; links are never built from request headers.
- `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` (`true` for port 465), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (e.g. `FlyBot <no-reply@agrhub.com>`).
- Without `SMTP_HOST`, emails are printed to the server log in development (handy for testing reset links) and dropped in production.
- Google Workspace: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` = the sending mailbox, `SMTP_PASS` = an app password for it.
- Alert emails go only to users who confirmed their address and left email alerts on (Settings → Notifications).
