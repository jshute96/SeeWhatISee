# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation — setup, features, and commands |
| `privacy_policy.html` | User-facing privacy policy (linked from Chrome Web Store listing) — explains that nothing is collected or transmitted and why each manifest permission is required |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `package.json` | Node project manifest, scripts, and devDependencies |
| `package-lock.json` | npm lockfile (auto-generated) |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `playwright.config.ts` | Playwright test runner config |
| `.gitignore` | Git ignore rules (`dist/`, `node_modules/`, `tmp/`, etc.) |

## Marketplace (`.claude-plugin/`)

| File | Description |
|------|-------------|
| `.claude-plugin/marketplace.json` | Marketplace index so other users can install the plugin |

## Plugin (`plugin/`)

| File | Description |
|------|-------------|
| `plugin/.claude-plugin/plugin.json` | Plugin manifest — name, version, description |
| `plugin/settings.json` | Plugin-level permission defaults for the skills |
| `plugin/scripts/watch.sh` | CLI watcher for `latest.json`: default once-mode or `--loop`, `--after BASENAME` to catch up from a known capture, `--stop` to kill existing watcher, `.watch.pid` concurrency control, `.SeeWhatISee` config file support for directory override |
| `plugin/skills/see-what-i-see/SKILL.md` | `/see-what-i-see` — read the latest screenshot or HTML snapshot taken by the extension |
| `plugin/skills/see-what-i-see-watch/SKILL.md` | `/see-what-i-see-watch` — background loop that describes each new capture as it arrives |
| `plugin/skills/see-what-i-see-stop/SKILL.md` | `/see-what-i-see-stop` — stop a running watch loop |
| `plugin/skills/see-what-i-see-help/SKILL.md` | `/see-what-i-see-help` — print a summary of the see-what-i-see commands |

## Local Claude Config (`.claude/`)

| File | Description |
|------|-------------|
| `.claude/settings.json` | Local development settings: sets `CLAUDE_PLUGIN_ROOT=plugin` so plugin permissions resolve correctly when running Claude Code from this repo |
| `.claude/skills/see-what-i-see` | Symlink to `plugin/skills/see-what-i-see` — local shortcut for `/see-what-i-see` |
| `.claude/skills/see-what-i-see-watch` | Symlink to `plugin/skills/see-what-i-see-watch` — local shortcut for `/see-what-i-see-watch` |
| `.claude/skills/see-what-i-see-stop` | Symlink to `plugin/skills/see-what-i-see-stop` — local shortcut for `/see-what-i-see-stop` |
| `.claude/skills/see-what-i-see-help` | Symlink to `plugin/skills/see-what-i-see-help` — local shortcut for `/see-what-i-see-help` |

## Claude Commands (`.claude/commands/`)

| File | Description |
|------|-------------|
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — codereview then commit + push if clean |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 manifest, copied verbatim into `dist/` |
| `src/background.ts` | MV3 service worker — handles toolbar click + right-click context menu (immediate / 2s / 5s delayed captures, save html contents, clear Chrome history) and exposes `self.SeeWhatISee` for tests |
| `src/capture.ts` | Capture functions (`captureVisible`, `savePageContents`, `clearCaptureLog`), metadata sidecar writing (`latest.json`, `log.json`), and the storage-backed capture log |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons (camera emoji), copied into `dist/icons/` by the build |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons and manifest, runs `tsc` |
| `scripts/watch.sh` | Symlink to `plugin/scripts/watch.sh` — preserves existing test and doc references |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixture: worker-scoped persistent Chromium context with the unpacked extension loaded, a worker-scoped local HTTP server that serves the solid-color fixture pages, plus a `getServiceWorker()` helper that re-resolves the SW handle each call (MV3 SWs idle out aggressively) |
| `tests/fixtures/files.ts` | Test helpers: `waitForDownloadPath` resolves a chrome.downloads id to its on-disk path; `pixelColorAt` decodes a saved PNG via pngjs and samples one pixel; `expectColorClose` does tolerant RGB equality; `verifyCapture` is a one-shot helper that checks all three on-disk files (PNG pixel color, latest.json content, log.json last line + optional delta) for a single capture |
| `tests/fixtures/pages/{purple,green,orange}.html` | Solid-color HTML pages served by the test HTTP server, used to make captured screenshots verifiable by sampling a known pixel color |
| `tests/e2e/html-snapshot.spec.ts` | E2E test: `savePageContents` HTML capture + sidecar file verification (HTML content substring, latest.json, log.json) |
| `tests/e2e/screenshot.spec.ts` | E2E tests: capture + sidecar file verification (PNG pixel color, full latest.json, log.json last-line + delta), `delayMs` timing assertion, two delay-with-navigation tests (same-tab navigation and tab switch), and a `clearCaptureLog` test that verifies the next capture after a clear produces a single-record `log.json` — all use the local color fixtures so the captured PNGs can be checked pixel-wise |
| `tests/e2e/watch.spec.ts` | Standalone tests for `scripts/watch.sh`: once/loop mode emission, `--after` catch-up, `--help`, error on missing dir, pidfile lifecycle, second-watcher-kills-first, `--stop`, `.SeeWhatISee` config file parsing (current-dir lookup, `--directory` override, unrecognized keys, comments/blanks, quoted values). Uses temp dirs with simulated captures (no extension needed) |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `architecture.md` | High-level architecture of the extension and capture flow |
| `claude-plugin.md` | Notes on the Claude Code plugin: marketplace/plugin manifests, install flow, `${CLAUDE_PLUGIN_ROOT}`, local-dev shim, and gotchas we hit |
