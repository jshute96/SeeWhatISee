// E2E coverage for the "Capture with details…" flow, minus the
// drawing-overlay tests (Redact / Crop / Undo / Clear / bake-in),
// which now live in `capture-drawing.spec.ts`.
//
// What's left here:
//   - Save-option combinations (PNG only, HTML only, PNG+HTML,
//     URL-only, selection) and the associated prompt / URL / flag
//     assertions.
//   - Tab positioning + opener focus return on close.
//   - Default click action routing (setDefaultWithSelectionId /
//     setDefaultWithoutSelectionId).
//   - Copy-filename buttons, including the drawing→cache
//     invalidation interplay (the drawing tests themselves moved
//     out, but the cache-invalidation scenarios that happen to
//     involve a drag stay here because the focus is caching).
//   - Edit-html / Edit-selection dialog behavior.
//   - HTML scrape-failure UX.

import fs from 'node:fs';
import { PNG } from 'pngjs';
import type { Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import {
  SCREENSHOT_PATTERN,
  CONTENTS_PATTERN,
  configureAndCapture,
  dragRect,
  findCapturedDownload,
  openDetailsFlow,
  readLatestRecord,
} from './details-helpers';
import { type CaptureRecord, waitForDownloadPath } from '../fixtures/files';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Each test in this file issues one capture via startCaptureWithDetails;
// without a small cushion the suite occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// Shared helpers live in ./details-helpers. The openDetailsFlow
// there installs a chrome.downloads.download spy so
// findCapturedDownload / readLatestRecord can map requested
// filenames to on-disk paths.

// ─── Tests ────────────────────────────────────────────────────────

test('details: png only, no prompt, no highlights', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents).toBeUndefined();
  expect(record.prompt).toBeUndefined();
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);

  // The PNG should exist and be non-empty.
  const pngPath = await findCapturedDownload(sw, '.png');
  expect(fs.statSync(pngPath).size).toBeGreaterThan(0);

  await openerPage.close();
});

test('details: html only with prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
    prompt: 'find the bug',
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.prompt).toBe('find the bug');
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);

  // The HTML file should contain the fixture page's marker.
  const contentsPath = await findCapturedDownload(sw, '.html');
  const html = fs.readFileSync(contentsPath, 'utf8');
  expect(html).toContain('background: #800080');

  await openerPage.close();
});

test('details: png + html with prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
    prompt: 'compare these',
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.prompt).toBe('compare these');
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  // Both files share the same compact-timestamp suffix when written
  // by the detailed-capture path.
  const screenshotSuffix = record.screenshot!.filename.replace(/^screenshot-/, '').replace(/\.png$/, '');
  const contentsSuffix = record.contents!.filename.replace(/^contents-/, '').replace(/\.html$/, '');
  expect(screenshotSuffix).toBe(contentsSuffix);

  await openerPage.close();
});

test('details: url-only (no screenshot, no html) with prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
    prompt: 'what runs on this host?',
  });

  const sw = await getServiceWorker();
  // No content file was written this capture, so `findCapturedDownload`
  // for '.png' / '.html' would miss. Pull the log file directly.
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  const record: CaptureRecord = JSON.parse(lines[lines.length - 1]);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents).toBeUndefined();
  expect(record.prompt).toBe('what runs on this host?');
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);

  await openerPage.close();
});

test('details: url-only with no prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  const record: CaptureRecord = JSON.parse(lines[lines.length - 1]);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents).toBeUndefined();
  expect(record.prompt).toBeUndefined();
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);

  await openerPage.close();
});

test('details: tab opens next to opener and returns focus on close', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Clean up any leftover tabs from earlier tests in the same
  // worker — they confuse close-time tab activation analysis.
  for (const p of extensionContext.pages()) {
    try {
      await p.close();
    } catch {
      /* ignore */
    }
  }

  // Three tabs total so the opener has neighbors on both sides
  // and the details tab can't accidentally satisfy the
  // "right-neighbor" assertion by being at the end of the strip.
  // Distinct colors make it easy to tell which tab Chrome
  // activates if a regression bites.
  const leftDistractor = await extensionContext.newPage();
  await leftDistractor.goto(`${fixtureServer.baseUrl}/green.html`);

  const opener = await extensionContext.newPage();
  await opener.goto(`${fixtureServer.baseUrl}/orange.html`);

  const rightDistractor = await extensionContext.newPage();
  await rightDistractor.goto(`${fixtureServer.baseUrl}/purple.html`);

  // Make the opener the active tab. We use chrome.tabs.update
  // from the SW rather than Playwright's `bringToFront`, because
  // bringToFront in headless mode doesn't always update Chrome's
  // tab activation history — and that history is what Chrome's
  // close-time tab picker reads from.
  const sw0 = await getServiceWorker();
  const openerIndex = await sw0.evaluate(async (orangeUrl) => {
    const all = await chrome.tabs.query({});
    const tab = all.find((t) => t.url === orangeUrl);
    if (!tab?.id) throw new Error(`no tab matching ${orangeUrl}`);
    await chrome.tabs.update(tab.id, { active: true });
    return tab.index!;
  }, `${fixtureServer.baseUrl}/orange.html`);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { startCaptureWithDetails: () => Promise<void> };
      }
    ).SeeWhatISee.startCaptureWithDetails();
  });
  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // Verify the details tab is at openerIndex + 1, i.e. immediately
  // to the right of the opener. We can't filter `chrome.tabs.query`
  // by `url` (that needs the `tabs` permission, which the manifest
  // deliberately omits), so we look the tab up via its session-
  // storage key.
  const detailsIndex = await sw.evaluate(async () => {
    const stored = await chrome.storage.session.get(null);
    const key = Object.keys(stored).find((k) => k.startsWith('captureDetails_'));
    if (!key) throw new Error('no captureDetails_ key in session storage');
    const tabId = Number(key.slice('captureDetails_'.length));
    const tab = await chrome.tabs.get(tabId);
    return tab.index;
  });
  // The details tab opens immediately to the right of the opener
  // (`index: active.index + 1` in startCaptureWithDetails).
  expect(detailsIndex).toBe(openerIndex + 1);

  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  // After close, the active tab should be the opener (orange.html),
  // because the saveDetails finally block explicitly re-activates
  // it. Chrome's natural pick on close is unreliable across
  // layouts, so the assertion bites if anyone tries to drop the
  // explicit `chrome.tabs.update` in background.ts.
  const sw2 = await getServiceWorker();
  const activeUrl = await sw2.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t.url;
  });
  expect(activeUrl).toBe(`${fixtureServer.baseUrl}/orange.html`);

  await opener.close();
  await leftDistractor.close();
  await rightDistractor.close();
});

// ─── Default click action dispatch ────────────────────────────────
//
// The toolbar action's onClicked listener routes through
// `handleActionClick`, which looks up the current default click
// action from `chrome.storage.local` and runs it. Playwright can't
// actually click the toolbar, so we drive the dispatcher directly
// via `self.SeeWhatISee` and observe the side effect (a screenshot
// file written, or a capture.html tab opening).

test('captureBothToMemory(delayMs) sleeps before snapshotting', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/green.html`);
  await page.bringToFront();

  const sw = await getServiceWorker();
  const elapsedMs = await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          captureBothToMemory: (delayMs?: number) => Promise<{
            screenshotDataUrl: string;
            html: string;
            url: string;
          }>;
        };
      }
    ).SeeWhatISee;
    const start = performance.now();
    const data = await api.captureBothToMemory(200);
    const elapsed = performance.now() - start;
    // Sanity check: we actually grabbed something. The data URL
    // prefix and a non-empty HTML body prove both legs ran.
    if (!data.screenshotDataUrl.startsWith('data:image/png')) {
      throw new Error('missing screenshot data URL');
    }
    if (!data.html.includes('background: #00c000')) {
      throw new Error('html scrape did not land on green.html');
    }
    return elapsed;
  });

  // Delay must actually fire — the details-flow delayed path shares
  // the same timer. A missing `await` on the setTimeout would make
  // this near-zero.
  expect(elapsedMs).toBeGreaterThanOrEqual(190);
  expect(elapsedMs).toBeLessThan(500);

  await page.close();
});

test('default click action set to capture-now: handleActionClick takes a direct screenshot', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(async () => {
    await chrome.storage.local.clear();
    await (
      self as unknown as {
        SeeWhatISee: { setDefaultWithoutSelectionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultWithoutSelectionId('capture-now');
  });

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();

  // If a capture.html tab opens, the test should fail — capture-now
  // should dispatch directly, not open the details flow.
  let detailsOpened = false;
  const onPage = (p: Page) => {
    if (p.url().endsWith('/capture.html')) detailsOpened = true;
  };
  extensionContext.on('page', onPage);

  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { handleActionClick: () => Promise<void> };
      }
    ).SeeWhatISee.handleActionClick();
  });

  // Give Chrome a moment to fire any stray page event before
  // checking the flag.
  await new Promise((r) => setTimeout(r, 200));
  extensionContext.off('page', onPage);
  expect(detailsOpened).toBe(false);

  // The screenshot should have landed via the direct path.
  const sw2 = await getServiceWorker();
  const stored = await sw2.evaluate(async () => {
    return await chrome.storage.local.get('captureLog');
  });
  const log = (stored.captureLog ?? []) as { screenshot?: { filename: string } }[];
  expect(log.length).toBeGreaterThan(0);
  expect(log[log.length - 1].screenshot?.filename).toMatch(SCREENSHOT_PATTERN);

  await openerPage.close();
});

test('default click action set to capture-with-details: handleActionClick opens the details page', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(async () => {
    await chrome.storage.local.clear();
    await (
      self as unknown as {
        SeeWhatISee: { setDefaultWithoutSelectionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultWithoutSelectionId('capture-with-details');
  });

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { handleActionClick: () => Promise<void> };
      }
    ).SeeWhatISee.handleActionClick();
  });

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // Close the details tab cleanly so it doesn't leak into the next
  // test.
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  // Reset the preference so subsequent tests in this worker get
  // the default behavior.
  const sw2 = await getServiceWorker();
  await sw2.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { setDefaultWithoutSelectionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultWithoutSelectionId('capture-now');
  });

  await openerPage.close();
});

test('setDefaultWithoutSelectionId updates the toolbar tooltip to match', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const titles = await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          setDefaultWithSelectionId: (id: string) => Promise<void>;
          setDefaultWithoutSelectionId: (id: string) => Promise<void>;
        };
      }
    ).SeeWhatISee;
    // Pin the with-selection default so the middle tooltip line
    // stays stable regardless of the starting storage state.
    await api.setDefaultWithSelectionId('capture-selection-html');
    await api.setDefaultWithoutSelectionId('capture-now');
    const a = await chrome.action.getTitle({});
    await api.setDefaultWithoutSelectionId('capture-now-2s');
    const b = await chrome.action.getTitle({});
    await api.setDefaultWithoutSelectionId('save-page-contents');
    const c = await chrome.action.getTitle({});
    await api.setDefaultWithoutSelectionId('capture-with-details');
    const d = await chrome.action.getTitle({});
    // Restore default so the rest of the suite is unaffected.
    await api.setDefaultWithoutSelectionId('capture-now');
    return { a, b, c, d };
  });

  // Tooltip layout (bracketed by blank lines above and below the
  // action block — see `getDefaultActionTooltip`):
  //
  //   SeeWhatISee
  //   <blank>
  //   Click: <…>
  //   Double-click: <…>
  //   With selection: <…>
  //   <blank trailing line>
  const withSelLine = 'With selection: Capture as HTML';
  const expected = (click: string, dbl: string) =>
    ['SeeWhatISee', '', `Click: ${click}`, `Double-click: ${dbl}`, withSelLine, ''].join('\n');
  expect(titles.a).toBe(expected('Take screenshot', 'Capture with details'));
  expect(titles.b).toBe(expected('Take screenshot in 2s', 'Capture with details'));
  expect(titles.c).toBe(expected('Save HTML contents', 'Capture with details'));
  expect(titles.d).toBe(expected('Capture with details', 'Take screenshot'));
});

// ─── Copy-filename buttons on the capture page ────────────────────
//
// Each click materializes the file on disk via the SW (writing under
// the same pinned filename Capture would use) and puts the file's
// real on-disk path on the clipboard. Subsequent clicks short-circuit
// against the SW's per-tab download cache; a highlight change bumps
// the page's `editVersion` and forces a re-download with the new
// baked-in PNG. The eventual Capture click goes through the same
// `ensure…Downloaded` helpers, so files already pre-downloaded by
// Copy aren't re-written.

// Spy on `navigator.clipboard.writeText` from the capture page. The
// spy installs a per-page array of all text writes so the test can
// inspect them without needing clipboard-read permission (which
// additionally requires user activation to actually read back).
async function installClipboardSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface SpyState { __seeClip?: string[] }
    const g = self as unknown as SpyState;
    g.__seeClip = [];
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text: string) => {
      g.__seeClip!.push(text);
      return orig(text);
    };
  });
}

async function readClipboardSpy(page: Page): Promise<string[]> {
  return await page.evaluate(
    () => (self as unknown as { __seeClip?: string[] }).__seeClip ?? [],
  );
}

// Wait until the clipboard spy has recorded `n` writes. Copy click
// handlers are async (SW round-trip + wait-for-download-complete),
// so a Playwright `.click()` resolves before the write lands.
async function waitForClipboardWrites(page: Page, n: number): Promise<void> {
  await page.waitForFunction(
    (count) =>
      ((self as unknown as { __seeClip?: string[] }).__seeClip?.length ?? 0) >= count,
    n,
    { timeout: 5000 },
  );
}

// Count the screenshot / HTML downloads recorded in the SW spy
// (installed by `openDetailsFlow`). Used to assert the per-tab cache
// short-circuits — i.e. after the first Copy on each kind, neither a
// repeat Copy nor the eventual Capture should add another entry.
async function countDownloadsBySuffix(sw: Worker, suffix: string): Promise<number> {
  return await sw.evaluate((sfx) => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    const list = (self as unknown as SpyState).__seeDl ?? [];
    return list.filter((d) => d.name.endsWith(sfx)).length;
  }, suffix);
}

// Return *all* downloads whose requested filename matches a bare
// basename prefix (e.g. `'contents-'` or `'selection-'`), in the
// order they were initiated. Each entry includes the chrome
// downloadId so the caller can resolve the on-disk path and read
// the bytes back. Used by the edit-dialog tests to verify that a
// post-edit Copy requests the *same* pinned filename as the
// pre-edit Copy (i.e. production overwrites in place) while also
// proving the bytes on disk differ.
async function findAllCapturedDownloads(
  sw: Worker,
  basenamePrefix: string,
): Promise<{ id: number; name: string }[]> {
  return await sw.evaluate((prefix) => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    const list = (self as unknown as SpyState).__seeDl ?? [];
    // `name` is the full `SeeWhatISee/<basename>` path we passed to
    // `chrome.downloads.download`. Match the bare basename prefix
    // so callers don't have to care about the directory segment.
    return list.filter((d) => {
      const base = d.name.split('/').pop() ?? d.name;
      return base.startsWith(prefix);
    });
  }, basenamePrefix);
}

test('details: copy buttons download files and put real paths on the clipboard', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardSpy(capturePage);

  await capturePage.locator('#copy-screenshot-name').click();
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 2);
  const writes = await readClipboardSpy(capturePage);

  // Each write is an absolute on-disk path to a real, non-empty
  // file. In the Playwright fixture the SeeWhatISee/<filename> is
  // rewritten to a UUID basename under a temp dir, so we don't pin
  // the basename shape — but the file is on disk and non-empty.
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatch(/^[/\\]/);
  expect(writes[1]).toMatch(/^[/\\]/);
  expect(writes[0]).not.toBe(writes[1]);
  expect(fs.existsSync(writes[0])).toBe(true);
  expect(fs.statSync(writes[0]).size).toBeGreaterThan(0);
  expect(fs.existsSync(writes[1])).toBe(true);
  expect(fs.statSync(writes[1]).size).toBeGreaterThan(0);

  await configureAndCapture(capturePage, { saveScreenshot: true, saveHtml: true });

  // After Capture the log record references the two pinned filenames.
  // The clipboard advertised the same files (in production, anyway —
  // the Playwright fixture rewrites filenames, so we can only check
  // the regex shape here).
  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(fs.existsSync(writes[0])).toBe(true);
  expect(fs.existsSync(writes[1])).toBe(true);

  await openerPage.close();
});

test('details: copy then copy again without editing reuses the cached download', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardSpy(capturePage);

  // First Copy → SW downloads → one .png + zero .html so far.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 1);
  const sw = await getServiceWorker();
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);

  // Same for HTML.
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 2);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Click each Copy a second time without editing in between. The
  // SW cache (keyed by editVersion for screenshot, unconditional for
  // HTML) should short-circuit, so neither call adds a download.
  await capturePage.locator('#copy-screenshot-name').click();
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 4);
  const writes = await readClipboardSpy(capturePage);
  expect(writes).toHaveLength(4);
  expect(writes[2]).toBe(writes[0]); // same path returned from cache
  expect(writes[3]).toBe(writes[1]);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Capture with both checkboxes also hits the cache — no third
  // download for either kind.
  await configureAndCapture(capturePage, { saveScreenshot: true, saveHtml: true });
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  await openerPage.close();
});

test('details: drawing a highlight invalidates the screenshot cache so the next copy re-downloads', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardSpy(capturePage);

  // Initial Copy at editVersion=0 → one .png download.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 1);
  const sw = await getServiceWorker();
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);

  // Draw a rectangle: bumps editVersion, invalidates the cache.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );

  // Second Copy → SW sees the bumped editVersion, re-downloads with
  // the highlight-baked PNG. That's a second .png download.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 2);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(2);

  // Third Copy with no further edits → cache hit again, no new download.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 3);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(2);

  // Capture at the same editVersion → cache hit, no download.
  await configureAndCapture(capturePage, { saveScreenshot: true, saveHtml: false });
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(2);

  // Saved record carries highlights:true because we drew before save.
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.screenshot?.hasHighlights).toBe(true);

  await openerPage.close();
});

test('details: capture without ever clicking copy still downloads exactly once per kind', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  await configureAndCapture(capturePage, { saveScreenshot: true, saveHtml: true });

  const sw = await getServiceWorker();
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  await openerPage.close();
});

test('details: copy → edit → capture re-downloads the screenshot with the highlight baked in', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardSpy(capturePage);

  // First Copy at editVersion=0 — un-annotated PNG hits disk.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 1);
  const sw = await getServiceWorker();
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);

  // Draw a highlight — editVersion bumps, the v0 cache entry is now
  // stale relative to what the user is looking at.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );

  // Capture without an intervening Copy. The SW's
  // `ensureScreenshotDownloaded` sees `editVersion` (now 1) doesn't
  // match the cached `editVersion` (0), so it re-downloads with the
  // page's highlight-baked PNG. That's a second .png download —
  // the *final* image with the highlight, not the v0 file the Copy
  // wrote.
  await configureAndCapture(capturePage, { saveScreenshot: true, saveHtml: false });
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(2);

  // Saved record reflects the post-edit save: the screenshot
  // artifact carries `hasHighlights: true`, and the saved PNG
  // contains the red rectangle. We verify the
  // bake-in by sampling the PNG along the rectangle's left edge,
  // same as the dedicated highlight-bake-in test does.
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.screenshot?.hasHighlights).toBe(true);

  // findCapturedDownload returns the *latest* matching download, so
  // here it gives us the v1 (post-edit) re-download triggered by
  // Capture — the file with the red rectangle baked in — not the
  // v0 file the earlier Copy click wrote.
  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const edgeX = Math.round(png.width * 0.2);
  const edgeY = Math.round(png.height * 0.3);
  const edgeIdx = (edgeY * png.width + edgeX) * 4;
  const [r, g, b] = [png.data[edgeIdx], png.data[edgeIdx + 1], png.data[edgeIdx + 2]];
  // Red dominates: roughly r ≈ 255, g/b ≈ 0. Loose tolerance to
  // accommodate antialiasing along the stroke.
  expect(r).toBeGreaterThan(180);
  expect(g).toBeLessThan(80);
  expect(b).toBeLessThan(80);

  await openerPage.close();
});

test('details: edit-html dialog — copy, edit, copy-overwrites, capture is no-op', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardSpy(capturePage);
  const sw = await getServiceWorker();

  // Step 1: Copy the HTML once *before* editing. The SW materializes
  // the raw scrape under the pinned `contents-*.html` filename and
  // puts its on-disk path on the clipboard. One download recorded.
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Step 2: Open the edit dialog and replace the body. The textarea
  // is seeded with the original capture — the fixture's purple
  // marker — and we swap it for a unique marker we can grep for.
  expect(await capturePage.locator('#edit-html-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(false);
  await capturePage.locator('#edit-html').click();
  expect(await capturePage.locator('#edit-html-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(true);
  const prefill = await capturePage.locator('#edit-html-textarea').inputValue();
  expect(prefill).toContain('background: #800080');

  const EDITED = '<!doctype html><html><body>edited by test 42</body></html>';
  await capturePage.locator('#edit-html-textarea').fill(EDITED);
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty(
    'open',
    false,
  );
  // The HTML-size readout reflects the new (much shorter) body.
  const sizeText = await capturePage.locator('#html-size').innerText();
  expect(sizeText).toMatch(/^\d+ B$/);

  // Step 3: Copy again *after* editing. The edit invalidated the
  // cache, so the SW re-downloads — count goes to 2. The two
  // downloads must request the *same* pinned basename (production
  // overwrites in place via conflictAction: 'overwrite'), even
  // though the Playwright harness rewrites each temp path.
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 2);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const htmlDownloads = await findAllCapturedDownloads(sw, 'contents-');
  expect(htmlDownloads).toHaveLength(2);
  expect(htmlDownloads[0].name).toBe(htmlDownloads[1].name);

  // The second download carries the edited bytes; the first
  // download's file still holds the original scrape since the
  // Playwright fixture gives each write its own UUID path.
  const firstPath = await waitForDownloadPath(sw, htmlDownloads[0].id);
  const secondPath = await waitForDownloadPath(sw, htmlDownloads[1].id);
  expect(fs.readFileSync(firstPath, 'utf8')).toContain('background: #800080');
  const editedBytes = fs.readFileSync(secondPath, 'utf8');
  expect(editedBytes).toContain('edited by test 42');
  expect(editedBytes).not.toContain('background: #800080');

  // Step 4: Capture with Save HTML on. The post-edit Copy already
  // wrote the edited file, so the SW's per-tab cache short-circuits
  // — no third download. Log records the pinned filename + edited
  // flag.
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
  });
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const record = await readLatestRecord(sw);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.contents?.isEdited).toBe(true);

  await openerPage.close();
});

// Shared beforeCapture hook used by the selection-edit tests.
// Injects a <span> into the fixture body and selects its contents
// so the SW's scripting call sees a non-empty `window.getSelection`.
async function seedSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const span = document.createElement('span');
    span.id = 'sel-seed';
    span.textContent = 'hello selection world';
    document.body.appendChild(span);
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
  });
}

// Whitespace-only variant: the scraped fragment's `innerHTML` is
// non-empty (so the SW sends us a `selections` object), but every
// format trims to empty. The details page must collapse the whole
// selection group to disabled + unchecked, not leave the master
// enabled with three dead radios underneath.
async function seedWhitespaceOnlySelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const span = document.createElement('span');
    span.id = 'sel-seed';
    span.textContent = '   \n\t  ';
    document.body.appendChild(span);
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
  });
}

test('details: whitespace-only selection disables the whole Save selection group', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedWhitespaceOnlySelection,
  );

  // Master checkbox stays disabled + unchecked, with the shared
  // selection-error icon explaining why.
  const selectionBox = capturePage.locator('#cap-selection');
  await expect(selectionBox).toBeDisabled();
  await expect(selectionBox).not.toBeChecked();
  await expect(capturePage.locator('#row-selection')).toHaveClass(/has-error/);
  await expect(capturePage.locator('#error-selection')).toHaveAttribute(
    'title',
    /Selection has no saveable content/,
  );

  // The whole format group is hidden; the per-format rows don't
  // surface at all so the user sees only the master's explanation.
  await expect(capturePage.locator('.selection-formats')).toBeHidden();

  await openerPage.close();
});

test('details: edit-selection dialog — copy, edit, copy-overwrites, capture is no-op', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  await installClipboardSpy(capturePage);
  const sw = await getServiceWorker();

  // The Save-selection-as-HTML row was enabled by loadData (the SW
  // saw our seeded selection and the HTML format always has content
  // when the selection is non-empty), so the pencil button is
  // clickable rather than stuck in its disabled default state. It's
  // also the default-checked radio — matching the old "Save
  // selection" default which always used the HTML serialization.
  await expect(capturePage.locator('#edit-selection-html-btn')).toBeEnabled();
  await expect(capturePage.locator('#cap-selection-html')).toBeChecked();

  // Step 1: Copy the selection HTML before editing — SW writes the
  // raw selection scrape under the pinned `selection-*.html` filename.
  await capturePage.locator('#copy-selection-html-name').click();
  await waitForClipboardWrites(capturePage, 1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Step 2: Open the dialog and replace the selection body. The
  // textarea is seeded with what the SW scraped, which contains
  // our fixture's injected text.
  await capturePage.locator('#edit-selection-html-btn').click();
  expect(await capturePage.locator('#edit-selection-html-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(true);
  const prefill = await capturePage.locator('#edit-selection-html-textarea').inputValue();
  expect(prefill).toContain('hello selection world');

  const EDITED = '<p>selection edited by test 99</p>';
  await capturePage.locator('#edit-selection-html-textarea').fill(EDITED);
  await capturePage.locator('#edit-selection-html-save').click();
  await expect(capturePage.locator('#edit-selection-html-dialog')).toHaveJSProperty(
    'open',
    false,
  );

  // Step 3: Copy again → cache invalidated, second download fires,
  // pinned filename unchanged, new bytes on disk.
  await capturePage.locator('#copy-selection-html-name').click();
  await waitForClipboardWrites(capturePage, 2);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const selDownloads = await findAllCapturedDownloads(sw, 'selection-');
  expect(selDownloads).toHaveLength(2);
  expect(selDownloads[0].name).toBe(selDownloads[1].name);

  const firstPath = await waitForDownloadPath(sw, selDownloads[0].id);
  const secondPath = await waitForDownloadPath(sw, selDownloads[1].id);
  expect(fs.readFileSync(firstPath, 'utf8')).toContain('hello selection world');
  const editedBytes = fs.readFileSync(secondPath, 'utf8');
  expect(editedBytes).toContain('selection edited by test 99');
  expect(editedBytes).not.toContain('hello selection world');

  // Step 4: Capture with Save selection as HTML on (default-checked
  // when a selection was detected). Cache hit → no third download.
  // Log's `selection` artifact carries `format: 'html'` and
  // `isEdited: true`.
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
  });
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const record = await readLatestRecord(sw);
  expect(record.selection?.filename).toBeDefined();
  expect(record.selection?.format).toBe('html');
  expect(record.selection?.isEdited).toBe(true);

  await openerPage.close();
});

test('details: edit-selection cancel leaves the captured selection untouched', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );

  await capturePage.locator('#edit-selection-html-btn').click();
  await capturePage.locator('#edit-selection-html-textarea').fill('DISCARDED NONSENSE');
  await capturePage.locator('#edit-selection-html-cancel').click();
  await expect(capturePage.locator('#edit-selection-html-dialog')).toHaveJSProperty(
    'open',
    false,
  );

  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  // No edit actually landed, so the sidecar's selection object
  // must not carry the sticky `isEdited` flag.
  expect(record.selection?.isEdited).toBeUndefined();

  const selPath = await findCapturedDownload(sw, '.html');
  const body = fs.readFileSync(selPath, 'utf8');
  expect(body).toContain('hello selection world');
  expect(body).not.toContain('DISCARDED NONSENSE');

  await openerPage.close();
});

test('details: edit-html cancel leaves the captured HTML untouched', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Open the dialog, type garbage, then hit Cancel. The captured
  // body on the SW side must be unchanged — the ensuing HTML save
  // should write the original fixture HTML, not our edits.
  await capturePage.locator('#edit-html').click();
  await capturePage.locator('#edit-html-textarea').fill('DISCARDED NONSENSE');
  await capturePage.locator('#edit-html-cancel').click();
  expect(await capturePage.locator('#edit-html-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(false);

  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
  });

  const sw = await getServiceWorker();
  const contentsPath = await findCapturedDownload(sw, '.html');
  const html = fs.readFileSync(contentsPath, 'utf8');
  expect(html).toContain('background: #800080');
  expect(html).not.toContain('DISCARDED NONSENSE');

  await openerPage.close();
});

test('details: edit-html save-with-no-changes is a no-op (no SW round-trip, no isEdited flag)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardSpy(capturePage);
  const sw = await getServiceWorker();

  // Pre-download the HTML so we have a baseline cache entry to watch.
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Open the dialog, touch nothing, click Save. The no-op guard
  // should skip the SW round-trip — so the cache stays committed
  // and no second download fires.
  await capturePage.locator('#edit-html').click();
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty('open', false);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Capture: still a cache hit, still no download; the sidecar must
  // NOT carry `isEdited: true` since no real edit happened.
  await configureAndCapture(capturePage, { saveScreenshot: false, saveHtml: true });
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  const record = await readLatestRecord(sw);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.contents?.isEdited).toBeUndefined();

  await openerPage.close();
});

test('details: edit → edit → save keeps isEdited: true across multiple dialog opens', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // First edit cycle: replace body with marker A.
  await capturePage.locator('#edit-html').click();
  await capturePage.locator('#edit-html-textarea').fill('<html><body>first edit A</body></html>');
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty('open', false);

  // Reopen: the dialog should seed from the edited body, not the
  // original scrape. Replace again with marker B.
  await capturePage.locator('#edit-html').click();
  const seededFromFirstEdit = await capturePage.locator('#edit-html-textarea').inputValue();
  expect(seededFromFirstEdit).toContain('first edit A');
  await capturePage.locator('#edit-html-textarea').fill('<html><body>second edit B</body></html>');
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty('open', false);

  await configureAndCapture(capturePage, { saveScreenshot: false, saveHtml: true });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  // Sticky across multiple edit cycles — one Save already flipped
  // the flag, and a later Save can't unset it.
  expect(record.contents?.isEdited).toBe(true);

  const contentsPath = await findCapturedDownload(sw, '.html');
  const html = fs.readFileSync(contentsPath, 'utf8');
  expect(html).toContain('second edit B');
  expect(html).not.toContain('first edit A');

  await openerPage.close();
});

// Both HTML-bearing Edit dialogs (page contents + selection HTML)
// expose the Edit/Preview toggle. The preview wiring is identical,
// so we run the same matrix of assertions for each kind — opening
// via the kind-specific pencil button and asserting against the
// kind-specific DOM ids. The selection variant needs a seeded
// selection so its row (and pencil) come out enabled.
interface PreviewCase {
  kind: 'html' | 'selection-html';
  openBtnId: string;
  slug: string;
  /** Optional opener hook to inject a live selection. */
  beforeCapture?: (page: Page) => Promise<void>;
}

const PREVIEW_CASES: PreviewCase[] = [
  { kind: 'html', openBtnId: '#edit-html', slug: 'html' },
  {
    kind: 'selection-html',
    openBtnId: '#edit-selection-html-btn',
    slug: 'selection-html',
    beforeCapture: seedSelection,
  },
];

for (const c of PREVIEW_CASES) {
  test(`details: ${c.kind} edit dialog preview mode renders the current textarea via a sandboxed iframe`, async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const { openerPage, capturePage } = await openDetailsFlow(
      extensionContext,
      fixtureServer,
      getServiceWorker,
      'purple.html',
      c.beforeCapture,
    );

    const editBtnSel = `#edit-${c.slug}-mode-edit`;
    const previewBtnSel = `#edit-${c.slug}-mode-preview`;
    const textareaSel = `#edit-${c.slug}-textarea`;
    const iframeSel = `#edit-${c.slug}-preview`;

    await capturePage.locator(c.openBtnId).click();

    // Edit is selected by default; Preview is not. The iframe is
    // hidden, the textarea visible.
    await expect(capturePage.locator(editBtnSel)).toHaveClass(/selected/);
    await expect(capturePage.locator(previewBtnSel)).not.toHaveClass(/selected/);
    await expect(capturePage.locator(textareaSel)).toBeVisible();
    await expect(capturePage.locator(iframeSel)).toBeHidden();

    // Replace the body with a unique marker so we can check it
    // renders via the preview iframe.
    const MARKER = `preview-marker-${c.slug}-9817`;
    await capturePage.locator(textareaSel).fill(
      `<html><body><h1>${MARKER}</h1><a href="foo.html">link</a></body></html>`,
    );

    // Flip to Preview. The iframe shows, the toggle's selected state
    // flips. The textarea stays in the DOM (kept as layout anchor)
    // but is hidden via `visibility: hidden`, so its bounding box
    // persists — the dialog's dimensions can't jump across modes.
    await capturePage.locator(previewBtnSel).click();
    await expect(capturePage.locator(previewBtnSel)).toHaveClass(/selected/);
    await expect(capturePage.locator(editBtnSel)).not.toHaveClass(/selected/);
    await expect(capturePage.locator(iframeSel)).toBeVisible();
    expect(await capturePage.locator(textareaSel).evaluate(
      (el) => getComputedStyle(el).visibility,
    )).toBe('hidden');

    // The iframe uses a blob: URL (srcdoc has an attribute size limit
    // that truncates large captures), with sandbox tokens that allow
    // popups but deny scripts / same-origin / forms / top navigation.
    const src = await capturePage.locator(iframeSel).getAttribute('src');
    expect(src).toMatch(/^blob:/);
    const sandboxTokens = await capturePage.locator(iframeSel)
      .getAttribute('sandbox');
    expect(sandboxTokens).toBe('allow-popups allow-popups-to-escape-sandbox');

    // The rendered iframe actually shows the marker content, the
    // injected <base> is in <head> with href + target=_blank, and a
    // forced <meta charset="utf-8"> is in place so non-ASCII content
    // doesn't mojibake under the blob's default charset.
    const iframe = capturePage.frameLocator(iframeSel);
    await expect(iframe.locator('h1')).toHaveText(MARKER);
    await expect(iframe.locator('head meta[charset="utf-8"]')).toHaveCount(1);
    const baseAttrs = await iframe.locator('head > base').first().evaluate(
      (el) => ({
        href: el.getAttribute('href') ?? '',
        target: el.getAttribute('target') ?? '',
      }),
    );
    expect(baseAttrs.target).toBe('_blank');
    expect(baseAttrs.href).toMatch(/^http:\/\//);

    // Flip back to Edit: textarea is visible again, edits are
    // preserved, iframe's src is dropped so we're not retaining the
    // blob.
    await capturePage.locator(editBtnSel).click();
    await expect(capturePage.locator(textareaSel)).toBeVisible();
    await expect(capturePage.locator(iframeSel)).toBeHidden();
    expect(await capturePage.locator(textareaSel).inputValue())
      .toContain(MARKER);
    expect(await capturePage.locator(iframeSel).getAttribute('src'))
      .toBeNull();

    await openerPage.close();
  });
}

test('details: preview strips <script> and <meta http-equiv=refresh>', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Input with two known hijack vectors: inline script (neutralized
  // by the iframe sandbox anyway, but we strip for defense in depth)
  // and a meta refresh that would otherwise navigate the iframe to
  // an attacker URL without any script needed.
  const MARKER = 'safe-marker-8842';
  const HOSTILE = `
    <html><head>
      <meta http-equiv="refresh" content="0; url=https://evil.example/">
      <meta http-equiv="REFRESH" content="1">
      <meta http-equiv="Content-Type" content="text/html">
    </head><body>
      <h1>${MARKER}</h1>
      <script>document.body.innerHTML = 'pwned'</script>
      <script src="https://evil.example/beacon.js"></script>
    </body></html>
  `;
  await capturePage.locator('#edit-html').click();
  await capturePage.locator('#edit-html-textarea').fill(HOSTILE);
  await capturePage.locator('#edit-html-mode-preview').click();

  const iframe = capturePage.frameLocator('#edit-html-preview');
  // Marker content still renders.
  await expect(iframe.locator('h1')).toHaveText(MARKER);
  // Both <script> tags removed (inline + src).
  await expect(iframe.locator('script')).toHaveCount(0);
  // Both <meta http-equiv=refresh> tags removed (case-insensitive
  // match covers the uppercase variant). The benign Content-Type
  // meta is also stripped because `buildPreviewHtml` removes any
  // Content-Type-style meta before injecting its own charset — so
  // the only http-equiv meta left is ours (if any). In practice
  // there is none, since we inject `<meta charset>` not http-equiv.
  await expect(iframe.locator('meta[http-equiv="refresh" i]')).toHaveCount(0);

  await openerPage.close();
});

test('details: preview tolerates malformed HTML and still renders content', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Deliberately broken input: unclosed tags, mismatched close tags,
  // stray `<span>` close, a truncated comment, and a mismatched
  // quote. DOMParser's `text/html` mode + the browser's tolerant
  // parser recover to something sensible; the preview should still
  // display the marker text instead of going blank.
  const MARKER = 'malformed-marker-5523';
  const BROKEN = `<p>before<div><h1>${MARKER}</h1></span>after</p><!--oops`;
  await capturePage.locator('#edit-html').click();
  await capturePage.locator('#edit-html-textarea').fill(BROKEN);
  await capturePage.locator('#edit-html-mode-preview').click();

  const iframe = capturePage.frameLocator('#edit-html-preview');
  // H1 still rendered.
  await expect(iframe.locator('h1')).toHaveText(MARKER);
  // Neighboring text nodes survived the recovery.
  await expect(iframe.locator('body')).toContainText('before');
  await expect(iframe.locator('body')).toContainText('after');

  await openerPage.close();
});

test('details: non-HTML edit dialogs (selection text) have no Preview toggle', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // The toggle is rendered hidden by default in the template and
  // only revealed by `setMode(..)` for previewable kinds, so it's
  // enough to assert the selection-text dialog's toggle stays
  // hidden — no need to open the dialog or seed a selection.
  const toggle = capturePage.locator(
    '#edit-selection-text-dialog .edit-dialog-mode-toggle',
  );
  await expect(toggle).toBeHidden();

  await openerPage.close();
});

// ─── Graceful handling of failed HTML / selection scrape ──────────
//
// `chrome.scripting.executeScript` fails on restricted URLs
// (chrome://, the Web Store, file:// without explicit opt-in, etc.)
// — the details flow must still open, with Save HTML + Save
// selection disabled and error icons explaining why, so the user
// can still take a URL- / screenshot- / prompt-only capture with
// annotations. We simulate the failure by stubbing executeScript in
// the SW; driving an actual chrome:// page from Playwright is
// flaky across headless modes.

async function openDetailsFlowWithFailedScrape(
  extensionContext: BrowserContext,
  fixtureServer: { baseUrl: string },
  getServiceWorker: () => Promise<Worker>,
  errorMessage: string,
): Promise<{ openerPage: Page; capturePage: Page }> {
  const sw0 = await getServiceWorker();
  await sw0.evaluate((msg) => {
    interface ScrapeSpy {
      __seeScrapeOrig?: typeof chrome.scripting.executeScript;
    }
    const g = self as unknown as ScrapeSpy;
    if (!g.__seeScrapeOrig) {
      g.__seeScrapeOrig = chrome.scripting.executeScript.bind(chrome.scripting);
    }
    (chrome.scripting as { executeScript: typeof chrome.scripting.executeScript }).executeScript =
      (async () => {
        throw new Error(msg);
      }) as typeof chrome.scripting.executeScript;
  }, errorMessage);

  try {
    return await openDetailsFlow(extensionContext, fixtureServer, getServiceWorker);
  } finally {
    // Restore executeScript on its way out so later tests in the
    // worker see normal scraping again.
    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      interface ScrapeSpy {
        __seeScrapeOrig?: typeof chrome.scripting.executeScript;
      }
      const g = self as unknown as ScrapeSpy;
      if (g.__seeScrapeOrig) {
        (chrome.scripting as { executeScript: typeof chrome.scripting.executeScript }).executeScript =
          g.__seeScrapeOrig;
      }
    });
  }
}

test('details: html scrape failure still opens the page with HTML/selection disabled + error icons', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const reason = 'Cannot access contents of the page';
  const { openerPage, capturePage } = await openDetailsFlowWithFailedScrape(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    reason,
  );

  // Save HTML is disabled + unchecked, its Copy and Edit buttons are
  // disabled (and hidden via the shared `.copy-btn:disabled` rule),
  // and the row carries the `has-error` class + a tooltip explaining
  // what went wrong.
  const htmlBox = capturePage.locator('#cap-html');
  await expect(htmlBox).toBeDisabled();
  await expect(htmlBox).not.toBeChecked();
  await expect(capturePage.locator('#copy-html-name')).toBeDisabled();
  await expect(capturePage.locator('#edit-html')).toBeDisabled();
  await expect(capturePage.locator('#row-html')).toHaveClass(/has-error/);
  await expect(capturePage.locator('#error-html')).toHaveAttribute(
    'title',
    new RegExp(`Unable to capture HTML contents.*${reason}`),
  );

  // Master "Save selection" checkbox stays in its default
  // greyed-out state. The failure was the same `executeScript`
  // call, so the HTML row's error already explains it; a
  // duplicate icon on the selection master row would just be
  // noise. We do NOT add `has-error` and do NOT set any
  // selection-error tooltip in this case.
  const selectionBox = capturePage.locator('#cap-selection');
  await expect(selectionBox).toBeDisabled();
  await expect(selectionBox).not.toBeChecked();
  await expect(capturePage.locator('#row-selection')).not.toHaveClass(/has-error/);
  await expect(capturePage.locator('#error-selection')).toHaveAttribute('title', '');

  // With no selection at all the whole format group is hidden —
  // the per-format rows don't surface in any scrape-failure path.
  await expect(capturePage.locator('.selection-formats')).toBeHidden();

  // Screenshot + prompt + highlights remain functional: drawing a
  // rectangle and saving the screenshot + prompt should still produce
  // a normal record.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );
  await capturePage.locator('#prompt-text').fill('scrape failed but I can still use this');
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.contents).toBeUndefined();
  expect(record.selection).toBeUndefined();
  expect(record.prompt).toBe('scrape failed but I can still use this');

  await openerPage.close();
});

// ─── Selection-aware click dispatch ──────────────────────────────
//
// These tests cover the toolbar-click behavior when the active page
// has a text selection. Matrix:
//
//   - `with-sel` default × selection present × single / double-click,
//     verifying both what runs and what *doesn't* (ignore-selection
//     must not probe; double-click on selection always opens details).
//   - `copyLastSelectionFilename` menu action.
//   - Stale storage: a `capture-selection-*` id stashed in the
//     without-selection slot should fall back (the setter normally
//     rejects it, but storage migrations or manual edits could leak
//     one in).
//
// Shared setup pattern: each test clears `chrome.storage.local`,
// pins the two click defaults it cares about, seeds a selection on
// the opener page via `seedSelection`, and then drives
// `handleActionClick` from the SW. Assertions read the in-memory
// log (`chrome.storage.local.get('captureLog')`) rather than
// log.json — no need for the download-spy setup that the details
// flow uses, since we only care about what was recorded.

type ClickApi = {
  handleActionClick: () => Promise<void>;
  setDefaultWithSelectionId: (id: string) => Promise<void>;
  setDefaultWithoutSelectionId: (id: string) => Promise<void>;
};

async function pinClickDefaults(
  sw: Worker,
  withId: string,
  withoutId: string,
): Promise<void> {
  await sw.evaluate(
    async ({ withId, withoutId }: { withId: string; withoutId: string }) => {
      await chrome.storage.local.clear();
      const api = (self as unknown as { SeeWhatISee: ClickApi }).SeeWhatISee;
      await api.setDefaultWithSelectionId(withId);
      await api.setDefaultWithoutSelectionId(withoutId);
    },
    { withId, withoutId },
  );
}

async function runSingleClick(sw: Worker): Promise<void> {
  await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ClickApi }).SeeWhatISee;
    await api.handleActionClick();
  });
}

// Fire two clicks tight enough that the second lands before the
// 250ms `DOUBLE_CLICK_MS` timer expires. The first call's promise
// never resolves once the timer is cleared (that's the production
// reality too — a real double-click leaks a pending promise inside
// the SW), so we fire-and-forget it and only await the second.
async function runDoubleClick(sw: Worker): Promise<void> {
  await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ClickApi }).SeeWhatISee;
    void api.handleActionClick().catch(() => {});
    // Micro-pause so the first call registers its timer before the
    // second clears it. Same-worker single-threaded — the `await`
    // is defensive against any future microtask shuffle.
    await new Promise((r) => setTimeout(r, 20));
    await api.handleActionClick();
  });
}

type LogRecord = {
  screenshot?: { filename: string };
  contents?: { filename: string };
  selection?: { filename: string; format: string };
};

async function latestLogRecord(sw: Worker): Promise<LogRecord | undefined> {
  const stored = await sw.evaluate(() => chrome.storage.local.get('captureLog'));
  const log = (stored.captureLog ?? []) as LogRecord[];
  return log[log.length - 1];
}

async function selectionRecordOnlyCheck(sw: Worker, expectFormat: string): Promise<void> {
  const r = await latestLogRecord(sw);
  expect(r, 'a capture record landed').toBeDefined();
  expect(r!.selection?.format).toBe(expectFormat);
  expect(r!.screenshot).toBeUndefined();
  expect(r!.contents).toBeUndefined();
}

for (const { id, format, ext } of [
  { id: 'capture-selection-html', format: 'html', ext: 'html' },
  { id: 'capture-selection-text', format: 'text', ext: 'txt' },
  { id: 'capture-selection-markdown', format: 'markdown', ext: 'md' },
] as const) {
  test(`click with selection: with-sel=${id} saves selection as .${ext}`, async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    await pinClickDefaults(sw, id, 'capture-with-details');

    const openerPage = await extensionContext.newPage();
    await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
    await openerPage.bringToFront();
    await seedSelection(openerPage);

    await runSingleClick(sw);

    const r = await latestLogRecord(sw);
    expect(r?.selection?.filename, 'selection file written').toMatch(
      new RegExp(`^selection-\\d{8}-\\d{6}-\\d{3}\\.${ext}$`),
    );
    expect(r?.selection?.format).toBe(format);
    expect(r?.screenshot).toBeUndefined();
    expect(r?.contents).toBeUndefined();

    await openerPage.close();
  });
}

test('click with selection: with-sel=capture-with-details opens details in selectionOnly mode', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await pinClickDefaults(sw, 'capture-with-details', 'capture-now');

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();
  await seedSelection(openerPage);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  await runSingleClick(sw);
  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // selectionOnly: screenshot + html unchecked, Save selection
  // master checked. Any format row may be the default-checked one
  // (loadData picks the first with content); HTML is the reliable
  // one against our seeded selection, but any checked format works.
  await expect(capturePage.locator('#cap-screenshot')).not.toBeChecked();
  await expect(capturePage.locator('#cap-html')).not.toBeChecked();
  await expect(capturePage.locator('#cap-selection')).toBeChecked();

  // Close the details tab without saving so nothing leaks into the
  // log / file system.
  await capturePage.close();
  await openerPage.close();
});

test('click with selection: with-sel=ignore-selection runs the without-selection default', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // ignore-selection + capture-now should take a screenshot even
  // though a selection is present — the probe is skipped entirely.
  await pinClickDefaults(sw, 'ignore-selection', 'capture-now');

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();
  await seedSelection(openerPage);

  // If the probe *did* run and kicked us into a with-selection
  // branch, we'd either open a details page or save a selection
  // file. Guard against the details path opening.
  let detailsOpened = false;
  const onPage = (p: Page): void => {
    if (p.url().endsWith('/capture.html')) detailsOpened = true;
  };
  extensionContext.on('page', onPage);

  await runSingleClick(sw);

  await new Promise((r) => setTimeout(r, 150));
  extensionContext.off('page', onPage);
  expect(detailsOpened, 'no details page opens in ignore-selection mode').toBe(false);

  const r = await latestLogRecord(sw);
  expect(r?.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(r?.selection, 'selection NOT saved in ignore-selection mode').toBeUndefined();

  await openerPage.close();
});

test('double-click with selection: always opens details (even when without-sel=capture-with-details)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Without-sel = capture-with-details → classic alternate is
  // capture-now (screenshot). With a selection present and
  // with-sel != ignore-selection, the new rule overrides that
  // alternate and routes double-click to details. This test
  // regression-guards the override.
  const sw = await getServiceWorker();
  await pinClickDefaults(sw, 'capture-selection-html', 'capture-with-details');

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();
  await seedSelection(openerPage);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  await runDoubleClick(sw);

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // Double-click opens plain details (NOT selectionOnly), so the
  // usual defaults apply: screenshot checked, html unchecked,
  // selection pre-checked because the SW saw our selection.
  await expect(capturePage.locator('#cap-screenshot')).toBeChecked();
  await expect(capturePage.locator('#cap-selection')).toBeChecked();

  await capturePage.close();
  await openerPage.close();
});

test('double-click with selection: ignore-selection keeps the classic alternate (screenshot)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // ignore-selection + without-sel=capture-with-details → classic
  // double-click alternate is capture-now. The "selection present"
  // override must NOT trigger when the user has opted out via
  // ignore-selection, so a selection on the page shouldn't flip
  // the dispatch to details.
  const sw = await getServiceWorker();
  await pinClickDefaults(sw, 'ignore-selection', 'capture-with-details');

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();
  await seedSelection(openerPage);

  let detailsOpened = false;
  const onPage = (p: Page): void => {
    if (p.url().endsWith('/capture.html')) detailsOpened = true;
  };
  extensionContext.on('page', onPage);

  await runDoubleClick(sw);

  await new Promise((r) => setTimeout(r, 150));
  extensionContext.off('page', onPage);
  expect(detailsOpened, 'details must NOT open in ignore-selection double-click').toBe(false);

  const r = await latestLogRecord(sw);
  expect(r?.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);

  await openerPage.close();
});

test('getDefaultWithoutSelectionId: stale capture-selection-* storage value falls back', async ({
  getServiceWorker,
}) => {
  // The setter rejects `capture-selection-*` baseIds, but a stale
  // value could leak in from a storage migration or manual edit.
  // The getter must refuse to hand it back — it'd error on every
  // click without a selection.
  const sw = await getServiceWorker();
  const id = await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    // Bypass the setter to simulate a corrupt value.
    await chrome.storage.local.set({
      defaultClickWithoutSelection: 'capture-selection-html',
    });
    return await (
      self as unknown as {
        SeeWhatISee: { getDefaultWithoutSelectionId: () => Promise<string> };
      }
    ).SeeWhatISee.getDefaultWithoutSelectionId();
  });
  expect(id).toBe('capture-with-details');
});

test('copyLastSelectionFilename: throws when no capture in the log', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const err = await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    try {
      await (
        self as unknown as {
          SeeWhatISee: { copyLastSelectionFilename: () => Promise<void> };
        }
      ).SeeWhatISee.copyLastSelectionFilename();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(err).toBe('No captures in the log to copy from');
});

test('copyLastSelectionFilename: throws when latest record has no selection', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const err = await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    // Seed a screenshot-only record — the latest has no selection.
    await chrome.storage.local.set({
      captureLog: [
        {
          timestamp: '2026-04-21T12:00:00.000Z',
          url: 'https://example.test/',
          screenshot: { filename: 'screenshot-20260421-120000-000.png' },
        },
      ],
    });
    try {
      await (
        self as unknown as {
          SeeWhatISee: { copyLastSelectionFilename: () => Promise<void> };
        }
      ).SeeWhatISee.copyLastSelectionFilename();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(err).toBe('Latest capture has no selection to copy');
});

test('copyLastSelectionFilename: forwards the selection filename to the offscreen copy target', async ({
  getServiceWorker,
}) => {
  // Intercept the three chrome.* calls that `copyLastSelectionFilename`
  // depends on so the test can read the payload handed to the
  // offscreen document without needing a real capture to have
  // written log.json (which is what `getCaptureDirectory` normally
  // looks up via `chrome.downloads.search`), and without needing
  // the offscreen doc to actually execute `execCommand('copy')`.
  //
  // Originals are saved and restored via a finally block so later
  // tests in the same worker see unpatched chrome.* APIs — the SW
  // is shared across tests in this single-worker setup.
  const sw = await getServiceWorker();
  try {
    const forwarded = await sw.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        captureLog: [
          {
            timestamp: '2026-04-21T12:00:00.000Z',
            url: 'https://example.test/',
            selection: { filename: 'selection-20260421-120000-000.md', format: 'markdown' },
          },
        ],
      });

      interface Spy {
        __seeCopyOrigSearch?: typeof chrome.downloads.search;
        __seeCopyOrigCreate?: typeof chrome.offscreen.createDocument;
        __seeCopyOrigSend?: typeof chrome.runtime.sendMessage;
        __seeOffscreenMsg?: unknown;
      }
      const g = self as unknown as Spy;
      g.__seeCopyOrigSearch = chrome.downloads.search.bind(chrome.downloads);
      g.__seeCopyOrigCreate = chrome.offscreen.createDocument.bind(chrome.offscreen);
      g.__seeCopyOrigSend = chrome.runtime.sendMessage.bind(chrome.runtime);

      // Fake the download-history lookup: return a single synthetic
      // log.json entry with byExtensionId = our id, so
      // `getCaptureDirectory` accepts it and strips to a directory.
      (chrome.downloads as { search: typeof chrome.downloads.search }).search =
        (async () => [
          {
            id: 0,
            byExtensionId: chrome.runtime.id,
            filename: '/tmp/fake-see-dir/log.json',
          } as chrome.downloads.DownloadItem,
        ]) as typeof chrome.downloads.search;
      (chrome.offscreen as { createDocument: typeof chrome.offscreen.createDocument }).createDocument =
        (async () => {}) as typeof chrome.offscreen.createDocument;
      (chrome.runtime as { sendMessage: typeof chrome.runtime.sendMessage }).sendMessage =
        (async (msg: unknown) => {
          g.__seeOffscreenMsg = msg;
          // `copyToClipboard` treats an `undefined` response as
          // "offscreen listener never registered"; return an ok
          // envelope so the success path runs to completion.
          return { ok: true };
        }) as typeof chrome.runtime.sendMessage;

      g.__seeOffscreenMsg = undefined;
      await (
        self as unknown as {
          SeeWhatISee: { copyLastSelectionFilename: () => Promise<void> };
        }
      ).SeeWhatISee.copyLastSelectionFilename();

      return g.__seeOffscreenMsg;
    });
    const msg = forwarded as { target?: string; text?: string } | undefined;
    expect(msg?.target).toBe('offscreen-copy');
    expect(msg?.text).toBe('/tmp/fake-see-dir/selection-20260421-120000-000.md');
  } finally {
    // Restore originals so later tests see unpatched APIs.
    await sw.evaluate(() => {
      interface Spy {
        __seeCopyOrigSearch?: typeof chrome.downloads.search;
        __seeCopyOrigCreate?: typeof chrome.offscreen.createDocument;
        __seeCopyOrigSend?: typeof chrome.runtime.sendMessage;
      }
      const g = self as unknown as Spy;
      if (g.__seeCopyOrigSearch) {
        (chrome.downloads as { search: typeof chrome.downloads.search }).search =
          g.__seeCopyOrigSearch;
      }
      if (g.__seeCopyOrigCreate) {
        (chrome.offscreen as { createDocument: typeof chrome.offscreen.createDocument }).createDocument =
          g.__seeCopyOrigCreate;
      }
      if (g.__seeCopyOrigSend) {
        (chrome.runtime as { sendMessage: typeof chrome.runtime.sendMessage }).sendMessage =
          g.__seeCopyOrigSend;
      }
    });
  }
});

test('details: html scrape failure allows url-only capture (no checkboxes)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlowWithFailedScrape(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'restricted url',
  );

  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
    prompt: 'just the url please',
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents).toBeUndefined();
  expect(record.selection).toBeUndefined();
  expect(record.prompt).toBe('just the url please');
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);

  await openerPage.close();
});
