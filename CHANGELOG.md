# Changelog

## Unreleased

### FlyBot assistant
- Also answers which active ingredients worked best, how the farms compare, and whether the next 3 days suit fruit flies.

### Development
- Node.js 22.12 or later (Node 20 reached end of life in April 2026).
- vue-router 5, concurrently 10, AWS SDK 3.1146; the sign-in redirect is covered by the end-to-end test.

## 1.1.0 (2026-10-13)

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

### Field log (VietGAP)
- **Monthly VietGAP record**: turn it on under Settings, Notifications to get last month's pesticide use record as a PDF on the 1st at 07:00, by email and on Telegram. **Email last month** in the Field log sends it right away.
- **Pre-harvest intervals**: the overview lists areas still inside the interval after a treatment, with the time harvest is allowed; that morning at 06:00 everyone who sees the traps gets an **OK to harvest** notice in the app, by email, Telegram, push and webhook (`harvest_ready`).
- **Effect by active ingredient**: the Field log sums up every use of each active ingredient (or product): average change in flies per trap per day in the 7 days after, and how many uses clearly worked (a drop of 30% or more).

### Farms
- **Compare farms** at the top of Farms: each farm's flies per trap per day over 7, 30 or 90 days against the period before, a line per farm, its worst plot and its treatments; a row opens to its plots. For a cooperative that follows several growers.

### Weather outlook
- The degree-day panel shows the next 3 days with temperature, humidity and rain, and which of them suit fruit flies (25–33°C, humid, no heavy rain).
- When two or more such days come just as a new wave of adults is due, each farm gets a **weather warning** at 17:00 the day before (`weather_risk`), at most once a day.

### Works without signal
- The installed app opens in the field without a connection and shows the last data seen, with the time it was saved. Actions that need the network say so instead of failing silently. Saved data is cleared on sign-out.

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
- In-app quick tour, a rewritten Guide with screenshots in both languages, and a product tour video in 1080p that starts playing right away.
- Presentation decks export to PowerPoint in one step (`tools/media/prepare-deck-pptx.mjs`), in Arial, with the tour video linked rather than embedded (about 5 MB each); pictures are PNG so they show in Google Slides and Drive.

### Reliability and speed
- Every call to EZVIZ, storage and AI has a time limit, so one stuck camera no longer stops the captures. Failed AI analyses are retried for 6 hours.
- Daily statistics are kept at least 25 months; old photos are deleted in batches and only after their file is gone from storage.
- Faster history filters, reports and overview (up to 15x on large histories). Admin **Capture pipeline** monitor.

### Operations
- `node deploy/deploy-cloudrun.js --check` reports what `.env` provides for production without calling gcloud.
- Cloud Run settings are generated from `.env` on every deploy; `deploy/cloudrun.env.yaml` is only the template.
- `GOOGLE_APPLICATION_CREDENTIALS` tolerates stray quotes and falls back to `gcp-service-account.json`.
- The deploy stops if a tour video is only a Git LFS pointer (a checkout without git-lfs).

### Development
- Tests for the web app: Vitest unit and component tests (translations checked for missing keys and placeholders), and an end-to-end smoke test that opens every page of the demo in headless Chrome.
- GitHub Actions CI on every push and pull request: server tests, web app tests and build, end-to-end; failed tests show as annotations. Dependabot opens weekly update pull requests.
- Server tests never read the real `.env` (a guard test checks every test file).
- Tour videos and decks are stored in Git LFS.
- Test and build tools upgraded: `npm audit` reports no known vulnerability.
