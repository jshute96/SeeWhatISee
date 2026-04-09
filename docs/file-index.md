# File Index

One-line descriptions of every source file, grouped by directory.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation — setup, features, and commands |
| `CLAUDE.md` | Guidance for AI agents working in this repository |
| `package.json` | Node project manifest, scripts, and devDependencies |
| `package-lock.json` | npm lockfile (auto-generated) |
| `tsconfig.json` | TypeScript compiler config for the extension build |
| `playwright.config.ts` | Playwright test runner config |
| `.gitignore` | Git ignore rules (`dist/`, `node_modules/`, `tmp/`, etc.) |

## Claude Commands (`.claude/commands/`)

| File | Description |
|------|-------------|
| `.claude/commands/codereview.md` | `/codereview` slash command — launches a background review subagent |
| `.claude/commands/pushreview.md` | `/pushreview` slash command — codereview then commit + push if clean |
| `.claude/commands/SeeWhatISee.md` | `/SeeWhatISee` slash command — read the latest screenshot taken by the extension |

## Extension Source (`src/`)

| File | Description |
|------|-------------|
| `src/manifest.json` | Manifest V3 manifest, copied verbatim into `dist/` |
| `src/background.ts` | MV3 service worker — handles toolbar click + right-click context menu (immediate / 2s / 5s delayed captures) and exposes `self.SeeWhatISee` for tests |
| `src/capture.ts` | Capture functions (`captureVisible`, future variations), metadata sidecar writing (`latest.json`, `log.json`), and the storage-backed capture log |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons (camera emoji), copied into `dist/icons/` by the build |

## Build Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons and manifest, runs `tsc` |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixture: worker-scoped persistent Chromium context with the unpacked extension loaded, plus a `getServiceWorker()` helper that re-resolves the SW handle each call (MV3 SWs idle out aggressively) |
| `tests/e2e/screenshot.spec.ts` | E2E tests: visible-tab capture smoke test, `delayMs` timing assertion, and two delay-with-navigation tests (same-tab navigation and tab switch) |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `architecture.md` | High-level architecture of the extension and capture flow |
