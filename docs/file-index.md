# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `privacy_policy.md` | User-facing privacy policy linked from the Chrome Web Store listing |
| `THIRD_PARTY_NOTICES.md` | Attribution + license terms for bundled third-party assets — provider brand logos (Claude / Gemini / ChatGPT / Google) |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `package.json` | Node project manifest, scripts, devDependencies |
| `package-lock.json` | npm lockfile (auto-generated) |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `playwright.config.ts` | Playwright test runner config (default e2e suite) |
| `playwright.config.live.ts` | Playwright config for the live-provider suite (Claude / Gemini / ChatGPT / Google) — opt-in only |
| `.gitignore` | Git ignore rules |

## Local Claude Config (`.claude/`)

| File | Description |
|------|-------------|
| `.claude/settings.json` | Local dev settings — Bash permissions for the plugin scripts and `npm test` commands |
| `.claude/skills/see-what-i-see` | Symlink to `skills/claude-plugin/skills/see-what-i-see` |
| `.claude/skills/see-what-i-see-watch` | Symlink to `skills/claude-plugin/skills/see-what-i-see-watch` |
| `.claude/skills/see-what-i-see-stop` | Symlink to `skills/claude-plugin/skills/see-what-i-see-stop` |
| `.claude/skills/see-what-i-see-help` | Symlink to `skills/claude-plugin/skills/see-what-i-see-help` |

## Claude Commands (`.claude/commands/`)

| File | Description |
|------|-------------|
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — codereview then commit + push if clean |
| `.claude/commands/test-markdown-converter.md` | `/test-markdown-converter` slash command — tests the HTML→markdown converter against URLs / HTML files via parallel background agents |

## Skill Templates (`skills/`)

| File | Description |
|------|-------------|
| `skills/generate-skills.py` | Generator/validator that produces the Claude skill and Gemini command files from the templates below |
| `skills/json-record.template.md` | Shared block describing the `log.json` record shape, embedded via `[[...]]` |
| `skills/process.template.md` | Shared block describing how to process a capture record, embedded via `[[...]]` |
| `skills/claude.see.md` | Template for `skills/claude-plugin/skills/see-what-i-see/SKILL.md` |
| `skills/claude.watch.md` | Template for `skills/claude-plugin/skills/see-what-i-see-watch/SKILL.md` |
| `skills/claude.stop.md` | Template for `skills/claude-plugin/skills/see-what-i-see-stop/SKILL.md` |
| `skills/claude.help.md` | Template for `skills/claude-plugin/skills/see-what-i-see-help/SKILL.md` |
| `skills/gemini.see.md` | Template for `skills/dot-gemini/commands/see-what-i-see.toml` and the matching SKILL.md mirror |
| `skills/gemini.watch.md` | Template for `skills/dot-gemini/commands/see-what-i-see-watch.toml` and the matching SKILL.md mirror |
| `skills/gemini.xtract.md` | Template for the `see-what-i-see-xtract` SKILL.md alias — same body as `gemini.see.md`, description marks it as an alias |
| `skills/diff-claude-gemini.sh` | Dev helper — opens `meld` on the claude/gemini template pairs |
| `skills/copy-claude-plugin-release.sh` | Mirrors `skills/claude-plugin/` and `skills/dot-claude-plugin/` into `../SeeWhatISee-claude/plugin/` and `../SeeWhatISee-claude/.claude-plugin/` (rsync --delete; bails if release repo missing) |
| `skills/copy-gemini-extension-release.sh` | Mirrors each top-level entry under `skills/dot-gemini/` into the matching path at `../SeeWhatISee-gemini/` (subdirs rsync --delete; top-level files copy without --delete; bails if release repo missing) |

## Marketplace (`skills/dot-claude-plugin/`)

Mirrors `.claude-plugin/` in the `SeeWhatISee-claude` release repo (sibling clone). Published via `skills/copy-claude-plugin-release.sh`.

| File | Description |
|------|-------------|
| `skills/dot-claude-plugin/marketplace.json` | Marketplace index so other users can install the plugin (`source: "./plugin"` reflects the release-repo layout) |

## Claude Plugin (`skills/claude-plugin/`)

Mirrors `plugin/` in the `SeeWhatISee-claude` release repo. Published via `skills/copy-claude-plugin-release.sh`.

| File | Description |
|------|-------------|
| `skills/claude-plugin/.claude-plugin/plugin.json` | Plugin manifest — name and repository URL |
| `skills/claude-plugin/skills/see-what-i-see/scripts/get-latest.sh` | Print latest capture as JSON with absolute file paths |
| `skills/claude-plugin/skills/see-what-i-see/scripts/see-what-i-see_common.sh` | Shared helpers sourced by every per-skill script (sibling-relative): directory resolution, config parsing, JSON path absolutization, `kill_existing` watcher pidfile helper |
| `skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh` | CLI command to watch for new updates to `log.json` (also accepts `--stop` as a convenience) |
| `skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh` | Small script that just stops a running watcher — used by `/see-what-i-see-stop` |

**NOTE: the skills below are generated from `skills/`, do not edit directly**

| File | Description |
|------|-------------|
| `skills/claude-plugin/skills/see-what-i-see/SKILL.md` | `/see-what-i-see` — describe the latest capture |
| `skills/claude-plugin/skills/see-what-i-see-watch/SKILL.md` | `/see-what-i-see-watch` — describe each new capture as it arrives |
| `skills/claude-plugin/skills/see-what-i-see-stop/SKILL.md` | `/see-what-i-see-stop` — stop the watch loop |
| `skills/claude-plugin/skills/see-what-i-see-help/SKILL.md` | `/see-what-i-see-help` — summary of see-what-i-see commands |

## Gemini CLI Tree (`skills/dot-gemini/`)

Mirrors the top-level layout of the `SeeWhatISee-gemini` release repo (sibling clone) — each subdir and top-level file here lands as a sibling at the release-repo root, not under a `.gemini/` subdir. Published via `skills/copy-gemini-extension-release.sh`. Users install from the release repo into their own `~/.gemini/`.

| File | Description |
|------|-------------|
| `skills/dot-gemini/gemini-extension.json` | Gemini extension manifest — installed at the release-repo root |
| `skills/dot-gemini/skills/see-what-i-see/scripts/copy-last-snapshot.sh` | Emits the latest record from `log.json` via `see-what-i-see_common.sh`'s `emit_record` |
| `skills/dot-gemini/skills/see-what-i-see/scripts/see-what-i-see_common.sh` | Shared Gemini-script helpers (sibling-relative source target) — directory resolution, log.json mtime, per-record copy + path rewrite |
| `skills/dot-gemini/skills/see-what-i-see-watch/scripts/watch-and-copy.sh` | Emits one new capture per invocation — supports `--after TIMESTAMP` for loop catch-up and `--help` |
| `skills/dot-gemini/skills/see-what-i-see-xtract/scripts/copy-last-snapshot.sh` | Thin wrapper — execs the sibling `see-what-i-see/scripts/copy-last-snapshot.sh` so the alias shares one implementation |

**NOTE: the SKILL.md files below are generated from `skills/`, do not edit directly**

| File | Description |
|------|-------------|
| `skills/dot-gemini/skills/see-what-i-see/SKILL.md` | `/see-what-i-see` — describe the latest capture (Gemini side) |
| `skills/dot-gemini/skills/see-what-i-see-watch/SKILL.md` | `/see-what-i-see-watch` — foreground loop that describes each new capture |
| `skills/dot-gemini/skills/see-what-i-see-xtract/SKILL.md` | Alias of `see-what-i-see` SKILL — surfaces first in Gemini's reverse-alphabetical autocomplete |

## Extension Source (`src/`)

- **`src/` (top level)** — entry-point files and pure shared helpers.
- **`src/background/`** — MV3 service-worker modules.
- **`src/background/ask/`** — Ask-flow logic on the SW side.
- **`src/capture/`** — SW-side "save a thing" pipeline.
- **`src/capture-page/`** — Capture-page controller submodules.
- **`src/icons/`** — toolbar action icons and provider brand logos.

### Top-level (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 manifest, copied verbatim into `dist/` |
| `src/background.ts` | MV3 service worker entrypoint — wires Chrome event listeners to the modules under `src/background/` and exposes `self.SeeWhatISee` for tests |
| `src/capture.ts` | Capture entry points (`captureVisible`/`savePageContents`/`captureSelection`/`captureBothToMemory`/`scrapeSelection`), record types, `recordDetailedCapture` + `saveCapture` — orchestrates the submodules under `src/capture/` |
| `src/capture.html` | Capture page — page-card, save options, edit dialogs, prompt, drawing-tool palette + image overlay; stale-load error pane when opened without a SW session |
| `src/capture-page.ts` | Controller for `capture.html`: page-card, prompt, save options, Copy-filename clipboard, Edit dialogs, bake-in — orchestrates the submodules under `src/capture-page/` |
| `src/ask-inject.ts` | MAIN-world helpers (attach files, type prompt, click submit) callable individually via a `window.postMessage` bridge from the widget; chip-count gate per call |
| `src/ask-widget.ts` | ISOLATED-world status widget — drives the inject via a postMessage bridge, renders per-item rows with retry, copy-to-clipboard recovery |
| `src/scrape-page-state.ts` | Self-contained page-context worker (HTML + selection scrape) injected into tabs via `executeScript` and reused by tests |
| `src/markdown.ts` | Pure HTML → markdown + HTML → text converter plus markdown-source detection (selection capture + paste) |
| `src/shrink.ts` | Pure pixel-buffer operator that tightens a rectangle around its content — backs the Capture-page Shrink button |
| `src/url-helpers.ts` | Pure URL helpers (no DOM) — `firstUrlSegment` with 20-char truncation, `excludedSuffix` for the Ask menu's disabled-tab annotation |
| `src/options.html` | Extension options page — Ask provider settings, Save-checkbox defaults, Click / Double-click radios per selection state, hotkey display |
| `src/options.ts` | Controller for `options.html`: fetches state from the SW, renders all sections, multi-line hotkey cells, immediate + delayed action sections, saves via `setOptions` |
| `src/shared-styles.css` | Page-wide `.btn` chrome + `.app-header` / `.app-footer` bar layout/colour + `.header-btn` trailing chrome shared by `capture.html` and `options.html` |
| `src/offscreen.html` | Hidden offscreen document that hosts the clipboard-write helper for the service worker |
| `src/offscreen.ts` | Receives `offscreen-copy` messages from the SW and writes their text to the clipboard via `execCommand('copy')` |

### Background SW modules (`src/background/`)

| File | Description |
|------|-------------|
| `src/background/error-reporting.ts` | Capture-failed-page error surface: `runWithErrorReporting`, `reportCaptureError`, `friendlyErrorMessage`, unhandled-rejection suppression |
| `src/background/session-quota.ts` | Pre-flight `chrome.storage.session` quota check + size-aware error formatter shared by the Capture, Upload, and Ask write paths |
| `src/background/capture-actions.ts` | `CAPTURE_ACTIONS` table — base actions × delays, the `captureUrlOnly` / `saveDefaults` / `captureAll` shortcuts, delay/title helpers |
| `src/background/default-action.ts` | Click + Double-click defaults (with/without selection), `handleActionClick` dispatcher, `runDblDefault`, `getDefaultActionTooltip` builder |
| `src/background/tooltip.ts` | Pure toolbar-tooltip layout — single-line `Save X or Y` row collapse + `saveDefaultsMenuTitle` shared with the menu side |
| `src/background/menu-hint.ts` | Pure menu-hint composition — `rowScope`, `buildRowGroup`, `buildMenuHint`; extracted for unit-testability without the chrome.* import chain |
| `src/background/context-menu.ts` | Right-click menu: `installContextMenu`, hotkey-aware title refresh, More-submenu utilities (copy-last, snapshots dir, offscreen clipboard) |
| `src/background/capture-details.ts` | Capture-page flow — per-tab session, `ensure*Downloaded` cache, multi-capture bump, HTML byte-size cap, `runtime.onMessage` handlers |
| `src/background/capture-page-defaults.ts` | Stored Capture-page settings — Save-checkbox defaults, default button, Prompt Enter behavior; shape + normalize/get/set |
| `src/background/options.ts` | SW-side options-page wire — `runtime.onMessage` handlers for `getOptionsData` / `setOptions` |

### Ask flow, SW side (`src/background/ask/`)

| File | Description |
|------|-------------|
| `src/background/ask/index.ts` | Ask flow orchestration — `sendToAi`, `listAskProviders`, `resolveAsk` (default destination + stale-pin detection), `installAskMessageHandler`; pins last destination in `chrome.storage.session` |
| `src/background/ask/providers.ts` | Provider registry types and the `ASK_PROVIDERS` array |
| `src/background/ask/settings.ts` | User-facing Ask provider preferences — per-provider enabled flags + default provider; normalize/get/set with auto-shift on disable |
| `src/background/ask/claude.ts` | Claude provider data — URLs, ranked selectors, and a `urlVariants` entry for the image-only `/code` (Claude Code) sub-page |
| `src/background/ask/gemini.ts` | Gemini provider data — adds `preFileInputClicks` since Gemini's file input is created on-demand by its upload menu |
| `src/background/ask/chatgpt.ts` | ChatGPT provider data — `#upload-files` is in the initial DOM so no preFileInputClicks; declares `attachmentPreview` for chip-count verification |
| `src/background/ask/google.ts` | Google Search provider — `newTabOnly` (no pinning), image-only via `acceptedAttachmentKinds`, types into the search textarea and submits to `/search` |
| `src/background/ask/widget-store.ts` | `chrome.storage.session` wrapper for the in-page Ask widget — record per destination tabId with overall status, per-item state, payload, plus tab-removal cleanup |

### Capture hub (`src/capture/`)

| File | Description |
|------|-------------|
| `src/capture/types.ts` | Wire-format types and constants shared across the capture pipeline (`CaptureRecord`, `InMemoryCapture`, `SelectionFormat`, `SELECTION_EXTENSIONS`, `noSelectionContentMessage`, …) — imported by `capture.ts`, the sibling submodules, and SW consumers without going through the hub |
| `src/capture/recompress.ts` | Capture-time PNG→JPEG recompress (`maybeRecompressLargeScreenshot`) + threshold consts + `_setLargeScreenshotThresholdForTest` |
| `src/capture/downloads.ts` | Download helpers — `DOWNLOAD_SUBDIR`, `downloadArtifact`/`htmlDataUrl`, `downloadScreenshot`/`downloadHtml`/`downloadSelection`, `waitForDownloadComplete` |
| `src/capture/log-store.ts` | Capture log + on-disk `log.json` sidecar — `LOG_STORAGE_KEY`, `clearCaptureLog`/`appendToLog`/`writeJsonFile`/`serializeRecord`/`serializeWrite`, `compactTimestamp` |
| `src/capture/image-source.ts` | Image-source capture paths — `captureImageToMemory`/`captureImageAsScreenshot`/`captureImageTabToMemory`/`probeActiveTabImage`/`fetchImageBytes`, image MIME tables, `imageExtensionFor` |

### Capture-page modules (`src/capture-page/`)

| File | Description |
|------|-------------|
| `src/capture-page/paste.ts` | Capture-page rich-text paste — `attachHtmlAwarePaste` (text/html → markdown or HTML-source), highlighter / markdown detection, nbsp normalization |
| `src/capture-page/ask.ts` | Capture-page Ask flow — `initAsk(ctx)`: split-button label refresh, destination menu, per-provider buttons, payload build, send + pre-send guard, cross-tab storage listener |
| `src/capture-page/zoom.ts` | Capture-page Image fit / Zoom / Pan — `initZoom(ctx)`: fit/Nx sizing, zoom menu, Ctrl+wheel + Alt+± step, middle-click + Ctrl-left pan, last-mouse-pos cache |
| `src/capture-page/drawing.ts` | Capture-page highlight overlay — `initDrawing(ctx)`: edits / history / polyline / boxDrag state, snap-to, render, drawViewportEdges, Shrink, tool palette; bake helpers (`hasBakeableEdits`, `editFlags`, `activeCrop`, `arrowBarbs`, `pctRectToPixels`) and `__seeState` hooks exported for main |
| `src/capture-page/edit-dialog.ts` | Capture-page Edit dialogs — `initEditDialogs(ctx)` builds the per-kind catalog (HTML / selection HTML / text / markdown), wires Edit/Preview, Save, Cancel, Download; `anyEditDialogOpen()` for the page-wide Alt-shortcut suspend |
| `src/capture-page/upload.ts` | Capture-page upload landing — `handleUploadFlow(ctx)`: wires the file picker, validates / decodes / sends `initializeUploadSession`, scrubs `?upload=true` from the URL, hands off to the caller for re-load |
| `src/capture-page/pills.ts` | Capture-page Image / HTML / Selection size pills — `initPills(ctx)`, per-pill refreshers + `setScreenshotErrored`, `formatBytes`, `composeImageBadgeText`; image pill includes live cropped-dim updates from a crop drag |
| `src/capture-page/save-as.ts` | Capture-page per-row Save-as buttons + drawing-palette Copy-image / Save-image — `initSaveAs(ctx)`, plus `downloadEditableAs` shared with the in-dialog Download button in edit-dialog.ts |

### Icons (`src/icons/`)

| File | Description |
|------|-------------|
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons |
| `src/icons/{claude.svg,gemini.svg,chatgpt.ico,google.ico}` | Provider brand logos used by the Capture page's per-provider Ask buttons (favicon-only squares) |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies vendor scripts + theme, classic-wraps codejar, then runs `tsc` |
| `scripts/_release-common.sh` | Sourced helpers for release scripts (gh check, clean-main check, tag-unused check, orphaned-tag trap) |
| `scripts/release-extension.sh` | Cuts a GitHub release for the Chrome extension (tag `extension-vX.Y.Z`); builds the zip and runs `gh release create` (draft by default) |
| `scripts/zip_extension.sh` | Builds + zips `dist/` to `/tmp/SeeWhatISee.zip` (or `-extension-vVERSION.zip` with `--release VERSION`) |
| `scripts/test-md-slice.mjs` | Fetches a URL / reads an HTML file, slices main content at balanced tag boundaries, runs each slice through the markdown converter, emits a structured report |
| `scripts/open-test-browser.sh` | Launches Playwright's Chromium with the extension + remote debugging on port 9222 + persistent profile, used by the live e2e suite (CDP-attach pattern; sidesteps Google's automation block) |
| `scripts/copy-last-snapshot.sh` | Dev-convenience wrapper — `exec`s `skills/dot-gemini/skills/see-what-i-see/scripts/copy-last-snapshot.sh` |
| `scripts/get-latest.sh` | Dev-convenience wrapper — `exec`s `skills/claude-plugin/skills/see-what-i-see/scripts/get-latest.sh` |
| `scripts/stop.sh` | Dev-convenience wrapper — `exec`s `skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh` |
| `scripts/watch-and-copy.sh` | Dev-convenience wrapper — `exec`s `skills/dot-gemini/skills/see-what-i-see-watch/scripts/watch-and-copy.sh` |
| `scripts/watch.sh` | Dev-convenience wrapper — `exec`s `skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh` |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/demo.html` | Demo page for screenshot-based interaction |
| `tests/fixtures/extension.ts` | Playwright fixtures: persistent Chromium context with the extension loaded, fixture HTTP server, and a `getServiceWorker()` helper |
| `tests/fixtures/capture-quota.ts` | Smart pre-test wait + auto-retry for `chrome.tabs.captureVisibleTab`'s 2/sec quota; replaces the unconditional 600ms sleep |
| `tests/fixtures/files.ts` | Test helpers for resolving downloads, sampling PNG pixels, and verifying capture sidecars |
| `tests/fixtures/pages/{purple,green,orange}.html` | Solid-color fixture pages used for pixel-verifiable screenshot tests |
| `tests/fixtures/pages/gradient.html` | Multi-stop linear-gradient page — used by the large-screenshot-recompress e2e to produce a capture where JPEG clearly beats PNG |
| `tests/fixtures/pages/shrink-target.html` | Grey page with a single centered black 50%×50% block — deterministic content for the Shrink-tool e2e tests |
| `tests/fixtures/pages/shrink-nested.html` | Grey page → blue card → red inner block — exercises the two-step Shrink (page bg → card → inner block) e2e |
| `tests/fixtures/pages/red-image.html` | Fixture page with `<img>`s (http PNG, inline JPEG data URL, http JPEG, http WEBP) for the image-context capture e2e tests |
| `tests/fixtures/pages/red-pixel.png` | 200x200 solid-red PNG used as the `<img>` source in `red-image.html` |
| `tests/fixtures/pages/red-pixel.jpg` | 200x200 solid-red JPEG counterpart for tests that exercise the JPEG sticky bake-in path |
| `tests/fixtures/pages/red-pixel.webp` | 200x200 solid-red WEBP — used by tests that exercise the "non-PNG/JPG source bakes to PNG" branch |
| `tests/fixtures/pages/corrupt.png` | Text file named `.png` — passes the MIME-prefix check but fails image decode; used by the upload-spec decode-validation test |
| `tests/e2e/screenshot.spec.ts` | E2E tests for `captureVisible` (basic capture, delay, navigate-during-delay, tab-switch, clear log) |
| `tests/e2e/html-snapshot.spec.ts` | E2E test for `savePageContents` (HTML capture + sidecar verification) |
| `tests/e2e/capture-with-details.spec.ts` | E2E for the Capture page flow core — save-option matrix (PNG/HTML/URL combos) and tab positioning/focus-return |
| `tests/e2e/capture-details-copy.spec.ts` | E2E for the Capture page's copy-filename buttons and per-tab download-cache semantics (including drawing-invalidates-cache) |
| `tests/e2e/capture-details-edit.spec.ts` | E2E for the edit-html / edit-selection dialogs, Preview toggle / sandboxed iframe, and scrape-failure UX |
| `tests/e2e/capture-paste.spec.ts` | E2E for rich-text paste — html→markdown / html-source routing, source-view short-circuit, real copy/paste round-trips |
| `tests/e2e/capture-prompt-enter.spec.ts` | E2E for the Capture-page Prompt Enter behaviour and `defaultButton` setting — ring placement, plain/Shift/Ctrl/`\`+Enter routing, `triggerCapture` hand-off |
| `tests/e2e/capture-details-download.spec.ts` | E2E for the per-row Save-as buttons + the in-dialog Download button (filenames, MIME, committed vs. uncommitted edits, cancel-doesn't-leak) |
| `tests/e2e/capture-drawing-helpers.ts` | Shared `__seeState` reads and the `dragEdge` / `expectRedAtRectEdge` utilities for the drawing specs |
| `tests/e2e/capture-drawing-basic.spec.ts` | E2E for per-tool draw → save flows (Box/Line/Arrow/Crop/Redact) and Undo/Clear button state |
| `tests/e2e/capture-drawing-resize-nudge.spec.ts` | E2E for box-edge resize, arrow-key nudge of an in-flight drag, and visible-pane clamping under zoom |
| `tests/e2e/capture-drawing-polyline.spec.ts` | E2E for Polyline / Poly-arrow chains and the Ctrl-promote shortcut, plus chain-lifetime edge cases |
| `tests/e2e/capture-drawing-snap.spec.ts` | E2E for snap-to behaviour — corners, edges, endpoints, axis-align, line projection, polyline loop close |
| `tests/e2e/capture-drawing-palette.spec.ts` | E2E for the palette Save / Copy buttons on the Capture page, with and without edits |
| `tests/e2e/capture-drawing-shrink.spec.ts` | E2E for the Shrink-tool operator — per-mode enable state, history/Undo wiring, drill-through on nested fixtures |
| `tests/e2e/capture-zoom.spec.ts` | E2E for zoom-mode sizing (1× = source-CSS-px parity via `naturalSize / DPR`), Fit cap, and stroke-width ladder + DPR-stub regressions |
| `tests/e2e/toolbar-dispatch.spec.ts` | E2E for toolbar click routing — `handleActionClick`, with-selection dispatch, default-id migration, `copyLastSelectionFilename` |
| `tests/e2e/details-helpers.ts` | Shared helpers for the Capture page flow specs — flow open, capture submit, editor read/write, clipboard + SW/page download spies |
| `tests/e2e/scrape-page-state.spec.ts` | Direct coverage for `scrapePageStateInPage` — real / no / CodeMirror-style fake / empty selections, `includeHtml` flag |
| `tests/e2e/more-captures.spec.ts` | E2E for the More-submenu shortcuts: `captureUrlOnly` (URL-only record) and `captureAll` (PNG + HTML + selection-if-any + record) |
| `tests/e2e/capture-image-context.spec.ts` | E2E for the image right-click flow — Save-screenshot bytes/path, Capture-page defaults, `imageUrl` persistence (incl. screenshot-unchecked), quiet-disabled HTML, JPEG format preservation (canvas fallback + MIME normalization) |
| `tests/e2e/capture-image-tab.spec.ts` | E2E for the image-tab routing — `captureVisible` / `captureAll` / `startCaptureWithDetails` on a bare image URL save source bytes, skip HTML, open the Capture page in upload-flow shape |
| `tests/e2e/copy-button-pressed.spec.ts` | E2E that Copy buttons hold `.pressed` for the async SW + writeText lifetime and clear it (incl. on error) |
| `tests/e2e/webp-png-cache-edit-sync.spec.ts` | E2E regression — WEBP source: repeat-Copy and same-revision multi-Capture keep `.png` ext aligned with on-disk bytes |
| `tests/e2e/large-screenshot-recompress.spec.ts` | E2E for capture-time PNG→JPEG recompress — JPEG wins on gradient, kept-PNG on solid color, threshold short-circuit |
| `tests/e2e/html-size-cap.spec.ts` | E2E for the HTML byte-size cap — capture-time rejection, under-cap pass-through, edit-save rejection |
| `tests/e2e/upload-image.spec.ts` | E2E for the "Upload image to Capture..." entry — landing card, type/decode validation, menu-routing seam, PNG/JPG happy paths, JPG-stays-JPG sticky bake, WEBP→PNG conversion, multi-capture bump regression |
| `tests/e2e/image-size-pill.spec.ts` | E2E for the Capture-page Image-size pill (`#image-size-badge`) — pill text matches saved dims/bytes, JPG stays JPG on bake (sticky), WEBP→PNG label flip on bake, live dim updates during a Crop-tool drag |
| `tests/e2e/get-latest.spec.ts` | Tests for `scripts/get-latest.sh` (absolute paths, config file, error cases) |
| `tests/e2e/copy-last-snapshot.spec.ts` | Tests for `scripts/copy-last-snapshot.sh` (copy + path rewrite to TARGET_DIR) |
| `tests/e2e/watch.spec.ts` | Standalone tests for `scripts/watch.sh` (once/loop, `--after`, `--stop`, config file, absolute paths) |
| `tests/e2e/error-reporting.spec.ts` | E2E tests for `reportCaptureError` / `runWithErrorReporting` — spies on `chrome.tabs.create` to verify the Capture-failed page URL and friendly rewrites |
| `tests/e2e/options-refresh.spec.ts` | E2E test for the Options-page hotkey-refresh hook — opening Options resyncs the toolbar tooltip when shortcut bindings have changed |
| `tests/e2e/ask.spec.ts` | E2E tests for the Ask AI flow — menu rendering, exclude patterns, empty-payload guard, inject runtime, Alt+A keyboard binding |
| `tests/e2e/ask-pinned-tabs.spec.ts` | E2E tests for target-window pinning — pin lifecycle, dead/navigated/disabled-provider invalidation, plain-Ask reuse |
| `tests/e2e/ask-toolbar-pin.spec.ts` | E2E tests for the toolbar context-menu Set/Unset entry — eligibility, "Set"/"Unset" title flip, toggle behavior |
| `tests/e2e/ask-url-variants.spec.ts` | E2E tests for `urlVariants` — pre-send guard refuses unsupported kinds; Claude Code happy path (image + prompt) sends end-to-end |
| `tests/unit/ask-resolvers.test.mjs` | Unit tests for `resolveAcceptedKinds`, `resolveDestinationLabel`, `formatKindList` — pure helpers used by the URL-variant resolver |
| `tests/e2e/ask-helpers.ts` | Shared scaffolding for the Ask specs — fake-Claude state reader, provider-override seam, per-test hooks (snapshot/restore + pin reset) |
| `tests/fixtures/pages/fake-claude.html` | Fake claude.ai composer (file input + ProseMirror-class contenteditable + Send button) used by the Ask specs so tests don't talk to the real claude.ai |
| `tests/e2e-live/lib/types.ts` | `LiveProvider` plugin contract for the live test suite — selectors plus per-provider DOM-verification helpers |
| `tests/e2e-live/lib/bridge.ts` | Shared postMessage-bridge driver (`callBridge`, `driveBridge`) that mirrors the widget's `callMain` so live specs exercise the same code path |
| `tests/e2e-live/lib/live-suite.ts` | Shared live-test cases parameterized by a `LiveProvider` — runs the same five tests against any provider |
| `tests/e2e-live/claude.live.spec.ts` | Claude `LiveProvider` wiring (selectors imported from `claude.ts`, data-testid-based locators) — calls `runLiveSuite` |
| `tests/e2e-live/claude-code.live.spec.ts` | Claude Code `LiveProvider` wiring — reuses Claude's selectors / locators, declares `acceptedAttachmentKinds: ['image']`; the shared suite swaps in extra images for the text-payload tests |
| `tests/e2e-live/gemini.live.spec.ts` | Gemini `LiveProvider` wiring (selectors imported from `gemini.ts`, Quill + `uploader-file-preview` chips + Angular `user-query` locators) — calls `runLiveSuite` |
| `tests/e2e-live/chatgpt.live.spec.ts` | ChatGPT `LiveProvider` wiring (selectors imported from `chatgpt.ts`, `group/file-tile` chips + `data-message-author-role="user"` bubble) — calls `runLiveSuite` |
| `tests/e2e-live/google.live.spec.ts` | Google live spec — custom (skips `runLiveSuite`); selectors smoke check, image-attaches-no-submit, image+prompt submit navigates to `/search?q=…` |

## Unit Tests (`tests/unit/`)

| File | Description |
|------|-------------|
| `tests/unit/markdown.test.mjs` | Pure unit tests for `src/markdown.ts` — run via `node --test` (no browser required) |
| `tests/unit/ask-glob.test.mjs` | Unit tests for the URL-glob matcher in `src/background/ask/index.ts` (`globMatch` / `matchesAny`) |
| `tests/unit/ask-inject-error.test.mjs` | Unit tests for `friendlyInjectError` in `src/background/ask/index.ts` (policy block error propagation) |
| `tests/unit/ask-settings.test.mjs` | Unit tests for the Ask provider settings normalizer + default-rotation helper |
| `tests/unit/url-helpers.test.mjs` | Unit tests for `src/url-helpers.ts` — first-segment extraction, 20-char truncation boundary, the bare-suffix fallback |
| `tests/unit/image-extension.test.mjs` | Unit tests for `imageExtensionFor` — MIME table, URL-pathname fallback, `.unknown` final fallback |
| `tests/unit/tooltip.test.mjs` | Unit tests for `src/background/tooltip.ts` — `expandFragment`, `combineFragments`, `buildRow`, `saveDefaultsMenuTitle`, full `buildTooltip` |
| `tests/unit/menu-hint.test.mjs` | Unit tests for `src/background/menu-hint.ts` — `rowScope`, `buildRowGroup`, `buildMenuHint`, plus a sentinel-pin grep against `default-action.ts` |
| `tests/unit/shrink.test.mjs` | Unit tests for `src/shrink.ts` — solid bg / h-line / gradient / noise tolerance / wall collapse / clamp / patterned interior |
| `tests/unit/session-quota.test.mjs` | Unit tests for `src/background/session-quota.ts` — `estimateRecordBytes`, `formatBytes`, `formatQuotaError`, `checkSessionStorageRoom` (with a `chrome.storage.session` stub) |
| `tests/unit/error-reporting.test.mjs` | Unit tests for `friendlyErrorMessage` — covers each rewritten throw-site string plus the verbatim-passthrough fallback |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `architecture.md` | High-level architecture: components, storage model, sidecar JSON shape, handoff to coding agents |
| `capture-actions.md` | Action catalog (`CAPTURE_ACTIONS`), default-click dispatch, toolbar / image / keyboard menus, adding a new capture mode |
| `capture-page.md` | Capture-page flow, image annotation, edit dialogs, copy-filename buttons, save and close, multi-capture filename strategy |
| `chrome-extension.md` | Chrome MV3 hazards: SW lifecycle, permissions rationale, error surface, context-menu gotchas, image-fetch strategies |
| `testing.md` | Playwright + devtools-console patterns for testing the extension |
| `smart-paste.md` | Rich-text paste on the Capture page — modes, `cleanCopiedHtml`, `shouldPasteAsText`, build wiring |
| `options-and-settings.md` | Stored toolbar defaults + Capture-page Save defaults: storage shapes, dispatch, tooltip, Options page layout/wire |
| `ask-on-web.md` | "Ask AI" flow — Capture-page UI, provider registry, send flow, injected runtime, ProseMirror notes, diagnostics |
| `ask-widget.md` | In-page status / recovery widget — UI, theming, per-item orchestration, cross-world bridge, storage record, retry / cancel-and-replace |
| `ask-live-tests.md` | Manual live e2e suite — CDP-attach pattern, setup, design principles (token economy, library-only injection), troubleshooting, adding a provider |
| `claude-plugin.md` | Notes on the Claude Code plugin (marketplace/plugin manifests, install flow, `${CLAUDE_SKILL_DIR}` script references, local-dev shim) |
| `cli_commands.md` | Per-CLI command inventory (Claude / Gemini), their backing scripts, and the per-tree `see-what-i-see_common.sh` helpers |
| `images/copy-icon.png` | Inline icon image referenced from the README's Capture-page bullet for the Copy button |
| `images/edit-icon.png` | Inline icon image referenced from the README's Capture-page bullet for the Edit button |
| `images/download-icon.png` | Inline icon image referenced from the README's Capture-page bullet for the Save-as button |
