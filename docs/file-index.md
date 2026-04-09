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
| `src/background.ts` | MV3 service worker — handles toolbar click and exposes `self.SeeWhatISee` for tests |
| `src/capture.ts` | Capture functions (`captureVisible`, future variations), metadata sidecar writing (`latest.json`, `log.json`), and the storage-backed capture log |
| `src/icons/icon-{16,48,128}.png` | Toolbar action icons (camera emoji), copied into `dist/icons/` by the build |

## Build Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `scripts/build.mjs` | Cleans `dist/`, copies icons and manifest, runs `tsc` |

## Tests (`tests/`)

| File | Description |
|------|-------------|
| `tests/fixtures/extension.ts` | Playwright fixture that launches Chromium with the unpacked extension and exposes its service worker |
| `tests/e2e/screenshot.spec.ts` | Smoke test that triggers `captureVisible` via the service worker |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `file-index.md` | This file — one-line descriptions of every source file |
| `architecture.md` | High-level architecture of the extension and capture flow |
