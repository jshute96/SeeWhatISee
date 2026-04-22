# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation: setup, usage, commands |
| `privacy_policy.md` | User-facing privacy policy linked from the Chrome Web Store listing |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `package.json` | Node project manifest, scripts, devDependencies |
| `package-lock.json` | npm lockfile (auto-generated) |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `playwright.config.ts` | Playwright test runner config |
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
| `src/background.ts` | MV3 service worker — `CAPTURE_ACTIONS` dispatch, action menu + Delay/Set-default/More submenus, details-flow, error surface |
| `src/capture.ts` | Capture dispatch, per-format selection scraping + download, `log.json` sidecar writing |
| `src/markdown.ts` | Pure HTML → markdown + HTML → text converter used by the selection capture paths |
| `src/capture.html` | Extension page for the "Capture with details…" flow (URL, HTML size, save options + Copy/Edit buttons, edit HTML + selection modals, prompt, highlight overlay) |
| `src/capture-page.ts` | Controller for `capture.html`: prompt, Copy-filename clipboard, Edit dialogs, highlight overlay (rects/lines/Redact/Crop/drag-to-crop), bake-in, fit-to-viewport |
| `src/offscreen.html` | Hidden offscreen document that hosts the clipboard-write helper for the service worker |
| `src/offscreen.ts` | Receives `offscreen-copy` messages from the SW and writes their text to the clipboard via `execCommand('copy')` |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons |
| `src/icons/icon-error-{16,48,128}.png` | Error-state variants of the action icons |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons/manifest/HTML + `marked`, `highlight.js` + theme, and a classic-wrapped `codejar.js`, then runs `tsc` |
| `scripts/generate-error-icons.mjs` | One-shot utility that generates `icon-error-*.png` variants from the base icons |
| `scripts/test-md-slice.mjs` | Fetches a URL / reads an HTML file, slices main content at balanced tag boundaries, runs each slice through the markdown converter, emits a structured report |
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
| `tests/e2e/capture-with-details.spec.ts` | E2E for the details flow and `handleActionClick` dispatch — save combos, tab positioning, copy/edit caching, scrape-failure UX |
| `tests/e2e/capture-drawing.spec.ts` | E2E for the drawing overlay — boxes/lines/Redact/Crop/Undo/Clear, drag-to-crop, edit-flag semantics on log.json |
| `tests/e2e/details-helpers.ts` | Shared helpers for the two details specs — flow open, capture submit, overlay drag, on-disk record lookup, CodeJar editor read/write |
| `tests/e2e/more-captures.spec.ts` | E2E for the More-submenu shortcuts: `captureUrlOnly` (URL-only record) and `captureBoth` (PNG + HTML + record) |
| `tests/e2e/get-latest.spec.ts` | Tests for `scripts/get-latest.sh` (absolute paths, config file, error cases) |
| `tests/e2e/copy-last-snapshot.spec.ts` | Tests for `scripts/copy-last-snapshot.sh` (copy + path rewrite to TARGET_DIR) |
| `tests/e2e/watch.spec.ts` | Standalone tests for `scripts/watch.sh` (once/loop, `--after`, `--stop`, config file, absolute paths) |
| `tests/e2e/error-reporting.spec.ts` | E2E tests for the icon-swap / tooltip error surface |

## Unit Tests (`tests/unit/`)

| File | Description |
|------|-------------|
| `tests/unit/markdown.test.mjs` | Pure unit tests for `src/markdown.ts` — run via `node --test` (no browser required) |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `architecture.md` | High-level architecture of the extension and capture flow |
| `chrome-extension.md` | Chrome-extension implementation notes (SW lifecycle, permissions, error surface, details flow, Playwright patterns) |
| `claude-plugin.md` | Notes on the Claude Code plugin (marketplace/plugin manifests, install flow, `CLAUDE_PLUGIN_ROOT`, local-dev shim) |
| `cli_commands.md` | Per-CLI command inventory (Claude / Gemini), their backing scripts, and the per-tree `_common.sh` helpers |
