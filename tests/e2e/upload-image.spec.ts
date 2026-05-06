// E2E coverage for the More-submenu's "Upload image to Capture..."
// entry. The menu click opens `capture.html?upload=true`; the page
// renders an upload-landing card; selecting an image initializes a
// synthetic session via `initializeUploadSession` and falls into the
// normal Capture-page flow.
//
// We exercise the page directly (skipping the menu click) by
// navigating to `chrome-extension://<id>/capture.html?upload=true`.
// The menu wiring itself is covered by the context-menu install
// tests; this spec focuses on the page-side flow + the SW init
// handler.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import { findCapturedDownload, readLatestRecord } from './details-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../fixtures/pages');
const RED_PNG = path.join(FIXTURES_DIR, 'red-pixel.png');
const RED_JPG = path.join(FIXTURES_DIR, 'red-pixel.jpg');
const PURPLE_HTML = path.join(FIXTURES_DIR, 'purple.html');

test.beforeEach(async ({ getServiceWorker }) => {
  const sw = await getServiceWorker();
  // Reset the log + install the SW-side download spy used by
  // `findCapturedDownload` / `readLatestRecord`. The other flow
  // tests get this spy via `openDetailsFlow` / `openImageDetailsFlow`;
  // upload doesn't go through either, so we install it directly.
  await sw.evaluate(async () => {
    await chrome.storage.local.clear();
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
          if (typeof id === 'number') g.__seeDl!.push({ id, name: opts.filename ?? '' });
          return id;
        }) as typeof chrome.downloads.download;
    }
    g.__seeDl = [];
  });
});

test('upload: ?upload=true renders the upload-landing card with main blocks hidden', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  await expect(page.locator('#upload-landing')).toBeVisible();
  // The missing-session-error pane is the OTHER no-session branch;
  // we shouldn't be rendering both.
  await expect(page.locator('#missing-session-error')).toBeHidden();

  const mainBlocks = page.locator('[data-capture-main]');
  const count = await mainBlocks.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(mainBlocks.nth(i)).toBeHidden();
  }

  await page.close();
});

test('upload: selecting a non-image file shows an inline error and keeps the landing visible', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  await page.locator('#upload-file-input').setInputFiles(PURPLE_HTML);

  await expect(page.locator('#upload-error')).toBeVisible();
  await expect(page.locator('#upload-error')).toContainText('Not a supported image format');
  // Landing stays so the user can pick a different file.
  await expect(page.locator('#upload-landing')).toBeVisible();

  await page.close();
});

test('upload: PNG happy-path captures with the synthetic file: URL and Uploaded-image title', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);
  await page.locator('#upload-file-input').setInputFiles(RED_PNG);

  // Page transitions to the normal Capture flow.
  await expect(page.locator('#upload-landing')).toBeHidden();
  await expect(page.locator('#preview')).toBeVisible();
  await expect(page.locator('#captured-title')).toHaveText('Uploaded image');

  // HTML is quiet-disabled (no error icon — htmlUnavailable is set).
  await expect(page.locator('#cap-html')).toBeDisabled();
  await expect(page.locator('#cap-html')).not.toBeChecked();

  // Image-flow defaults: Save Screenshot ticked even if the user's
  // stored `withoutSelection.screenshot` would normally be false.
  await expect(page.locator('#cap-screenshot')).toBeChecked();

  await Promise.all([
    page.waitForEvent('close'),
    page.locator('#capture').click(),
  ]);

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(record.url).toBe('file:red-pixel.png');
  expect(record.title).toBe('Uploaded image');
  // No imageUrl on upload records — the file *is* the source. No
  // separate URL to point at.
  expect(record.imageUrl).toBeUndefined();
  expect(record.contents).toBeUndefined();

  const pngPath = await findCapturedDownload(sw, '.png');
  expect(fs.statSync(pngPath).size).toBeGreaterThan(0);
});

test('upload: JPG happy-path saves under .jpg with no edits', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);
  await page.locator('#upload-file-input').setInputFiles(RED_JPG);

  await expect(page.locator('#upload-landing')).toBeHidden();
  await expect(page.locator('#captured-title')).toHaveText('Uploaded image');

  await Promise.all([
    page.waitForEvent('close'),
    page.locator('#capture').click(),
  ]);

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.jpg$/);
  expect(record.url).toBe('file:red-pixel.jpg');
  expect(record.title).toBe('Uploaded image');
  expect(record.imageUrl).toBeUndefined();
});

test('upload: JPG + highlight bakes a PNG but keeps the original file: URL on .jpg', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  // Same JPG-source bake-in semantics as the right-click image
  // flow — verifies the upload path uses the same Capture-page
  // machinery rather than diverging.
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);
  await page.locator('#upload-file-input').setInputFiles(RED_JPG);

  await expect(page.locator('#preview')).toBeVisible();
  await page.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  // Drag a Box highlight across the centre of the overlay.
  const overlay = page.locator('#overlay');
  const box = await overlay.boundingBox();
  expect(box).not.toBeNull();
  const x1 = box!.x + box!.width * 0.3;
  const y1 = box!.y + box!.height * 0.3;
  const x2 = box!.x + box!.width * 0.7;
  const y2 = box!.y + box!.height * 0.7;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2);
  await page.mouse.move(x2, y2);
  await page.mouse.up();

  await Promise.all([
    page.waitForEvent('close'),
    page.locator('#capture').click(),
  ]);

  const record = await readLatestRecord(sw);
  // Saved under .png because the canvas bake always emits PNG…
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(record.screenshot?.hasHighlights).toBe(true);
  // …but `url` still records the original .jpg filename — nothing
  // about the user's edits changes the source we read it from.
  expect(record.url).toBe('file:red-pixel.jpg');
  expect(record.title).toBe('Uploaded image');
});
