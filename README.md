# SeeWhatISee Chrome Extension

This is a Chrome extension for taking screenshots and saving HTML snapshots, optimized for use during agentic development.

This lets you share what you see on a web page with your coding agent (Claude code, etc) *with a single click*.

## Usage

### Chrome extension

- Click the extension icon to take a screenshot of the current page and share it directly with your coding agent.
- Right-click the icon for more options:
  - Take a screenshot after a delay (so you can activate hovers, pop-ups, etc).
  - Capture the HTML contents of the page.

Captured screenshots are written to `~/Downloads/SeeWhatISee/`. Coding agents can pick up the latest one without any copy-paste using the skills below.

### Claude Code skills

- `/see-what-i-see` — read the latest capture and describe it
- `/see-what-i-see-watch` — watch for new screenshots to appear in the background, and then look at them when they appear
- `/see-what-i-see-stop` — stop a running watch loop
- `/see-what-i-see-help` — print a summary of the commands

## Installation

### Chrome extension

1. Clone this repo and install dependencies:
   ```bash
   git clone https://github.com/jshute96/SeeWhatISee.git
   cd SeeWhatISee
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. In Chrome: open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select the `dist/` directory.

### Claude Code plugin

Add the marketplace and install the plugin:

```bash
/plugin marketplace add jshute96/SeeWhatISee
/plugin install see-what-i-see@see-what-i-see-marketplace
```

For local development, load the plugin directly from a checkout:

```bash
claude --plugin-dir ~/dev/SeeWhatISee/plugin
```

## Output files

Each capture writes three files into that directory:

- `screenshot-<timestamp>.png` or `contents-<timestamp>.html` — the
  captured content itself, one per capture.
- `latest.json` — pretty-printed `{timestamp, filename, url}` for the
  most recent capture, overwritten every time. An agent can read this
  to find the newest capture without having to `ls`.
- `log.json` — newline-delimited JSON (one record per line, same
  schema as `latest.json`), grep-friendly history of recent captures.
  Capped at the 100 most recent entries (FIFO eviction). The
  authoritative log lives in extension storage and `log.json` is a
  snapshot rewritten on every capture. If deleted, it will be restored
  from Chrome storage.

## Development setup

```bash
npm install
npx playwright install chromium
```

## Building

```bash
npm run build        # one-shot build into dist/
npm run watch        # rebuild on TS changes
```

## Testing

```bash
npm test             # run Playwright e2e tests
npm run test:headed  # same, with a visible browser
```

The tests load the unpacked extension from `dist/` and drive it by
calling capture functions on the background service worker — Playwright
can't click the browser toolbar, so each capture mode is also exposed
on `self.SeeWhatISee` for test/console access.

## Watching for screenshots from CLI

```bash
scripts/watch.sh                # wait for the next capture, print it, exit
scripts/watch.sh --loop         # keep printing captures until ^C
scripts/watch.sh --after FILE   # emit any captures newer than FILE, then watch
scripts/watch.sh --stop         # stop a running watcher
scripts/watch.sh --help         # full usage
```

## Layout

- `src/` — TypeScript sources and `manifest.json`
- `dist/` — built extension (gitignored, loaded unpacked into Chrome)
- `scripts/build.mjs` — build script (cleans `dist/`, copies icons and
  manifest, runs `tsc`)
- `scripts/watch.sh` — symlink to `plugin/scripts/watch.sh`
- `plugin/` — Claude Code plugin (skills, settings, manifest)
- `tests/e2e/` — Playwright tests
- `tests/fixtures/extension.ts` — fixture that loads the extension and
  exposes its service worker
- `docs/` — design docs and the file index
