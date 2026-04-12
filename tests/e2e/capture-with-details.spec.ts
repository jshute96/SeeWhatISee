// E2E coverage for the "Capture with details…" flow.
//
// We drive the actual capture.html UI: open a fixture page, call
// `SeeWhatISee.startCaptureWithDetails()` from the SW, find the
// resulting capture.html tab, manipulate its checkboxes / prompt /
// highlight overlay, click Capture, and verify the on-disk record.
//
// Combinations covered (not full cross-product — just enough to
// touch every dimension):
//   - PNG only, no prompt, no highlights
//   - HTML only, with prompt
//   - PNG + HTML, with prompt
//   - PNG only, with highlights + prompt (verifies the canvas
//     bake-in: a red dot from the click ends up in the saved PNG)
//   - PNG + HTML, with highlights, no prompt
//   - Tab positioning + opener focus return on close

import fs from 'node:fs';
import { PNG } from 'pngjs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { type CaptureRecord, waitForDownloadPath } from '../fixtures/files';

const SCREENSHOT_PATTERN = /^screenshot-\d{8}-\d{6}-\d{3}\.png$/;
const CONTENTS_PATTERN = /^contents-\d{8}-\d{6}-\d{3}\.html$/;

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Each test in this file issues one capture via startCaptureWithDetails;
// without a small cushion the suite occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// We spy on `chrome.downloads.download` so we can map *requested
// filenames* to download ids. Without this we can't tell the
// detailed-capture downloads apart: `chrome.downloads.search`
// returns the Playwright-managed temp UUID path, not the original
// `latest.json` / `screenshot-…png` filename we asked for. Only
// the `download()` call sees the requested name.
//
// The spy install runs *inside the same `evaluate` block* that
// triggers `startCaptureWithDetails`, so a single SW respawn can't
// lose the patch between install and use. See openDetailsFlow.

// Resolve the recorded download whose requested filename ends with
// `suffix` (e.g. `'latest.json'`, `'.png'`). Returns the on-disk
// path via the existing `waitForDownloadPath` poll.
async function findCapturedDownload(sw: Worker, suffix: string): Promise<string> {
  const id = await sw.evaluate((sfx) => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    const list = (self as unknown as SpyState).__seeDl ?? [];
    const match = list.find((d) => d.name.endsWith(sfx));
    if (!match) {
      throw new Error(
        `no captured download ending in ${sfx}; have: ${list.map((d) => d.name).join(', ')}`,
      );
    }
    return match.id;
  }, suffix);
  return await waitForDownloadPath(sw, id);
}

async function readLatestRecord(sw: Worker): Promise<CaptureRecord> {
  const path = await findCapturedDownload(sw, 'latest.json');
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// Open a fixture page (the "opener") and trigger the details flow.
// Returns both the opener page and the capture.html page so the
// caller can manipulate the latter and clean up the former.
async function openDetailsFlow(
  extensionContext: BrowserContext,
  fixtureServer: { baseUrl: string },
  getServiceWorker: () => Promise<Worker>,
  fixturePath = 'purple.html',
): Promise<{ openerPage: Page; capturePage: Page }> {
  // Clean log so a stale latest.json from an earlier test in the
  // same worker can't satisfy our assertions.
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/${fixturePath}`);
  await openerPage.bringToFront();

  // Set up the page-event listener *before* triggering the SW call,
  // so we don't miss the new tab if it lands fast.
  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  const sw = await getServiceWorker();
  // Install the spy + trigger the flow in one `evaluate` block so
  // we can't lose the patch to an SW idle-out between calls.
  await sw.evaluate(async () => {
    interface SpyState {
      __seeDl?: { id: number; name: string }[];
      __seeDlOrig?: typeof chrome.downloads.download;
    }
    const g = self as unknown as SpyState;
    if (!g.__seeDlOrig) {
      g.__seeDlOrig = chrome.downloads.download.bind(chrome.downloads);
      (chrome.downloads as { download: typeof chrome.downloads.download }).download =
        (async (opts: chrome.downloads.DownloadOptions) => {
          const id = await g.__seeDlOrig!(opts);
          if (typeof id === 'number') {
            g.__seeDl!.push({ id, name: opts.filename ?? '' });
          }
          return id;
        }) as typeof chrome.downloads.download;
    }
    g.__seeDl = [];

    await (
      self as unknown as {
        SeeWhatISee: { startCaptureWithDetails: () => Promise<void> };
      }
    ).SeeWhatISee.startCaptureWithDetails();
  });

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');
  // Wait for the screenshot data URL to load + the overlay to size
  // itself, so any subsequent highlight clicks land on a sized target.
  await capturePage.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  return { openerPage, capturePage };
}

interface CaptureOptions {
  saveScreenshot: boolean;
  saveHtml: boolean;
  prompt?: string;
  /** Click the overlay at this percent of its bounding box to drop
   * a red dot. Plain click (no movement) → circle, per the
   * CLICK_THRESHOLD_PX guard in capture-page.ts. */
  drawDot?: { xPct: number; yPct: number };
}

async function configureAndCapture(
  capturePage: Page,
  opts: CaptureOptions,
): Promise<void> {
  // Reconcile each checkbox against the desired state. Default
  // markup has cap-screenshot=checked / cap-html=unchecked.
  const screenshotEl = capturePage.locator('#cap-screenshot');
  if ((await screenshotEl.isChecked()) !== opts.saveScreenshot) {
    await screenshotEl.click();
  }
  const htmlEl = capturePage.locator('#cap-html');
  if ((await htmlEl.isChecked()) !== opts.saveHtml) {
    await htmlEl.click();
  }

  if (opts.prompt !== undefined) {
    await capturePage.locator('#prompt-text').fill(opts.prompt);
  }

  if (opts.drawDot) {
    const box = await capturePage.locator('#overlay').boundingBox();
    if (!box) throw new Error('overlay has no bounding box');
    const x = box.x + box.width * opts.drawDot.xPct;
    const y = box.y + box.height * opts.drawDot.yPct;
    // mouse.click is mousedown+mouseup at the same coords → 0px
    // movement → CLICK_THRESHOLD_PX guard fires → dot, not rect.
    await capturePage.mouse.click(x, y);
  }

  // The Capture button submits via runtime message; the background
  // saves and then closes our tab. Wait for the close to know the
  // round-trip is done.
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);
}

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
  expect(record.screenshot).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents).toBeUndefined();
  expect(record.prompt).toBeUndefined();
  expect(record.highlights).toBeUndefined();
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
  expect(record.contents).toMatch(CONTENTS_PATTERN);
  expect(record.prompt).toBe('find the bug');
  expect(record.highlights).toBeUndefined();
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
  expect(record.screenshot).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents).toMatch(CONTENTS_PATTERN);
  expect(record.prompt).toBe('compare these');
  expect(record.highlights).toBeUndefined();
  // Both files share the same compact-timestamp suffix when written
  // by the detailed-capture path.
  const screenshotSuffix = record.screenshot!.replace(/^screenshot-/, '').replace(/\.png$/, '');
  const contentsSuffix = record.contents!.replace(/^contents-/, '').replace(/\.html$/, '');
  expect(screenshotSuffix).toBe(contentsSuffix);

  await openerPage.close();
});

test('details: png with highlights bakes red into the saved PNG', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Click 30%/30% of the overlay → red dot. The bake-in scales the
  // 5px CSS-pixel radius up to natural pixels via the
  // display→natural ratio.
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'look at the dot',
    drawDot: { xPct: 0.3, yPct: 0.3 },
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.highlights).toBe(true);
  expect(record.prompt).toBe('look at the dot');
  expect(record.screenshot).toMatch(SCREENSHOT_PATTERN);

  // Sample the saved PNG at the same percent coordinates: should
  // be solid red. Far from the dot should still be the fixture's
  // purple background.
  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));

  const dotX = Math.floor(png.width * 0.3);
  const dotY = Math.floor(png.height * 0.3);
  const dotIdx = (dotY * png.width + dotX) * 4;
  const [r, g, b] = [
    png.data[dotIdx],
    png.data[dotIdx + 1],
    png.data[dotIdx + 2],
  ];
  // Red dot: high R, low G/B. Tolerate antialiasing.
  expect(r).toBeGreaterThan(200);
  expect(g).toBeLessThan(60);
  expect(b).toBeLessThan(60);

  // Far corner should still be the fixture's purple background.
  const farIdx = (10 * png.width + 10) * 4;
  expect(png.data[farIdx]).toBeGreaterThan(100); // R of #800080
  expect(png.data[farIdx + 1]).toBeLessThan(40); // G of #800080
  expect(png.data[farIdx + 2]).toBeGreaterThan(100); // B of #800080

  await openerPage.close();
});

test('details: png + html with highlights, no prompt', async ({
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
    drawDot: { xPct: 0.5, yPct: 0.5 },
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents).toMatch(CONTENTS_PATTERN);
  expect(record.highlights).toBe(true);
  expect(record.prompt).toBeUndefined();

  await openerPage.close();
});

test('details: undo/clear buttons reflect the edit stack', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  const undo = capturePage.locator('#undo');
  const clear = capturePage.locator('#clear');
  const overlay = capturePage.locator('#overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('overlay has no bounding box');

  const dotAt = (xPct: number, yPct: number) =>
    capturePage.mouse.click(box.x + box.width * xPct, box.y + box.height * yPct);

  // Empty stack → both buttons disabled.
  await expect(undo).toBeDisabled();
  await expect(clear).toBeDisabled();

  // One edit → both enabled.
  await dotAt(0.25, 0.25);
  await expect(undo).toBeEnabled();
  await expect(clear).toBeEnabled();

  // Undo back to empty → both disabled.
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(clear).toBeDisabled();

  // Two edits, one undo → still enabled (one left).
  await dotAt(0.3, 0.3);
  await dotAt(0.5, 0.5);
  await undo.click();
  await expect(undo).toBeEnabled();
  await expect(clear).toBeEnabled();

  // Clear empties the stack regardless of count.
  await clear.click();
  await expect(undo).toBeDisabled();
  await expect(clear).toBeDisabled();

  // Close the details tab cleanly so it doesn't leak into the next
  // test. Default checkbox state (screenshot only) keeps Capture
  // enabled.
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  await openerPage.close();
});

test('details: draw then undo → no highlights flag, no red in saved PNG', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  const box = await capturePage.locator('#overlay').boundingBox();
  if (!box) throw new Error('overlay has no bounding box');

  // Drop a dot, then undo it. The edit stack is now empty so the
  // capture-page bake-in path doesn't fire and the saved record
  // gets no `highlights` field.
  await capturePage.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await capturePage.locator('#undo').click();

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot).toMatch(SCREENSHOT_PATTERN);
  expect(record.highlights).toBeUndefined();

  // Sample the PNG where the dot would have been: should be the
  // fixture's purple (#800080), not red.
  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const dotX = Math.floor(png.width * 0.3);
  const dotY = Math.floor(png.height * 0.3);
  const i = (dotY * png.width + dotX) * 4;
  // #800080 ≈ (128, 0, 128). G should be ~0, B ~128. A red pixel
  // would be (255, 0, 0) — the B test alone is enough to
  // discriminate.
  expect(png.data[i + 2]).toBeGreaterThan(80);

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
        SeeWhatISee: { setDefaultClickActionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultClickActionId('capture-now');
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
  const log = (stored.captureLog ?? []) as { screenshot?: string }[];
  expect(log.length).toBeGreaterThan(0);
  expect(log[log.length - 1].screenshot).toMatch(SCREENSHOT_PATTERN);

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
        SeeWhatISee: { setDefaultClickActionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultClickActionId('capture-with-details');
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
  // test. Default checkbox state (screenshot only) keeps Capture
  // enabled.
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
        SeeWhatISee: { setDefaultClickActionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultClickActionId('capture-now');
  });

  await openerPage.close();
});

test('setDefaultClickActionId updates the toolbar tooltip to match', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const titles = await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: { setDefaultClickActionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee;
    await api.setDefaultClickActionId('capture-now');
    const a = await chrome.action.getTitle({});
    await api.setDefaultClickActionId('capture-now-2s');
    const b = await chrome.action.getTitle({});
    await api.setDefaultClickActionId('save-page-contents');
    const c = await chrome.action.getTitle({});
    await api.setDefaultClickActionId('capture-with-details');
    const d = await chrome.action.getTitle({});
    // Restore default so the rest of the suite is unaffected.
    await api.setDefaultClickActionId('capture-now');
    return { a, b, c, d };
  });

  expect(titles.a).toBe('SeeWhatISee — Capture visible tab\nDouble-click for capture with details');
  expect(titles.b).toBe('SeeWhatISee — Capture visible tab in 2s\nDouble-click for capture with details');
  expect(titles.c).toBe('SeeWhatISee — Save HTML contents\nDouble-click for capture with details');
  expect(titles.d).toBe('SeeWhatISee — Capture with details\nDouble-click for screenshot');
});
