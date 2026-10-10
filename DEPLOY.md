# Deploying CamHub

One Docker image (`Dockerfile`) runs on both targets. The server serves the API and the built Vue client on one port.

| | Cloud Run | Compute Engine VM |
|---|---|---|
| Build and run | `cloudbuild.yaml` | `compose.yaml` |
| Restart after a crash | Automatic | `restart: unless-stopped` |
| Config | `deploy/cloudrun.env.yaml` + Secret Manager | `.env` on the VM |
| HTTPS | Built in | Needs a load balancer or a reverse proxy (Caddy/nginx) |

> **Run the background jobs in one place only.** If both deployments use the same MongoDB, set `ENABLE_CRON=false` on one of them. Otherwise snapshots get captured and analyzed twice.

## Cloud Run: automated deploy script

The scripts below do everything in the Cloud Run sections that follow: enable APIs, create the service account, repository, permissions and secrets, fill `deploy/cloudrun.env.yaml` from `.env`, build, deploy and check `/health`. They are safe to re-run; anything that already exists is skipped.

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
gcloud iam service-accounts create camhub-run
gcloud projects add-iam-policy-binding PROJECT_ID --member=serviceAccount:camhub-run@PROJECT_ID.iam.gserviceaccount.com --role=roles/aiplatform.user
gcloud projects add-iam-policy-binding PROJECT_ID --member=serviceAccount:camhub-run@PROJECT_ID.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
```

## Cloud Run

### 1. Image repository
```bash
gcloud artifacts repositories create camhub --repository-format=docker --location=asia-southeast1
```

### 2. Secrets
Create one secret per value, copying each value from your `.env`. Typing values at the prompt keeps them out of your shell history:

```bash
for name in camhub-jwt-secret camhub-mongo-uri camhub-ezviz-app-key camhub-ezviz-secret-key camhub-s3-access-key camhub-s3-secret-key camhub-roboflow-api-key; do
  read -rsp "$name: " value; echo
  printf '%s' "$value" | gcloud secrets create "$name" --data-file=-
done
```

| Secret | `.env` variable |
|---|---|
| `camhub-jwt-secret` | `JWT_SECRET` |
| `camhub-mongo-uri` | `MONGO_URI` |
| `camhub-ezviz-app-key` | `APP_KEY` |
| `camhub-ezviz-secret-key` | `SECRET_KEY` |
| `camhub-s3-access-key` | `S3_ACCESS_KEY` |
| `camhub-s3-secret-key` | `S3_SECRET_KEY` |
| `camhub-roboflow-api-key` | `ROBOFLOW_API_KEY` |
| `camhub-smtp-pass` (optional) | `SMTP_PASS`, only needed when sending email |

To change a secret later, run `gcloud secrets versions add NAME --data-file=-`, then redeploy.

### 3. Cloud Build permissions
The build's deploy step needs to manage Cloud Run and act as the runtime account:

```bash
PROJECT_NUMBER=$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')
CB=serviceAccount:$PROJECT_NUMBER@cloudbuild.gserviceaccount.com
gcloud projects add-iam-policy-binding PROJECT_ID --member=$CB --role=roles/run.admin
gcloud iam service-accounts add-iam-policy-binding camhub-run@PROJECT_ID.iam.gserviceaccount.com --member=$CB --role=roles/iam.serviceAccountUser
```

Newer projects may run builds as the Compute Engine default service account instead (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`). If the deploy step fails with a permission error, grant the same roles to that account.

### 4. Settings
Fill in the `TODO` values in `deploy/cloudrun.env.yaml`. Everything in that file is non-secret.

For email (password reset, email confirmation, alert emails), fill `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER` and `MAIL_FROM`, and store `SMTP_PASS` as the `camhub-smtp-pass` secret. Then add `,SMTP_PASS=camhub-smtp-pass:latest` to `_EXTRA_SECRETS`. The deploy script does all of this from `.env`. `APP_BASE_URL` must be the public URL of the app; the deploy script sets it to the Cloud Run URL when it is empty.

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
Attach the `camhub-run` service account so Vertex AI works without a key file:

```bash
gcloud compute instances create camhub-vm --zone=asia-southeast1-b --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --service-account=camhub-run@PROJECT_ID.iam.gserviceaccount.com --scopes=cloud-platform \
  --tags=http-server,https-server
```

### 2. Install Docker
On the VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out and back in
```

### 3. Get the code and config
Clone the repository, then create `.env` next to `compose.yaml`. Use the same keys as your local `.env`, plus:

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
