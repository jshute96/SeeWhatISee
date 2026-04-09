// Playwright fixture that launches Chromium with the unpacked extension
// loaded from dist/, and exposes a handle to its MV3 service worker.
//
// MV3 extensions can't be triggered by clicking the toolbar from Playwright,
// so tests invoke capture functions through `serviceWorker.evaluate(...)`,
// which calls into `self.SeeWhatISee` (set up in src/background.ts).

import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GetServiceWorker = () => Promise<Worker>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');

// `extensionContext` is *worker-scoped* so a single Chromium window
// (with the extension loaded) is reused across every test in the same
// Playwright worker. Spinning up a fresh persistent context per test
// adds ~1s of launch overhead and a visible window flash. Tests get
// their own page via `extensionContext.newPage()` inside each test
// body and clean up after themselves.
//
// `serviceWorker` is *test-scoped* (and depends on the worker-scoped
// context) because the MV3 service worker can idle out and respawn
// between tests, which invalidates any previously-captured Worker
// handle. Re-resolving per test gives each test a live handle.
//
// The context fixture is named `extensionContext` (rather than
// overriding Playwright's builtin `context`) because the builtin is
// hard-wired test-scoped, and Playwright rejects worker fixtures that
// depend on builtin test fixtures even when you try to override them.
type WorkerFixtures = {
  extensionContext: BrowserContext;
};

type TestFixtures = {
  // A function that returns a freshly-resolved, known-live service
  // worker handle. Tests should call this every time they need to
  // evaluate something — caching the returned Worker across page
  // operations risks the handle going stale (see fixture body for the
  // gnarly details).
  getServiceWorker: GetServiceWorker;
  extensionId: string;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  extensionContext: [
    async ({}, use) => {
      const ctx = await chromium.launchPersistentContext('', {
        // Headed: extensions historically required headed mode. The newer
        // headless ("--headless=new") supports extensions, but headed is the
        // most reliable default. Override per-test if needed.
        headless: false,
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
        ],
      });
      await use(ctx);
      await ctx.close();
    },
    { scope: 'worker' },
  ],

  getServiceWorker: async ({ extensionContext }, use) => {
    // MV3 service workers idle out aggressively, and Playwright's
    // `serviceWorkers()` list can hand back a Worker handle whose
    // underlying CDP target has already been torn down. Worse, a
    // previously-live handle can go stale partway through a test if
    // the SW is terminated between operations. So we don't cache —
    // every call walks the current list and verifies each candidate
    // with a no-op evaluate, falling back to waitForEvent for a fresh
    // spawn if nothing in the list is live.
    //
    // Caveat: if every listed SW is stale AND Chrome doesn't respawn
    // the worker on its own (which it normally does for any extension
    // event), the waitForEvent below will hang until its timeout
    // fires. We pass an explicit short timeout so a stuck test fails
    // fast with a clear error rather than after Playwright's default
    // ~30s. There's also an unavoidable TOCTOU race where the no-op
    // probe succeeds but the worker dies before the caller's real
    // evaluate runs — the caller has to retry in that case.
    const get: GetServiceWorker = async () => {
      for (const candidate of extensionContext.serviceWorkers()) {
        try {
          await candidate.evaluate(() => true);
          return candidate;
        } catch {
          // stale; try the next one
        }
      }
      const sw = await extensionContext.waitForEvent('serviceworker', { timeout: 5000 });
      // Newly-spawned worker may need a moment to be ready for evaluate.
      await sw.evaluate(() => true);
      return sw;
    };
    await use(get);
  },

  extensionId: async ({ getServiceWorker }, use) => {
    // Service worker URL looks like: chrome-extension://<id>/background.js
    const sw = await getServiceWorker();
    const id = new URL(sw.url()).host;
    await use(id);
  },
});

export const expect = test.expect;
