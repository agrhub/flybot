# Changelog

## 1.5.0 (2026-10-14)

### What to do next
- **To do** on the dashboard: one suggestion per plot from simple rules: treat now when traps are at their threshold and nothing was done in the past week, check the effect after a recent treatment, bait a few days before the next fly generation (degree-days), sanitation when the weather favors flies. Dates skip days with heavy rain, and a reminder to change the active ingredient comes when the last two sprays used the same one. The morning brief carries the most urgent suggestion; the assistant answers "when should I spray" from it (get_spray_plan). GET /api/farms/plan.
- On each suggestion, **Done** opens the field log form filled in (the plot's traps, the measure, the area) and **Later** hides it for the rest of the day on that device.

### For administrators
- **Usage** (Settings, administration): people active over 7 and 30 days, accounts, the features used over the last 30 days (log entries by form, assistant and import, card changes, assistant questions, data downloads, cooperative reminders and reports), the cameras, and twelve weeks of active people, log entries and photos. Counted from what FlyBot already stores; no outside tracking, no content. GET /api/admin/usage.

### Guide and tour
- A **Cooperatives** section in the guide: setting up the organization and inviting growers, bringing their traps in, following them up and reminding them, their field logs, and the report for the board (Vietnamese and English, with pictures).
- The farm picture in the guide shows a farm's plots again (it had shown the farm list since the cooperative cards were added).
- The tour videos (99 s) show the To do card, the cooperative overview, the log import and voice logging; the guide pictures show the To do card.

### Code
- One flies-per-trap-per-day helper, one report PDF kit and one change tag replace their copies.

### Security
- A grower who left a cooperative is no longer reminded or listed for a visit; their cameras left in the organization still count in its figures and are marked "Left the organization".
- "Download all my data" waits for a slow connection instead of holding the archive in memory, and stops when the download is closed.
- More access tests: another organization cannot see, remind or report one it is not in; a camera shared for viewing only cannot take an imported log.

## 1.4.0 (2026-10-14)

### Cooperatives
- **Cooperative overview** (Farms, for organization owners and managers): one row per member with flies per trap per day against the period before (7 or 30 days), traps at their threshold, cameras without a photo for a day and the last treatment. Members with traps at the threshold and no treatment logged in the period come first, for a field visit. Exports to Excel.
- **Reminders**: from the cooperative overview, "Remind" asks a member to check their traps and log their work (in the app, by email and Telegram; once a day each). Owners and managers get the list of members to visit on Monday mornings (Settings, Notifications to turn it off).
- **Cooperative report (PDF)** at the bottom of the overview: for a chosen period, the members ranked by flies per trap per day against the period before, month by month, the effect by active ingredient across members and their treatment record; downloaded or emailed.

### Field log
- **Log by voice**: a microphone in the assistant box (browsers with speech recognition). Say "this morning I sprayed Radiant on mango plot A, 7 days pre-harvest": the assistant finds the plot's traps and fills a card with the product, area and pre-harvest interval to Confirm. The words only fill the box; nothing is sent until you press Send.
- **Import from file**: an Excel (.xlsx) or CSV file of past treatments, with a template. Columns and values in Vietnamese or English, traps by name or serial; every row is checked and previewed, rows already in the log are skipped, up to 500 rows at a time.

### Speed and reliability
- The dashboard overview runs its queries at the same time and counts photos from the daily rollup: with 20 traps and a year of photos, about 1-2 s down to 0.4-0.6 s.
- The end-to-end test no longer hangs: a dead Chrome or a navigation left unanswered fails at once, and a cold dev server is warmed up first.
- The guide has pictures of the cooperative overview, the log import and voice logging.

## 1.3.0 (2026-10-13)

### Works without signal
- A treatment in the Field log or a card change recorded without signal is kept on the device and sent when the network is back; a bar at the top shows what is waiting, and anything the server refused with its reason. Each carries an id, so a send that did arrive but lost its answer is never recorded twice.

### Organizations
- **Invite many**: paste a list of email addresses or pick a CSV file to invite a whole cooperative at once (up to 50 addresses each time, 100 invitations a day per person), with the result for each address.

### Your data
- Settings, Personal info: **Download all my data** gives one ZIP file with your cameras, farms and plots, daily counts, the analysis of every photo, treatments, trap changes, reports and assistant conversations (CSV tables and JSON). Values a spreadsheet would run as a formula are escaped; 3 downloads an hour.

### Accessibility
- The main pages pass the automatic WCAG 2.1 AA checks (axe-core) in light and dark mode, now part of the end-to-end test.
- Light mode uses deeper theme colors (green, amber, red, grey) so text reaches 4.5:1 contrast; in dark mode, text on the mint green is dark.
- Icon-only buttons, switches, drop-downs and progress bars have names a screen reader reads out; the page language follows the chosen language.
- Trap cards, map entries, notifications, report cards and photos open from the keyboard (Tab, then Enter or Space) and show where the focus is; the Settings menu and the avatar upload are one control each.
- The recording timeline is a slider: arrows play the previous or next clip, Page Up / Down jump an hour, Home / End go to the first or last clip.
- The sidebar tag under the logo is a short description in the chosen language ("Giám sát côn trùng" / "Insect monitoring") instead of "STUDIO".
- The guide pictures and both tour videos show the new colors.

## 1.2.0 (2026-10-13)

### Season report
- **Season report** on Farms: one PDF for a chosen period (6 months by default, up to a year), downloaded or emailed: each farm's flies per trap per day, month by month, its worst plot and busiest days, the effect of each active ingredient, and the treatment record (VietGAP) as an appendix.

### Alert thresholds
- Settings, Notifications: under each camera a threshold suggested from its last 30 days (the 90th percentile of the figure its alert compares), with how many days the current and the suggested one were reached, and an **Apply** button.

### Security and speed
- The farm comparison and the effect by ingredient are rate-limited per person; asking for a camera you cannot see is always refused.
- Effect by ingredient reads the daily figures once instead of per treatment: 23 s to 0.4 s with 200 treatments.

### Exports
- **Export Excel** for the farm comparison (a sheet for farms, one for plots) and for the effect by active ingredient, for cooperatives to send on.

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
