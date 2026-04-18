<p><img src="src/icons/icon-128.png" alt="icon"></p>

# SeeWhatISee Chrome Extension

This is a Chrome extension for taking screenshots and saving HTML snapshots, optimized for use during agentic development.

You can share what you see on a web page with your coding agent (Claude code, etc) *with a single click*.

The screenshots are saved in `~/Downloads/SeeWhatISee/`. Then the provided skills read them automatically from there.

## Usage

### Chrome extension

- Click the extension icon (![icon](src/icons/icon-16.png)) to take a screenshot, opening the capture details page (see below).
  - Double-click it to bypass the details page and take a screenshot immediately.
- Right-click the icon for more options:
  - Take a screenshot.
  - Capture the HTML contents of the page.
  - **Capture with details…** Opens a review page (see below).
  - **Capture with delay ▸** — Capture the page after a delay, so
    you can activate hover states, menus, etc.
  - **Set default click action ▸** — Choose which action to apply
    when clicking the icon.
    - If you choose another default single-click action, double-click will open *Capture with details*.
  - **More ▸**
    - **Capture URL** — Record just the current tab's URL, without a screenshot.
    - **Capture screenshot and HTML** — Save both the screenshot and the HTML snapshot.
    - **Capture selection** — Saves the HTML of the currently selected text.
    - **Copy last screenshot filename** — Copies filename to clipboard.
    - **Copy last HTML filename** — Copies filename to clipboard.
    - **Snapshots directory** — Opens the on-disk capture directory
      (`~/Downloads/SeeWhatISee/`) so you can browse the saved files.
    - **Clear log history** — Erases the `log.json` history of previous snapshots.
      Screenshot files are still saved in your Downloads folder.

#### Capturing with details

Use this to draw highlights on the page and/or add a prompt telling
the agent what you want to do.

Click *Capture*, the toolbar icon, or press *Enter* in the prompt field to submit.

On this page, you can:

- See the page URL and HTML size.
- Pick whether to save the screenshot, HTML snapshot, and/or currently selected text.
  - With none of these checked, you can still capture the URL.
- Copy saved filenames to the clipboard with the copy icon.
- Add an optional **Prompt**. (Enter submits, Shift+Enter inserts a newline.)
- Annotate the screenshot with red **highlights**:
  - **Click-drag** to draw a red box.
  - **Right-click-drag** to draw a red line.
  - **Undo** or **Clear** to roll back edits.

If you add a prompt, the agent will follow it when reading this snapshot,
focusing on highlighted areas in the screenshot.

### Claude Code skills

- `/see-what-i-see` — read the latest snapshot and describe it
- `/see-what-i-see-watch` — watch for new snapshots to appear in the background, and then look at them when they appear
- `/see-what-i-see-stop` — stop a running watch loop
- `/see-what-i-see-help` — print a summary of the commands

If you've added a prompt with the snapshot, Claude will follow it.

You can also add prompts after the commands above and they'll be applied
on each snapshot. For example,

- `/see-what-i-see` `What font is the heading on this page?`
- `/see-what-i-see-watch` `Just report the snapshot filenames`

### Gemini CLI commands

- `/see-what-i-see` `[prompt]` — read the latest capture.
- `/see-what-i-see-watch` `[prompt]` — watch for new captures and
  describe each one. Runs in the foreground (Gemini has no async
  background worker with a completion callback), so the conversation
  stays paused on a blocking shell call between captures. Stop it by
  pressing Escape.

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

### Gemini CLI commands

Run `scripts/gemini-install.sh` from inside `gemini`, so it can install into Gemini's sandbox home directory.

```bash
git clone https://github.com/jshute96/SeeWhatISee.git
cd SeeWhatISee
gemini 'Run `scripts/gemini-install.sh`'
```

Alternative: Copy these files into the same directories in your `.gemini` directory:

* [`.gemini/commands/see-what-i-see.toml`](https://github.com/jshute96/SeeWhatISee/blob/main/.gemini/commands/see-what-i-see.toml)
* [`.gemini/commands/see-what-i-see-watch.toml`](https://github.com/jshute96/SeeWhatISee/blob/main/.gemini/commands/see-what-i-see-watch.toml)
* [`.gemini/scripts/_common.sh`](https://github.com/jshute96/SeeWhatISee/blob/main/.gemini/scripts/_common.sh)
* [`.gemini/scripts/copy-last-snapshot.sh`](https://github.com/jshute96/SeeWhatISee/blob/main/.gemini/scripts/copy-last-snapshot.sh)
* [`.gemini/scripts/watch-and-copy.sh`](https://github.com/jshute96/SeeWhatISee/blob/main/.gemini/scripts/watch-and-copy.sh)

## Output files

Each capture writes two files into that directory:

- `screenshot-<timestamp>.png` or `contents-<timestamp>.html` — the
  captured content itself, one per capture.
- `log.json` — newline-delimited JSON (one record per line),
  grep-friendly history of recent captures. Each record contains:
  - `timestamp`
  - `url`
  - `screenshot` — PNG filename, when a screenshot was saved.
  - `contents` — HTML filename, when HTML was saved.
  - `selection` — HTML filename, when the selection was saved.
  - `prompt` — user prompt from the "Capture with details…" flow.
  - `highlights: true` — when the saved PNG includes user-drawn highlights.

The log is capped at the 100 most recent entries (FIFO eviction). The
authoritative log lives in extension storage and `log.json` is a
snapshot rewritten on every capture. If deleted, it will be restored
from Chrome storage. Scripts use `tail -1 log.json` to get the
latest record.

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

## Updating the Claude plugin in marketplace

The plugin won't update if the version is the same.

To make an update possible, bump `plugins[0].version` in `.claude-plugin/marketplace.json`. That's the field Claude Code uses for cache invalidation on this relative-path plugin; `plugin.json` intentionally has no `version` field. See `docs/claude-plugin.md` for the full story.

Users still need to run `/plugin marketplace update` followed by `/plugin` to pick up the new version — third-party marketplaces do not auto-update on startup.

## Running the Claude plugin locally

For local development, a plugin directory can be set manually:

```bash
claude --plugin-dir ~/dev/SeeWhatISee/plugin
```

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
