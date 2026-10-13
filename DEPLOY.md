# Deploying FlyBot

One Docker image (`Dockerfile`) runs on both targets. The server serves the API and the built Vue client on one port.

| | Cloud Run | Compute Engine VM |
|---|---|---|
| Build and run | `cloudbuild.yaml` | `compose.yaml` |
| Restart after a crash | Automatic | `restart: unless-stopped` |
| Config | `deploy/cloudrun.env.yaml` + Secret Manager | `.env` on the VM |
| HTTPS | Built in | Needs a load balancer or a reverse proxy (Caddy/nginx) |

> **Run the background jobs in one place only.** If both deployments use the same MongoDB, set `ENABLE_CRON=false` on one of them. Otherwise snapshots get captured and analyzed twice.

## Cloud Run: automated deploy script

The scripts below do everything in the Cloud Run sections that follow: enable APIs, create the service account, repository, permissions and secrets, generate the Cloud Run settings from `deploy/cloudrun.env.yaml` and `.env`, build, deploy and check `/health`. They are safe to re-run; anything that already exists is skipped.

Requirements: Node.js, and the Google Cloud CLI logged in with `gcloud auth login`.

```bash
./deploy/deploy-cloudrun.sh --project PROJECT_ID
```

On Windows (cmd or PowerShell):

```bat
deploy\deploy-cloudrun.bat --project PROJECT_ID
```

| Option | Effect |
|---|---|
| `--project ID` | GCP project (default: the current `gcloud config` project) |
| `--region REGION` | Default `asia-southeast1` |
| `--env-file PATH` | Where to read settings and secrets from (default `./.env`) |
| `--update-secrets` | Push the current `.env` values as new secret versions. Without it, existing secrets are left unchanged. |
| `--skip-setup` | Skip the one-time setup checks, for faster redeploys |
| `--dry-run` | Show the changes without making them. Read-only `gcloud` checks still run. |
| `--yes` | Don't ask for confirmation |
| `--check` | Only report what `.env` gives production: required values, the Cloud Run settings and which optional features (email, Telegram, push, maps, AI) are on. Runs no `gcloud` and writes nothing; exits with 1 if something blocks a deploy. |

Secret values go to `gcloud` through stdin, never on the command line. The script stops before changing anything if `.env` is missing a required value or `MONGO_URI`/`S3_ENDPOINT` point to `localhost`.

The manual steps below do the same thing by hand.

## Google Cloud setup (once)

Replace `PROJECT_ID` with your project. Region `asia-southeast1` (Singapore) is the closest to Vietnam; change `_REGION` in `cloudbuild.yaml` if you pick another.

```bash
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com
```

### Runtime service account
The app reaches Vertex AI through this account, so no JSON key file is needed.

```bash
gcloud iam service-accounts create flybot-run
gcloud projects add-iam-policy-binding PROJECT_ID --member=serviceAccount:flybot-run@PROJECT_ID.iam.gserviceaccount.com --role=roles/aiplatform.user
gcloud projects add-iam-policy-binding PROJECT_ID --member=serviceAccount:flybot-run@PROJECT_ID.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
```

## Cloud Run

### 1. Image repository
```bash
gcloud artifacts repositories create flybot --repository-format=docker --location=asia-southeast1
```

### 2. Secrets
Create one secret per value, copying each value from your `.env`. Typing values at the prompt keeps them out of your shell history:

```bash
for name in flybot-jwt-secret flybot-mongo-uri flybot-ezviz-app-key flybot-ezviz-secret-key flybot-s3-access-key flybot-s3-secret-key flybot-roboflow-api-key; do
  read -rsp "$name: " value; echo
  printf '%s' "$value" | gcloud secrets create "$name" --data-file=-
done
```

| Secret | `.env` variable |
|---|---|
| `flybot-jwt-secret` | `JWT_SECRET` |
| `flybot-mongo-uri` | `MONGO_URI` |
| `flybot-ezviz-app-key` | `APP_KEY` |
| `flybot-ezviz-secret-key` | `SECRET_KEY` |
| `flybot-s3-access-key` | `S3_ACCESS_KEY` |
| `flybot-s3-secret-key` | `S3_SECRET_KEY` |
| `flybot-roboflow-api-key` | `ROBOFLOW_API_KEY` |
| `flybot-smtp-pass` (optional) | `SMTP_PASS`, only needed when sending email |
| `flybot-telegram-bot-token` (optional) | `TELEGRAM_BOT_TOKEN`, only needed for Telegram alerts |
| `flybot-roboflow-upload-key` (optional) | `ROBOFLOW_UPLOAD_API_KEY`, only needed for retraining uploads |

To change a secret later, run `gcloud secrets versions add NAME --data-file=-`, then redeploy.

### 3. Cloud Build permissions
The build's deploy step needs to manage Cloud Run and act as the runtime account:

```bash
PROJECT_NUMBER=$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')
CB=serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com
gcloud projects add-iam-policy-binding PROJECT_ID --member=$CB --role=roles/run.admin
gcloud iam service-accounts add-iam-policy-binding flybot-run@PROJECT_ID.iam.gserviceaccount.com --member=$CB --role=roles/iam.serviceAccountUser
```

Newer projects may run builds as the Compute Engine default service account instead (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`). If the deploy step fails with a permission error, grant the same roles to that account.

### 4. Settings
`deploy/cloudrun.env.yaml` lists the non-secret settings Cloud Run gets, with defaults. On every run the deploy script writes `deploy/cloudrun.env.generated.yaml` (ignored by git, uploaded to Cloud Build) with each of these keys taken from `.env` when it is set there, otherwise from the template; `.env` changes reach the next deploy without editing anything. A `TODO` value must be set in one of the two.

The deploy-specific keys `NODE_ENV`, `APP_BASE_URL`, `COOKIE_SECURE`, `TRUST_PROXY`, `ENABLE_CRON` and `ALLOW_REGISTRATION` always come from the template, since the local `.env` holds development values for them. Secrets never go in either file. Deploying by hand with `gcloud builds submit`, fill the `TODO` values in the template itself (it is the default `_ENV_VARS_FILE`).

For email (password reset, email confirmation, alert emails), fill `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER` and `MAIL_FROM`, and store `SMTP_PASS` as the `flybot-smtp-pass` secret. Then add `,SMTP_PASS=flybot-smtp-pass:latest` to `_EXTRA_SECRETS`. The deploy script does all of this from `.env`. `APP_BASE_URL` must be the public URL of the app; the deploy script sets it to the Cloud Run URL when it is empty.

To send reviewed photos to Roboflow for retraining, set `ROBOFLOW_UPLOAD_PROJECT` to the project ID (the dataset slug in the project URL) and `ROBOFLOW_UPLOAD_CLASS` to its class name (default `fruit_fly`). Uploads need the workspace's **private** API key. If `ROBOFLOW_API_KEY` is a publishable key, set `ROBOFLOW_UPLOAD_API_KEY` too: the deploy script stores it as the `flybot-roboflow-upload-key` secret (by hand: add `,ROBOFLOW_UPLOAD_API_KEY=flybot-roboflow-upload-key:latest` to `_EXTRA_SECRETS`). An admin then turns it on under Settings → System.

### 5. Deploy
```bash
gcloud builds submit --config cloudbuild.yaml --substitutions=_MAPS_KEY=YOUR_BROWSER_MAPS_KEY
```

This builds the image, pushes it, and deploys it. The service runs as **exactly one always-on instance** (`--min-instances=1 --max-instances=1 --no-cpu-throttling`). It has to:
- the cron jobs (status sync every minute, capture every 30 minutes, cleanup every hour) only run while CPU is allocated
- login rate limits, AI chat history and live-stream sessions are kept in memory, so they only work within one instance

Restrict the Maps key to your Cloud Run URL or domain under **APIs & Services → Credentials**. It is visible to every browser that loads the page.

## Compute Engine VM

### 1. Create the VM
Attach the `flybot-run` service account so Vertex AI works without a key file:

```bash
gcloud compute instances create flybot-vm --zone=asia-southeast1-b --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --service-account=flybot-run@PROJECT_ID.iam.gserviceaccount.com --scopes=cloud-platform \
  --tags=http-server,https-server
```

### 2. Install Docker
On the VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out and back in
```

### 3. Get the code and config
Clone the repository, then create `.env` next to `compose.yaml`. Use the same keys as your local `.env` (compose.yaml always sets `NODE_ENV=production`), and set `APP_BASE_URL` to the public address, plus:

```env
# Random, 64+ characters. Use the same value as Cloud Run only if logins should work on both.
JWT_SECRET=...
# Only once HTTPS is in front; leave unset for plain-HTTP testing
COOKIE_SECURE=true
# Only when behind a load balancer or reverse proxy
TRUST_PROXY=1
# If Cloud Run already runs the jobs against the same database
ENABLE_CRON=false
# Port exposed on the VM (default 3000)
HOST_PORT=80
```

Put comments on their own lines. Docker Compose does not reliably strip comments at the end of a value.

Also set `APP_BASE_URL` to the public URL of the VM (used in email links) and the `SMTP_*` settings to send email; see `server/README.md`.

Leave out `GOOGLE_APPLICATION_CREDENTIALS`; the attached service account is used instead. Keep the file private with `chmod 600 .env`.

### 4. Start
```bash
docker compose up -d --build
docker compose logs -f
```

Docker restarts the container after a crash or a VM reboot. The health check calls `/health` every 30 seconds.

To update:
```bash
git pull && docker compose up -d --build
```

### 5. HTTPS
Cloud Run gives you HTTPS automatically; the VM does not. Either put a Google Cloud load balancer with a managed certificate in front of it, or run Caddy on the VM as a reverse proxy to `localhost:3000`. Caddy obtains certificates automatically. Then set `COOKIE_SECURE=true` and `TRUST_PROXY=1`.

## Checks after a deploy
- `GET /health` returns `{"status":"ok"}`.
- Logging in works, and camera snapshot images load. Images need the login cookie, so if they fail on plain HTTP, check that `COOKIE_SECURE` is not `true`.
- The logs show `⏰ Periodic Cron jobs initialized.` on exactly one deployment.
- After upgrading an existing database: if the logs warn about duplicate camera serials, run `node scripts/merge_duplicate_cameras.js --apply` once (see `server/README.md`, Roles and sharing).
- After upgrading: the old single-field index `deviceSerial_1` on `snapshots` is no longer used (replaced by `{deviceSerial, createdAt}`). It can be dropped to save space and write time: `db.snapshots.dropIndex("deviceSerial_1")`.
- Optional, once: `node scripts/find_orphan_files.js --out orphans.txt` (from `server/`) lists photo files in S3 that no snapshot points to, from captures whose database save failed before this was handled. It only reports; nothing is deleted.

## Known risks (accepted for now)
- **EZVIZ account token reaches viewers unless `EZVIZ_RAM_TOKENS=true`.** The EZUIKit player in the browser needs an EZVIZ access token. By default, live view and playback (`POST /api/live`, `/api/playback`) hand out the app account's token. Anyone who can watch any camera can read it and call the EZVIZ Open API directly, with access to **every** device in the account (list, live, settings, delete).
  With `EZVIZ_RAM_TOKENS=true`, each non-admin user gets an EZVIZ sub-account (RAM) whose policy allows only view, live and playback of the cameras they may see, and the browser gets that sub-account's token. The policy is updated before each token is handed out and by an hourly job, so removed access ends within an hour. If the sub-account calls fail, video is refused rather than falling back to the app token.
  This was built from the EZVIZ Open API documentation and **has not been tried against a real EZVIZ account**. To turn it on:
  1. Set the variable and redeploy.
  2. Open a camera's live view as a non-admin user. If it plays, the sub-account was created.
  3. In the browser's network tab, copy the `accessToken` from the `/api/live` answer. Check it can only see that user's cameras, for example with `POST /api/lapp/device/list` on the EZVIZ API.
  4. If video fails, the server log shows `EZVIZ sub-account token failed` with the EZVIZ error code.
- **Viewers can see a camera's verification code.** Encrypted streams are decrypted in the browser, so the live/playback response includes the code. Change the code on the device if you remove someone's access to an encrypted camera.
- **Rate limits are per instance.** Login, chat, share and capture limits live in memory. `cloudbuild.yaml` pins Cloud Run to one instance (`--max-instances=1`); raising it multiplies every limit unless they move to a shared store.
- **Snapshot bucket must be private.** Images are served through `/api/s3` with access checks; a public bucket or public `S3_PUBLIC_URL` would bypass them, since object keys are predictable.
- **Public dashboards are cached for 60 s.** After a camera is transferred or its share removed, a public link can show it for up to a minute.
