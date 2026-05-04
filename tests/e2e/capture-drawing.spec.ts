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

test('drawing: Arrow tool draw commits an arrow and flips hasHighlights', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Select the Arrow tool and drag — the drag commits an `arrow`
  // edit (line + arrowhead barbs at the click-release end). Arrows
  // count as `hasHighlights` alongside boxes and lines.
  await capturePage.locator('#tool-arrow').click();
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.6, yPct: 0.4 },
  );
  expect(await readEditKinds(capturePage)).toEqual(['arrow']);

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

test('drawing: draw arrow then undo → no highlights flag', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Arrow is a new edit-kind; confirm it flows through the generic
  // undo path the same way Box / Line / Crop / Redact do — popping
  // the arrow leaves the stack empty, the Undo / Clear buttons go
  // back to disabled, and the saved record carries no highlight flag.
  const undo = capturePage.locator('#undo');
  const clear = capturePage.locator('#clear');

  await capturePage.locator('#tool-arrow').click();
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.6, yPct: 0.4 },
  );
  expect(await readEditKinds(capturePage)).toEqual(['arrow']);
  await expect(undo).toBeEnabled();

  await undo.click();
  expect(await readEditKinds(capturePage)).toEqual([]);
  await expect(undo).toBeDisabled();
  await expect(clear).toBeDisabled();

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.hasHighlights).toBeUndefined();

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

// ─── Shrink ──────────────────────────────────────────────────────
//
// shrink-target.html is a grey page with a single black block
// from 25%–75% horizontally and vertically. That gives the
// algorithm a deterministic bg→content boundary on every edge,
// independent of viewport size — Shrink should trim the grey
// margins to expose the block.

async function readLastRectBounds(
  capturePage: Page,
  kind: 'rect' | 'redact' | 'crop',
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return capturePage.evaluate(
    (k) =>
      (window as unknown as {
        __seeState: {
          lastRectBounds: (
            kind: string,
          ) => { x: number; y: number; w: number; h: number } | null;
        };
      }).__seeState.lastRectBounds(k),
    kind,
  );
}

test('shrink: button is enabled in Crop mode and disabled for Line / Arrow', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  const shrinkBtn = capturePage.locator('#shrink');

  // Default tool is Box. With no Box edits on the stack yet, Shrink
  // has no target and stays disabled.
  await expect(shrinkBtn).toBeDisabled();

  // Crop mode: Shrink is always enabled (it falls back to the full
  // image when no crop exists yet).
  await capturePage.locator('#tool-crop').click();
  await expect(shrinkBtn).toBeEnabled();

  // Line / Arrow modes have no rectangular geometry — Shrink stays
  // disabled regardless of the edit stack.
  await capturePage.locator('#tool-line').click();
  await expect(shrinkBtn).toBeDisabled();
  await capturePage.locator('#tool-arrow').click();
  await expect(shrinkBtn).toBeDisabled();

  await openerPage.close();
});

test('shrink: Crop with no active crop commits a tighter crop, Undo restores', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );

  await capturePage.locator('#tool-crop').click();
  expect(await readEffectiveCrop(capturePage)).toBeNull();

  await capturePage.locator('#shrink').click();
  const crop = await readEffectiveCrop(capturePage);
  expect(crop).not.toBeNull();
  // The grey margins around the black block (25%/75% bounds in CSS)
  // should be trimmed; allow generous slack since the captured PNG
  // includes anti-aliased edges and the block's CSS percentages
  // round to whole pixels.
  expect(crop!.x).toBeGreaterThan(15);
  expect(crop!.x).toBeLessThan(35);
  expect(crop!.y).toBeGreaterThan(15);
  expect(crop!.y).toBeLessThan(35);
  expect(crop!.w).toBeGreaterThan(40);
  expect(crop!.w).toBeLessThan(60);
  expect(crop!.h).toBeGreaterThan(40);
  expect(crop!.h).toBeLessThan(60);

  // Undo removes the new crop edit — back to "no crop yet".
  await capturePage.locator('#undo').click();
  expect(await readEffectiveCrop(capturePage)).toBeNull();

  await openerPage.close();
});

test('shrink: tightens the most recent Box, Undo restores, and a second click is idempotent', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );

  // Coarse box well around the central black block — drag from
  // (10%, 10%) to (90%, 90%). Shrink should pull every edge in
  // toward the 25%–75% block bounds.
  await dragRect(
    capturePage,
    { xPct: 0.1, yPct: 0.1 },
    { xPct: 0.9, yPct: 0.9 },
  );
  const before = await readLastRectBounds(capturePage, 'rect');
  expect(before).not.toBeNull();
  expect(before!.w).toBeGreaterThan(70);
  expect(before!.h).toBeGreaterThan(70);

  await capturePage.locator('#shrink').click();
  const after = await readLastRectBounds(capturePage, 'rect');
  expect(after).not.toBeNull();
  // After shrinking, the rect should be much tighter than the
  // original 80% × 80% drag.
  expect(after!.w).toBeLessThan(60);
  expect(after!.h).toBeLessThan(60);
  // And it shouldn't have collapsed — the block is genuinely
  // ~50% × 50% of the viewport.
  expect(after!.w).toBeGreaterThan(40);
  expect(after!.h).toBeGreaterThan(40);

  // A *second* Shrink click on a Box that already wraps clean
  // content with a 1-pixel margin must be a no-op. Without the
  // algorithm-noop guard in capture-page.ts, the +1 expansion
  // would fire unconditionally — clicks would either pulse (clean
  // content) or grow the box by 1 each time (noisy content), both
  // observable as a regression here.
  await capturePage.locator('#shrink').click();
  const afterTwice = await readLastRectBounds(capturePage, 'rect');
  expect(afterTwice).not.toBeNull();
  expect(afterTwice!.x).toBeCloseTo(after!.x, 6);
  expect(afterTwice!.y).toBeCloseTo(after!.y, 6);
  expect(afterTwice!.w).toBeCloseTo(after!.w, 6);
  expect(afterTwice!.h).toBeCloseTo(after!.h, 6);

  // Undo once should restore the pre-shrink geometry in place
  // (the second click was a no-op, so it didn't push history).
  await capturePage.locator('#undo').click();
  const restored = await readLastRectBounds(capturePage, 'rect');
  expect(restored).not.toBeNull();
  expect(restored!.x).toBeCloseTo(before!.x, 3);
  expect(restored!.y).toBeCloseTo(before!.y, 3);
  expect(restored!.w).toBeCloseTo(before!.w, 3);
  expect(restored!.h).toBeCloseTo(before!.h, 3);

  await openerPage.close();
});

test('shrink: a second Box click drills further when click 1 lands on a uniform border', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Same nested fixture as the Crop drill test: grey page → blue
  // card → red inner block. Box mode wraps the *outer* card on
  // click 1 (with a 1-pixel margin) and should drill into the red
  // inner block on click 2 — but only if the click handler retries
  // the algorithm from the *contracted* rect when the first
  // attempt couldn't advance. Without that retry, the box's edge
  // sits 1 pixel outside the card's blue edge, the algorithm sees
  // plain bg as the snapshot, and click 2 can never see the
  // uniform-blue border that becomes Crop's drilling snapshot.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-nested.html',
  );

  // Default tool is Box — coarse drag well around everything.
  // Stay at least HANDLE_PX inset from the image edges so the
  // mousedown lands on the tool (not on a crop-edge handle).
  await dragRect(
    capturePage,
    { xPct: 0.05, yPct: 0.05 },
    { xPct: 0.95, yPct: 0.95 },
  );

  await capturePage.locator('#shrink').click();
  const afterFirst = await readLastRectBounds(capturePage, 'rect');
  expect(afterFirst).not.toBeNull();
  // First click wraps the blue card with a 1-pixel margin
  // (~10%–90% in fixture pct, with a ±1-pixel slop).
  expect(afterFirst!.x).toBeGreaterThan(5);
  expect(afterFirst!.x).toBeLessThan(15);
  expect(afterFirst!.w).toBeGreaterThan(70);
  expect(afterFirst!.w).toBeLessThan(90);

  await capturePage.locator('#shrink').click();
  const afterSecond = await readLastRectBounds(capturePage, 'rect');
  expect(afterSecond).not.toBeNull();
  // Second click drills past the uniform blue band to wrap the
  // red inner block (~25%–75%).
  expect(afterSecond!.x).toBeGreaterThan(20);
  expect(afterSecond!.x).toBeLessThan(30);
  expect(afterSecond!.w).toBeGreaterThan(40);
  expect(afterSecond!.w).toBeLessThan(60);

  // A *third* click on a Box that's already wrapping uniform
  // content with a 1-pixel margin must be idempotent — the
  // contracted retry can't drill any further once the rect's
  // inside is solid red.
  await capturePage.locator('#shrink').click();
  const afterThird = await readLastRectBounds(capturePage, 'rect');
  expect(afterThird).not.toBeNull();
  expect(afterThird!.x).toBeCloseTo(afterSecond!.x, 6);
  expect(afterThird!.y).toBeCloseTo(afterSecond!.y, 6);
  expect(afterThird!.w).toBeCloseTo(afterSecond!.w, 6);
  expect(afterThird!.h).toBeCloseTo(afterSecond!.h, 6);

  await openerPage.close();
});

test('shrink: a second Crop click drills further when click 1 lands on a uniform border', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // shrink-nested.html nests a red inner block (25%–75%) inside
  // a blue card (10%–90%) on a grey page. Click 1 trims the grey
  // margin and stops at the card's blue top/bottom/left/right
  // rows. Those rows are *uniform blue*, so on click 2 the
  // algorithm's snapshot is "blue", every neighbour blue row
  // matches, and shrinking continues until it hits the inner red
  // block.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-nested.html',
  );

  await capturePage.locator('#tool-crop').click();

  // First click: grey → blue card.
  await capturePage.locator('#shrink').click();
  const afterFirst = await readEffectiveCrop(capturePage);
  expect(afterFirst).not.toBeNull();
  expect(afterFirst!.x).toBeGreaterThan(5);
  expect(afterFirst!.x).toBeLessThan(15);
  expect(afterFirst!.w).toBeGreaterThan(70);
  expect(afterFirst!.w).toBeLessThan(90);

  // Second click: blue band → red inner block.
  await capturePage.locator('#shrink').click();
  const afterSecond = await readEffectiveCrop(capturePage);
  expect(afterSecond).not.toBeNull();
  expect(afterSecond!.x).toBeGreaterThan(20);
  expect(afterSecond!.x).toBeLessThan(30);
  expect(afterSecond!.w).toBeGreaterThan(40);
  expect(afterSecond!.w).toBeLessThan(60);

  // Both clicks pushed history, so two Undos peel back through
  // the chain — first to the blue card, then to "no crop yet".
  await capturePage.locator('#undo').click();
  const undone1 = await readEffectiveCrop(capturePage);
  expect(undone1).not.toBeNull();
  expect(undone1!.x).toBeCloseTo(afterFirst!.x, 6);
  expect(undone1!.w).toBeCloseTo(afterFirst!.w, 6);
  await capturePage.locator('#undo').click();
  expect(await readEffectiveCrop(capturePage)).toBeNull();

  await openerPage.close();
});
