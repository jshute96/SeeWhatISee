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

## Marketplace (`.claude-plugin/`)

| File | Description |
|------|-------------|
| `.claude-plugin/marketplace.json` | Marketplace index so other users can install the plugin |

## Claude Plugin (`plugin/`)

| File | Description |
|------|-------------|
| `plugin/.claude-plugin/plugin.json` | Plugin manifest — name and repository URL |
| `plugin/settings.json` | Plugin-level permission defaults for the skills |
| `plugin/scripts/_common.sh` | Shared helpers: directory resolution, config parsing, JSON path absolutization |
| `plugin/scripts/get-latest.sh` | Print latest capture as JSON with absolute file paths |
| `plugin/scripts/watch.sh` | CLI watcher for `latest.json` (`--loop`, `--after`, `--stop`, `--directory`) |
| `plugin/skills/see-what-i-see/SKILL.md` | `/see-what-i-see` — describe the latest capture |
| `plugin/skills/see-what-i-see-watch/SKILL.md` | `/see-what-i-see-watch` — describe each new capture as it arrives |
| `plugin/skills/see-what-i-see-stop/SKILL.md` | `/see-what-i-see-stop` — stop the watch loop |
| `plugin/skills/see-what-i-see-help/SKILL.md` | `/see-what-i-see-help` — summary of see-what-i-see commands |

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

## Gemini CLI Commands (`.gemini/`)

| File | Description |
|------|-------------|
| `.gemini/commands/see-what-i-see.toml` | Gemini CLI command — describes the latest capture (uses `copy-last-snapshot.sh`) |
| `.gemini/scripts/copy-last-snapshot.sh` | Copies latest snapshot files into `.gemini/tmp/` and prints JSON with rewritten paths |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 manifest, copied verbatim into `dist/` |
| `src/background.ts` | MV3 service worker — `CAPTURE_ACTIONS` dispatch, action menu + Delay/Set-default submenus, details-flow, error surface |
| `src/capture.ts` | Capture functions (`captureVisible`, `savePageContents`, `captureBothToMemory`, `saveDetailedCapture`, `clearCaptureLog`) and metadata sidecar writing (`latest.json`, `log.json`) |
| `src/capture.html` | Extension page for the "Capture with details…" flow (URL, HTML size, save options, prompt, highlight overlay) |
| `src/capture-page.ts` | Controller script for `capture.html`: data fetch, prompt/textarea behavior, SVG highlight overlay, canvas bake-in on save, image fit-to-viewport |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons |
| `src/icons/icon-error-{16,48,128}.png` | Error-state variants of the action icons |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons, manifest, and `capture.html`, then runs `tsc` |
| `scripts/generate-error-icons.mjs` | One-shot utility that generates `icon-error-*.png` variants from the base icons |
| `scripts/copy-last-snapshot.sh` | Symlink to `.gemini/scripts/copy-last-snapshot.sh` |
| `scripts/get-latest.sh` | Symlink to `plugin/scripts/get-latest.sh` |
| `scripts/watch.sh` | Symlink to `plugin/scripts/watch.sh` |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixtures: persistent Chromium context with the extension loaded, fixture HTTP server, and a `getServiceWorker()` helper |
| `tests/fixtures/files.ts` | Test helpers for resolving downloads, sampling PNG pixels, and verifying capture sidecars |
| `tests/fixtures/pages/{purple,green,orange}.html` | Solid-color fixture pages used for pixel-verifiable screenshot tests |
| `tests/e2e/screenshot.spec.ts` | E2E tests for `captureVisible` (basic capture, delay, navigate-during-delay, tab-switch, clear log) |
| `tests/e2e/html-snapshot.spec.ts` | E2E test for `savePageContents` (HTML capture + sidecar verification) |
| `tests/e2e/capture-with-details.spec.ts` | E2E for the details flow and `handleActionClick` dispatch — save combos, highlights, tab positioning, tooltip sync |
| `tests/e2e/get-latest.spec.ts` | Tests for `scripts/get-latest.sh` (absolute paths, config file, error cases) |
| `tests/e2e/copy-last-snapshot.spec.ts` | Tests for `scripts/copy-last-snapshot.sh` (copy + path rewrite to TARGET_DIR) |
| `tests/e2e/watch.spec.ts` | Standalone tests for `scripts/watch.sh` (once/loop, `--after`, `--stop`, config file, absolute paths) |
| `tests/e2e/error-reporting.spec.ts` | E2E tests for the icon-swap / tooltip error surface |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `architecture.md` | High-level architecture of the extension and capture flow |
| `chrome-extension.md` | Chrome-extension implementation notes (SW lifecycle, permissions, error surface, details flow, Playwright patterns) |
| `claude-plugin.md` | Notes on the Claude Code plugin (marketplace/plugin manifests, install flow, `CLAUDE_PLUGIN_ROOT`, local-dev shim) |
