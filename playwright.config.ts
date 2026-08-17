import { defineConfig } from '@playwright/test';

// Extension e2e tests must run in a persistent Chromium context with the
// unpacked extension loaded.
//
// Parallelism is per *file*, not per test: `fullyParallel: false` keeps
// each file on one worker, and the fixtures give every worker its own
// browser. That isolation is what makes running several workers safe —
// each gets its own profile and download dir, its own
// `captureVisibleTab` quota (Chrome meters it per browser), and its own
// fixture HTTP server on port 0. Nothing is shared across workers.
//
// `workers` is left unset so Playwright uses its default of half the
// available cores. Each worker is a whole Chromium (browser process,
// renderers, MV3 service worker), so this is real load — on an 8-core
// box the suite saturates all 8 at 4 workers. It's still worth it: the
// tests are mostly waiting on CDP round-trips and SW messaging, so 4x
// the workers buys ~3x the throughput (8.8 min -> 3.0 min). Pushing to
// 6 gained only ~30 s and started tripping the 5 s `expect` timeouts.
//
// Tracing is off by default. Playwright's per-test `tracing.startChunk`
// makes a CDP roundtrip that occasionally stalls under the load of a
// long-running persistent context, and the failures show up as a
// "trace recording" fixture-setup timeout rather than anything in the
// test itself. To capture traces while debugging a failure, run with
// `PW_TRACE=retain-on-failure pnpm run test:e2e` (or any other value
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
  reporter: 'list',
  // Single retry to absorb flakes caused by Chrome MV3 service-worker
  // lifetime: deep into a long run, the SW occasionally gets killed
  // mid-message-handler (e.g. an `askSetDefault` or `askAiDefault`
  // round-trip), leaving the page-side `chrome.runtime.sendMessage`
  // waiting on a response that never arrives. Each retry re-resolves
  // the SW handle and gets a fresh worker. The underlying issue is
  // Chrome's MV3 SW-shutdown race rather than a bug in the test or
  // product; a real fix would need a keepalive port or a
  // chrome.alarms watchdog in the SW.
  retries: 1,
  use: {
    trace,
  },
});
