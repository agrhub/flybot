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

Copy the results into the app:

- `shots/*.webp` → `client/public/manual/vi/`
- `shots-en/*.webp` → `client/public/manual/en/`
- `video/*` → `client/public/media/`

`node frames.mjs <video.mp4> <prefix> <seconds...>` saves frames of a video, to check it.

## Files

- `demo-server.js`: demo API with seeded data (users, farms, four traps, weeks of photos, a report, recordings). It writes the sign-in tokens to `demo-tokens.json` (not versioned).
- `trapImage.js`: draws the synthetic sticky-card photos and their detection boxes.
- `demo-client.mjs`: Vite dev server for the demo.
- `cdp.mjs`: headless Chrome through the DevTools protocol.
- `shoot.mjs`: the screenshot list. Each entry has a name, a page and the clicks to make before the shot. The guide shows them through `IMAGES` in `client/src/pages/Manual.vue`.
- `record.mjs`: the tour scenes (`ORDER`), captions in both languages, timing and bitrate.
- `frames.mjs`: frame grabber for checking a video.
