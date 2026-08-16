// Playwright fixture that launches Chromium with the unpacked extension
// loaded from dist/, and exposes a handle to its MV3 service worker.
//
// MV3 extensions can't be triggered by clicking the toolbar from Playwright,
// so tests invoke capture functions through `serviceWorker.evaluate(...)`,
// which calls into `self.SeeWhatISee` (set up in src/background.ts).

import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCaptureQuotaTracker, waitForCaptureQuota } from './capture-quota';

export type GetServiceWorker = () => Promise<Worker>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');
const FIXTURE_PAGES_DIR = path.resolve(__dirname, 'pages');

// How long teardown waits on a single `page.close()` before giving up
// — see the call site for why this is bounded.
const PAGE_CLOSE_TIMEOUT_MS = 3000;

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
  // Local HTTP server fixture: serves the solid-color fixture HTML
  // pages out of tests/fixtures/pages/. We need a real http:// origin
  // (rather than file:// or data:) because:
  //   - Unpacked extensions don't get file:// access by default, so
  //     chrome.tabs.captureVisibleTab on a file:// page would fail
  //     without extra per-extension preference plumbing.
  //   - data: URLs aren't matched by the manifest's <all_urls> host
  //     permission, so the capture isn't authorized.
  //
  // Worker-scoped because it shares its lifetime with `extensionContext`
  // — one server per Playwright worker, reused across all tests in the
  // worker — and listens on port 0 so multiple workers don't collide.
  fixtureServer: { baseUrl: string };
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
  // Auto-fixture (see its body) — nothing to consume, it just has to
  // run around every test.
  extensionHooks: void;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  fixtureServer: [
    async ({}, use) => {
      const server = http.createServer((req, res) => {
        try {
          // Serve a fixture page from FIXTURE_PAGES_DIR. Reject path
          // traversal so a malformed URL can't escape the fixture root.
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const name = url.pathname.replace(/^\//, '') || 'index.html';
          const filePath = path.join(FIXTURE_PAGES_DIR, name);
          const rel = path.relative(FIXTURE_PAGES_DIR, filePath);
          if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          // Serve a sensible Content-Type per extension. Default is
          // text/html for fixture HTML; PNG/JPG fixtures (used by the
          // image-right-click tests) need their image MIME so the
          // page-side `fetch().blob().type` reads back the right
          // value — `imageExtensionFor()` keys off it.
          const ext = path.extname(filePath).toLowerCase();
          const mime = ({
            '.html': 'text/html; charset=utf-8',
            '.htm': 'text/html; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
          } as Record<string, string>)[ext] ?? 'application/octet-stream';
          res.setHeader('Content-Type', mime);
          res.end(fs.readFileSync(filePath));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      await use({ baseUrl });
      // closeAllConnections() forces any idle keep-alive sockets shut so
      // server.close() doesn't block on them — without it, teardown hangs
      // until Playwright's 30s fixture timeout fires.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    { scope: 'worker' },
  ],

  extensionContext: [
    async ({}, use) => {
      const ctx = await chromium.launchPersistentContext('', {
        // Extensions require Chrome's new headless mode (--headless=new,
        // available since Chrome 112). We set headless: false so Playwright
        // doesn't inject its own --headless flag, then pass --headless=new
        // ourselves. This avoids a visible window that steals focus.
        headless: false,
        args: [
          '--headless=new',
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
        ],
      });
      // Forward `[capture-quota]`-tagged SW warnings to the test
      // output so backoff hits are visible without instrumenting
      // every spec. Anything else stays where Playwright would put
      // it (CDP-only, not in stdout). Each newly-spawned SW gets
      // its own listener since MV3 service workers respawn on idle.
      const onSw = (sw: Worker): void => {
        sw.on('console', (msg) => {
          const text = msg.text();
          if (text.includes('[capture-quota]')) {
            process.stderr.write(`SW ${msg.type()}: ${text}\n`);
          }
        });
      };
      ctx.serviceWorkers().forEach(onSw);
      ctx.on('serviceworker', onSw);
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

  // Per-test setup/teardown shared by every extension spec. This is an
  // *auto fixture*, not a `test.beforeEach` / `test.afterEach` pair,
  // and that distinction matters:
  //
  //   - Node caches this module, so its top level executes exactly
  //     once per Playwright worker — while the *first* spec file of
  //     that worker is being loaded.
  //   - Playwright attaches a `test.beforeEach` to whichever file is
  //     loading at the time it is called. So module-level hooks here
  //     only ever ran for that first spec file; every later file in
  //     the same worker silently ran with no quota wait and no page
  //     cleanup.
  //   - Leaked pages then piled up for the rest of the worker's life,
  //     and each extra page slows down every CDP round-trip. That
  //     made identical tests run several times slower purely because
  //     of what ran before them.
  //
  // Fixtures have no such file affinity — an auto fixture runs for
  // every test that uses this `test` object, in any file.
  //
  // Setup: the smart captureVisibleTab quota wait (see
  // capture-quota.ts). `installCaptureQuotaTracker` patches the SW so
  // successful captures stamp a 2-entry timestamp ring;
  // `waitForCaptureQuota` sleeps only the remainder needed for the
  // next call to stay under Chrome's 2-per-second cap — typically
  // 0 ms. The patch also auto-retries the quota error as a safety net.
  //
  // Teardown: close any pages the test left behind. Tests generally
  // close their own, but cleanup is best-effort and failure paths
  // skip it. `about:blank` pages are left alone (Chrome's initial tab
  // counts) and errors from already-closed pages are swallowed.
  extensionHooks: [
    async ({ getServiceWorker, extensionContext }, use) => {
      const sw = await getServiceWorker();
      await installCaptureQuotaTracker(sw);
      await waitForCaptureQuota(sw);

      await use();

      for (const page of extensionContext.pages()) {
        if (page.url() === 'about:blank') continue;
        // Bounded: a page whose renderer is wedged (or which is
        // mid-navigation as the test ends) can leave `close()` pending
        // indefinitely. Fixture teardown counts against the *test*
        // timeout, so an unbounded wait here turns a passing test into
        // a 30 s "Tearing down extensionHooks exceeded the test
        // timeout" failure. A straggler page is a much smaller problem
        // than a false failure, so we give up and move on.
        //
        // The `.catch` sits on the close promise itself rather than
        // around the race: a page that already closed (or a context
        // tearing down) can reject *after* the timeout has won, and a
        // try/catch around the race would no longer be listening.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          page.close().catch(() => {}),
          new Promise((resolve) => {
            timer = setTimeout(resolve, PAGE_CLOSE_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
      }
    },
    { auto: true },
  ],
});

export const expect = test.expect;
