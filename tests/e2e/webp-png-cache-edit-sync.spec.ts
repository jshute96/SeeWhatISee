// Regression coverage for the source-ext ↔ PNG sync across cached
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
// non-PNG source after baking highlights flipped `screenshotFilename`
// back to the source ext while the on-disk file was `.png`. A
// subsequent Capture would then log a stale-ext filename even though
// the saved file was PNG bytes.
//
// Uses a WEBP source: now that the bake is format-sticky, a JPG
// source would mask the bug (JPG stays `.jpg` end-to-end — there's
// no ext flip to mis-revert). WEBP is non-PNG/JPG, so the bake
// converts to PNG and the ext rewrite has somewhere to break.
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
  installClipboardSpy,
  openImageDetailsFlow,
  readLatestRecord,
  waitForClipboardWrites,
} from './details-helpers';

test('image flow: WEBP → highlight → copy → repeat-copy keeps the .png ext', async ({
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
    '#http-webp', // 200×200 real WEBP served with image/webp.
  );
  expect(imageUrl).toMatch(/\/red-pixel\.webp$/);

  const sw = await getServiceWorker();

  // Synchronize on the page-side clipboard write rather than the
  // download spy: `countDownloadsBySuffix` increments at download
  // *enqueue* (when `chrome.downloads.download` returns an id), but
  // the SW's per-tab cache entry only lands AFTER
  // `waitForDownloadComplete`. If the next Copy click reaches the
  // SW between the spy bump and the cache commit, the SW sees no
  // cache and fires a fresh download — observed as a flaky
  // `count('.png') === 2` here. The clipboard write happens right
  // after `await chrome.runtime.sendMessage` resolves on the page,
  // which is gated by the SW's full ensure-flow finishing (cache
  // included). Waiting for it serializes the clicks.
  await installClipboardSpy(capturePage);

  // 1. Copy with no edits → SW issues a .webp download.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 1);
  expect(await countDownloadsBySuffix(sw, '.webp')).toBe(1);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(0);

  // 2. Draw a highlight → editVersion bumps → next copy bakes a PNG.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });

  // 3. Copy with edits → SW issues a .png download.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 2);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);

  // 4. Copy AGAIN without edits — page short-circuits override to
  //    undefined (cache-hit shortcut). Without the fix, the SW
  //    rewrote `capture.screenshotFilename` back to .webp here even
  //    though the cache (and on-disk file) is still .png. The cache
  //    short-circuit means no new download issues either way.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 3);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);
  expect(await countDownloadsBySuffix(sw, '.webp')).toBe(1);

  // 5. Capture and verify the saved record references .png (the
  //    bug surfaced as a stale-ext filename in the log even though
  //    the file on disk was PNG bytes).
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

test('image flow: WEBP → edit → copy → undo-all → copy correctly reverts to .webp', async ({
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
    '#http-webp',
  );
  expect(imageUrl).toMatch(/\/red-pixel\.webp$/);

  const sw = await getServiceWorker();

  // Bake then undo. dragRect bumps editVersion; #undo bumps it again.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  await capturePage.locator('#copy-screenshot-name').click();
  await expect.poll(() => countDownloadsBySuffix(sw, '.png')).toBe(1);

  await capturePage.locator('#undo').click();
  await capturePage.locator('#copy-screenshot-name').click();
  // Cache miss at the new editVersion → SW issues a fresh .webp
  // download with the original bytes.
  await expect.poll(() => countDownloadsBySuffix(sw, '.webp')).toBe(1);

  await openerPage.close();
});

test('image flow: WEBP → highlight → shift-Capture → repeat-Copy → Capture must keep .png in log', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Regression for the multi-capture rebump path: a Capture against a
  // WEBP with highlights bakes a `.png` and pins
  // `saved.screenshot = { bumpIndex: 0, revision }`. A subsequent
  // same-revision Copy click would then enter `rebumpFilenameIfLocked`
  // with `saved` set; pre-fix, the rebump derived its desired filename
  // from `bases.screenshot` (which carries the original `.webp` ext),
  // saw it differ from the current `…png`, stomped the filename back
  // to `.webp` and dropped the cache. With override=undefined on a
  // page-side cache-hit Copy, the rewrite kept `.webp` and original
  // WEBP bytes landed under that name. A follow-up shift-Capture then
  // cache-hit the stale `.webp` and wrote a `screenshot.filename:
  // …webp` log entry alongside `hasHighlights: true` — the user's
  // exact reported symptom. Fix: rebump no-ops on same-revision so
  // the post-rewrite filename survives.
  const { openerPage, capturePage, imageUrl } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
    undefined,
    undefined,
    '#http-webp',
  );
  expect(imageUrl).toMatch(/\/red-pixel\.webp$/);

  const sw = await getServiceWorker();
  // Same enqueue/commit-race guard as test 1 — the page-side
  // `lastSent` only updates after `chrome.runtime.sendMessage`
  // resolves, and the SW cache only commits after
  // `waitForDownloadComplete`. Gate each Copy on the clipboard
  // write so consecutive clicks can't race their override flag or
  // step on the cache-commit window.
  await installClipboardSpy(capturePage);

  // 1. Draw a highlight + shift-Capture so `saved.screenshot` gets
  //    pinned at the current editVersion.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  await capturePage.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(capturePage.locator('#ask-status')).toHaveText('Saved.', {
    timeout: 10_000,
  });
  expect(capturePage.isClosed()).toBe(false);
  await expect.poll(() => countDownloadsBySuffix(sw, '.png')).toBe(1);

  // 2. Two Copy clicks at the same editVersion. Capture doesn't
  //    update the page-side `lastSent`, so the FIRST copy still
  //    bakes + sends an override (cache-hit on the SW's side, no new
  //    download). The SECOND copy short-circuits on the page side
  //    (`lastSent` now matches) and sends `screenshotOverride =
  //    undefined`. This is the click that previously corrupted
  //    `screenshotFilename` back to `.webp` via the rebump. Wait
  //    on each clipboard write so the second click is guaranteed
  //    to see `lastSent` updated by the first.
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 1);
  await capturePage.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(capturePage, 2);
  expect(await countDownloadsBySuffix(sw, '.png')).toBe(1);
  expect(await countDownloadsBySuffix(sw, '.webp')).toBe(0);

  // 3. shift-Capture again at the same editVersion. The bug-shape
  //    record was `{ filename: '…webp', hasHighlights: true }`. Post
  //    fix the second log line must still reference the original
  //    `.png` file with `hasHighlights: true`.
  await capturePage.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(capturePage.locator('#ask-status')).toHaveText('Saved.', {
    timeout: 10_000,
  });

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/\.png$/);
  expect(record.screenshot?.hasHighlights).toBe(true);

  // Confirm the on-disk bytes the log points at really are PNG —
  // the bug class is "filename in log disagrees with the actual
  // bytes", so verifying both sides closes the loop.
  const pngPath = await findCapturedDownload(sw, '.png');
  const buf = fs.readFileSync(pngPath);
  expect(buf[0]).toBe(0x89);
  expect(buf[1]).toBe(0x50);
  expect(buf[2]).toBe(0x4e);
  expect(buf[3]).toBe(0x47);

  await capturePage.close();
  await openerPage.close();
});
