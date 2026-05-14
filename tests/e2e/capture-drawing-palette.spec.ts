// E2E coverage for the Capture page palette's per-image Save / Copy
// buttons (`#download-image-btn` / `#copy-image-btn`) — separately
// from the main capture flow, which has its own per-row buttons in
// `capture-details-download.spec.ts` / `capture-details-copy.spec.ts`.
//
// The palette buttons branch on `hasBakeableEdits()`:
//   - With edits, both buttons round-trip through `renderHighlightedPng`
//     so the saved / copied bytes match the on-screen baked PNG.
//   - Without edits, both buttons short-circuit to the original
//     `previewImg.src` — no re-encode, no edit re-render.

import { test, expect } from '../fixtures/extension';
import {
  dragRect,
  installClipboardWriteSpy,
  installPageDownloadSpy,
  openDetailsFlow,
  readClipboardWriteSpy,
  readPageDownloads,
  waitForClipboardWriteSpy,
  waitForPageDownloads,
} from './details-helpers';
import { expectRedAtRectEdge } from './capture-drawing-helpers';

test('drawing: palette Save writes the edited PNG via the save-as dialog', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installPageDownloadSpy(capturePage);

  // Draw a red rectangle, then click the palette's Save button. The
  // save-as dialog should be invoked with the *edited* PNG bytes,
  // not the original capture.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );
  await capturePage.locator('#download-image-btn').click();
  await waitForPageDownloads(capturePage, 1);

  const dls = await readPageDownloads(capturePage);
  expect(dls).toHaveLength(1);
  expect(dls[0].filename).toBe('screenshot.png');
  expect(dls[0].saveAs).toBe(true);
  expect(dls[0].mime).toMatch(/^image\/png/);

  // Spy's `bytes` field is a UTF-8 decode of binary PNG (lossy), so
  // decode the data: URL directly to get clean bytes for pngjs.
  const m = dls[0].url.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  expect(m).not.toBeNull();
  expectRedAtRectEdge(Buffer.from(m![1], 'base64'));

  await openerPage.close();
});

test('drawing: palette Copy puts the edited PNG bytes on the clipboard', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardWriteSpy(capturePage);

  // Draw a red rectangle, then click the palette's Copy button. The
  // clipboard.write call should carry an `image/png` ClipboardItem
  // whose blob bytes contain the *edited* PNG (red stroke baked in).
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );
  await capturePage.locator('#copy-image-btn').click();
  await waitForClipboardWriteSpy(capturePage, 1);

  const writes = await readClipboardWriteSpy(capturePage);
  expect(writes).toHaveLength(1);
  expect(writes[0].types).toEqual(['image/png']);

  expectRedAtRectEdge(Buffer.from(writes[0].blobs['image/png']!, 'base64'));

  await openerPage.close();
});

test('drawing: palette Copy + Save with no edits still write the original capture', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // The Copy / Save handlers branch on `hasBakeableEdits()`. The two
  // tests above cover the with-edits path (renderHighlightedPng);
  // this one covers the no-edits path (`previewImg.src` direct), so
  // a future change that breaks one branch can't silently slip past.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installPageDownloadSpy(capturePage);
  await installClipboardWriteSpy(capturePage);

  // No drag — both buttons fire from a clean capture.
  await capturePage.locator('#download-image-btn').click();
  await waitForPageDownloads(capturePage, 1);
  await capturePage.locator('#copy-image-btn').click();
  await waitForClipboardWriteSpy(capturePage, 1);

  const dls = await readPageDownloads(capturePage);
  expect(dls).toHaveLength(1);
  expect(dls[0].filename).toBe('screenshot.png');
  expect(dls[0].url).toMatch(/^data:image\/png;base64,/);

  const writes = await readClipboardWriteSpy(capturePage);
  expect(writes).toHaveLength(1);
  expect(writes[0].types).toEqual(['image/png']);
  // PNG magic header bytes (the first 8 are 89 50 4E 47 0D 0A 1A 0A)
  // — assert we round-tripped a real PNG, not an empty/garbage blob.
  const buf = Buffer.from(writes[0].blobs['image/png']!, 'base64');
  expect(buf.length).toBeGreaterThan(8);
  expect(buf[0]).toBe(0x89);
  expect(buf[1]).toBe(0x50);
  expect(buf[2]).toBe(0x4e);
  expect(buf[3]).toBe(0x47);

  await openerPage.close();
});
