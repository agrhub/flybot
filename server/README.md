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
