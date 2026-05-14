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
import { dragRect, findCapturedDownload, readLatestRecord } from './details-helpers';
import type { CaptureRecord } from '../fixtures/files';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../fixtures/pages');
const RED_PNG = path.join(FIXTURES_DIR, 'red-pixel.png');
const RED_JPG = path.join(FIXTURES_DIR, 'red-pixel.jpg');
const RED_WEBP = path.join(FIXTURES_DIR, 'red-pixel.webp');
const PURPLE_HTML = path.join(FIXTURES_DIR, 'purple.html');
// 24 bytes of plain text, named `.png` — passes the MIME-prefix
// check (Chrome stamps `image/png` from the extension) but fails
// the decode probe in the page handler.
const CORRUPT_PNG = path.join(FIXTURES_DIR, 'corrupt.png');

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

test('upload: a `.png`-named file with garbage bytes fails decode-validation up front', async ({
  extensionContext,
  extensionId,
}) => {
  // Without the `<img>` decode probe, the file would pass the
  // `image/*` MIME prefix check and we'd ship the bytes to the SW;
  // the Capture page would then render a broken-image preview.
  // Catching it here gives the user a clear inline error instead.
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  await page.locator('#upload-file-input').setInputFiles(CORRUPT_PNG);

  await expect(page.locator('#upload-error')).toBeVisible();
  await expect(page.locator('#upload-error')).toContainText('Not a valid image');
  await expect(page.locator('#upload-landing')).toBeVisible();

  await page.close();
});

test('upload: menu-click handler opens capture.html?upload=true adjacent to the active tab', async ({
  extensionContext,
  getServiceWorker,
}) => {
  // The menu-click route is `chrome.contextMenus.onClicked` →
  // `openUploadCapturePage(tab)`. Chrome's API doesn't expose a
  // programmatic dispatch for `onClicked`, so the listener body
  // delegates to a named helper exposed on the SW test seam; we
  // call that helper directly with a synthetic opener tab and
  // verify it asks for the right URL + tab placement.
  const sw = await getServiceWorker();

  // Spy on `chrome.tabs.create`. Capture the create-properties
  // (URL, index, openerTabId) without actually opening the tab so
  // the test doesn't accumulate stray windows.
  await sw.evaluate(async () => {
    interface CreateSpy {
      __seeCreate?: chrome.tabs.CreateProperties[];
      __seeCreateOrig?: typeof chrome.tabs.create;
    }
    const g = self as unknown as CreateSpy;
    if (!g.__seeCreateOrig) {
      g.__seeCreateOrig = chrome.tabs.create.bind(chrome.tabs);
    }
    g.__seeCreate = [];
    (chrome.tabs as { create: typeof chrome.tabs.create }).create =
      (async (props: chrome.tabs.CreateProperties) => {
        g.__seeCreate!.push(props);
        // Return a stub Tab — the menu handler doesn't read it.
        return { id: 999, index: (props.index ?? 0) } as chrome.tabs.Tab;
      }) as typeof chrome.tabs.create;
  });

  try {
    const calls = await sw.evaluate(async () => {
      type Seam = { openUploadCapturePage: (t: chrome.tabs.Tab) => Promise<void> };
      const api = (self as unknown as { SeeWhatISee: Seam }).SeeWhatISee;
      // Synthetic opener at index 3, id 42 — same shape Chrome
      // hands to the real `onClicked` listener.
      await api.openUploadCapturePage({ id: 42, index: 3 } as chrome.tabs.Tab);
      const g = self as unknown as { __seeCreate?: chrome.tabs.CreateProperties[] };
      return g.__seeCreate ?? [];
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/capture\.html\?upload=true$/);
    expect(calls[0].index).toBe(4); // opener.index + 1
    expect(calls[0].openerTabId).toBe(42);
  } finally {
    // Restore so later tests in this file (and the rest of the
    // suite sharing this SW) see the real `chrome.tabs.create`.
    await sw.evaluate(async () => {
      interface CreateSpy {
        __seeCreateOrig?: typeof chrome.tabs.create;
      }
      const g = self as unknown as CreateSpy;
      if (g.__seeCreateOrig) {
        (chrome.tabs as { create: typeof chrome.tabs.create }).create = g.__seeCreateOrig;
      }
    });
  }
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
  expect(record.url).toBe('file:///red-pixel.png');
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
  expect(record.url).toBe('file:///red-pixel.jpg');
  expect(record.title).toBe('Uploaded image');
  expect(record.imageUrl).toBeUndefined();
});

test('upload: WEBP happy-path saves under .webp with no edits (no PNG conversion)', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  // Sticky-format counterpart: even though a WEBP source bakes to
  // PNG once edited (canvas only writes PNG / JPEG), a no-edits save
  // must NOT convert — the SW writes the original WEBP bytes
  // verbatim and the filename keeps `.webp`. Without this guarantee,
  // every upload would silently re-encode at save time even when
  // nothing was drawn on it.
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);
  await page.locator('#upload-file-input').setInputFiles(RED_WEBP);

  await expect(page.locator('#upload-landing')).toBeHidden();
  await expect(page.locator('#captured-title')).toHaveText('Uploaded image');

  await Promise.all([
    page.waitForEvent('close'),
    page.locator('#capture').click(),
  ]);

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.webp$/);
  expect(record.url).toBe('file:///red-pixel.webp');

  // Bytes on disk are real WEBP (RIFF header `52 49 46 46 …`).
  const webpPath = await findCapturedDownload(sw, '.webp');
  const buf = fs.readFileSync(webpPath);
  expect(buf[0]).toBe(0x52);
  expect(buf[1]).toBe(0x49);
  expect(buf[2]).toBe(0x46);
  expect(buf[3]).toBe(0x46);
});

test('upload: shift-click captures with edits between bump as -1, -2 (no stacked suffixes)', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  // Regression for the missing `bases` pin in the upload init
  // handler. When `bases.screenshot` is unset, the multi-capture
  // bump strategy in `rebumpFilenameIfLocked` falls back to the
  // *current* filename for `base`, so each edited shift-click
  // capture splices another `-N` onto the previously-bumped name
  // and produces stacked suffixes (e.g. `…-1-1-2-3.png`) instead
  // of a flat counter (`…-1.png`, `…-2.png`). The toolbar / image-
  // right-click flows pin `bases` at session creation in
  // `openCapturePageWithSession`; the upload flow has to do the
  // same in the SW init handler.
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);
  await page.locator('#upload-file-input').setInputFiles(RED_PNG);

  await expect(page.locator('#preview')).toBeVisible();
  await page.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  // Capture #1 (no edits) — locks the base filename.
  await page.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(page.locator('#ask-status')).toHaveText('Saved.', { timeout: 10_000 });

  // Edit + Capture #2 → fresh `-1` filename for the new revision.
  await dragRect(page, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.4, yPct: 0.4 });
  await page.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(page.locator('#ask-status')).toHaveText('Saved.', { timeout: 10_000 });

  // Edit + Capture #3 → fresh `-2` filename. Pre-fix this came out
  // as `…-1-2.png` (base = the previously-bumped current filename).
  await dragRect(page, { xPct: 0.5, yPct: 0.5 }, { xPct: 0.7, yPct: 0.7 });
  await page.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(page.locator('#ask-status')).toHaveText('Saved.', { timeout: 10_000 });

  const logPath = await findCapturedDownload(sw, 'log.json');
  const records: CaptureRecord[] = fs
    .readFileSync(logPath, 'utf8')
    .trimEnd()
    .split('\n')
    .slice(-3)
    .map((l) => JSON.parse(l));

  expect(records[0].screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(records[1].screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}-1\.png$/);
  // Anchored to the timestamp stem so a stacked-suffix regression
  // (`…-1-2.png` or `…-1-1-2.png`) fails this match.
  expect(records[2].screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}-2\.png$/);
});

test('upload: JPG + highlight stays .jpg (sticky output format)', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  // Sticky output format: a JPG upload that the user draws on must
  // still save as `.jpg` (with JPEG bytes), not `.png`. A JPEG
  // bake keeps a photographic upload from ballooning in size on
  // every minor markup edit.
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
  // Sticky output: ext stays .jpg even with highlights.
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.jpg$/);
  expect(record.screenshot?.hasHighlights).toBe(true);
  // `url` echoes the source filename — nothing about the user's
  // edits changes the source we read it from.
  expect(record.url).toBe('file:///red-pixel.jpg');
  expect(record.title).toBe('Uploaded image');

  // Bytes on disk are real JPEG (header `FF D8 FF`).
  const jpgPath = await findCapturedDownload(sw, '.jpg');
  const buf = fs.readFileSync(jpgPath);
  expect(buf[0]).toBe(0xff);
  expect(buf[1]).toBe(0xd8);
  expect(buf[2]).toBe(0xff);
});

test('upload: WEBP + highlight bakes to .png (non-JPG/PNG source converts)', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  // Companion to the JPG-sticky test above: a WEBP upload bakes to
  // PNG because the canvas can only write PNG or JPEG, and PNG is
  // the catch-all for non-JPEG sources. Confirms that the
  // sticky-output rule converts away from formats the bake can't
  // re-encode, rather than leaving stale `.webp` filenames pointing
  // at PNG bytes.
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);
  await page.locator('#upload-file-input').setInputFiles(RED_WEBP);

  await expect(page.locator('#preview')).toBeVisible();
  await page.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  await dragRect(page, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });

  await Promise.all([
    page.waitForEvent('close'),
    page.locator('#capture').click(),
  ]);

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.url).toBe('file:///red-pixel.webp');

  const pngPath = await findCapturedDownload(sw, '.png');
  const buf = fs.readFileSync(pngPath);
  expect(buf[0]).toBe(0x89);
  expect(buf[1]).toBe(0x50);
  expect(buf[2]).toBe(0x4e);
  expect(buf[3]).toBe(0x47);
});
