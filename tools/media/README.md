# Guide screenshots and product tour

Scripts that rebuild the screenshots of the user guide (`client/public/manual/vi|en/*.webp`) and the product tour videos (`client/public/media/flybot-tour-vi|en.mp4`) from a local demo. Run them again whenever the UI changes.

Nothing here touches a real database or external service. The demo API uses an in-memory MongoDB with seeded farms, cameras and photos. EZVIZ, S3, mail, Telegram and AI calls are stubbed, and every key from `.env` is blanked.

## Requirements

- `npm install` at the repository root.
- Google Chrome. Set `CHROME_PATH` if it is not at `C:/Program Files/Google/Chrome/Application/chrome.exe`.
- About 500 MB free for MongoDB. `FLYBOT_DEMO_DB` sets the data folder (default: the system temp folder). It is wiped on every start. `FLYBOT_SHOT_PROFILE` sets the throwaway Chrome profile folder.

## Steps

From this folder:

```bash
# 1. Demo API on :3013 (Vietnamese data; DEMO_LANG=en for English data)
node demo-server.js

# 2. In another terminal: the client on :3010, proxying /api to the demo
node demo-client.mjs

# 3. Screenshots: <outdir> <names|all> <vi|en>
node shoot.mjs shots all vi

# 4. Product tour from the screenshots: <shotsdir> <outdir> <vi|en>
node record.mjs shots video vi
```

For English, restart step 1 with `DEMO_LANG=en`, then run `node shoot.mjs shots-en all en` and `node record.mjs shots-en video en`.

For a sharp product tour, take its screenshots at twice the resolution (`FLYBOT_SHOT_SCALE=2 FLYBOT_SHOT_QUALITY=92 node shoot.mjs shots-2x <scenes> vi`) and record from those. `record.mjs` draws at 1920x1080 (`FLYBOT_VIDEO_SCALE`, default 1.5 x 1280x720) at 8 Mbps (`FLYBOT_VIDEO_BITRATE`); `FLYBOT_POSTER_ONLY=1` writes only the still frame.

Copy the results into the app:

- `shots/*.webp` → `client/public/manual/vi/`
- `shots-en/*.webp` → `client/public/manual/en/`
- `video/*` → `client/public/media/`

`node frames.mjs <video.mp4> <prefix> <seconds...>` saves frames of a video, to check it.

## Files

- `demo-server.js`: demo API with seeded data (users, farms, four traps, weeks of photos, a report, recordings). It writes the sign-in tokens to `demo-tokens.json` (not versioned). The assistant answers without Vertex: a stand-in model picks a real tool from the question (photos, week comparison, last 24 hours, reports, alerts, "đã thay" / "replaced" for a card change to confirm, a photo asked about from its window; otherwise the trap summary), with a canned look at photos and streams a short answer from its result, so the chat panel, its cards and ratings can be shown.
- `trapImage.js`: draws the synthetic sticky-card photos and their detection boxes.
- `demo-client.mjs`: Vite dev server for the demo.
- `cdp.mjs`: headless Chrome through the DevTools protocol.
- `shoot.mjs`: the screenshot list. Each entry has a name, a page and the clicks to make before the shot. The guide shows them through `IMAGES` in `client/src/pages/Manual.vue`.
- `record.mjs`: the tour scenes (`ORDER`), captions in both languages, timing and bitrate.
- `remux-mp4.ps1`: Chrome records a fragmented MP4 with no duration in its header, which PowerPoint cannot play and browsers cannot seek. After `record.mjs`, re-encode each video with Windows' own encoder: `powershell -NoProfile -ExecutionPolicy Bypass -File remux-mp4.ps1 <in.mp4> <out.mp4> 3500000 1920 1080` (bitrate, width, height). The website copy uses 3.5 Mbps (about 35 MB); a copy for a deck artifact (20 MB limit per file) 1.8 Mbps.
- `faststart-mp4.mjs`: Windows' encoder writes the MP4 index at the end, so a browser has to fetch the end of the file (or, without range requests, all of it) before playing. `node faststart-mp4.mjs <in.mp4> <out.mp4>` moves it to the front; run it on every video that goes in `client/public/media`.
- `embed-video-pptx.mjs`: PDF and PowerPoint exports of a deck show a video as its still frame. `node embed-video-pptx.mjs <in.pptx> <slide> <video.mp4> <out.pptx>` turns the largest picture on that slide into the playable video (PowerPoint 2010 and later). PDF cannot play video: give it a link.
- `prepare-deck-pptx.mjs`: run this on every PowerPoint export of a deck: `node prepare-deck-pptx.mjs "<deck>.pptx" <vi|en> <video.mp4> <https://…/video.mp4>`. It sets the text in Arial (the deck's web font is not embedded, and without it PowerPoint repeats words at Vietnamese line ends), tags Vietnamese text as such, moves apart text boxes the export laid over each other (two-column grids), and writes `<deck> (video).pptx` (embedded tour, plays offline) and `<deck> (link).pptx` (opens the online tour) with the two tools below.
- `link-video-pptx.mjs`: instead of embedding, `node link-video-pptx.mjs <in.pptx> <slide> <https://…/video.mp4> <out.pptx>` makes the largest picture on that slide (and a play button on it) open the online video, so a new video on the website needs no new deck. PowerPoint does not play a linked .mp4 URL inside the slide (only YouTube, Vimeo or Stream), so it opens in the browser.
- `frames.mjs`: frame grabber for checking a video.
