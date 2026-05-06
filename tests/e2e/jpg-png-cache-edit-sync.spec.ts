// Regression coverage for the JPG↔PNG extension sync across cached
// repeat-Copy clicks.
//
// Bug background: the page's Copy handler short-circuits the
// (potentially multi-MB) `screenshotOverride` payload when
// `editVersion` hasn't changed since the last successful send — the
// SW will cache-hit anyway, so the bake + IPC copy is wasted work.
// The SW's `ensureScreenshotDownloaded` was reading
// `screenshotOverride === undefined` as "no edits, revert filename
// extension to the original", which is wrong on a cache-hit click:
// the cached bytes are still PNG. Symptom: clicking Copy again on a
// JPG source after baking highlights flipped `screenshotFilename`
// back to `.jpg` while the on-disk file was `.png`. A subsequent
// Capture would then log a `.jpg` filename even though the saved
// file was PNG bytes.
//
// Fix: skip the extension rewrite when the SW's per-tab download
// cache holds an entry at the requested `editVersion`. The cached
// entry's path is authoritative for what the file actually is.

import fs from 'node:fs';
import { test, expect } from '../fixtures/extension';
import {
  countDownloadsBySuffix,
  dragRect,
  findCapturedDownload,
  openImageDetailsFlow,
  readLatestRecord,
} from './details-helpers';

test.beforeEach(async () => {
  // captureVisibleTab is rate-limited (~2/s per window).
  await new Promise((r) => setTimeout(r, 600));
});

test('image flow: JPG → highlight → copy → repeat-copy keeps the .png ext', async ({
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
    '#http-jpeg', // 200×200 real JPEG served with image/jpeg.
  );
  expect(imageUrl).toMatch(/\/red-pixel\.jpg$/);

  const sw = await getServiceWorker();

  // 1. Copy with no edits → SW issues a .jpg download.
  await capturePage.locator('#copy-screenshot-name').click();
  await expect.poll(() => countDownloadsBySuffix(sw, '.jpg')).toBe(1);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(0);

  // 2. Draw a highlight → editVersion bumps → next copy bakes a PNG.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });

  // 3. Copy with edits → SW issues a .png download.
  await capturePage.locator('#copy-screenshot-name').click();
  await expect.poll(() => countDownloadsBySuffix(sw, '.png')).toBe(1);

  // 4. Copy AGAIN without edits — page short-circuits override to
  //    undefined (cache-hit shortcut). Without the fix, the SW
  //    rewrote `capture.screenshotFilename` back to .jpg here even
  //    though the cache (and on-disk file) is still .png. The cache
  //    short-circuit means no new download issues either way.
  await capturePage.locator('#copy-screenshot-name').click();
  // Give any spurious extra download a chance to surface, then
  // assert no new file was issued.
  await capturePage.waitForTimeout(200);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);
  expect(await countDownloadsBySuffix(sw, '.jpg')).toBe(1);

  // 5. Capture and verify the saved record references .png (the
  //    bug surfaced as a .jpg filename in the log even though the
  //    file on disk was PNG bytes).
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.imageUrl).toBe(imageUrl);

  // On-disk bytes are real PNG (header `89 50 4E 47`). Confirms the
  // log entry's extension agrees with the bytes the user gets back
  // when they read the recorded file.
  const pngPath = await findCapturedDownload(sw, '.png');
  const buf = fs.readFileSync(pngPath);
  expect(buf[0]).toBe(0x89);
  expect(buf[1]).toBe(0x50);
  expect(buf[2]).toBe(0x4e);
  expect(buf[3]).toBe(0x47);

  await openerPage.close();
});

test('image flow: JPG → edit → copy → undo-all → copy correctly reverts to .jpg', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Sanity check that the cache-hit guard doesn't suppress the
  // legitimate revert path — undo-all bumps editVersion, so the
  // next copy is a cache miss and the extension rewrite must fire.
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

  const sw = await getServiceWorker();

  // Bake then undo. dragRect bumps editVersion; #undo bumps it again.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  await capturePage.locator('#copy-screenshot-name').click();
  await expect.poll(() => countDownloadsBySuffix(sw, '.png')).toBe(1);

  await capturePage.locator('#undo').click();
  await capturePage.locator('#copy-screenshot-name').click();
  // Cache miss at the new editVersion → SW issues a fresh .jpg
  // download with the original bytes.
  await expect.poll(() => countDownloadsBySuffix(sw, '.jpg')).toBe(1);

  await openerPage.close();
});
