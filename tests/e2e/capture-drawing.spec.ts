// E2E coverage for the Capture-page *drawing* overlay: the
// highlight-controls tool buttons (#tool-box / #tool-line /
// #tool-crop / #tool-redact, plus #undo / #clear), the SVG
// annotation surface (rect / line / crop / redact draws), the
// crop-handle resize gesture, and the resulting on-disk flags on
// log.json's `screenshot` artifact (`hasHighlights`,
// `hasRedactions`, `isCropped`).
//
// Split out of `capture-with-details.spec.ts` so the drawing
// surface has its own home — the details spec was approaching
// 1600 lines with cache / edit-dialog / scrape-failure tests
// mixed in, which made the drawing tests easy to overlook.

import fs from 'node:fs';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import {
  SCREENSHOT_PATTERN,
  CONTENTS_PATTERN,
  configureAndCapture,
  dragRect,
  findCapturedDownload,
  installClipboardWriteSpy,
  installPageDownloadSpy,
  openDetailsFlow,
  readClipboardWriteSpy,
  readLatestRecord,
  readPageDownloads,
  waitForClipboardWriteSpy,
  waitForPageDownloads,
} from './details-helpers';

// Sample the drawn-rect's red stroke at x≈20%, y≈30% of the PNG and
// assert it's red (high R, low G/B). Shared between the palette
// Save / Copy tests since both round-trip the same edited PNG bytes.
function expectRedAtRectEdge(buf: Buffer): void {
  const png = PNG.sync.read(buf);
  const x = Math.round(png.width * 0.2);
  const y = Math.round(png.height * 0.3);
  const i = (y * png.width + x) * 4;
  expect(png.data[i]).toBeGreaterThan(200);
  expect(png.data[i + 1]).toBeLessThan(60);
  expect(png.data[i + 2]).toBeLessThan(60);
}

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Every test here issues one capture via startCaptureWithDetails;
// without a small cushion the suite occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// ─── Helpers ─────────────────────────────────────────────────────

// Read the current effective crop bounds (or null when no crop is
// effective) straight out of the Capture page. Relies on the
// `__seeState` hook capture-page.ts installs at load time.
async function readEffectiveCrop(
  capturePage: Page,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return capturePage.evaluate(() =>
    (window as unknown as { __seeState: { effectiveCrop: () => unknown } }).__seeState.effectiveCrop() as
      | { x: number; y: number; w: number; h: number }
      | null,
  );
}

async function readEditKinds(capturePage: Page): Promise<string[]> {
  return capturePage.evaluate(() =>
    (window as unknown as { __seeState: { editKinds: () => string[] } }).__seeState.editKinds(),
  );
}

// Drag a single crop-edge handle inward (or back out to the
// boundary). The `edge` identifies which handle to grab; `toFrac`
// is where along the opposite axis the handle ends up, as a
// fraction of the overlay's bounding box.
//
// Internally uses a 1px inset from the image boundary on the
// mouseDown coordinate so the initial event lands *inside* the
// overlay (exactly-on-edge mouseDown can fall through to the
// parent), while still sitting within HANDLE_PX of the edge so
// `detectCropHandle` returns the intended handle.
async function dragEdge(
  capturePage: Page,
  edge: 'n' | 's' | 'e' | 'w',
  cropBounds: { x: number; y: number; w: number; h: number },
  toFrac: number,
): Promise<void> {
  // Use the image's bounding box, not the overlay's: capture-page.ts
  // computes drag percentages via `previewImg.getBoundingClientRect()`,
  // and on some platforms the overlay's rounded box is a fraction of
  // a CSS pixel off from the image's, leaving the drag ending a
  // fraction short of the intended edge.
  const box = await capturePage.locator('#preview').boundingBox();
  if (!box) throw new Error('preview has no bounding box');

  // Start the mouseDown a few pixels *inward* from the crop's
  // current edge. Two reasons:
  //   - A mouseDown exactly on the overlay boundary (e.g. toFrac=1
  //     on a fresh image) sometimes falls through to the parent.
  //   - When the image's bounding box is a sub-pixel fraction
  //     different from the overlay's, a drag starting right on the
  //     edge can end a fraction short of 100% on the opposite side
  //     (the handler's `localCoords` clamps to `r.width`/`r.height`,
  //     so the reachable dxPct is capped). A small inward inset
  //     increases the reachable drag distance enough to always
  //     clear the applyCropDrag clamp into 0 / 100.
  //
  // Inset stays within HANDLE_PX so `detectCropHandle` still picks
  // the intended edge.
  const INSET = 5;
  const midX = box.x + box.width * 0.5;
  const midY = box.y + box.height * 0.5;
  const edgeX = box.x + box.width * (cropBounds.x + cropBounds.w) / 100;
  const edgeStartX = box.x + box.width * cropBounds.x / 100;
  const edgeY = box.y + box.height * (cropBounds.y + cropBounds.h) / 100;
  const edgeStartY = box.y + box.height * cropBounds.y / 100;

  let x1 = midX;
  let y1 = midY;
  let x2 = midX;
  let y2 = midY;
  if (edge === 'w') {
    x1 = edgeStartX + INSET;
    y1 = midY;
    x2 = box.x + box.width * toFrac;
    y2 = midY;
  } else if (edge === 'e') {
    x1 = edgeX - INSET;
    y1 = midY;
    x2 = box.x + box.width * toFrac;
    y2 = midY;
  } else if (edge === 'n') {
    x1 = midX;
    y1 = edgeStartY + INSET;
    x2 = midX;
    y2 = box.y + box.height * toFrac;
  } else {
    x1 = midX;
    y1 = edgeY - INSET;
    x2 = midX;
    y2 = box.y + box.height * toFrac;
  }

  // Clamp target into the viewport so Playwright doesn't reject
  // negative / past-edge coordinates; the overlay's mousemove
  // handler clamps its localCoords to [0, r.width] / [0, r.height]
  // so "off-overlay" targets work as "pinned to the boundary."
  x2 = Math.max(box.x, Math.min(box.x + box.width, x2));
  y2 = Math.max(box.y, Math.min(box.y + box.height, y2));

  await capturePage.mouse.move(x1, y1);
  await capturePage.mouse.down();
  await capturePage.mouse.move((x1 + x2) / 2, (y1 + y2) / 2);
  await capturePage.mouse.move(x2, y2);
  await capturePage.mouse.up();
}

// ─── Moved from capture-with-details.spec.ts ──────────────────────

test('drawing: png with highlights bakes red into the saved PNG', async ({
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
  expect(record.screenshot?.hasRedactions).toBeUndefined();
  expect(record.screenshot?.isCropped).toBeUndefined();
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

test('drawing: png + html with highlights, no prompt', async ({
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

test('drawing: undo/clear buttons reflect the edit stack', async ({
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

  // Close the Capture page tab cleanly so it doesn't leak into the next
  // test.
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  await openerPage.close();
});

test('drawing: draw then undo → no highlights flag, no red in saved PNG', async ({
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
  expect(record.screenshot?.hasRedactions).toBeUndefined();
  expect(record.screenshot?.isCropped).toBeUndefined();

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

test('drawing: Line tool draw commits a line and flips hasHighlights', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Select the Line tool and drag — the drag commits a `line` edit
  // (the only tool that produces non-rect geometry). Lines count
  // as `hasHighlights` alongside Box-tool boxes.
  await capturePage.locator('#tool-line').click();
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.6, yPct: 0.4 },
  );
  expect(await readEditKinds(capturePage)).toEqual(['line']);

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.screenshot?.hasRedactions).toBeUndefined();
  expect(record.screenshot?.isCropped).toBeUndefined();

  await openerPage.close();
});

test('drawing: drag image edge to crop creates a crop', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // No active crop. Drag the east edge inward by ~40%. The overlay
  // detects a handle press within HANDLE_PX of the right image edge
  // and starts a crop-handle drag, committing a new 'crop' edit on
  // mouseup. This is the "drag image edges to crop" affordance — it
  // works regardless of which drawing tool is currently selected,
  // because the handle hit-test wins over the tool dispatch.
  await dragEdge(capturePage, 'e', { x: 0, y: 0, w: 100, h: 100 }, 0.6);
  expect(await readEditKinds(capturePage)).toEqual(['crop']);
  const crop = await readEffectiveCrop(capturePage);
  expect(crop).not.toBeNull();
  // Left edge stayed at 0, right edge moved inward to ~60%.
  expect(crop!.x).toBeCloseTo(0, 0);
  expect(crop!.w).toBeGreaterThan(50);
  expect(crop!.w).toBeLessThan(70);

  await openerPage.close();
});

// ─── Per-kind flags by drawing tool ──────────────────────────────

test('drawing: Redact tool draw flips only hasRedactions', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Select the Redact tool and drag — the drag commits a `redact`
  // edit directly. `hasHighlights` should NOT fire, since no red
  // rectangle / line was drawn.
  await capturePage.locator('#tool-redact').click();
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.7, yPct: 0.7 },
  );
  expect(await readEditKinds(capturePage)).toEqual(['redact']);

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  expect(record.screenshot?.hasRedactions).toBe(true);
  expect(record.screenshot?.isCropped).toBeUndefined();

  // The redact fill is solid black — sample in the middle of the
  // redaction region (x≈50%, y≈50%) and expect (0, 0, 0).
  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const cx = Math.round(png.width * 0.5);
  const cy = Math.round(png.height * 0.5);
  const idx = (cy * png.width + cx) * 4;
  expect(png.data[idx]).toBeLessThan(20);
  expect(png.data[idx + 1]).toBeLessThan(20);
  expect(png.data[idx + 2]).toBeLessThan(20);

  await openerPage.close();
});

test('drawing: Crop tool draw flips only isCropped', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Select the Crop tool and drag a region — the drag commits a
  // `crop` edit directly. The saved PNG should be sized to the
  // cropped region.
  await capturePage.locator('#tool-crop').click();
  await dragRect(
    capturePage,
    { xPct: 0.25, yPct: 0.25 },
    { xPct: 0.75, yPct: 0.75 },
  );
  expect(await readEditKinds(capturePage)).toEqual(['crop']);
  const crop = await readEffectiveCrop(capturePage);
  expect(crop).not.toBeNull();

  // Capture the original natural dimensions so we can verify the
  // saved PNG is smaller than the full image.
  const natural = await capturePage.evaluate(() => {
    const img = document.getElementById('preview') as HTMLImageElement;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  expect(record.screenshot?.hasRedactions).toBeUndefined();
  expect(record.screenshot?.isCropped).toBe(true);

  // Saved PNG should be ~50% of the natural dimensions on both
  // axes (the crop was 25%→75% on each).
  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  expect(png.width).toBeLessThan(natural.w);
  expect(png.height).toBeLessThan(natural.h);
  expect(png.width).toBeGreaterThan(natural.w * 0.4);
  expect(png.width).toBeLessThan(natural.w * 0.6);

  await openerPage.close();
});

test('drawing: rect + redact + crop together emit all three flags', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // One edit per kind by switching tools between drags. Default
  // tool is Box, so the first drag commits a `rect` without an
  // explicit tool click. All three flags should appear on the
  // record after save.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.4, yPct: 0.4 });
  await capturePage.locator('#tool-redact').click();
  await dragRect(capturePage, { xPct: 0.5, yPct: 0.5 }, { xPct: 0.6, yPct: 0.6 });
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.9, yPct: 0.9 });
  expect(await readEditKinds(capturePage)).toEqual(['rect', 'redact', 'crop']);

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.screenshot?.hasRedactions).toBe(true);
  expect(record.screenshot?.isCropped).toBe(true);

  await openerPage.close();
});

test('drawing: crop dragged back to full image → no isCropped flag, full-size PNG', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Create a smaller crop with the Crop tool, then resize via the
  // edge handles (which only become active *after* a crop exists).
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  let bounds = await readEffectiveCrop(capturePage);
  expect(bounds).not.toBeNull();

  // Drag each of the four edges back out to the image boundary.
  // Each drag commits a new 'crop' edit, so we refresh `bounds`
  // between drags to keep the mouseDown coordinate on the *current*
  // (outermost-so-far) edge.
  await dragEdge(capturePage, 'w', bounds!, 0);
  bounds = await readEffectiveCrop(capturePage);
  await dragEdge(capturePage, 'e', bounds!, 1);
  bounds = await readEffectiveCrop(capturePage);
  await dragEdge(capturePage, 'n', bounds!, 0);
  bounds = await readEffectiveCrop(capturePage);
  await dragEdge(capturePage, 's', bounds!, 1);

  // All four edges now flush with the image boundary —
  // activeCrop() should collapse to undefined.
  expect(await readEffectiveCrop(capturePage)).toBeNull();

  const natural = await capturePage.evaluate(() => {
    const img = document.getElementById('preview') as HTMLImageElement;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  // isCropped must be omitted — the PNG matches the original.
  expect(record.screenshot?.isCropped).toBeUndefined();

  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  expect(png.width).toBe(natural.w);
  expect(png.height).toBe(natural.h);

  await openerPage.close();
});

test('drawing: crop drag past the opposite edge clamps without moving it', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Start with a non-full crop (Crop tool draw), then drag the W
  // handle rightward well past the E edge. Under the current clamp
  // rule the W edge stops at `right - MIN_CROP_PCT` and the E edge
  // stays fixed — a previous version instead pushed the E edge
  // outward to preserve the minimum, which asymmetrically affected
  // N/W drags vs S/E drags.
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.8, yPct: 0.8 });
  const before = await readEffectiveCrop(capturePage);
  expect(before).not.toBeNull();
  // Our starting crop's east edge was at 80% of the image.
  const eastBefore = before!.x + before!.w;

  // Drag W handle (at xPct ≈ 0.2 of the overlay) far past the E
  // edge.
  await dragEdge(capturePage, 'w', before!, 0.95);

  const after = await readEffectiveCrop(capturePage);
  expect(after).not.toBeNull();
  const eastAfter = after!.x + after!.w;
  // E edge didn't move.
  expect(eastAfter).toBeCloseTo(eastBefore, 1);
  // New crop is exactly MIN_CROP_PCT (1.5) wide, anchored at the E
  // edge. Tightened from `< 5` so a future MIN_CROP_PCT bump can't
  // silently change the clamp without this test failing.
  expect(after!.w).toBeCloseTo(1.5, 0);
  expect(after!.x + after!.w).toBeCloseTo(eastBefore, 1);

  await openerPage.close();
});

test('drawing: Crop tool drag below MIN_CROP_PCT is discarded', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // A Crop drag just past the 4-px CLICK_THRESHOLD_PX commits a
  // sub-MIN_CROP_PCT crop under the naive path. Without the
  // commit-time floor the resulting crop's edge handles would be
  // un-grabbable. The drag below should produce no edit at all.
  await capturePage.locator('#tool-crop').click();
  await dragRect(
    capturePage,
    { xPct: 0.5, yPct: 0.5 },
    { xPct: 0.505, yPct: 0.505 },
  );
  expect(await readEditKinds(capturePage)).toEqual([]);
  expect(await readEffectiveCrop(capturePage)).toBeNull();

  // Sanity: a sufficiently-large Crop drag still commits.
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.7, yPct: 0.7 },
  );
  expect(await readEditKinds(capturePage)).toEqual(['crop']);

  await openerPage.close();
});

// ─── Palette Copy / Save buttons ─────────────────────────────────

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
