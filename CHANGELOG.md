# Changelog

## 2026-10-12

### Catches and alerts
- Counts are now **flies caught per day** and **flies per trap per day** instead of the running total on the card. Each camera is a sticky trap (glue card: the day's rise) or a lure trap (no glue: the average per photo); days with a card change are left out.
- Lure traps alert on today's average per photo; sticky traps on the latest photo. Emails, Telegram and push notifications say which.
- Server messages follow the app language (Vietnamese or English).

### Overview, cameras and analytics
- Overview cards for today's catch, 7-day flies per trap per day against the week before and the risk against each trap's threshold; 14-day chart per trap; the latest analyzed photo of every trap.
- Camera page with a wide live view, SD-card playback on a timeline and a per-camera detection history.
- New **In-depth analysis** tab (per-trap table, daily catches, temperature against catches, catches by hour) with filters per block; detection history filters for several cameras, alert status and review status.
- Exports of every matching record: PDF with detection boxes, Excel with photos (one sheet per camera), corrected data for retraining.

### Reports
- "Custom dashboards" renamed **Reports**: 7 days to 12 months or custom ranges with comparison to the period before, new blocks, PDF export, share expiry, and scheduled weekly or monthly sending by email and Telegram.

### FlyBot assistant
- Rebuilt as an agent that looks up real data: catches, comparisons, alerts, cards due, treatment results, report summaries, camera and pipeline health.
- Streams its answers with photo, chart, comparison and report cards, formatted text (headings, lists, tables), and can open the right page.
- Looks at a photo on request, takes a new photo, emails a report, and proposes card changes or treatments that are saved only after you press **Confirm**.
- Keeps conversations for 7 days; rate answers as helpful or not. Morning brief at 06:30 by Telegram or email.

### Accounts, organizations and sharing
- Profile photo upload (cropped, resized, location data removed), shown in the top bar and in member, share and user lists to people who share something with you.
- Invitations to someone whose account exists but whose email is not confirmed show **Not confirmed**, with **Remind to confirm**; admins can confirm an address and filter the accounts that have not.
- The Vietnamese interface uses Vietnamese labels throughout.

### Guide and media
- In-app quick tour, a rewritten Guide with screenshots in both languages, and an 82-second product tour video in 1080p that starts playing right away.

### Reliability and speed
- Every call to EZVIZ, storage and AI has a time limit, so one stuck camera no longer stops the captures. Failed AI analyses are retried for 6 hours.
- Daily statistics are kept at least 25 months; old photos are deleted in batches and only after their file is gone from storage.
- Faster history filters, reports and overview (up to 15x on large histories). Admin **Capture pipeline** monitor.

### Operations
- `node deploy/deploy-cloudrun.js --check` reports what `.env` provides for production without calling gcloud.
- Cloud Run settings are generated from `.env` on every deploy; `deploy/cloudrun.env.yaml` is only the template.
- `GOOGLE_APPLICATION_CREDENTIALS` tolerates stray quotes and falls back to `gcp-service-account.json`.
