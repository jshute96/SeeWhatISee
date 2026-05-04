// E2E coverage for the image right-click context menu paths:
//   - `captureImageAsScreenshot(tab, srcUrl)` — Save screenshot route,
//     no Capture page round-trip.
//   - `startCaptureWithDetailsFromImage(tab, srcUrl)` — Capture...
//     route, opens the Capture page with the image as the screenshot.
//
// Behavior pinned by these tests:
//   - The saved record carries `imageUrl` independent of whether
//     Save Screenshot is checked (the URL of the right-clicked
//     image survives even when the user unchecks the screenshot
//     checkbox before saving).
//   - Page HTML is *not* scraped on the image flow — the Save HTML
//     row is quiet-disabled (no error icon, no `has-error` class).
//   - Page selection still gets scraped: when text is selected on
//     the source page, Save Screenshot + Save Selection are both
//     checked by default (the right-click on an image often happens
//     while the caption is selected).
//   - Highlight / redact / crop flags still apply to the saved
//     `screenshot` artifact when the user draws on the preview.
//
// Driven via `self.SeeWhatISee` because Playwright can't trigger
// Chrome context-menu items on its own — same dispatch-via-evaluate
// approach the toolbar tests use.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import {
  configureAndCapture,
  countDownloadsBySuffix,
  dragRect,
  findCapturedDownload,
  openImageDetailsFlow,
  readLatestRecord,
  seedSelection,
  SCREENSHOT_PATTERN,
} from './details-helpers';
import { waitForDownloadPath } from '../fixtures/files';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RED_PIXEL_PATH = path.resolve(__dirname, '../fixtures/pages/red-pixel.png');

// chrome.tabs.captureVisibleTab isn't called on the image flow — the
// "screenshot" comes from a `fetch()` on the page side — but
// neighboring specs share the same Chromium worker. The cushion keeps
// us off any rate limit they might have just hit.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// ─── Save screenshot route ────────────────────────────────────────

test('image flow: save screenshot writes image bytes + record with imageUrl', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/red-image.html`);
  await openerPage.bringToFront();
  const imageUrl = await openerPage.locator('#target').evaluate(
    (el) => (el as HTMLImageElement).src,
  );

  const sw = await getServiceWorker();
  await sw.evaluate(async (src) => {
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

    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!active) throw new Error('no active tab');
    await (
      self as unknown as {
        SeeWhatISee: {
          captureImageAsScreenshot: (
            tab: chrome.tabs.Tab,
            srcUrl: string,
          ) => Promise<unknown>;
        };
      }
    ).SeeWhatISee.captureImageAsScreenshot(active, src);
  }, imageUrl);

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents).toBeUndefined();
  expect(record.selection).toBeUndefined();
  expect(record.imageUrl).toBe(imageUrl);
  // The source-page URL is recorded, not the image URL — they're
  // distinct fields (the latter is only for the right-clicked image).
  expect(record.url).toBe(`${fixtureServer.baseUrl}/red-image.html`);

  // Saved bytes equal the fixture's PNG bytes — the page-side
  // fetch + base64 round-trip is lossless.
  const pngPath = await findCapturedDownload(sw, '.png');
  const savedBytes = fs.readFileSync(pngPath);
  const fixtureBytes = fs.readFileSync(RED_PIXEL_PATH);
  expect(Buffer.compare(savedBytes, fixtureBytes)).toBe(0);

  await openerPage.close();
});

// ─── Capture... route — page-state assertions ─────────────────────

test('image flow: Capture page opens with screenshot+selection checked, HTML quiet-disabled', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage, imageUrl } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
    seedSelection,
  );

  const screenshotBox = capturePage.locator('#cap-screenshot');
  const htmlBox = capturePage.locator('#cap-html');
  const htmlRow = capturePage.locator('#row-html');
  const htmlSizeBadge = capturePage.locator('#html-size-badge');
  const selectionBox = capturePage.locator('#cap-selection');

  await expect(screenshotBox).toBeChecked();
  await expect(screenshotBox).toBeEnabled();

  // HTML row is disabled but NOT in error state — quiet disable.
  await expect(htmlBox).toBeDisabled();
  await expect(htmlBox).not.toBeChecked();
  expect(await htmlRow.evaluate((el) => el.classList.contains('has-error'))).toBe(false);
  await expect(htmlSizeBadge).toBeHidden();

  // Selection is auto-checked because seedSelection seeded a non-
  // empty range on the source page before the flow opened.
  await expect(selectionBox).toBeChecked();
  await expect(selectionBox).toBeEnabled();

  // Save and verify the record reflects all three flags.
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents).toBeUndefined();
  expect(record.selection?.format).toBeDefined();
  expect(record.imageUrl).toBe(imageUrl);

  await openerPage.close();
});

// ─── imageUrl is recorded even when Save Screenshot is unchecked ─

test('image flow: imageUrl is recorded even when Save Screenshot is unchecked', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage, imageUrl } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
    seedSelection,
  );

  // Uncheck Save Screenshot but keep Save Selection checked.
  await capturePage.locator('#cap-screenshot').uncheck();
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents).toBeUndefined();
  expect(record.selection?.format).toBeDefined();
  // The whole point of this test: imageUrl survives unchecking
  // Save Screenshot, because the user's intent in the right-click
  // flow is to remember the image they picked.
  expect(record.imageUrl).toBe(imageUrl);

  // No screenshot should have been written either (the user
  // unchecked it, and the cache shouldn't materialize the file
  // speculatively).
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(0);

  await openerPage.close();
});

// ─── Without a selection, the master selection row stays disabled ─

test('image flow: no selection on page → selection row disabled, screenshot still defaulted on', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage, imageUrl } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
  );

  await expect(capturePage.locator('#cap-screenshot')).toBeChecked();
  await expect(capturePage.locator('#cap-html')).toBeDisabled();
  await expect(capturePage.locator('#cap-selection')).toBeDisabled();

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents).toBeUndefined();
  expect(record.selection).toBeUndefined();
  expect(record.imageUrl).toBe(imageUrl);

  await openerPage.close();
});

// ─── Drawing flags still surface on image-flow records ────────────

// ─── Save screenshot path: HTML scrape never fires ────────────────

// The image flow's whole point is "this image, not the page," so the
// save-screenshot path must not fire a page HTML scrape. The previous
// "Save screenshot" test only asserts `record.contents` is undefined,
// which could be satisfied for unrelated reasons. This test pins it
// directly by swapping `chrome.scripting.executeScript` for a counting
// proxy and asserting the count is zero after the save.
test('image flow: save screenshot does NOT scrape the page (no executeScript call)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/red-image.html`);
  await openerPage.bringToFront();
  const imageUrl = await openerPage.locator('#target').evaluate(
    (el) => (el as HTMLImageElement).src,
  );

  const sw = await getServiceWorker();
  await sw.evaluate(async (src) => {
    interface SpyState {
      __seeScrapeCount?: number;
      __seeScrapeOrig?: typeof chrome.scripting.executeScript;
    }
    const g = self as unknown as SpyState;
    g.__seeScrapeOrig = chrome.scripting.executeScript.bind(chrome.scripting);
    g.__seeScrapeCount = 0;
    (chrome.scripting as { executeScript: typeof chrome.scripting.executeScript }).executeScript =
      (async (...args: Parameters<typeof chrome.scripting.executeScript>) => {
        g.__seeScrapeCount = (g.__seeScrapeCount ?? 0) + 1;
        return g.__seeScrapeOrig!(...args);
      }) as typeof chrome.scripting.executeScript;

    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!active) throw new Error('no active tab');
    await (
      self as unknown as {
        SeeWhatISee: {
          captureImageAsScreenshot: (
            tab: chrome.tabs.Tab,
            srcUrl: string,
          ) => Promise<unknown>;
        };
      }
    ).SeeWhatISee.captureImageAsScreenshot(active, src);
  }, imageUrl);

  // The image fetch happens via executeScript too — that's expected.
  // What must NOT happen is a *second* executeScript call for the
  // page HTML scrape (`scrapePageStateInPage`). In the save-screenshot
  // path there's exactly one executeScript call: the page-side fetch.
  const scrapeCount = await sw.evaluate(
    () => (self as unknown as { __seeScrapeCount?: number }).__seeScrapeCount ?? 0,
  );
  expect(scrapeCount).toBe(1);

  // Restore so later tests in the worker see the real executeScript.
  await sw.evaluate(() => {
    interface SpyState {
      __seeScrapeOrig?: typeof chrome.scripting.executeScript;
    }
    const g = self as unknown as SpyState;
    if (g.__seeScrapeOrig) {
      (chrome.scripting as { executeScript: typeof chrome.scripting.executeScript }).executeScript =
        g.__seeScrapeOrig;
    }
  });

  await openerPage.close();
});

// ─── data: URL + JPEG MIME → `.jpg` extension ─────────────────────

// Pins two things at once: `fetchImageInPage` works for `data:` image
// URLs (no http round-trip), and `imageExtensionFor('image/jpeg', …)`
// produces `.jpg` (not the `unknown` final fallback) so the saved
// bytes match their format.
test('image flow: data: URL with JPEG MIME saves under `.jpg`', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/red-image.html`);
  await openerPage.bringToFront();
  const imageUrl = await openerPage.locator('#inline-jpeg').evaluate(
    (el) => (el as HTMLImageElement).src,
  );
  expect(imageUrl.startsWith('data:image/jpeg;base64,')).toBe(true);

  const sw = await getServiceWorker();
  await sw.evaluate(async (src) => {
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

    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!active) throw new Error('no active tab');
    await (
      self as unknown as {
        SeeWhatISee: {
          captureImageAsScreenshot: (
            tab: chrome.tabs.Tab,
            srcUrl: string,
          ) => Promise<unknown>;
        };
      }
    ).SeeWhatISee.captureImageAsScreenshot(active, src);
  }, imageUrl);

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.jpg$/);
  expect(record.imageUrl).toBe(imageUrl);

  // The saved file should exist and be the JPEG bytes (header `FF D8 FF`).
  const jpgPath = await findCapturedDownload(sw, '.jpg');
  const buf = fs.readFileSync(jpgPath);
  expect(buf.length).toBeGreaterThan(0);
  expect(buf[0]).toBe(0xff);
  expect(buf[1]).toBe(0xd8);
  expect(buf[2]).toBe(0xff);

  await openerPage.close();
});

// ─── Fetch failure surfaces via the toolbar error channel ─────────

// Pins that the page-side error envelope (executeScript discards
// page-side rejections, so we return `{error}` instead) and the
// surrounding `runWithErrorReporting` wrap actually fail the call
// rather than silently writing a no-bytes record.
test('image flow: fetch failure on a 404 image URL throws + writes no record', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/red-image.html`);
  await openerPage.bringToFront();

  const sw = await getServiceWorker();
  const { errorMessage, recordCount } = await sw.evaluate(async (badUrl) => {
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!active) throw new Error('no active tab');
    let errorMessage: string | null = null;
    try {
      await (
        self as unknown as {
          SeeWhatISee: {
            captureImageAsScreenshot: (
              tab: chrome.tabs.Tab,
              srcUrl: string,
            ) => Promise<unknown>;
          };
        }
      ).SeeWhatISee.captureImageAsScreenshot(active, badUrl);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    const data = await chrome.storage.local.get('captureLog');
    const log = (data.captureLog as unknown[] | undefined) ?? [];
    return { errorMessage, recordCount: log.length };
  }, `${fixtureServer.baseUrl}/definitely-not-a-real-image.png`);

  // The image fetch reported an error envelope from the page; the SW
  // re-throws so the toolbar error channel surfaces it.
  expect(errorMessage).toMatch(/HTTP 404|Failed to fetch|fetching image/i);
  // No log record should have landed — the throw aborts before
  // `appendToLog`.
  expect(recordCount).toBe(0);

  await openerPage.close();
});

// ─── Canvas fallback rescues a fetch failure ─────────────────────

// On real sites this is the cookies-blocked / hot-link-protected
// path: `<img src>` painted fine via the browser's image loader, but
// a fresh `fetch()` from the content-script context gets 403'd. The
// SW's `fetchImageInPage` falls through to a canvas snapshot of the
// already-painted `<img>`.
//
// Forcing the failure: `chrome.scripting.executeScript` (default
// ISOLATED world) shares a per-frame isolated world across all
// extension calls. Patching `window.fetch` from one `executeScript`
// persists into the next one, so we can stub fetch to reject before
// the SW runs its capture and the canvas branch fires.
test('image flow: canvas fallback rescues a fetch failure on a painted <img>', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/red-image.html`);
  await openerPage.bringToFront();
  const imageUrl = await openerPage.locator('#target').evaluate(
    (el) => (el as HTMLImageElement).src,
  );

  const sw = await getServiceWorker();
  // Stage 1: poison fetch in the page's isolated world.
  await sw.evaluate(async () => {
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!active?.id) throw new Error('no active tab');
    await chrome.scripting.executeScript({
      target: { tabId: active.id },
      func: () => {
        // Reject every fetch with a synthetic 403-style error so
        // `fetchImageInPage` thinks the network leg failed and
        // falls through to the canvas branch.
        (window as unknown as { fetch: typeof fetch }).fetch =
          (() => Promise.reject(new Error('simulated 403 from test'))) as typeof fetch;
      },
    });
  });

  // Stage 2: trigger the capture. The SW's image fetch will hit the
  // patched fetch, throw, then look for a painted <img> matching
  // imageUrl — `#target` on red-image.html paints `/red-pixel.png`,
  // so canvas snapshot succeeds.
  await sw.evaluate(async (src) => {
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

    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!active) throw new Error('no active tab');
    await (
      self as unknown as {
        SeeWhatISee: {
          captureImageAsScreenshot: (
            tab: chrome.tabs.Tab,
            srcUrl: string,
          ) => Promise<unknown>;
        };
      }
    ).SeeWhatISee.captureImageAsScreenshot(active, src);
  }, imageUrl);

  // Record landed: imageUrl preserved; canvas always emits PNG so
  // the saved bytes have a `.png` extension regardless of the
  // source image's original format.
  const record = await readLatestRecord(sw);
  expect(record.imageUrl).toBe(imageUrl);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);

  // Bytes on disk are real PNG (header `89 50 4E 47`).
  const pngPath = await findCapturedDownload(sw, '.png');
  const buf = fs.readFileSync(pngPath);
  expect(buf[0]).toBe(0x89);
  expect(buf[1]).toBe(0x50);
  expect(buf[2]).toBe(0x4e);
  expect(buf[3]).toBe(0x47);

  await openerPage.close();
});

// ─── imageFlowDefaults inherits user's defaultButton ──────────────

// Pins that `imageFlowDefaults` only overrides the Save-checkbox
// fields and faithfully passes through the user's `defaultButton`
// preference. Without this, a user who set Ask as their default
// would silently lose the Ask highlight on every image-context
// capture.
test('image flow: Capture page inherits stored defaultButton (ask)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
    undefined,
    {
      capturePageDefaults: {
        withoutSelection: { screenshot: true, html: false },
        withSelection: { screenshot: false, html: false, selection: true, format: 'markdown' },
        defaultButton: 'ask',
        promptEnter: 'send',
      },
    },
  );

  // Ask split-button carries the `is-default` class; Capture button doesn't.
  await expect(capturePage.locator('.ask-split')).toHaveClass(/\bis-default\b/);
  await expect(capturePage.locator('#capture')).not.toHaveClass(/\bis-default\b/);

  await openerPage.close();
});

// ─── Edit-bake forces .png filename even for non-PNG sources ─────

// `renderHighlightedPng` always emits PNG (canvas.toDataURL('image/png')).
// On a JPEG source, the original filename is `screenshot-<ts>.jpg`;
// once the user bakes any edit in, the bytes become PNG and the SW
// must rewrite the filename's extension so the file on disk matches
// its contents. Without this, downstream tools that key off the
// extension (image viewers, agents reading `log.json`) would
// disagree with the actual bytes.
test('image flow: JPEG source + bake-in writes .png with PNG bytes', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage, imageUrl } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
    undefined,
    undefined,
    '#http-jpeg', // 200x200 real JPEG served over http with image/jpeg.
  );
  expect(imageUrl).toMatch(/\/red-pixel\.jpg$/);

  // Draw a Box highlight to force the canvas bake.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });

  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);

  // Filename ext flipped from .jpg → .png to match the baked bytes.
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.imageUrl).toBe(imageUrl);

  // Bytes on disk are real PNG (header `89 50 4E 47`).
  const pngPath = await findCapturedDownload(sw, '.png');
  const buf = fs.readFileSync(pngPath);
  expect(buf[0]).toBe(0x89);
  expect(buf[1]).toBe(0x50);
  expect(buf[2]).toBe(0x4e);
  expect(buf[3]).toBe(0x47);

  await openerPage.close();
});

// ─── Undo-all reverts filename back to the original extension ─────

// The bake-in fix flips the screenshot filename's extension to
// `.png` when there's an override. The reverse path matters too:
// after the user undoes every edit, the override goes away, the
// bytes saved are the original (e.g. JPEG) bytes, and the filename
// must revert to `.jpg`. Without this, JPEG bytes would land under
// a `.png` filename — the same lie in reverse.
test('image flow: JPEG source + bake then undo-all writes original .jpg', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage, imageUrl } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
    undefined,
    undefined,
    '#http-jpeg',
  );
  expect(imageUrl).toMatch(/\/red-pixel\.jpg$/);

  // Bake an edit, then undo it — both via the in-page tool palette.
  // The `editVersion` counter bumps on each step (draw + undo are
  // both edits), so the SW sees two distinct versions and the
  // filename should land at `.jpg` once the override is gone.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  await capturePage.locator('#undo').click();

  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.jpg$/);
  // No highlight flag — the undo cleared the only edit.
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  expect(record.imageUrl).toBe(imageUrl);

  // Bytes on disk are the original JPEG (header `FF D8 FF`).
  const jpgPath = await findCapturedDownload(sw, '.jpg');
  const buf = fs.readFileSync(jpgPath);
  expect(buf[0]).toBe(0xff);
  expect(buf[1]).toBe(0xd8);
  expect(buf[2]).toBe(0xff);

  await openerPage.close();
});

test('image flow: drawing a Box highlight surfaces hasHighlights on the record', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage, imageUrl } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
  );

  // Default tool is Box (red rectangle highlight) — draw a box well
  // inside the preview so it doesn't trigger the crop-handle band.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });

  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.imageUrl).toBe(imageUrl);

  // The screenshot file gets re-downloaded with the highlight baked
  // in, so the saved bytes differ from the original fixture. Just
  // assert the file exists and is non-zero.
  const pngPath = await waitForDownloadPath(
    sw,
    await sw.evaluate(() => {
      interface SpyState { __seeDl?: { id: number; name: string }[] }
      const list = (self as unknown as SpyState).__seeDl ?? [];
      // Latest .png download — the bake-in re-download under the
      // same pinned filename.
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].name.endsWith('.png')) return list[i].id;
      }
      throw new Error('no .png download recorded');
    }),
  );
  expect(fs.statSync(pngPath).size).toBeGreaterThan(0);

  await openerPage.close();
});
