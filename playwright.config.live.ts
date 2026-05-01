// Playwright config for the LIVE-provider e2e suite (`tests/e2e-live/`).
//
// These tests hit real AI sites (claude.ai, gemini.google.com,
// chatgpt.com) with a logged-in user and so are NOT part of the
// default `npm run test:e2e`. They run only when explicitly
// requested via `npm run test:live` (all providers) or
// `npm run test:live-<provider>` (one project).
//
// Scope is narrow: each spec tests the inject library
// (`src/ask-inject.ts`) directly against the real AI page — it
// reads `dist/ask-inject.js` from disk and calls the runtime via
// `page.evaluate`. The extension itself is NOT under test here;
// that's the deterministic e2e suite's job.
//
// Auth: the test browser is launched manually via
// `scripts/open-test-browser.sh` (Playwright's bundled Chromium with
// remote debugging on port 9222 + a persistent profile dir). The
// user logs in to each AI provider once; sessions persist in the
// profile across test runs. Tests attach via `chromium.connectOverCDP`
// rather than launching their own browser — Google's automation
// detection refuses login from Playwright-launched browsers, so the
// CDP-attach pattern is the only way Gemini will work later.
//
// Adding a new provider:
//   1. Drop a spec at `tests/e2e-live/<provider>.live.spec.ts`.
//   2. Add a project entry below following the Claude/Gemini/ChatGPT
//      pattern.
//   3. Optionally add an `npm run test:live-<provider>` script.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-live',
  fullyParallel: false,
  workers: 1,
  // Live tests cross the network. 20s is enough for the slowest
  // case (image upload + prompt typing + submit + post-submit
  // composer-clear poll) without wasting minutes on a stuck test.
  // The deterministic e2e suite (`playwright.config.ts`) is much
  // tighter; bump only this when adding a new test that legitimately
  // needs more time.
  timeout: 20_000,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'claude',
      testMatch: /claude\.live\.spec\.ts$/,
    },
    {
      name: 'claude-code',
      testMatch: /claude-code\.live\.spec\.ts$/,
    },
    {
      name: 'gemini',
      testMatch: /gemini\.live\.spec\.ts$/,
    },
    {
      name: 'chatgpt',
      testMatch: /chatgpt\.live\.spec\.ts$/,
    },
  ],
});
