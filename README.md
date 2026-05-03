<p><img src="src/icons/icon-128.png" alt="icon"></p>

# SeeWhatISee Chrome Extension

This is a Chrome extension for taking screenshots and saving HTML snapshots, optimized for use during agentic development.

You can share what you see on a web page with your coding agent (Claude code, etc) *with a single click*.

When you select text in the page, that text is saved, as your choice of HTML, text, or agent-friendly markdown.

The screenshots are saved in `~/Downloads/SeeWhatISee/`. Then the provided skills read them automatically from there.

## Usage

### Chrome extension

- Click the extension icon ![icon](src/icons/icon-16.png) to open the *Capture* page (see below).
  - Double-click it to bypass the *Capture* page and save a screenshot immediately.
  - If there's text selected on the page, double-click instead saves the selected text immediately.
- Right-click the icon for more options:
  - **Capture…** Opens the *Capture* page (see below).
  - **Save screenshot.**
  - **Save HTML contents** of the page.
  - **Pin tab as Ask target** — when you're on Claude / Gemini / ChatGPT (including Claude Code on `claude.ai/code`), pins the current tab so future *Ask* clicks send to that conversation. Flips to **Unpin tab as Ask target** while the current tab is the pin.
  - **Capture with delay ▸** — Capture the page after a delay, so
    you can activate hover states, menus, etc.
  - **More ▸**
    - **Save default items** — Saves the default items the *Capture* page saves, according to current options.
    - **Save URL** — Record just the current tab's URL, without a screenshot.
    - **Save everything** — Saves the screenshot, the HTML, and the current selection (if any).
    - **Save selection as HTML, text, or markdown** — Saves the currently selected text.
    - **Copy last screenshot, HTML, or selection filename** — Copies filename to clipboard.
    - **Snapshots directory** — Opens the on-disk capture directory
      (`~/Downloads/SeeWhatISee/`) so you can browse the saved files.
    - **Clear log history** — Erases the `log.json` history of previous snapshots.
      Screenshot files are still saved in your Downloads folder.
- **Options** — Opens options page, where you can configure default actions
  for click and double-click, default Save choices on the *Capture* page,
  keyboard hotkeys, and which AI providers (Claude / Gemini / ChatGPT /
  Google) are enabled for *Ask* plus which one is the default destination.
  Claude Code (`claude.ai/code`) is treated as a Claude tab variant —
  pin or pick an existing one to send to it; the Capture page blocks
  the send and asks you to uncheck Save HTML / Save selection if
  those are set, since Claude Code only accepts image uploads.
  Google is image-only and always opens a fresh google.com tab (no
  pinning, no existing-tab reuse) — the search box gets your prompt
  and submits to a Google Search results page.

#### Capturing selected text

When text is selected on the page, clicking the icon saves the selection (by default).

The selection can be saved in three formats:
- **as HTML**: Saves the exact HTML extracted from the page. This can be noisy and difficult to read.
- **as text**: Saves a plain text version of the selection.
- **as markdown**: Converts the selection HTML to markdown.
  - This uses a lightweight conversion that includes headings, bullets, links, tables, and some simple formatting.
  - The markdown format preserves the content and structure, in a format friendly for both humans and agents to read.
  - When the selection is *already* markdown source, the original markdown is preserved without reformatting.

On the *Capture* page, you can also view or edit the selection content.

#### *Capture* page

This page allows full control of what's captured.  You can add highlights on the page and **add a prompt telling the agent what you want to do**.

Click **Capture**, the toolbar icon ![icon](src/icons/icon-16.png), or press *Enter* in the prompt field to submit.

On this page, you can:

- See the page URL and HTML size.
- Pick whether to save the screenshot, HTML snapshot, and/or the currently selected text.
  - Selected text can be saved **as HTML**, **as text**, or **as markdown**.
  - With nothing checked, you can still capture the URL.
- Copy saved filenames to the clipboard with the copy icon ![icon](docs/images/copy-icon.png).
- View or edit the captured HTML or selection before saving with the pencil icon ![icon](docs/images/edit-icon.png).
- **Save individual artifacts** to a custom location with the download icon ![icon](docs/images/download-icon.png).
- Add an optional **Prompt**. (Enter submits; Shift+Enter or `\`+Enter inserts a newline.)
- Annotate the screenshot with **drawing tools**:
  - **Box** (default) — draws a red rectangle to highlight a region.
  - **Line** / **Arrow** — draws a red line or arrow.
  - **Crop** — drag a rectangular region — image will be cropped to that region. Drag borders to resize.
  - **Redact** — draw a black box to hide part of the image.
  - **Undo** / **Clear** — roll back the most recent edit, or all edits.
  - **Copy** / **Save** — copy the edited image to the clipboard, or download it.
- Format conversion in **Paste**
  - If the clipboard holds HTML, *Paste* (*Ctrl-V*) converts it to markdown in the *Prompt* or *as markdown* editor.
  - In the HTML editors, the HTML source is pasted.
  - *Paste as plain text* (*Ctrl-Shift-V*) always pastes plain text.
- **Ask** — sends the selected content (screenshot, HTML snapshot, and/or selection) and the prompt to an AI web UI in another tab. The button is split: clicking **Ask** sends to the tab you used last (or, on first use, opens a new tab in the default provider); the chevron on the right opens a menu where you can pick a different target — a new tab in Claude, Gemini, ChatGPT, or Google, or any tab you already have open (including Claude Code on `claude.ai/code`). Google is new-tab-only — it doesn't appear in the existing-window list and can't be pinned. The menu marks the current target with a check. Picking a menu item shifts the default but doesn't send — use **Ask** (or *Alt+A*) to fire. *Alt+A* sends to the resolved default. If you typed a prompt, it's auto-submitted.
  - Modifier keys on **Capture** and **Ask** — *Shift-click* keeps the Capture page open after the action (which allows saving multiple capture varations from the same screenshot). *Ctrl-click* closes the page.

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

### Chrome extension (from a release zip)

1. Download `SeeWhatISee-extension-vX.Y.Z.zip` from the [Releases page](https://github.com/jshute96/SeeWhatISee/releases) and unzip it.
2. In Chrome: open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select the unzipped directory.

### Chrome extension (from source)

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

Note: To avoid permissions prompts in `/see-what-i-see-watch`, add this to `$HOME/.claude/settings.json`, replacing `HOMEDIR` with your home directory (which is printed in the permission prompt.)

```
  "permissions": {
    "allow": [
      "Bash(HOMEDIR/.claude/plugins/cache/see-what-i-see-marketplace/**)",
      "Read(~/Downloads/SeeWhatISee/**)"
    ]
  }
```

`/see-what-i-see-help` also includes this.

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

Everything the extension writes lands under
`~/Downloads/SeeWhatISee/`. A capture produces one or more capture
files plus an updated `log.json` sidecar.

### Capture files

Each capture writes one or more of these, by filename prefix:

- `screenshot-<timestamp>.png` — the captured PNG.
- `contents-<timestamp>.html` — the captured full-page HTML.
- `selection-<timestamp>.{html,txt,md}` — the captured text selection. Exactly one file per capture — the extension reflects the format the user picked (HTML fragment, plain text, or markdown).

A single Capture may include any subset of these (or
none — a URL-only record is valid). Filenames are pinned at capture
time so multiple saves within one run overwrite in place.

### `log.json`

Newline-delimited JSON (one record per line), grep-friendly history
of recent captures.

- Capped at the **100 most recent** entries (FIFO eviction).
- The authoritative log lives in Chrome extension storage; `log.json`
  is a snapshot rewritten on every capture. If deleted, it's restored
  from extension storage on the next capture.
- Scripts use `tail -1 log.json` to get the latest record.

### `log.json` record schema

Every record has `timestamp`. The remaining fields are optional, and only
present when that item was included or available.

- `timestamp` — ISO 8601 UTC timestamp of the capture.
- `screenshot` — present when a PNG screenshot was saved.
    - `filename` — filename of the PNG.
    - `hasHighlights` — `true` if the user added highlights.
    - `hasRedactions` — `true` if the user blacked out at least one region.
    - `isCropped` — `true` if the image was cropped to a user-selected region.
- `contents` — present when the full-page HTML was saved.
    - `filename` — filename of the HTML snapshot.
    - `isEdited` — `true` if the user edited the HTML content before saving.
- `selection` — present when the text selection was saved.
    - `filename` — filename of the selection file (`.html`, `.txt`, or `.md`).
    - `format` — one of `"html"`, `"text"`, `"markdown"`.
    - `isEdited` — `true` if the user edited the captured body before saving.
- `prompt` — user-entered prompt from the *Capture* page
  flow, giving instructions for agents on what to do with this capture.
- `url` — URL of the captured page.
- `title` — Title of the captured page.

`filename` fields have file basenames in `log.json` in the `Downloads` folder.
The scripts that extract these records to pass to agents expand `filename` to hold absolute paths.

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
npm test             # validate skill templates, then run Playwright e2e tests
npm run test:skills  # validate skill templates only (fast, no build)
npm run test:e2e     # run Playwright e2e tests only
npm run test:headed  # same as test:e2e, with a visible browser
npm run test:unit    # run the HTML→markdown converter unit tests
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
scripts/get-latest.sh     # print the latest capture record
scripts/watch.sh          # wait for the next capture, print it, exit
scripts/watch.sh --loop   # keep printing captures until ^C
```

## Building a Chrome extension release

Cut a Chrome extension release with `scripts/release-extension.sh`
(tag `extension-vX.Y.Z`). The `extension-` prefix leaves room for
separate release tracks for skills and plugins.

1. Bump the version in **both** `package.json` and `src/manifest.json`
   to the same value, and commit.
2. From a clean `main`, run:
   ```bash
   scripts/release-extension.sh             # draft (default)
   scripts/release-extension.sh --publish   # publish immediately
   ```

The script verifies the versions match, the `main` branch is clean, and the
tag is unused; then builds + zips the extension as
`/tmp/SeeWhatISee-extension-vX.Y.Z.zip`, creates and pushes an annotated tag,
and calls `gh release create` with auto-generated notes and the zip
attached. The default is a draft so you can review and publish from the
GitHub UI.

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

## License

The extension itself is MIT-licensed (see `LICENSE`). Bundled
third-party assets and their licenses are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
