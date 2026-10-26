# Guide screenshots, product tour and commercial

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

Ports 3013 and 3010 are taken? Set `DEMO_API_PORT` and `DEMO_CLIENT_PORT` for all the scripts.

For English, restart step 1 with `DEMO_LANG=en`, then run `node shoot.mjs shots-en all en` and `node record.mjs shots-en video en`.

For a sharp product tour, take its screenshots at twice the resolution (`FLYBOT_SHOT_SCALE=2 FLYBOT_SHOT_QUALITY=92 node shoot.mjs shots-2x <scenes> vi`) and record from those. `record.mjs` draws at 1920x1080 (`FLYBOT_VIDEO_SCALE`, default 1.5 x 1280x720) at 8 Mbps (`FLYBOT_VIDEO_BITRATE`); `FLYBOT_POSTER_ONLY=1` writes only the still frame.

Copy the results into the app:

- `shots/*.webp` → `client/public/manual/vi/`
- `shots-en/*.webp` → `client/public/manual/en/`
- `video/*` → `client/public/media/`

`node frames.mjs <video.mp4> <prefix> <seconds...>` saves frames of a video, to check it.

## Commercial (TVC)

The 60-second commercial on the home page (`client/public/media/flybot-tvc-vi|en.mp4`) is a motion-graphics page, `tvc/tvc.html`, drawn frame by frame. It needs no demo server: the app pictures come from the guide screenshots (`client/public/manual/<lang>/`) and the logo. Open `tvc/tvc.html?lang=vi` in Chrome to watch it play in real time while editing.

From the `tvc` folder:

```bash
# Stills at chosen seconds, to check the layout
node stills.mjs stills vi 3 10 17 25

# The video: 1800 frames (about 400 MB in the work folder, removed afterwards), then H.264 + AAC
node render-tvc.mjs vi flybot-tvc-vi.mp4
node render-tvc.mjs en flybot-tvc-en.mp4

# The poster: a still in WebP
FLYBOT_STILL_FORMAT=webp node stills.mjs poster vi 17

# The 9:16 cut (30 s, 1080x1920) for Reels, TikTok and Zalo: the same scripts with FLYBOT_TVC_PAGE
FLYBOT_TVC_PAGE=tvc-vertical.html node render-tvc.mjs vi flybot-tvc-vertical-vi.mp4
```

Rendering takes about ten minutes a language; `FLYBOT_TVC_KEEP=1` keeps the frames and `FLYBOT_TVC_REUSE=1` encodes them again without rendering. The MP4 needs no `remux-mp4.ps1` or `faststart-mp4.mjs`: it already has its index in front. Copy the videos and posters (`flybot-tvc-<lang>-poster.webp`) to `client/public/media/`.

## Demo film (OpenCV AI Competition 2026)

The competition video (at most 5 minutes, 1920x1080, English voice and subtitles) lives in `film/`: screen recordings of the live app at https://flybot.agrhub.com and motion graphics (the problem, the trap camera's parts and wiring, results) on one timeline, rendered frame by frame like the commercial. Its shot list is flybot-aws `docs/VIDEO_SCRIPT.md`.

Everything large stays in `film/media/` (not versioned): `rec/` the recordings, `photos/` the component photos, `assets/` the flybot-aws diagrams and sample photos and the logo, `footage/` the orchard clip, `voice/` the spoken lines, `tts/` the voice model, `out/` the films.

From the `film` folder:

```bash
# The values the recordings must never show (camera serial, verify code, home address, GPS position): fill these in first
cp privacy.example.json privacy.local.json

# Guest recordings (Guest access, headless Chrome)
node record-app.mjs guest all
# Owner recordings: a Chrome window opens on the sign-in page; the owner signs in there, then
node record-app.mjs browser
node record-app.mjs owner all

# People check of every recording before anyone looks at it (counts only, nothing leaves the computer)
uv run --no-project --python 3.12 --with opencv-python-headless==4.10.0.84 python -I peoplecheck.py media/rec/<shot>

# The voice-over (offline, Kokoro): model files in media/tts first, see below
node voice.mjs

# Watch it play, or take stills
node serve.mjs            # http://127.0.0.1:8090/film.html (?subs=vi, ?t=42, ?from=60)
node stills.mjs <outdir> 12 wiring trace

# The film, in one command (about an hour): media/out/flybot-demo-en.mp4 and its .en.srt / .vi.srt
node render-film.mjs
node render-film.mjs media/out/flybot-demo-vi.mp4 --subs vi
```

The orchard clip: put the team's clip at `film/media/footage/real-trap.mp4` (H.264 MP4; `.webm` and `.mov` are tried too) and render again; it fills the 30-second slot after the wiring animation (muted, the voice and music play over it). To start later in a longer clip, add `film/media/footage/footage.json`: `{ "file": "real-trap.mp4", "from": 12.5 }`. Without a clip the slot shows a "Placeholder" card. Check the clip for people before rendering. A longer clip can play only some parts: `{ "file": "real-trap.mp4", "segments": [[0, 12], [20, 38]] }`.

An internal review cut can fill the slot with a stand-in clip instead (for example a seller's video the team may use privately): `node render-film.mjs --footage placeholder` reads `film/media/vendor/footage.json` (`{ "file": "...", "segments": [...] }`, not versioned), labels the clip "Placeholder: seller footage, to be replaced" in the corner and names the film `*-placeholder.mp4`; the script refuses any other name. Without `--footage placeholder` the stand-in is never read, so a normal render cannot contain it. Never publish a `-placeholder` cut.

Privacy while recording: `inject.js` runs in every recorded page before the app. It rewrites every text, attribute and input value that matches a rule in `privacy.local.json` (and every e-mail address except the demo ones) before it is painted, and `record-app.mjs` deletes a take as soon as a masked value shows up unmasked. Pictures (camera photos, live view) are not masked: check them with `peoplecheck.py` and cut what it flags. The owner's window uses its own profile in `media/profile`; delete that folder after recording.

The voice: `voice.mjs` speaks the English lines of `script.js` with Kokoro (open weights, Apache-2.0) on this computer. Download `kokoro-v1.0.onnx` and `voices-v1.0.bin` from https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0 into `film/media/tts/`. A recorded voice can replace any line: `media/voice/<scene>-<n>.wav` with its length in `media/voice/manifest.json`.

## CamOS tutorial videos

Five short videos for the CamOS trap camera (firmware repository `camos-esp32-trap`): flashing a board, the Wi-Fi setup on a phone, the camera's web console, wiring and assembly, and daily use in FlyBot. Silent, 1920x1080, captions burned in (English, and a Vietnamese cut with the pages in Vietnamese), about 1.8 MB a minute.

The screens come from the firmware's mock camera (serial ESP000000000001, verify code ABC123, drawn pictures) and, for the FlyBot video, from the demo above. `demo-server.js` seeds an unclaimed CamOS trap with the mock's identity and answers its "Capture now"; the video puts it on the Pro plan to have room for it. The flasher page is the real one with ESP Web Tools: a stand-in serial port (`tutorials/inject.js`) is picked in a drawn port chooser and the install progress is played, since no board is attached. The phone's Wi-Fi settings are a drawing (`tutorials/props/phone-wifi.html`).

From the `tutorials` folder, with the mock camera running (`node tools/mock/server.js 8099` in camos-esp32-trap):

```bash
# For the FlyBot video, the demo first (DEMO_LANG=en for the English cut, vi for the Vietnamese one)
DEMO_LANG=en node ../demo-server.js
node ../demo-client.mjs

# 1. The takes: the pages played in headless Chrome, a picture each time the page changes (media/takes/<lesson>-<lang>)
node record.mjs all en        # or a list: flash,wifi,console,wiring,flybot
# 2. The videos and their posters: media/out/camos-<n>-<lesson>-<lang>.mp4 and .jpg
node render.mjs all en
# Stills of chosen seconds, to check the layout
CAMOS_TUTORIAL_STILL=10,25,40 node render.mjs console en
```

The FlyBot video claims the demo's CamOS trap: restart `demo-server.js` before recording it again. Set `CAMOS_REPO` when camos-esp32-trap is not next to this repository, `CAMOS_MOCK` for another mock address, `DEMO_CLIENT_PORT` (or `FLYBOT_DEMO_URL`) for the demo, and `CAMOS_TUTORIAL_WORK` for the work folder (default `tutorials/media`, not versioned).

- `tutorials/lessons.mjs`: the five videos, their clicks and their captions in both languages.
- `tutorials/record.mjs`: plays a lesson and writes its take (the distinct pictures, and for every frame the picture, cursor, zoom, highlight and caption). Nothing depends on real time except the page itself, so a slow machine records the same video.
- `tutorials/compose.html`: draws each frame (browser window or phone, cursor and clicks, zoom, highlight, caption) and encodes it with WebCodecs.
- `tutorials/render.mjs`: the MP4 (`tvc/mux-mp4.mjs`, index in front, no sound track) and its poster. `CAMOS_TUTORIAL_QP` sets the H.264 quantizer (default 28).

## Simulated demo farm, locally

`sim-demo.js` runs the simulated demo farm (`server/src/services/demoSim.js`, DEPLOY.md) the way production does, with the real vision handler: an in-memory MongoDB, the photos in a folder instead of S3, and the flybot-aws vision Lambda running on this computer.

```bash
# In flybot-aws/lambda/vision: the vision handler on http://127.0.0.1:9001/invoke
uv run python -m sentinel.lambda_local
# Here: the last FLYBOT_SIM_DAYS (5) days of the farm, then the API on :3013
FLYBOT_SIM_SET="<flybot-aws>/data/synth/demo-30d;<flybot-aws>/data/synth/pool" FLYBOT_SIM_STORE=<empty folder> FLYBOT_DEMO_DB=<folder> node sim-demo.js
node demo-client.mjs
```

Sign in as `judge@flybot.test` (a visitor, password `judge-demo-1`) or `admin@flybot.test`. Delete the store and database folders afterwards.

## Files

- `demo-server.js`: demo API with seeded data (users, farms, four traps, weeks of photos, a report, recordings). It writes the sign-in tokens to `demo-tokens.json` (not versioned). The assistant answers without Vertex: a stand-in model picks a real tool from the question (photos, week comparison, last 24 hours, reports, alerts, "đã thay" / "replaced" for a card change to confirm, a photo asked about from its window; otherwise the trap summary), with a canned look at photos and streams a short answer from its result, so the chat panel, its cards and ratings can be shown.
- `trapImage.js`: draws the synthetic sticky-card photos and their detection boxes.
- `demo-client.mjs`: Vite dev server for the demo.
- `cdp.mjs`: headless Chrome through the DevTools protocol.
- `shoot.mjs`: the screenshot list. Each entry has a name, a page and the clicks to make before the shot. The guide shows them through `IMAGES` in `client/src/pages/Manual.vue`.
- `record.mjs`: the tour scenes (`ORDER`), captions in both languages, timing and bitrate.
- `remux-mp4.ps1`: Chrome records a fragmented MP4 with no duration in its header, which PowerPoint cannot play and browsers cannot seek. After `record.mjs`, re-encode each video with Windows' own encoder: `powershell -NoProfile -ExecutionPolicy Bypass -File remux-mp4.ps1 <in.mp4> <out.mp4> 3500000 1920 1080` (bitrate, width, height). The website copy uses 3.5 Mbps (about 35 MB); a copy for a deck artifact (15 MB limit per file) 1.8 Mbps; the commercial keeps its sound with `-Audio` (`… 1600000 1280 720 -Audio`, about 13 MB).
- `faststart-mp4.mjs`: Windows' encoder writes the MP4 index at the end, so a browser has to fetch the end of the file (or, without range requests, all of it) before playing. `node faststart-mp4.mjs <in.mp4> <out.mp4>` moves it to the front; run it on every video that goes in `client/public/media`.
- `embed-video-pptx.mjs`: PDF and PowerPoint exports of a deck show a video as its still frame. `node embed-video-pptx.mjs <in.pptx> <slide> <video.mp4> <out.pptx>` turns the largest picture on that slide into the playable video (PowerPoint 2010 and later). PDF cannot play video: give it a link. The decks link the video instead; this is for a copy that must play with no connection.
- `pptx-images.mjs`: `node pptx-images.mjs <in.pptx> <out.pptx>` turns the WebP and SVG pictures of an existing .pptx into PNG, for files already made. Keep slide images in the decks as PNG or JPEG, so every export works in Google Slides. Embedded video never plays there.
- `prepare-deck-pptx.mjs`: run this on every PowerPoint export of a deck: `node prepare-deck-pptx.mjs "<export>.pptx" <vi|en> <https://…/video.mp4> "<deck>.pptx"`. It sets the text in Arial (the deck's web font is not embedded, and without it PowerPoint repeats words at Vietnamese line ends), tags Vietnamese text as such, moves apart text boxes the export laid over each other (two-column grids), turns WebP and SVG pictures into PNG (Google Slides and Drive's preview show neither), and links the video picture on slide 4 to the online video, the commercial `flybot-tvc-<lang>.mp4` (`link-video-pptx.mjs` below) instead of embedding it: the file stays about 5 MB, behaves the same in PowerPoint and Google Slides, and a new video needs no new deck.
- `link-video-pptx.mjs`: instead of embedding, `node link-video-pptx.mjs <in.pptx> <slide> <https://…/video.mp4> <out.pptx>` makes the largest picture on that slide (and a play button on it) open the online video, so a new video on the website needs no new deck. PowerPoint does not play a linked .mp4 URL inside the slide (only YouTube, Vimeo or Stream), so it opens in the browser.
- `frames.mjs`: frame grabber for checking a video.
- `tvc/tvc.html`: the commercial's eight scenes on one timeline (`S`, seconds, on the music's 2.4 s bars), their text in both languages (`COPY`) and `window.renderAt(t)`, which draws any moment exactly.
- `tvc/tvc-vertical.html`: the 9:16 cut, six scenes on 30 s, the app on a phone (the `mobile-*` guide screenshots). Each page tells the scripts its size and music in `window.TVC`.
- `tvc/music.js`: the music, synthesized with Web Audio (no samples): pads, bass, drums and arpeggio following the scenes, a rise and hit on the logo. `ARRANGEMENTS` holds one plan of bars per page (`landscape`, `vertical`).
- `tvc/encode.html`: encodes the frames and the music (or a finished sound file, as the demo film's mix) with WebCodecs, frame by frame rather than in real time, so a busy machine drops nothing.
- `tvc/mux-mp4.mjs`: writes the encoded video and sound into an MP4 with its index in front.
- `tvc/render-tvc.mjs`, `tvc/stills.mjs`: the video and stills, as above.
- `film/film.html`, `film/film.js`, `film/film.css`: the demo film's timeline; `window.renderAt(t)` draws any moment exactly. The scenes' text and voice lines are in `film/script.js`, the cut of the recordings (which take, from where, how fast, zoom) in `film/edit.js`.
- `film/record-app.mjs`, `film/shots.mjs`, `film/inject.js`: the screen recordings of the live app (`Page.startScreencast` frames with their times), the clicks of each shot, and the privacy mask and drawn cursor injected into the recorded page.
- `film/peoplecheck.py`: counts faces (YuNet, the model flybot-aws vendors) and people (HOG) in pictures, so pictures with people are found without anyone looking at them.
- `film/voice.mjs`, `film/tts.py`: the voice-over. `film/mix.html`: the music bed (`tvc/music.js`) ducked under the voice. `film/render-film.mjs`: frames, sound, MP4 and subtitles. `film/serve.mjs`, `film/stills.mjs`: preview.
