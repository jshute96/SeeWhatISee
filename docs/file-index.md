# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `privacy_policy.md` | User-facing privacy policy linked from the Chrome Web Store listing |
| `THIRD_PARTY_NOTICES.md` | Attribution + license terms for bundled third-party assets (currently the Material Symbols pin / pin-off / new-window icons) |
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
| `.claude/settings.json` | Local dev settings — sets `CLAUDE_PLUGIN_ROOT=plugin` |
| `.claude/skills/see-what-i-see` | Symlink to `plugin/skills/see-what-i-see` |
| `.claude/skills/see-what-i-see-watch` | Symlink to `plugin/skills/see-what-i-see-watch` |
| `.claude/skills/see-what-i-see-stop` | Symlink to `plugin/skills/see-what-i-see-stop` |
| `.claude/skills/see-what-i-see-help` | Symlink to `plugin/skills/see-what-i-see-help` |

## Claude Commands (`.claude/commands/`)

| File | Description |
|------|-------------|
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — codereview then commit + push if clean |
| `.claude/commands/test-markdown-converter.md` | `/test-markdown-converter` slash command — tests the HTML→markdown converter against URLs / HTML files via parallel background agents |

## Skill Templates (`src/skills_templates/`)

| File | Description |
|------|-------------|
| `src/skills_templates/generate-skills.py` | Generator/validator that produces the Claude skill and Gemini command files from the templates below |
| `src/skills_templates/json-record.template.md` | Shared block describing the `log.json` record shape, embedded via `[[...]]` |
| `src/skills_templates/process.template.md` | Shared block describing how to process a capture record, embedded via `[[...]]` |
| `src/skills_templates/claude.see.md` | Template for `plugin/skills/see-what-i-see/SKILL.md` |
| `src/skills_templates/claude.watch.md` | Template for `plugin/skills/see-what-i-see-watch/SKILL.md` |
| `src/skills_templates/claude.stop.md` | Template for `plugin/skills/see-what-i-see-stop/SKILL.md` |
| `src/skills_templates/claude.help.md` | Template for `plugin/skills/see-what-i-see-help/SKILL.md` |
| `src/skills_templates/gemini.see.md` | Template for `.gemini/commands/see-what-i-see.toml` |
| `src/skills_templates/gemini.watch.md` | Template for `.gemini/commands/see-what-i-see-watch.toml` |
| `src/skills_templates/diff-claude-gemini.sh` | Dev helper — opens `meld` on the claude/gemini template pairs |

## Marketplace (`.claude-plugin/`)

| File | Description |
|------|-------------|
| `.claude-plugin/marketplace.json` | Marketplace index so other users can install the plugin |

## Claude Plugin (`plugin/`)

| File | Description |
|------|-------------|
| `plugin/.claude-plugin/plugin.json` | Plugin manifest — name and repository URL |
| `plugin/scripts/_common.sh` | Shared helpers: directory resolution, config parsing, JSON path absolutization |
| `plugin/scripts/get-latest.sh` | Print latest capture as JSON with absolute file paths |
| `plugin/scripts/watch.sh` | CLI command to watch for new updates to `log.json` |

**NOTE: the skills below are generated from `src/skills_templates/`, do not edit directly**

| File | Description |
|------|-------------|
| `plugin/skills/see-what-i-see/SKILL.md` | `/see-what-i-see` — describe the latest capture |
| `plugin/skills/see-what-i-see-watch/SKILL.md` | `/see-what-i-see-watch` — describe each new capture as it arrives |
| `plugin/skills/see-what-i-see-stop/SKILL.md` | `/see-what-i-see-stop` — stop the watch loop |
| `plugin/skills/see-what-i-see-help/SKILL.md` | `/see-what-i-see-help` — summary of see-what-i-see commands |

## Gemini CLI Commands (`.gemini/`)

| File | Description |
|------|-------------|
| `.gemini/scripts/_common.sh` | Shared Gemini-script helpers — directory resolution, log.json mtime, per-record copy + path rewrite |
| `.gemini/scripts/copy-last-snapshot.sh` | Emits the latest record from `log.json` via `_common.sh`'s `emit_record` |
| `.gemini/scripts/watch-and-copy.sh` | Emits one new capture per invocation — supports `--after TIMESTAMP` for loop catch-up and `--help` |

**NOTE: the commands below are generated from `src/skills_templates/`, do not edit directly**

| File | Description |
|------|-------------|
| `.gemini/commands/see-what-i-see.toml` | Gemini CLI command — describes the latest capture (uses `copy-last-snapshot.sh`) |
| `.gemini/commands/see-what-i-see-watch.toml` | Gemini CLI command — foreground watch loop that describes each new capture (uses `watch-and-copy.sh`) |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 manifest, copied verbatim into `dist/` |
| `src/background.ts` | MV3 service worker entrypoint — wires Chrome event listeners to the modules under `src/background/` and exposes `self.SeeWhatISee` for tests |
| `src/background/error-reporting.ts` | Icon/tooltip error surface: `runWithErrorReporting`, `reportCaptureError`, `clearCaptureError`, unhandled-rejection suppression |
| `src/background/capture-actions.ts` | `CAPTURE_ACTIONS` table — base actions × delays, the `captureUrlOnly` / `saveDefaults` / `captureAll` shortcuts, delay/title helpers |
| `src/background/default-action.ts` | Click + Double-click defaults (with/without selection), `handleActionClick` dispatcher, `runDblDefault`, `getDefaultActionTooltip` builder |
| `src/background/tooltip.ts` | Pure toolbar-tooltip layout — `buildTooltip` + per-row Case 1–4 algorithm, factored out so the logic is unit-testable |
| `src/background/context-menu.ts` | Right-click menu: `installContextMenu`, hotkey-aware title refresh, More-submenu utilities (copy-last, snapshots dir, offscreen clipboard) |
| `src/background/capture-details.ts` | Capture-page flow — per-tab session, `ensure*Downloaded` artifact cache, `runtime.onMessage` handlers |
| `src/background/capture-page-defaults.ts` | Stored Capture-page settings — Save-checkbox defaults, default button, Prompt Enter behavior; shape + normalize/get/set |
| `src/background/options.ts` | SW-side options-page wire — `runtime.onMessage` handlers for `getOptionsData` / `setOptions` |
| `src/background/ask/index.ts` | Ask flow orchestration — `sendToAi`, `listAskProviders`, `resolveAsk` (default destination + stale-pin detection), `installAskMessageHandler`; pins last destination in `chrome.storage.session` |
| `src/background/ask/providers.ts` | Provider registry types and the `ASK_PROVIDERS` array |
| `src/background/ask/settings.ts` | User-facing Ask provider preferences — per-provider enabled flags + default provider; normalize/get/set with auto-shift on disable |
| `src/background/ask/claude.ts` | Claude provider data — URLs, ranked selectors, and a `urlVariants` entry for the image-only `/code` (Claude Code) sub-page |
| `src/background/ask/gemini.ts` | Gemini provider data — adds `preFileInputClicks` since Gemini's file input is created on-demand by its upload menu |
| `src/background/ask/chatgpt.ts` | ChatGPT provider data — `#upload-files` is in the initial DOM so no preFileInputClicks; declares `attachmentPreview` for chip-count verification |
| `src/background/ask/google.ts` | Google Search provider — `newTabOnly` (no pinning), image-only via `acceptedAttachmentKinds`, types into the search textarea and submits to `/search` |
| `src/ask-inject.ts` | Provider-agnostic MAIN-world runtime — attach files, type prompt, click submit; optional `attachmentPreview` chip-count gate verifies the upload landed |
| `src/url-helpers.ts` | Pure URL helpers (no DOM) — `firstUrlSegment` with 20-char truncation, `excludedSuffix` for the Ask menu's disabled-tab annotation |
| `src/capture.ts` | Capture dispatch, per-format selection scraping + download, `log.json` sidecar writing |
| `src/scrape-page-state.ts` | Self-contained page-context worker (HTML + selection scrape) injected into tabs via `executeScript` and reused by tests |
| `src/markdown.ts` | Pure HTML → markdown + HTML → text converter plus markdown-source detection (selection capture + paste) |
| `src/capture.html` | Capture page (the `Capture...` action's review surface) — page-card (title/URL/size + Copy URL), save options + Copy/Edit buttons, edit HTML + selection modals, prompt, drawing-tool palette + image overlay |
| `src/capture-page.ts` | Controller for `capture.html`: prompt, Copy-filename clipboard, Edit dialogs, modal drawing tools (Box/Line/Crop/Redact + crop-edge resize), bake-in, fit-to-viewport |
| `src/options.html` | Extension options page — Ask provider settings, Save-checkbox defaults, Click / Double-click radios per selection state, hotkey display |
| `src/options.ts` | Controller for `options.html`: fetches state from the SW, renders all sections, multi-line hotkey cells, collapsible delay groups, saves via `setOptions` |
| `src/shared-styles.css` | Page-wide `.btn` chrome (raised look + hover/active/.pressed flash + disabled) shared by `capture.html` and `options.html` via `<link rel="stylesheet">` |
| `src/offscreen.html` | Hidden offscreen document that hosts the clipboard-write helper for the service worker |
| `src/offscreen.ts` | Receives `offscreen-copy` messages from the SW and writes their text to the clipboard via `execCommand('copy')` |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons |
| `src/icons/icon-error-{16,48,128}.png` | Error-state variants of the action icons |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies vendor scripts + theme, classic-wraps codejar, then runs `tsc` |
| `scripts/generate-error-icons.mjs` | One-shot utility that generates `icon-error-*.png` variants from the base icons |
| `scripts/_release-common.sh` | Sourced helpers for release scripts (gh check, clean-main check, tag-unused check, orphaned-tag trap) |
| `scripts/release-extension.sh` | Cuts a GitHub release for the Chrome extension (tag `extension-vX.Y.Z`); builds the zip and runs `gh release create` (draft by default) |
| `scripts/zip_extension.sh` | Builds + zips `dist/` to `/tmp/SeeWhatISee.zip` (or `-extension-vVERSION.zip` with `--release VERSION`) |
| `scripts/test-md-slice.mjs` | Fetches a URL / reads an HTML file, slices main content at balanced tag boundaries, runs each slice through the markdown converter, emits a structured report |
| `scripts/open-test-browser.sh` | Launches Playwright's Chromium with the extension + remote debugging on port 9222 + persistent profile, used by the live e2e suite (CDP-attach pattern; sidesteps Google's automation block) |
| `scripts/copy-last-snapshot.sh` | Symlink to `.gemini/scripts/copy-last-snapshot.sh` |
| `scripts/get-latest.sh` | Symlink to `plugin/scripts/get-latest.sh` |
| `scripts/watch-and-copy.sh` | Symlink to `.gemini/scripts/watch-and-copy.sh` |
| `scripts/watch.sh` | Symlink to `plugin/scripts/watch.sh` |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/demo.html` | Demo page for screenshot-based interaction |
| `tests/fixtures/extension.ts` | Playwright fixtures: persistent Chromium context with the extension loaded, fixture HTTP server, and a `getServiceWorker()` helper |
| `tests/fixtures/files.ts` | Test helpers for resolving downloads, sampling PNG pixels, and verifying capture sidecars |
| `tests/fixtures/pages/{purple,green,orange}.html` | Solid-color fixture pages used for pixel-verifiable screenshot tests |
| `tests/e2e/screenshot.spec.ts` | E2E tests for `captureVisible` (basic capture, delay, navigate-during-delay, tab-switch, clear log) |
| `tests/e2e/html-snapshot.spec.ts` | E2E test for `savePageContents` (HTML capture + sidecar verification) |
| `tests/e2e/capture-with-details.spec.ts` | E2E for the Capture page flow core — save-option matrix (PNG/HTML/URL combos) and tab positioning/focus-return |
| `tests/e2e/capture-details-copy.spec.ts` | E2E for the Capture page's copy-filename buttons and per-tab download-cache semantics (including drawing-invalidates-cache) |
| `tests/e2e/capture-details-edit.spec.ts` | E2E for the edit-html / edit-selection dialogs, Preview toggle / sandboxed iframe, and scrape-failure UX |
| `tests/e2e/capture-paste.spec.ts` | E2E for rich-text paste — html→markdown / html-source routing, source-view short-circuit, real copy/paste round-trips |
| `tests/e2e/capture-prompt-enter.spec.ts` | E2E for the Capture-page Prompt Enter behaviour and `defaultButton` setting — ring placement, plain/Shift/Ctrl/`\`+Enter routing, `triggerCapture` hand-off |
| `tests/e2e/capture-details-download.spec.ts` | E2E for the per-row Save-as buttons + the in-dialog Download button (filenames, MIME, committed vs. uncommitted edits, cancel-doesn't-leak) |
| `tests/e2e/capture-drawing.spec.ts` | E2E for the drawing tool palette — Box/Line/Crop/Redact + Undo/Clear, crop-edge resize, edit-flag semantics on log.json |
| `tests/e2e/toolbar-dispatch.spec.ts` | E2E for toolbar click routing — `handleActionClick`, with-selection dispatch, default-id migration, `copyLastSelectionFilename` |
| `tests/e2e/details-helpers.ts` | Shared helpers for the Capture page flow specs — flow open, capture submit, editor read/write, clipboard + SW/page download spies |
| `tests/e2e/scrape-page-state.spec.ts` | Direct coverage for `scrapePageStateInPage` — real / no / CodeMirror-style fake / empty selections, `includeHtml` flag |
| `tests/e2e/more-captures.spec.ts` | E2E for the More-submenu shortcuts: `captureUrlOnly` (URL-only record) and `captureAll` (PNG + HTML + selection-if-any + record) |
| `tests/e2e/get-latest.spec.ts` | Tests for `scripts/get-latest.sh` (absolute paths, config file, error cases) |
| `tests/e2e/copy-last-snapshot.spec.ts` | Tests for `scripts/copy-last-snapshot.sh` (copy + path rewrite to TARGET_DIR) |
| `tests/e2e/watch.spec.ts` | Standalone tests for `scripts/watch.sh` (once/loop, `--after`, `--stop`, config file, absolute paths) |
| `tests/e2e/error-reporting.spec.ts` | E2E tests for the icon-swap / tooltip error surface |
| `tests/e2e/options-refresh.spec.ts` | E2E test for the Options-page hotkey-refresh hook — opening Options resyncs the toolbar tooltip when shortcut bindings have changed |
| `tests/e2e/ask.spec.ts` | E2E tests for the Ask AI flow — menu rendering, exclude patterns, empty-payload guard, inject runtime, Alt+A keyboard binding |
| `tests/e2e/ask-pinned-tabs.spec.ts` | E2E tests for target-window pinning — pin lifecycle, dead/navigated/disabled-provider invalidation, plain-Ask reuse |
| `tests/e2e/ask-toolbar-pin.spec.ts` | E2E tests for the toolbar context-menu Pin/Unpin entry — eligibility, "Pin"/"Unpin" title flip, toggle behavior |
| `tests/e2e/ask-url-variants.spec.ts` | E2E tests for `urlVariants` — pre-send guard refuses unsupported kinds; Claude Code happy path (image + prompt) sends end-to-end |
| `tests/unit/ask-resolvers.test.mjs` | Unit tests for `resolveAcceptedKinds`, `resolveDestinationLabel`, `formatKindList` — pure helpers used by the URL-variant resolver |
| `tests/e2e/ask-helpers.ts` | Shared scaffolding for the Ask specs — fake-Claude state reader, provider-override seam, per-test hooks (snapshot/restore + pin reset) |
| `tests/fixtures/pages/fake-claude.html` | Fake claude.ai composer (file input + ProseMirror-class contenteditable + Send button) used by the Ask specs so tests don't talk to the real claude.ai |
| `tests/e2e-live/lib/types.ts` | `LiveProvider` plugin contract for the live test suite — selectors plus per-provider DOM-verification helpers |
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
| `tests/unit/ask-settings.test.mjs` | Unit tests for the Ask provider settings normalizer + default-rotation helper |
| `tests/unit/url-helpers.test.mjs` | Unit tests for `src/url-helpers.ts` — first-segment extraction, 20-char truncation boundary, the bare-suffix fallback |
| `tests/unit/tooltip.test.mjs` | Unit tests for `src/background/tooltip.ts` — covers all Case 1–4 paths, hotkey suffix, save-defaults expansion |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `architecture.md` | High-level architecture of the extension and capture flow |
| `chrome-extension.md` | Chrome-extension implementation notes (SW lifecycle, permissions, error surface, Capture page flow, Playwright patterns) |
| `smart-paste.md` | Rich-text paste on the Capture page — modes, `cleanCopiedHtml`, `shouldPasteAsText`, build wiring |
| `options-and-settings.md` | Stored toolbar defaults + Capture-page Save defaults: storage shapes, dispatch, tooltip, Options page layout/wire |
| `ask-on-web.md` | "Ask AI" flow — Capture-page UI, provider registry, send flow, injected runtime, ProseMirror notes, diagnostics |
| `ask-live-tests.md` | Manual live e2e suite — CDP-attach pattern, setup, design principles (token economy, library-only injection), troubleshooting, adding a provider |
| `claude-plugin.md` | Notes on the Claude Code plugin (marketplace/plugin manifests, install flow, `CLAUDE_PLUGIN_ROOT`, local-dev shim) |
| `cli_commands.md` | Per-CLI command inventory (Claude / Gemini), their backing scripts, and the per-tree `_common.sh` helpers |
| `images/copy-icon.png` | Inline icon image referenced from the README's Capture-page bullet for the Copy button |
| `images/edit-icon.png` | Inline icon image referenced from the README's Capture-page bullet for the Edit button |
| `images/download-icon.png` | Inline icon image referenced from the README's Capture-page bullet for the Save-as button |
