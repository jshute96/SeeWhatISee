// E2E coverage for the copy-filename buttons on the Capture page
// and their interaction with the SW's per-tab download cache.
//
// Each click materializes the file on disk via the SW (writing
// under the same pinned filename Capture would use) and puts the
// file's real on-disk path on the clipboard. Subsequent clicks
// short-circuit against the SW's per-tab download cache; a
// highlight change bumps the page's `editVersion` and forces a
// re-download with the new baked-in PNG. The eventual Capture
// click goes through the same `ensure…Downloaded` helpers, so
// files already pre-downloaded by Copy aren't re-written.

import fs from 'node:fs';
import { PNG } from 'pngjs';
import { test, expect } from '../fixtures/extension';
import {
  CONTENTS_PATTERN,
  SCREENSHOT_PATTERN,
  configureAndCapture,
  countDownloadsBySuffix,
  dragRect,
  findCapturedDownload,
  installClipboardSpy,
  openDetailsFlow,
  readClipboardSpy,
  readLatestRecord,
  waitForClipboardWrites,
} from './details-helpers';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Each test in this file issues one capture via
// startCaptureWithDetails; without a small cushion the suite
// occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

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
