# Contributing to FlyBot

## Setup

Install [Git LFS](https://git-lfs.com) first (`git lfs install`): the tour videos in `client/public/media` and the `.pptx` decks are stored there. A new video or deck is picked up by `.gitattributes` automatically.

```bash
npm install
cp .env.example .env
npm run dev
```

Use a development database. The test suite and the demo (below) never need a real one.

## Conventions

- **English in code.** Identifiers, comments, log lines, error messages and data keys are in English. Vietnamese text lives only in the locale files.
- **Every UI string goes through i18n**, in both `client/src/locales/en.json` and `vi.json`. The Vietnamese interface must read fully in Vietnamese: no English labels left in it (brand and technical names such as FlyBot, EZVIZ, AI, PDF, API stay as they are). In vue-i18n messages write `@` as `{'@'}`.
- **Server messages are translated too.** A message like `res.status(400).json({ message: "This person already has access." })` needs a key in `server/src/locales/en.json` and `vi.json` (lowercase words joined by `_`: `this_person_already_has_access`). `server/tests/localize.test.js` fails on any message without one.
- **UI:** Element Plus components and `@element-plus/icons-vue` only, colors from the theme variables. See [client/UI_GUIDELINES.md](client/UI_GUIDELINES.md).
- **The product is FlyBot** in every user-facing text.
- **Security by default:** check access on the server for every record (camera, farm, report, organization), return the same 404 for "missing" and "not yours", rate-limit anything that sends email or calls an external service, and escape user text before rendering HTML.

## Tests

```bash
npm test
```

The server tests run against an in-memory MongoDB with S3, email and EZVIZ stubbed. Each in-memory database needs about 500 MB of temporary disk space, so on a crowded machine run them one file at a time and point the temp folder at a drive with room:

```bash
cd server
TMP=/path/with/space TEMP=/path/with/space node --test --test-concurrency=1 tests/*.test.js
```

Add a test with every server change: access rules, validation and the happy path. Build the web app (`npm run build:client`) before sending a change.

The web app has two kinds of tests:

```bash
npm run test:client      # Vitest: utilities, translations, components (a few seconds)
npm run test:e2e         # the demo in headless Chrome: every main page and the main flows
```

`test:client` also checks that Vietnamese and English have the same keys and placeholders, that every message compiles (write `{'@'}` for a literal @) and that every `t('...')` key used in the code exists. Component tests live in `client/tests/unit` and mock `@/services/api`.

`test:e2e` starts the demo from `tools/media` (in-memory database, ports 3013 and 3010, which must be free), opens every main page with a manager account and fails on any script error, then checks the overview, the field log and the notification settings, and that pages fit a phone screen. It needs Google Chrome (`CHROME_PATH` if it is elsewhere) and about 500 MB of temporary disk space. If another in-memory MongoDB is running and the test cannot replace the cached `mongod`, point it at that file with `MONGOMS_SYSTEM_BINARY`.

## Trying the UI without real data

`tools/media` runs a demo: an API with an in-memory database and sample farms, cameras and photos, plus the web app pointed at it. The same tools take the guide screenshots and record the product tour. See [tools/media/README.md](tools/media/README.md).

## Commits

One topic per commit, a short summary line, then what changed and why. Keep secrets out of the repository: `.env`, service account files and keys are ignored by git; use `.env.example` for new settings (with an empty or sample value) and document them in [DEPLOY.md](DEPLOY.md) when production needs them.
