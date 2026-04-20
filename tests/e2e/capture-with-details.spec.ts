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
//     bake-in: a red rectangle from a left-drag ends up in the
//     saved PNG)
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
// `log.json` / `screenshot-…png` filename we asked for. Only
// the `download()` call sees the requested name.
//
// The spy install runs *inside the same `evaluate` block* that
// triggers `startCaptureWithDetails`, so a single SW respawn can't
// lose the patch between install and use. See openDetailsFlow.

// Resolve the recorded download whose requested filename ends with
// `suffix` (e.g. `'log.json'`, `'.png'`). Returns the on-disk
// path via the existing `waitForDownloadPath` poll.
// Resolve the most recently recorded download whose requested
// filename ends with `suffix` (e.g. `'log.json'`, `'.png'`) to its
// on-disk path, via `waitForDownloadPath`.
//
// Returning the *latest* match (rather than the first) handles the
// case where the same logical artifact has been re-downloaded —
// e.g. a Copy-button pre-download at editVersion=0 followed by a
// Capture-time re-download at editVersion=1 after the user drew a
// highlight. Tests that only ever produce a single matching
// download (the common case) get the same result either way.
async function findCapturedDownload(sw: Worker, suffix: string): Promise<string> {
  const id = await sw.evaluate((sfx) => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    const list = (self as unknown as SpyState).__seeDl ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].name.endsWith(sfx)) return list[i].id;
    }
    throw new Error(
      `no captured download ending in ${sfx}; have: ${list.map((d) => d.name).join(', ')}`,
    );
  }, suffix);
  return await waitForDownloadPath(sw, id);
}

async function readLatestRecord(sw: Worker): Promise<CaptureRecord> {
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// Open a fixture page (the "opener") and trigger the details flow.
// Returns both the opener page and the capture.html page so the
// caller can manipulate the latter and clean up the former.
async function openDetailsFlow(
  extensionContext: BrowserContext,
  fixtureServer: { baseUrl: string },
  getServiceWorker: () => Promise<Worker>,
  fixturePath = 'purple.html',
  // Optional hook run on the opener page *after* it has been
  // brought to front but *before* the SW triggers
  // startCaptureWithDetails. Used by the selection-edit tests to
  // inject a live `window.getSelection()` state that the SW's
  // scripting call observes as `selection`.
  beforeCapture?: (page: Page) => Promise<void>,
): Promise<{ openerPage: Page; capturePage: Page }> {
  // Clean log so stale entries from an earlier test in the same
  // worker can't satisfy our assertions.
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/${fixturePath}`);
  await openerPage.bringToFront();
  if (beforeCapture) await beforeCapture(openerPage);

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

  // The Capture button submits via runtime message; the background
  // saves and then closes our tab. Wait for the close to know the
  // round-trip is done.
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);
}

// Drag a rectangle on the highlight overlay between the given
// percentage coordinates of its bounding box. Tests use this to
// produce highlights without coupling to an internal drawing helper.
async function dragRect(
  capturePage: Page,
  fromPct: { xPct: number; yPct: number },
  toPct: { xPct: number; yPct: number },
): Promise<void> {
  const box = await capturePage.locator('#overlay').boundingBox();
  if (!box) throw new Error('overlay has no bounding box');
  const x1 = box.x + box.width * fromPct.xPct;
  const y1 = box.y + box.height * fromPct.yPct;
  const x2 = box.x + box.width * toPct.xPct;
  const y2 = box.y + box.height * toPct.yPct;
  await capturePage.mouse.move(x1, y1);
  await capturePage.mouse.down();
  // Two-step move so Playwright synthesises a real intermediate
  // mousemove and the overlay sees the drag distance cross the
  // CLICK_THRESHOLD_PX guard in capture-page.ts.
  await capturePage.mouse.move((x1 + x2) / 2, (y1 + y2) / 2);
  await capturePage.mouse.move(x2, y2);
  await capturePage.mouse.up();
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
  // Drag a red rectangle from (20%, 20%) to (40%, 40%). The bake-in
  // scales the 3px CSS-pixel stroke up to natural pixels via the
  // display→natural ratio, so the rectangle's left edge at x=20%
  // shows up as red in the saved PNG.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'look at the box',
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.prompt).toBe('look at the box');
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);

  // Sample the saved PNG along the rectangle's left edge (x=20%):
  // should be red. Far from the box should still be the fixture's
  // purple background.
  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));

  const edgeX = Math.round(png.width * 0.2);
  const edgeY = Math.round(png.height * 0.3);
  const edgeIdx = (edgeY * png.width + edgeX) * 4;
  const [r, g, b] = [
    png.data[edgeIdx],
    png.data[edgeIdx + 1],
    png.data[edgeIdx + 2],
  ];
  // Red stroke: high R, low G/B. Tolerate antialiasing.
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
  await dragRect(
    capturePage,
    { xPct: 0.4, yPct: 0.4 },
    { xPct: 0.6, yPct: 0.6 },
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.screenshot?.hasHighlights).toBe(true);
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

  // Empty stack → both buttons disabled.
  await expect(undo).toBeDisabled();
  await expect(clear).toBeDisabled();

  // One edit → both enabled.
  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.3, yPct: 0.3 });
  await expect(undo).toBeEnabled();
  await expect(clear).toBeEnabled();

  // Undo back to empty → both disabled.
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(clear).toBeDisabled();

  // Two edits, one undo → still enabled (one left).
  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.3, yPct: 0.3 });
  await dragRect(capturePage, { xPct: 0.4, yPct: 0.4 }, { xPct: 0.5, yPct: 0.5 });
  await undo.click();
  await expect(undo).toBeEnabled();
  await expect(clear).toBeEnabled();

  // Clear empties the stack regardless of count.
  await clear.click();
  await expect(undo).toBeDisabled();
  await expect(clear).toBeDisabled();

  // Close the details tab cleanly so it doesn't leak into the next
  // test.
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

  // Draw a rectangle, then undo it. The edit stack is now empty so
  // the capture-page bake-in path doesn't fire and the saved record
  // gets no `highlights` field.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );
  await capturePage.locator('#undo').click();

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.screenshot?.hasHighlights).toBeUndefined();

  // Sample the PNG along where the rectangle's left edge would have
  // been: should be the fixture's purple (#800080), not red.
  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const edgeX = Math.round(png.width * 0.2);
  const edgeY = Math.round(png.height * 0.3);
  const i = (edgeY * png.width + edgeX) * 4;
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

  // The Save-selection row was enabled by loadData (the SW saw our
  // seeded selection), so the pencil button is clickable rather
  // than stuck in its disabled default state.
  await expect(capturePage.locator('#edit-selection')).toBeEnabled();

  // Step 1: Copy the selection before editing — SW writes the raw
  // selection scrape under the pinned `selection-*.html` filename.
  await capturePage.locator('#copy-selection-name').click();
  await waitForClipboardWrites(capturePage, 1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Step 2: Open the dialog and replace the selection body. The
  // textarea is seeded with what the SW scraped, which contains
  // our fixture's injected text.
  await capturePage.locator('#edit-selection').click();
  expect(await capturePage.locator('#edit-selection-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(true);
  const prefill = await capturePage.locator('#edit-selection-textarea').inputValue();
  expect(prefill).toContain('hello selection world');

  const EDITED = '<p>selection edited by test 99</p>';
  await capturePage.locator('#edit-selection-textarea').fill(EDITED);
  await capturePage.locator('#edit-selection-save').click();
  await expect(capturePage.locator('#edit-selection-dialog')).toHaveJSProperty(
    'open',
    false,
  );

  // Step 3: Copy again → cache invalidated, second download fires,
  // pinned filename unchanged, new bytes on disk.
  await capturePage.locator('#copy-selection-name').click();
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

  // Step 4: Capture with Save selection on (default-checked when a
  // selection was detected). Cache hit → no third download. Log's
  // `selection` artifact carries `isEdited: true`.
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
  });
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const record = await readLatestRecord(sw);
  expect(record.selection?.filename).toBeDefined();
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

  await capturePage.locator('#edit-selection').click();
  await capturePage.locator('#edit-selection-textarea').fill('DISCARDED NONSENSE');
  await capturePage.locator('#edit-selection-cancel').click();
  await expect(capturePage.locator('#edit-selection-dialog')).toHaveJSProperty(
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

  // Selection row stays in its default greyed-out state — the
  // failure was the same `executeScript` call, so the HTML row's
  // error already explains it; a duplicate selection icon would
  // just be noise. We do NOT add `has-error` and do NOT set the
  // selection-error tooltip in this case.
  const selectionBox = capturePage.locator('#cap-selection');
  await expect(selectionBox).toBeDisabled();
  await expect(selectionBox).not.toBeChecked();
  await expect(capturePage.locator('#edit-selection')).toBeDisabled();
  await expect(capturePage.locator('#row-selection')).not.toHaveClass(/has-error/);
  await expect(capturePage.locator('#error-selection')).toHaveAttribute('title', '');

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
