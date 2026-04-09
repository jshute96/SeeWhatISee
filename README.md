# SeeWhatISee Chrome Extension

This is a Chrome extension for taking screenshots, optimized for use during agentic development.

Click the extension icon to take a screenshot of the current page and share it directly with your coding agent. Right-click the icon for a menu with **Take screenshot**, **Take screenshot in 2s**, and **Take screenshot in 5s**.

Screenshots are written to `~/Downloads/SeeWhatISee/` so an agent (Claude
Code, etc.) can pick up the latest one without any copy-paste.

## Output files

Each capture writes three files into that directory:

- `screenshot-<timestamp>.png` — the image itself, one per capture.
- `latest.json` — pretty-printed `{timestamp, filename, url}` for the
  most recent capture, overwritten every time. An agent can read this
  to find the newest screenshot without having to `ls`.
- `log.json` — newline-delimited JSON (one record per line, same
  schema as `latest.json`), grep-friendly history of recent captures.
  Capped at the 100 most recent entries (FIFO eviction). The
  authoritative log lives in extension storage and `log.json` is a
  snapshot rewritten on every capture. If deleted, it will be restored
  from Chrome storage.

## Setup

```bash
npm install
npx playwright install chromium
```

## Building

```bash
npm run build        # one-shot build into dist/
npm run watch        # rebuild on TS changes
```

Then in Chrome: open `chrome://extensions`, enable **Developer mode**,
click **Load unpacked**, and select the `dist/` directory (**not**
`src/` — `src/` holds TypeScript sources, `dist/` is what Chrome loads).

## Testing

```bash
npm test             # run Playwright e2e tests
npm run test:headed  # same, with a visible browser
```

The tests load the unpacked extension from `dist/` and drive it by
calling capture functions on the background service worker — Playwright
can't click the browser toolbar, so each capture mode is also exposed
on `self.SeeWhatISee` for test/console access.

## Layout

- `src/` — TypeScript sources and `manifest.json`
- `dist/` — built extension (gitignored, loaded unpacked into Chrome)
- `scripts/build.mjs` — build script (cleans `dist/`, copies icons and
  manifest, runs `tsc`)
- `tests/e2e/` — Playwright tests
- `tests/fixtures/extension.ts` — fixture that loads the extension and
  exposes its service worker
- `docs/` — design docs and the file index
