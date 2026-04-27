// E2E coverage for the Capture-page *drawing* overlay: the
// highlight-bar buttons (Redact, Crop, Undo, Clear), the SVG
// annotation surface (rect / line draws), the drag-to-crop
// gesture, and the resulting on-disk flags on log.json's
// `screenshot` artifact (`hasHighlights`, `hasRedactions`,
// `isCropped`).
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
  openDetailsFlow,
  readLatestRecord,
} from './details-helpers';

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

// ─── New: per-kind flags and conversion semantics ────────────────

test('drawing: rect → Redact → save flips only hasRedactions', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Draw a rectangle, then convert it to a redaction. The only
  // edit on the stack is now a `redact` — `hasHighlights` should
  // NOT fire, since no red rectangle / line survives.
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.7, yPct: 0.7 },
  );
  await capturePage.locator('#redact').click();
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

test('drawing: rect → Crop → save flips only isCropped', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Draw a rectangle, click Crop. The edit is now `crop` and the
  // saved PNG should be sized to the cropped region.
  await dragRect(
    capturePage,
    { xPct: 0.25, yPct: 0.25 },
    { xPct: 0.75, yPct: 0.75 },
  );
  await capturePage.locator('#crop').click();
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

  // Three edits on the stack, one per kind: a red rect (kept),
  // a redact (converted), a crop (converted). All three flags
  // should appear on the record.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.4, yPct: 0.4 });
  await dragRect(capturePage, { xPct: 0.5, yPct: 0.5 }, { xPct: 0.6, yPct: 0.6 });
  await capturePage.locator('#redact').click();
  await dragRect(capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.9, yPct: 0.9 });
  await capturePage.locator('#crop').click();
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

  // No active crop. Drag the east edge inward by ~40%. The
  // overlay detects a handle press within HANDLE_PX of the right
  // edge and starts a crop-drag, committing a new 'crop' edit on
  // mouseup.
  await dragEdge(capturePage, 'e', { x: 0, y: 0, w: 100, h: 100 }, 0.6);
  expect(await readEditKinds(capturePage)).toEqual(['crop']);
  const crop = await readEffectiveCrop(capturePage);
  expect(crop).not.toBeNull();
  // Left edge stayed at 0, right edge moved inward to ~60%.
  expect(crop!.x).toBeCloseTo(0, 0);
  expect(crop!.w).toBeGreaterThan(50);
  expect(crop!.w).toBeLessThan(70);

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
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

  // Create a smaller crop via the Crop button.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  await capturePage.locator('#crop').click();
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

  // Start with a non-full crop, then drag the W handle rightward
  // well past the E edge. Under the current clamp rule the W edge
  // stops at `right - MIN_CROP_PCT` and the E edge stays fixed —
  // a previous version instead pushed the E edge outward to
  // preserve the minimum, which asymmetrically affected N/W drags
  // vs S/E drags.
  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.8, yPct: 0.8 });
  await capturePage.locator('#crop').click();
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
  // New crop is minimum-width and anchored at the E edge.
  expect(after!.w).toBeLessThan(5);
  expect(after!.x + after!.w).toBeCloseTo(eastBefore, 1);

  await openerPage.close();
});
