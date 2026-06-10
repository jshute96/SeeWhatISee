<p><img src="docs/chrome-web-store/promo-tile.png" alt="SeeWhatISee — The ultimate screenshot tool for vibe-coding" width="440"></p>

# SeeWhatISee Chrome Extension

Click the toolbar icon to open the *Capture* page. Pick what to send
(screenshot, page HTML, selected text, or just the URL), mark it up
or add a prompt, and ship it to a web chatbot, a CLI agent, or other
tools using the MCP server.

- **Web targets** — *Claude*, *ChatGPT*, *Gemini*, *Google*.
- **CLI targets** — *Claude Code* and *Gemini CLI*, via bundled
  `/see-what-i-see` skills that read captures saved to
  `~/Downloads/SeeWhatISee/`.
- **MCP targets** (*Experimental*) — Claude Desktop, Cursor, Zed, Continue, etc.

See [Usage](#usage) for the full feature tour, CLI [Skills](#claude-code-skills), or [Installation](#installation).

The *Capture* page:

![Capture page with highlight drawn over a Wikipedia article](docs/images/readme-screenshot.png)

## Usage

### Chrome extension

#### Activate SeeWhatISee

- Click the extension icon ![icon](src/icons/icon-16.png) to open the *Capture* page.
  - Default hotkey: `Ctrl+Shift+X` (`⌘+Shift+X` on Mac)
- Double-click to save a screenshot (or selected text) immediately.
  - Default hotkey: `Ctrl+Shift+E` (`⌘+Shift+E` on Mac)
- Right-click for more options.
  - Capture after a 3-second delay (e.g. to activate hover states).
  - Save capturable elements directly.
  - Upload an image directly to the *Capture* page.
  - Reopen the last *Capture* page after closing it.
- Right-clicking on an image lets you capture that image directly.

#### Capturing selected text

When text is selected on the page, clicking the icon saves the selection (by default).  You can also save selected text on the *Capture* page.

Text can be saved **as HTML**, **as text**, or **as markdown** (the default).

Saving as markdown uses a lightweight conversion that includes headings, bullets, links, tables, and some simple formatting, converting to a format that's friendly and efficient for both humans and agents to read.

#### *Capture* page

This page allows full control of what's captured.  You can add highlights on the page and **add a prompt telling the agent what you want to do**.

Click **Capture**, the toolbar icon ![icon](src/icons/icon-16.png), or press `Enter` in the prompt field to submit.

On this page, you can:

- Choose what to save: **screenshot**, **HTML**, or **selection**.
  - You can preview or edit the HTML or selection text with the pencil icon ![icon](docs/images/edit-icon.png).
  - Copy the saved filenames to the clipboard with the copy icon ![icon](docs/images/copy-icon.png).
  - Save to other locations with the download icon ![icon](docs/images/download-icon.png).

- Add an optional **Prompt**.
  - `Enter` submits; `Shift+Enter` or `\+Enter` inserts a newline.
  - HTML copied from a web page is converted to markdown during **Paste**.
    - *Paste as plain text* (`Ctrl-Shift-V`) pastes the original copied text.

- Annotate the screenshot with **drawing tools**:
  - Draw **boxes**, **lines** or **arrows**.
  - Use the **black box** to redact and hide parts of the image.
  - Drag box edges to resize them.
  - **Crop** the image by drawing a rectangle, or dragging borders.
  - Use **Shrink** to tighten the most recent box or redaction, or the crop region, around its content. This strips whitespace or borders around the outer edges.
  - **Zoom** in or out. (Also with `Ctrl+mouse wheel` or `Alt +/-`.)
  - **Undo** or **Clear** to revert edits.
  - **Copy** to clipboard.
  - **Save** to a file.

> [!TIP]
> If you add a prompt, the agent will follow it when reading this snapshot, focusing on highlighted areas in the screenshot.

#### **Ask** buttons — Sending to web chatbots

Click **Ask** to send the selected files and the prompt to one of the chatbots on the web.

Use the drop-down menu to select a target — opening a new tab (↗) or continuing in an existing tab (📌).

Click a provider icon to start a new tab in
- **Claude**; Requires login. Supports **Claude Code** too, but with image uploads only.
- **ChatGPT**; Supports uploading at most two files per prompt.
- **Gemini**; Requires login to upload images.
- **Google**; Does a Google search with the prompt and an uploaded image. Requires login to upload images.

While viewing a chatbot page, the toolbar context menu lets you **Set this tab as the Ask button target**.

> [!TIP]
> Some chatbot providers require an account and that you are logged in. You can change the default and remove unsupported providers on the *Options* page.

#### Keyboard and mouse shortcuts

(`⌘` is the `Ctrl` equivalent on Mac for all shortcuts.)

##### Activating SeeWhatISee

- `Ctrl+Shift+X` — open the *Capture* page.
- `Ctrl+Shift+E` — save a screenshot (or selected text) immediately.

> [!TIP]
> These are suggested defaults. Chrome might not apply them if it thinks something else uses those keys.

> [!TIP]
> You can change these hotkeys, and add hotkeys for other *Save* actions, from `chrome://extensions/shortcuts` (which is linked on the *Options* page).

##### *Prompt* field

- `Enter` — submit.
- `Shift+Enter` or `\ Enter` — insert a newline.
- `Ctrl+V` — *Paste as markdown* (if selection content is HTML, it's converted to markdown).
- `Ctrl+Shift+V` — *Paste as plain text*.

##### *Capture* and *Ask* buttons

- `Shift+click` - Do the action without closing the *Capture* tab.
- `Ctrl+click` - Do the action and close the *Capture* tab.

##### Zoom and pan

- `Alt +` / `Alt −` (or `Ctrl+mouse-wheel`) — zoom in / out.
- `Ctrl+drag` (or middle-click drag) — pan.

##### Drawing

- `Shift+drag` — draw without snap and without grabbing resize handles.
- `Ctrl+Shift+drag` — draw without grabbing resize handles, with snap still on.
- Arrow keys while dragging — nudge the drag point by one output pixel.

#### Options

Open the **Options** page from the toolbar context menu or with the button on the *Capture* page.

You can configure:

- **Ask** button providers — Which web chat provider is the default, and which others show up.
- *Capture* page *Prompt* settings — `Enter` behavior, and whether to *Capture* or *Ask* by default.
- Default items to save — on the Capture page and when you double-click.
- Toolbar icon and context menu 
  - Default actions for *Click* and *Double-click*
  - Hotkeys (set on the Chrome settings page chrome://extensions/shortcuts)

### Claude Code skills

- `/see-what-i-see` — read the latest snapshot and describe it
- `/see-what-i-see-watch` — watch for new snapshots to appear in the background, and then look at them when they appear
- `/see-what-i-see-stop` — stop a running watch loop

If you've added a prompt with the snapshot, Claude will follow it.

You can also add prompts after the commands above and they'll be applied
on each snapshot. For example,

- `/see-what-i-see` `What font is the heading on this page?`
- `/see-what-i-see-watch` `Just report the snapshot filenames`

### Gemini CLI commands

- `/see-what-i-see` `[prompt]` — read the latest capture.
- `/see-what-i-see-watch` `[prompt]` — watch for new captures and
  describe each one.
  - Runs in the foreground. (Gemini has no async background worker with a completion callback)
  - The conversation stays paused on a blocking shell call between captures. 
  - Stop it by pressing *Escape*.
- `/see-what-i-see-xtract` `[prompt]` — alias for `/see-what-i-see`. Useful because Gemini shows auto-completes in reverse alphabetical order, so this name surfaces first.

### MCP server (*Experimental*)

The MCP server [`@see-what-i-see/mcp-server`](https://www.npmjs.com/package/@see-what-i-see/mcp-server) exposes the same operations as the skills above, so they work in any MCP-aware client (Claude Desktop, Cursor, Zed, Continue, etc.) — not just Claude Code and Gemini CLI.

Same two prompts:

- `see-what-i-see` — read the latest capture
- `see-what-i-see-watch` — watch for new captures and describe each one

How the prompts surface depends on the client. Claude Code exposes them as `/mcp__see-what-i-see__see-what-i-see` and `/mcp__see-what-i-see__see-what-i-see-watch`; most other clients show MCP prompts in a picker UI.

Some clients support an MCP server's tools but not its prompts. If your client doesn't support these prompts automatically from the MCP server, they are also available as plain skills under [`skills/mcp/`](skills/mcp/) — install those skills and they'll drive the `see-what-i-see` MCP server's tools directly.

See the [npm page](https://www.npmjs.com/package/@see-what-i-see/mcp-server) for details.

## Installation

### Chrome web store

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/seewhatisee/mdfeigicgahogllcdiibkeidfllhddae).**

> [!TIP]
> Pin the extension on your toolbar using **Pin to toolbar** on the **Manage extension** page, or using the "Extensions" (puzzle piece) toolbar icon.

### Claude Code plugin

Add the marketplace and install the plugin:

```bash
/plugin marketplace add jshute96/SeeWhatISee-claude
/plugin install see-what-i-see@see-what-i-see-marketplace
```

This loads the released version of the Claude plugin from the [SeeWhatISee-claude](https://github.com/jshute96/SeeWhatISee-claude) GitHub repository.

#### Avoiding permission prompts (Optional)

`/see-what-i-see-watch` triggers a permission prompt when it reads screenshot files after a background notification.

Add this to `$HOME/.claude/settings.json` to avoid those prompts.

```json
{
  "permissions": {
    "allow": [
      "Read(~/Downloads/SeeWhatISee/**)"
    ]
  }
}
```

### Gemini CLI extension

Install the Gemini extension:

```bash
gemini extensions install https://github.com/jshute96/SeeWhatISee-gemini
```

Add permissions in `$HOME/.gemini/settings.json` to avoid permission prompts:

```
{
  "tools": {
    "allowed": [
      "run_shell_command($HOME/.gemini/extensions/see-what-i-see/skills/see-what-i-see/scripts/copy-last-snapshot.sh)",
      "run_shell_command($HOME/.gemini/extensions/see-what-i-see/skills/see-what-i-see-watch/scripts/watch-and-copy.sh)",
      "run_shell_command($HOME/.gemini/extensions/see-what-i-see/skills/see-what-i-see-xtract/scripts/copy-last-snapshot.sh)"
    ]
  }
}
```

#### Manual install

If `gemini extensions install` directly from GitHub doesn't work, clone the release repo and install the extension from files.

```bash
git clone https://github.com/jshute96/SeeWhatISee-gemini.git
gemini extension install SeeWhatISee-gemini
```

### MCP server (*Experimental*)

Add this to your MCP client's config. The JSON shape is the same across most MCP-aware clients (only the config-file location varies):

```json
{
  "mcpServers": {
    "see-what-i-see": {
      "command": "npx",
      "args": ["-y", "@see-what-i-see/mcp-server"]
    }
  }
}
```

For Claude Code, this CLI command works (but the [plugin](#claude-code-plugin) is preferred):

```bash
claude mcp add see-what-i-see -- npx -y @see-what-i-see/mcp-server
```

See the [npm page](https://www.npmjs.com/package/@see-what-i-see/mcp-server) for per-client config-file paths and other details.

### Skills for other coding agents

The release has skill plugins for Claude and Gemini so far.
These skills and scripts may work for other coding agents too.

The released Claude skills are in [SeeWhatISee-claude](https://github.com/jshute96/SeeWhatISee-claude), under `plugin/skills`.

The released Gemini skills are in [SeeWhatISee-gemini](https://github.com/jshute96/SeeWhatISee-gemini), under `skills/`.

See [Developing skills](#developing-skills) below for more details.

## Output files

Everything the extension writes lands under
`~/Downloads/SeeWhatISee/`. A capture produces one or more capture
files plus an updated `log.json` sidecar.

### Capture files

Each capture writes one or more of these, by filename prefix:

- `screenshot-<timestamp>.png` — the captured PNG (or JPG).
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
- `imageUrl` — URL of a specific image the user captured on the page.

`filename` fields have file basenames in `log.json` in the `Downloads` folder.
The scripts that extract these records to pass to agents expand `filename` to hold absolute paths.

## Development

### Setup

```bash
npm install
npx playwright install chromium
```

### Developing skills

The `skills/` directory in this repository uses templates to generate similar skills tuned for different coding agents, and packaged for their plugin mechanisms. Adding more variations is possible.

The released skills are [linked above](#skills-for-other-coding-agents).
These may work for other coding agents too.

Differences:
* Claude scripts read the screenshot files in place. Gemini scripts copy them to a tmp directory first to avoid permission issues reading external files.
* The Claude `/see-what-i-see-watch` skill runs in the background. The Gemini version runs in the foreground.

Send a PR if you get skills working for another tool.

### Building

```bash
npm run build        # one-shot build into dist/
npm run watch        # rebuild on TS changes
```

### Install Chrome extension from source

The extension builds in `dist/`.

In Chrome: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `dist/` directory.

### Install Chrome extension from a release zip

1. Download `SeeWhatISee-extension-vX.Y.Z.zip` from the [Releases page](https://github.com/jshute96/SeeWhatISee/releases) and unzip it.
2. In Chrome: open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select the unzipped directory.

### Testing

```bash
npm test                  # validate skill templates, run unit + MCP-server + Playwright e2e tests
npm run test:skills       # validate skill templates only (fast, no build)
npm run test:e2e          # run Playwright e2e tests only
npm run test:headed       # same as test:e2e, with a visible browser
npm run test:unit         # run the HTML→markdown converter unit tests
npm run test:mcp-server   # run the MCP server's tests (in-memory transport)
```

The tests load the unpacked extension from `dist/` and drive it by
calling capture functions on the background service worker — Playwright
can't click the browser toolbar, so each capture mode is also exposed
on `self.SeeWhatISee` for test/console access.

### Updating the Claude plugin in marketplace

The plugin won't update if the version is the same.

To make an update possible, bump `plugins[0].version` in `skills/dot-claude-plugin/marketplace.json`. That's the field Claude Code uses for cache invalidation on this relative-path plugin; `plugin.json` intentionally has no `version` field. See `docs/claude-plugin.md` for the full story.

Users still need to run `/plugin marketplace update` followed by `/plugin` to pick up the new version — third-party marketplaces do not auto-update on startup.

Release new versions to users by running `skills/copy-claude-plugin-release.sh`, which mirrors `skills/claude-plugin/` and `skills/dot-claude-plugin/` into the sibling [SeeWhatISee-claude](https://github.com/jshute96/SeeWhatISee-claude) release repo. Commit and push that repo to publish.

The Gemini extension has the equivalent `skills/copy-gemini-extension-release.sh` for the [SeeWhatISee-gemini](https://github.com/jshute96/SeeWhatISee-gemini) release repo.

### Running the Claude plugin locally

For local development, a plugin directory can be set manually:

```bash
claude --plugin-dir $(pwd)/skills/claude-plugin
```

(The repo also auto-discovers the plugin via `.claude/skills/` symlinks, so running `claude` from inside this checkout normally works without the flag.)

### Watching for screenshots from CLI

```bash
scripts/SeeWhatISee.sh                          # print the latest capture record
scripts/SeeWhatISee.sh --watch                  # wait for the next capture, print it, exit
scripts/SeeWhatISee.sh --watch --loop           # keep printing captures until ^C
scripts/SeeWhatISee.sh --watch --pid-lockfile   # killable from another shell via --stop
scripts/SeeWhatISee.sh --stop                   # stop a watcher running with --pid-lockfile
```

### MCP server

`mcp-server/` holds a TypeScript MCP server that exposes the same captures the skills do (`get_latest`, `watch`) plus resources — captured files are readable as `file://` resources (discovered via the `resource_link`s in tool results) and a subscribable stream that pushes notifications when new captures arrive. It's a separate package, wired into the root install as an npm workspace, so the root `npm install` covers it.

Design doc: `docs/mcp-server.md`.

Build the single-file bundle:

```bash
npm run build:mcp-server
```

That produces `mcp-server/dist/seewhatisee-mcp.js` — a single bundled Node script with a `#!/usr/bin/env node` shebang, ready to run.

#### Try it with the MCP Inspector

The fastest way to poke at the server is the official inspector — a local web UI that lists tools, lets you call each one with form-filled args, reads/subscribes to resources, and renders prompts:

```bash
npx @modelcontextprotocol/inspector node "$(pwd)/mcp-server/dist/seewhatisee-mcp.js"
```

#### Try it in Claude Code

Register the bundled server with Claude Code (absolute path required):

```bash
claude mcp add see-what-i-see -- node "$(pwd)/mcp-server/dist/seewhatisee-mcp.js"
```

Inside any Claude Code session after that, the `get_latest` / `watch` tools are callable directly, captured files are readable as `file://` resources, and the `see-what-i-see` / `see-what-i-see-watch` prompts show up in the slash-command picker.

#### Tests

```bash
npm run test:mcp-server
```

End-to-end tests use the SDK's in-memory transport — no subprocess, no stdio framing, just a `Client` and `Server` linked inside one Node process.

#### Making an npm release of the MCP server

```bash
scripts/release-mcp-server.sh patch              # 0.1.0 → 0.1.1, GH release as draft
scripts/release-mcp-server.sh minor              # 0.1.0 → 0.2.0
scripts/release-mcp-server.sh patch --publish    # publish the GH release immediately
scripts/release-mcp-server.sh patch --no-gh-release   # npm-only release, skip GH
```

Bumps `mcp-server/package.json`, runs tests + build, commits, tags as `mcp-server-vX.Y.Z`, publishes to npm, pushes, and (by default) drafts a GitHub release. Requires `npm login` and `gh auth login` first. See the script header for the rollback recipe if `npm publish` fails after the local commit lands.

The first publish — to register the name on npm — is manual: `cd mcp-server && npm publish`. Subsequent releases use this script.

### Building a Chrome extension release

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

### Code layout

- `src/` — TypeScript sources and `manifest.json`:
  - `src/background/` — MV3 service-worker modules.
  - `src/ask/` — Ask-flow logic on the SW side.
  - `src/capture/` — SW-side "save a thing" pipeline.
  - `src/capture-page/` — Capture-page controller submodules.
  - `src/icons/` — toolbar action icons and provider brand logos.
- `dist/` — built extension (gitignored, loaded unpacked into Chrome)
- `scripts/build.mjs` — build script (cleans `dist/`, copies icons and
  manifest, runs `tsc`)
- `skills/` — Common templates for Claude and Gemini skills, and update scripts. Subtrees:
  - `skills/claude-plugin/` → `plugin/` in the [SeeWhatISee-claude](https://github.com/jshute96/SeeWhatISee-claude) release repo
  - `skills/dot-claude-plugin/` → `.claude-plugin/` in that release repo
  - `skills/dot-gemini/` → root of the [SeeWhatISee-gemini](https://github.com/jshute96/SeeWhatISee-gemini) release repo
- `mcp-server/` — standalone TS MCP server (npm workspace) that exposes
  captures over the Model Context Protocol; bundled to a single
  `dist/seewhatisee-mcp.js` for distribution
- `tests/e2e/` — Playwright tests
- `tests/fixtures/extension.ts` — fixture that loads the extension and
  exposes its service worker
- `docs/` — design docs and the file index

## License

The extension itself is MIT-licensed (see `LICENSE`). Bundled
third-party assets and their licenses are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
