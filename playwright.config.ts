import { defineConfig } from '@playwright/test';

// Extension e2e tests must run in a persistent Chromium context with the
// unpacked extension loaded. They are not parallelizable per worker because
// each worker spins up its own browser context anyway.
//
// Tracing is off by default. Playwright's per-test `tracing.startChunk`
// makes a CDP roundtrip that occasionally stalls under the load of a
// long-running persistent context, and the failures show up as a
// "trace recording" fixture-setup timeout rather than anything in the
// test itself. To capture traces while debugging a failure, run with
// `PW_TRACE=retain-on-failure npm run test:e2e` (or any other value
// from Playwright's `trace` option — `on`, `on-first-retry`, etc.).
const trace = (process.env.PW_TRACE ?? 'off') as
  | 'off'
  | 'on'
  | 'retain-on-failure'
  | 'on-first-retry'
  | 'on-all-retries';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  // Single retry to absorb late-suite flakes caused by Chrome MV3
  // service-worker lifetime: by ~10 minutes into a 374-test single-
  // worker run, the SW occasionally gets killed mid-message-handler
  // (e.g. an `askSetDefault` or `askAiDefault` round-trip), leaving
  // the page-side `chrome.runtime.sendMessage` waiting on a response
  // that never arrives. Each retry re-resolves the SW handle and gets
  // a fresh worker. The underlying issue is Chrome's MV3 SW-shutdown
  // race rather than a bug in the test or product; a real fix would
  // need a keepalive port or chrome.alarms watchdog in the SW.
  retries: 1,
  use: {
    trace,
  },
});
