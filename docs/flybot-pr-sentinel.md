# PR: FlyBot Sentinel integration (`feat/sentinel` → `main`)

FlyBot Sentinel (OpenCV AI Competition 2026, repository flybot-sentinel) is an agent on AWS that looks at every
trap photo with OpenCV 5 and can ask FlyBot for an extra photo, a faster capture interval, a person's review,
or propose a card change / treatment that the owner confirms. This branch gives FlyBot the two doors it needs,
and puts Sentinel's operator console inside FlyBot (menu **Sentinel**) so growers and judges use one app.
Nothing in it acts on a farm by itself: proposals are confirm cards, and every Sentinel call is signed, budgeted
and audited.

`main` has not moved since the branch started (merge base `091b223`), so the branch merges without conflicts.

## What changes

| Commit | Change |
|---|---|
| `1f0c3ca` | `server/scripts/export_sentinel_dataset.js`: read-only export of photos, production boxes and reviews for evaluation and replay (excludes cameras listed by the caller) |
| `141cfa9` | Webhook event `snapshot_analyzed`: one event per analyzed photo (count, boxes, quality, presigned image link valid 1 h, previous photo, trap kind). Not an alert: no notification, no email. API.md "snapshot_analyzed" |
| `f3ed064` | Sentinel internal API `/api/sentinel/*` (HMAC-signed, English only): `capture` (daily budget per camera, quiet hours, 3/min), `capture-interval` (temporary, at most 72 h), `proposals` (the assistant's confirm card + Telegram Confirm/Reject; owner decides), `GET proposals/{id}`, `review-request`, `analysis` (stored under `aiResults.sentinel`). Optional `AI_PROVIDER=sentinel`. Audit category "FlyBot Sentinel" |
| `682346e` | The API accepts what the agent's client actually sends (found in the end-to-end check, flybot-sentinel `tests/test_flybot_e2e.py`): `X-FlyBot-*` signature headers as a fallback, `payload.reason`, string evidence (https link, photo id or a text reference, cut to 4 pictures first), the agent's treatment words (`bait_before_wave` → bait, `treat_now` → spray only with a product, else other), review-request extras (https links kept with the flag), analysis `estimates`, `null` counts dropped, bare `[x1,y1,x2,y2]` boxes. `tools/sentinel/dev-server.js`: a local FlyBot for the integration (in-memory MongoDB, EZVIZ and AI stubbed, fake S3 the Sentinel poller can read) |
| Sentinel console (server) | `/api/sentinel/ui/*`: proxy to the Sentinel UI API with the operator token kept on the server (allow-listed routes and query parameters, 5 s timeout, per-person limits, clean JSON errors, evidence pictures streamed by FlyBot). Decide: admins and managers, `by` set by FlyBot to the signed-in person. New `User.sentinelViewer` (read-only console for a "user" account, set by an admin). `/api/auth/me` and `/api/system/info` say `sentinelEnabled` / `sentinelCanDecide`. API.md "Sentinel console proxy" |
| Sentinel console (client) | The Sentinel pages ported into `client/` (A7's commit) |

Data: new collection `sentinelproposals`; new optional fields `Camera.sentinelCaptures`, `Camera.sentinelInterval`,
`Snapshot.trigger`, `Snapshot.aiResults.sentinel`, `Snapshot.review.requested`, `User.sentinelViewer`; webhook event list gains
`snapshot_analyzed`. No migration, nothing rewritten: `main` code ignores the new fields.

Tests: `npm test` green on the branch (16 Oct 2026): server 345 passed (332 + 13 for the console proxy).

## Settings

| Variable | Default | Production value |
|---|---|---|
| `SENTINEL_API_SECRET` | empty = `/api/sentinel` answers `503 SENTINEL_DISABLED` | The 64-hex key in flybot-sentinel `data/secrets/flybot-sentinel-api.env` (the same value is in the competition AWS account, Secrets Manager `sentinel-dev-flybot-sentinel-api`). Goes to Google Secret Manager as `flybot-sentinel-api-secret` (the deploy script's optional secret) |
| `SENTINEL_CAPTURE_BUDGET` | `4` | `4` (extra captures per camera per farm day; `0` turns capture off) |
| `SENTINEL_PROPOSAL_TTL_HOURS` | `24` | `24` |
| `SENTINEL_UI_URL` | empty = `/api/sentinel/ui` answers `503 SENTINEL_DISABLED`, Sentinel menu hidden | `https://scxxy5c2rf.execute-api.ap-southeast-2.amazonaws.com/ui` (stage dev; or the CloudFront `https://d146vb7dg01iax.cloudfront.net/ui`). Not a secret: `deploy/cloudrun.env.yaml` or `.env` |
| `SENTINEL_UI_TOKEN` | empty = same as above | The **operator** token, flybot-sentinel `data/secrets/ui-token.txt` (Secrets Manager `sentinel-dev-ui-token`). Google Secret Manager `flybot-sentinel-ui-token` (the deploy script's optional secret). Never the judge token: FlyBot enforces read-only itself. Rotating it on the Sentinel side (`ROTATE=operator make ui-token`) needs a new secret version here (`--update-secrets`) and a redeploy |
| `AI_PROVIDER` | `roboflow` in `deploy/cloudrun.env.yaml` | **keep `roboflow`**. Sentinel's counts are stored beside production's (`aiResults.sentinel`). `sentinel` would make Sentinel the only counter: not for production |

Nothing else changes (`ENABLE_CRON`, storage, Telegram as before).

## Rollout

1. Merge `feat/sentinel` into `main` (fast-forward is possible).
2. Add to `ezviz-manager/.env`: `SENTINEL_API_SECRET=<value from flybot-sentinel/data/secrets/flybot-sentinel-api.env>`,
   `SENTINEL_UI_URL=https://scxxy5c2rf.execute-api.ap-southeast-2.amazonaws.com/ui` and
   `SENTINEL_UI_TOKEN=<flybot-sentinel/data/secrets/ui-token.txt>` (`SENTINEL_UI_URL` may go in `deploy/cloudrun.env.yaml` instead).
   Check: `node deploy/deploy-cloudrun.js --check` shows "FlyBot Sentinel internal API: on" and "FlyBot Sentinel console: on".
3. Deploy with the usual script; `--update-secrets` is needed only if `flybot-sentinel-api-secret` already exists:
   ```bash
   ./deploy/deploy-cloudrun.sh --project PROJECT_ID --skip-setup          # Windows: deploy\deploy-cloudrun.bat ...
   ```
   The script creates the missing optional secret from `.env` and wires it into Cloud Run.
4. Checks after the deploy (DEPLOY.md "Checks after a deploy", plus):
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://ezviz.agrhub.com/api/sentinel/capture -H 'Content-Type: application/json' -d '{}'` → `401` (signed API on; `503` means the secret is not set).
   - Settings → API & Webhooks → Webhooks → the event list shows `snapshot_analyzed`.
   - Signed in as an admin: the **Sentinel** menu shows; `GET /api/sentinel/ui/summary` → `200` (`503 SENTINEL_DISABLED` = URL or token missing, `502 SENTINEL_AUTH` = wrong token).
5. Connect Sentinel (flybot-sentinel `docs/FLYBOT_INTEGRATION.md`, "After feat/sentinel is deployed"):
   `FLYBOT_TOKEN_FILE=~/.flybot-token bash camos_cloud/flybot-poller/register-flybot-webhook.sh` creates the
   webhook to Sentinel's receiver and stores its secret on AWS; redeploy the Sentinel stack with
   `FlyBotApiUrl=https://ezviz.agrhub.com`; turn the Sentinel poller off (same photos would arrive twice).
6. Watch for a day: Admin → Audit log, category "FlyBot Sentinel" (captures within budget, proposals waiting
   for Confirm); Settings → Webhooks → last status `200`.

## Judge account

Judges get an ordinary FlyBot account with the **user** role (FlyBot's viewer role: it views the cameras and
reports shared with it), the two orchard cameras shared with it, and the `sentinelViewer` switch for the Sentinel
pages. The user role already cannot reach Settings → API & Webhooks (`/api/integrations` is admin/manager only) or
Admin, cannot add, edit, share, delete or capture on cameras, and cannot approve or reject in Sentinel (`403`). The
switch only adds read access to the console, so no separate "judge" role is needed.

1. **Account.** The judge signs up at `https://ezviz.agrhub.com/auth/login` (Register) with their email and confirms
   it (public sign-up is on: `ALLOW_REGISTRATION=true`). New accounts get the role **user**. If the confirmation email
   does not arrive: Admin → Users → the account → confirm email (`PUT /api/admin/users/{id} {"emailVerified": true}`).
   Leave the role at **user**: it is the read-only one.
2. **Cameras.** The owner of the orchard traps (the manager account that owns BE4089629 and BE4111159) opens
   Cameras → each trap → Share and enters the judge's email (`POST /api/user/camera/share {"deviceSerial", "email"}`).
   A share to an unconfirmed address starts when the address is confirmed. Do not share AC6527557 (excluded camera).
3. **Sentinel pages.** An admin turns on `sentinelViewer` for the account. Until Admin → Users has a switch for it,
   use the API (the admin's session token is `localStorage.token` in the browser, valid 7 days; never commit or paste it):
   ```bash
   ADMIN_JWT=...
   ID=$(curl -s -H "Authorization: Bearer $ADMIN_JWT" "https://ezviz.agrhub.com/api/admin/users?q=judge@example.com" | jq -r '.users[0].id')
   curl -s -X PUT -H "Authorization: Bearer $ADMIN_JWT" -H 'Content-Type: application/json' \
        -d '{"sentinelViewer": true}' "https://ezviz.agrhub.com/api/admin/users/$ID" | jq '.user | {email, role, sentinelViewer}'
   ```
   (Or in mongosh: `db.users.updateOne({email: "judge@example.com"}, {$set: {sentinelViewer: true}})`.) The change is
   audited as `user.sentinel_access_changed`. The judge reloads the app: the **Sentinel** menu appears.
4. **Check** as the judge: the camera list shows the two traps only; Sentinel → Overview loads in read-only mode
   (`/summary` answers `role: "judge"`); Approvals shows no enabled Approve/Reject (the server answers `403` anyway).
5. **After the judging:** `{"sentinelViewer": false}`, remove the two shares, or disable the account (Admin → Users).

Notes: the Sentinel pages show every camera Sentinel knows (the two orchard traps, the bench AI camera
AIC54F29F5167FA and the simulated ones), not only the cameras shared with the judge; this is competition data, not
grower data. The judge can use the AI assistant on the shared cameras (10 messages a minute, 300 a day); its actions
need manage rights the judge does not have.

## Rollback

- **Stop Sentinel only** (no redeploy): remove the `snapshot_analyzed` webhook in Settings, and set
  `SENTINEL_API_SECRET` empty (`gcloud run services update flybot --region asia-southeast1 --remove-secrets SENTINEL_API_SECRET`
  or a new revision without it): `/api/sentinel` then answers `503`. Pending proposals expire by themselves.
- **Hide the Sentinel console only**: `--remove-secrets SENTINEL_UI_TOKEN` (or an empty `SENTINEL_UI_URL`): `/api/sentinel/ui` answers `503` and the menu disappears at the next reload.
- **Back to `main`**: route traffic to the previous revision
  (`gcloud run services update-traffic flybot --region asia-southeast1 --to-revisions PREVIOUS_REVISION=100`)
  or redeploy `main`. **Delete the `snapshot_analyzed` webhook first**: `main`'s webhook model does not know
  that event and would refuse to save that webhook's delivery status. The new fields and the
  `sentinelproposals` collection can stay (ignored by `main`).

## Checks done on the branch

- `npm test`: server 332/332, client 39/39 (Vitest, 10 files).
- `server/tests/sentinelApi.test.js` 15 tests, `snapshotAnalyzed.test.js`, `sentinelExport.test.js`.
- End to end against `tools/sentinel/dev-server.js` from flybot-sentinel (A2's Python client and EZVIZ adapter):
  6 tests passed with `AI_PROVIDER=roboflow` and with `AI_PROVIDER=sentinel` (capture and its signed
  `snapshot_analyzed`, capture interval, treatment proposal → confirm card in the owner's assistant history →
  Confirm → proposal `confirmed`, lure card change refused, review request listed, analysis stored, unsigned and
  replayed requests refused).
- The webhook path against Sentinel's real AWS receiver: a local FlyBot created the webhook with the script and
  its Test ping was answered `200` (signature accepted).
- Sentinel console proxy: `server/tests/sentinelUi.test.js` 13 tests (stub UI API: roles, allow-list, `by` forced, 503 when
  off, upstream errors, evidence streaming, the token never in an answer). Live against the stage-dev UI API through
  `tools/sentinel/dev-server.js` (operator token read from flybot-sentinel `data/secrets/ui-token.txt`, never printed):
  judge `summary` 200 with `role: judge` (admin: `operator`), `traces`, `traces/{id}`, `devices`, `devices/{serial}`,
  `approvals`, `density`, `bench` 200, one evidence frame 200 `image/jpeg` 21188 bytes, judge decide 403, manager
  decide on an unknown id 404 (no real approval decided), unknown path 404; no answer contained the token.
- Not done: anything against production (needs this deploy).
