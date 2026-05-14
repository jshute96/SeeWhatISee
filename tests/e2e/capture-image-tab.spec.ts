// E2E coverage for the "active tab is a bare image" routing:
//   - `captureVisible()` saves the source image bytes (no
//     `captureVisibleTab` re-encode of Chrome's image viewer).
//   - `startCaptureWithDetails()` opens the Capture page using the
//     same `htmlUnavailable: true` / `useImageFlowDefaults: true`
//     shape as the upload-image flow.
//
// Driven by navigating a tab directly to a fixture image URL
// (`/red-pixel.png` / `.jpg`), so Chrome serves the image into its
// built-in image viewer — `document.contentType` then reports the
// image MIME and `probeActiveTabImage` short-circuits the screenshot
// path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import {
  findCapturedDownload,
  readLatestRecord,
  SCREENSHOT_PATTERN,
} from './details-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/pages');
const RED_PNG = path.join(FIXTURE_DIR, 'red-pixel.png');
const RED_JPG = path.join(FIXTURE_DIR, 'red-pixel.jpg');

// Install the chrome.downloads spy used by `findCapturedDownload` /
// `readLatestRecord`. Mirrors the same patch `openDetailsFlow` and
// `openImageDetailsFlow` install — we just need it standalone for
// the `captureVisible` path (which doesn't go through either helper).
async function installDownloadSpy(sw: import('@playwright/test').Worker): Promise<void> {
  await sw.evaluate(() => {
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
  });
}

// ─── captureVisible (save-screenshot) route ────────────────────────

test('image tab: captureVisible saves the source PNG bytes, not a screenshot', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const imageUrl = `${fixtureServer.baseUrl}/red-pixel.png`;
  const tab = await extensionContext.newPage();
  await tab.goto(imageUrl);
  await tab.bringToFront();

  const sw = await getServiceWorker();
  await installDownloadSpy(sw);
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { captureVisible: () => Promise<unknown> };
      }
    ).SeeWhatISee.captureVisible();
  });

  const record = await readLatestRecord(sw);
  // The saved file is named `screenshot-…` regardless of the routing
  // path — downstream consumers (the see-what-i-see skills) key off
  // this. Extension matches the source MIME (`.png` here).
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  // Image-tab path records the image URL as the page URL (the tab
  // IS the image). No separate `imageUrl` field — that's only set on
  // the right-click image flow.
  expect(record.url).toBe(imageUrl);
  expect(record.imageUrl).toBeUndefined();

  const pngPath = await findCapturedDownload(sw, '.png');
  const saved = fs.readFileSync(pngPath);
  const fixture = fs.readFileSync(RED_PNG);
  expect(Buffer.compare(saved, fixture)).toBe(0);

  await tab.close();
});

test('image tab: captureVisible on a JPEG image saves under `.jpg`', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const imageUrl = `${fixtureServer.baseUrl}/red-pixel.jpg`;
  const tab = await extensionContext.newPage();
  await tab.goto(imageUrl);
  await tab.bringToFront();

  const sw = await getServiceWorker();
  await installDownloadSpy(sw);
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { captureVisible: () => Promise<unknown> };
      }
    ).SeeWhatISee.captureVisible();
  });

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.jpg$/);
  expect(record.url).toBe(imageUrl);

  const jpgPath = await findCapturedDownload(sw, '.jpg');
  const saved = fs.readFileSync(jpgPath);
  const fixture = fs.readFileSync(RED_JPG);
  expect(Buffer.compare(saved, fixture)).toBe(0);

  await tab.close();
});

// ─── captureAll / saveDefaults respect htmlUnavailable ────────────

// Regression: `captureAll` and `saveDefaults` both call
// `captureBothToMemory`, which for an image tab returns
// `htmlUnavailable: true` instead of an `htmlError`. Pre-fix, the
// "save everything" / "save default items" shortcuts would silently
// write an empty `contents-*.html` alongside the image because the
// `htmlError`-only guard let an empty HTML body through.
test('image tab: captureAll on a PNG saves the image and skips HTML', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const imageUrl = `${fixtureServer.baseUrl}/red-pixel.png`;
  const tab = await extensionContext.newPage();
  await tab.goto(imageUrl);
  await tab.bringToFront();

  const sw = await getServiceWorker();
  await installDownloadSpy(sw);
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { captureAll: () => Promise<unknown> };
      }
    ).SeeWhatISee.captureAll();
  });

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  // No HTML artifact — image tabs have nothing to save there. The
  // record's `contents` field is absent rather than pointing at an
  // empty file.
  expect(record.contents).toBeUndefined();

  // Verify the spy didn't see an HTML download fire either (the
  // record check would miss a file that landed but didn't get
  // referenced).
  const namesAfter = await sw.evaluate(() => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    return ((self as unknown as SpyState).__seeDl ?? []).map((d) => d.name);
  });
  expect(namesAfter.some((n) => n.endsWith('.html'))).toBe(false);

  await tab.close();
});

test('image tab: saveDefaults skips HTML even when withoutSelection.html=true', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());
  // Seed defaults so the user's pref *would* save HTML on a normal
  // page. The image-tab path should suppress it via `htmlUnavailable`.
  await sw0.evaluate(async () => {
    await chrome.storage.local.set({
      capturePageDefaults: {
        withoutSelection: { screenshot: true, html: true },
        withSelection: { screenshot: true, html: true, selection: true, format: 'markdown' },
        defaultButton: 'capture',
        promptEnter: 'send',
      },
    });
  });

  const imageUrl = `${fixtureServer.baseUrl}/red-pixel.png`;
  const tab = await extensionContext.newPage();
  await tab.goto(imageUrl);
  await tab.bringToFront();

  const sw = await getServiceWorker();
  await installDownloadSpy(sw);
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { saveDefaults: () => Promise<unknown> };
      }
    ).SeeWhatISee.saveDefaults();
  });

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(record.contents).toBeUndefined();
  const namesAfter = await sw.evaluate(() => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    return ((self as unknown as SpyState).__seeDl ?? []).map((d) => d.name);
  });
  expect(namesAfter.some((n) => n.endsWith('.html'))).toBe(false);

  await tab.close();
});

// ─── Capture... (startCaptureWithDetails) route ───────────────────

// Regression for the user-reported "JPG → PNG" issue: a JPEG image
// tab routed through the Capture page (no edits, just click Save)
// must land on disk as `.jpg` with JPEG bytes — same as the upload
// flow already does for the same source.
test('image tab: Capture page save of a JPEG keeps it as .jpg (no bake)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const imageUrl = `${fixtureServer.baseUrl}/red-pixel.jpg`;
  const tab = await extensionContext.newPage();
  await tab.goto(imageUrl);
  await tab.bringToFront();

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  const sw = await getServiceWorker();
  await installDownloadSpy(sw);
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { startCaptureWithDetails: () => Promise<void> };
      }
    ).SeeWhatISee.startCaptureWithDetails();
  });

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');
  await capturePage.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.jpg$/);

  const jpgPath = await findCapturedDownload(sw, '.jpg');
  const saved = fs.readFileSync(jpgPath);
  const fixture = fs.readFileSync(RED_JPG);
  expect(Buffer.compare(saved, fixture)).toBe(0);

  await tab.close();
});

test('image tab: startCaptureWithDetails opens Capture page with image-flow shape', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const imageUrl = `${fixtureServer.baseUrl}/red-pixel.png`;
  const tab = await extensionContext.newPage();
  await tab.goto(imageUrl);
  await tab.bringToFront();

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  const sw = await getServiceWorker();
  await installDownloadSpy(sw);
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { startCaptureWithDetails: () => Promise<void> };
      }
    ).SeeWhatISee.startCaptureWithDetails();
  });

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');
  await capturePage.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  // The preview shows the source image bytes (decoded by the browser
  // as a PNG, so `naturalWidth` is the source's pixel width — 200 for
  // the red-pixel fixture).
  const previewWidth = await capturePage.evaluate(() => {
    const img = document.getElementById('preview') as HTMLImageElement;
    return img.naturalWidth;
  });
  expect(previewWidth).toBe(200);

  // HTML row is quiet-disabled (image-flow shape — no error icon, no
  // `has-error` class). Selection is ignored entirely; the row stays
  // unchecked but reachable when no selection was scraped.
  await expect(capturePage.locator('#cap-html')).toBeDisabled();
  await expect(capturePage.locator('#cap-html')).not.toBeChecked();
  await expect(capturePage.locator('#row-html')).not.toHaveClass(/has-error/);

  // Screenshot row is image-flow defaulted on (matches upload-image
  // behavior — saving the screenshot is the natural intent).
  await expect(capturePage.locator('#cap-screenshot')).toBeChecked();

  // The URL row mirrors the tab URL (which IS the image URL on this
  // path). No separate `imageUrl` field — same as the upload flow.
  const urlText = (
    await capturePage.locator('#captured-url-text').textContent()
  )?.trim();
  expect(urlText).toBe(imageUrl);

  await capturePage.close();
  await tab.close();
});
