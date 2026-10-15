# PR: FlyBot Sentinel integration (`feat/sentinel` → `main`)

FlyBot Sentinel (OpenCV AI Competition 2026, repository flybot-sentinel) is an agent on AWS that looks at every
trap photo with OpenCV 5 and can ask FlyBot for an extra photo, a faster capture interval, a person's review,
or propose a card change / treatment that the owner confirms. This branch gives FlyBot the two doors it needs.
Nothing in it acts on a farm by itself: proposals are confirm cards, and every Sentinel call is signed, budgeted
and audited.

`main` has not moved since the branch started (merge base `091b223`), so the branch merges without conflicts.

## What changes

| Commit | Change |
|---|---|
| `1f0c3ca` | `server/scripts/export_sentinel_dataset.js`: read-only export of photos, production boxes and reviews for evaluation and replay (excludes cameras listed by the caller) |
| `141cfa9` | Webhook event `snapshot_analyzed`: one event per analyzed photo (count, boxes, quality, presigned image link valid 1 h, previous photo, trap kind). Not an alert: no notification, no email. API.md "snapshot_analyzed" |
| `f3ed064` | Sentinel internal API `/api/sentinel/*` (HMAC-signed, English only): `capture` (daily budget per camera, quiet hours, 3/min), `capture-interval` (temporary, at most 72 h), `proposals` (the assistant's confirm card + Telegram Confirm/Reject; owner decides), `GET proposals/{id}`, `review-request`, `analysis` (stored under `aiResults.sentinel`). Optional `AI_PROVIDER=sentinel`. Audit category "FlyBot Sentinel" |
| this PR's last commit | The API accepts what the agent's client actually sends (found in the end-to-end check, flybot-sentinel `tests/test_flybot_e2e.py`): `X-FlyBot-*` signature headers as a fallback, `payload.reason`, string evidence (https link, photo id or a text reference, cut to 4 pictures first), the agent's treatment words (`bait_before_wave` → bait, `treat_now` → spray only with a product, else other), review-request extras (https links kept with the flag), analysis `estimates`, `null` counts dropped, bare `[x1,y1,x2,y2]` boxes. `tools/sentinel/dev-server.js`: a local FlyBot for the integration (in-memory MongoDB, EZVIZ and AI stubbed, fake S3 the Sentinel poller can read) |

Data: new collection `sentinelproposals`; new optional fields `Camera.sentinelCaptures`, `Camera.sentinelInterval`,
`Snapshot.trigger`, `Snapshot.aiResults.sentinel`, `Snapshot.review.requested`; webhook event list gains
`snapshot_analyzed`. No migration, nothing rewritten: `main` code ignores the new fields.

Tests: `npm test` green on the branch (15 Oct 2026): server 332 passed, client 39 passed.

## Settings

| Variable | Default | Production value |
|---|---|---|
| `SENTINEL_API_SECRET` | empty = `/api/sentinel` answers `503 SENTINEL_DISABLED` | The 64-hex key in flybot-sentinel `data/secrets/flybot-sentinel-api.env` (the same value is in the competition AWS account, Secrets Manager `sentinel-dev-flybot-sentinel-api`). Goes to Google Secret Manager as `flybot-sentinel-api-secret` (the deploy script's optional secret) |
| `SENTINEL_CAPTURE_BUDGET` | `4` | `4` (extra captures per camera per farm day; `0` turns capture off) |
| `SENTINEL_PROPOSAL_TTL_HOURS` | `24` | `24` |
| `AI_PROVIDER` | `roboflow` in `deploy/cloudrun.env.yaml` | **keep `roboflow`**. Sentinel's counts are stored beside production's (`aiResults.sentinel`). `sentinel` would make Sentinel the only counter: not for production |

Nothing else changes (`ENABLE_CRON`, storage, Telegram as before).

## Rollout

1. Merge `feat/sentinel` into `main` (fast-forward is possible).
2. Add to `ezviz-manager/.env`: `SENTINEL_API_SECRET=<value from flybot-sentinel/data/secrets/flybot-sentinel-api.env>`.
   Check: `node deploy/deploy-cloudrun.js --check` lists the optional secret.
3. Deploy with the usual script; `--update-secrets` is needed only if `flybot-sentinel-api-secret` already exists:
   ```bash
   ./deploy/deploy-cloudrun.sh --project PROJECT_ID --skip-setup          # Windows: deploy\deploy-cloudrun.bat ...
   ```
   The script creates the missing optional secret from `.env` and wires it into Cloud Run.
4. Checks after the deploy (DEPLOY.md "Checks after a deploy", plus):
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://ezviz.agrhub.com/api/sentinel/capture -H 'Content-Type: application/json' -d '{}'` → `401` (signed API on; `503` means the secret is not set).
   - Settings → API & Webhooks → Webhooks → the event list shows `snapshot_analyzed`.
5. Connect Sentinel (flybot-sentinel `docs/FLYBOT_INTEGRATION.md`, "After feat/sentinel is deployed"):
   `FLYBOT_TOKEN_FILE=~/.flybot-token bash camos_cloud/flybot-poller/register-flybot-webhook.sh` creates the
   webhook to Sentinel's receiver and stores its secret on AWS; redeploy the Sentinel stack with
   `FlyBotApiUrl=https://ezviz.agrhub.com`; turn the Sentinel poller off (same photos would arrive twice).
6. Watch for a day: Admin → Audit log, category "FlyBot Sentinel" (captures within budget, proposals waiting
   for Confirm); Settings → Webhooks → last status `200`.

## Rollback

- **Stop Sentinel only** (no redeploy): remove the `snapshot_analyzed` webhook in Settings, and set
  `SENTINEL_API_SECRET` empty (`gcloud run services update flybot --region asia-southeast1 --remove-secrets SENTINEL_API_SECRET`
  or a new revision without it): `/api/sentinel` then answers `503`. Pending proposals expire by themselves.
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
- Not done: anything against production (needs this deploy).
