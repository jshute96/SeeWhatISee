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

// Sample the drawn-rect's red stroke around x≈20%, y≈30% of the PNG
// and assert at least one pixel along that horizontal band is red
// (high R, low G/B). Scans a small ±3 px window because the stroke
// is only 3 px wide and the rectangle's left edge at exactly x=20%
// can land sub-pixel — a single Math.round'd sample can land on the
// stroke's antialiased fringe instead of its fully-saturated center.
// Shared between the palette Save / Copy tests since both round-trip
// the same edited PNG bytes.
function expectRedAtRectEdge(buf: Buffer): void {
  const png = PNG.sync.read(buf);
  const cx = Math.round(png.width * 0.2);
  const y = Math.round(png.height * 0.3);
  let found = false;
  for (let dx = -3; dx <= 3 && !found; dx++) {
    const x = cx + dx;
    if (x < 0 || x >= png.width) continue;
    const i = (y * png.width + x) * 4;
    if (
      png.data[i] > 200 &&
      png.data[i + 1] < 60 &&
      png.data[i + 2] < 60
    ) {
      found = true;
    }
  }
  expect(found, `no red stroke pixel found near x=${cx}, y=${y}`).toBe(true);
}

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

// Read the most-recent edit of the given kind's bounds, or null when
// no such edit exists. Mirrors `__seeState.lastRectBounds`.
async function readLastBounds(
  capturePage: Page,
  kind: 'rect' | 'redact' | 'crop',
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return capturePage.evaluate(
    (k) =>
      (window as unknown as {
        __seeState: { lastRectBounds: (k: string) => unknown };
      }).__seeState.lastRectBounds(k) as
        | { x: number; y: number; w: number; h: number }
        | null,
    kind,
  );
}

// Drag a single edge handle of a rect-shaped target inward (or back
// out to the image boundary). The `edge` identifies which handle to
// grab; `toFrac` is where along the opposite axis the handle ends
// up, as a fraction of the overlay's bounding box. `bounds` are the
// percent-space bounds of the targeted box (any rect / redact /
// crop), or `{0, 0, 100, 100}` to drag an image-edge handle when no
// crop exists.
//
// Internally uses a small inset from the targeted edge on the
// mouseDown coordinate so the initial event lands *inside* the
// overlay (exactly-on-edge mouseDown can fall through to the
// parent), while still sitting within HANDLE_PX of the edge so
// `detectBoxHandle` returns the intended edge.
async function dragEdge(
  capturePage: Page,
  edge: 'n' | 's' | 'e' | 'w',
  bounds: { x: number; y: number; w: number; h: number },
  toFrac: number,
  modifiers?: { shift?: boolean },
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
  //     clear the applyEdgeDrag clamp into 0 / 100.
  //
  // Inset stays within HANDLE_PX (now 6) so `detectBoxHandle` still
  // picks the intended edge.
  const INSET = 4;
  // For non-edge anchors keep the orthogonal coordinate inside the
  // targeted box so the perpendicular extent gate (`withinX` /
  // `withinY` in handleAtRect) matches.
  const midX = box.x + box.width * (bounds.x + bounds.w / 2) / 100;
  const midY = box.y + box.height * (bounds.y + bounds.h / 2) / 100;
  const edgeX = box.x + box.width * (bounds.x + bounds.w) / 100;
  const edgeStartX = box.x + box.width * bounds.x / 100;
  const edgeY = box.y + box.height * (bounds.y + bounds.h) / 100;
  const edgeStartY = box.y + box.height * bounds.y / 100;

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
  if (modifiers?.shift) await capturePage.keyboard.down('Shift');
  await capturePage.mouse.down();
  await capturePage.mouse.move((x1 + x2) / 2, (y1 + y2) / 2);
  await capturePage.mouse.move(x2, y2);
  await capturePage.mouse.up();
  if (modifiers?.shift) await capturePage.keyboard.up('Shift');
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
  // paints a fixed 3 natural-px red stroke centered on each edge,
  // so the rectangle's left edge at x=20% shows up as red in the
  // saved PNG.
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
  // purple background. Scan a small ±3 px window because the 3 px
  // stroke can land sub-pixel — a single Math.round'd sample can
  // hit the antialiased fringe instead of the saturated center.
  const pngPath = await findCapturedDownload(sw, '.png');
  const png = PNG.sync.read(fs.readFileSync(pngPath));

  const cx = Math.round(png.width * 0.2);
  const edgeY = Math.round(png.height * 0.3);
  let foundRed = false;
  for (let dx = -3; dx <= 3 && !foundRed; dx++) {
    const x = cx + dx;
    if (x < 0 || x >= png.width) continue;
    const i = (edgeY * png.width + x) * 4;
    if (
      png.data[i] > 200 &&
      png.data[i + 1] < 60 &&
      png.data[i + 2] < 60
    ) {
      foundRed = true;
    }
  }
  expect(foundRed, `no red stroke pixel found near x=${cx}, y=${edgeY}`).toBe(true);

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
  // rule the W edge stops at `right - MIN_BOX_PCT` and the E edge
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
  // New crop is exactly MIN_BOX_PCT (1.5) wide, anchored at the E
  // edge. Tightened from `< 5` so a future MIN_BOX_PCT bump can't
  // silently change the clamp without this test failing.
  expect(after!.w).toBeCloseTo(1.5, 0);
  expect(after!.x + after!.w).toBeCloseTo(eastBefore, 1);

  await openerPage.close();
});

test('drawing: Crop tool drag below MIN_BOX_PCT is discarded', async ({
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
  // sub-MIN_BOX_PCT crop under the naive path. Without the
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

// ─── Box-edge resize (rect / redact) ─────────────────────────────

test('drawing: rect edge drag resizes the existing box in place + Undo restores', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Draw a Box, then drag its east edge inward. The resize must
  // mutate the existing rect in place — no second 'rect' edit on
  // the stack — and the Undo button must roll the bounds back to
  // the pre-drag values (Shrink-style `prev` history op).
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  expect(await readEditKinds(capturePage)).toEqual(['rect']);
  const before = await readLastBounds(capturePage, 'rect');
  expect(before).not.toBeNull();

  await dragEdge(capturePage, 'e', before!, 0.5);
  // Stack unchanged — the resize mutated the existing edit, no new
  // rect added.
  expect(await readEditKinds(capturePage)).toEqual(['rect']);
  const after = await readLastBounds(capturePage, 'rect');
  expect(after).not.toBeNull();
  // East edge moved from ~70% to ~50%; west edge stayed at ~30%.
  // Loose ±2 since the dragged pointer ends a couple px short of
  // the target after sub-pixel rounding through the image-rect
  // mapping.
  expect(after!.x).toBeCloseTo(before!.x, 1);
  expect(after!.x + after!.w).toBeLessThan((before!.x + before!.w) - 10);
  expect(after!.x + after!.w).toBeGreaterThan(48);
  expect(after!.x + after!.w).toBeLessThan(53);

  // Undo restores the pre-drag bounds without removing the edit.
  await capturePage.locator('#undo').click();
  expect(await readEditKinds(capturePage)).toEqual(['rect']);
  const restored = await readLastBounds(capturePage, 'rect');
  expect(restored).not.toBeNull();
  expect(restored!.x).toBeCloseTo(before!.x, 1);
  expect(restored!.y).toBeCloseTo(before!.y, 1);
  expect(restored!.w).toBeCloseTo(before!.w, 1);
  expect(restored!.h).toBeCloseTo(before!.h, 1);

  // A second Undo removes the rect entirely (the original add op).
  await capturePage.locator('#undo').click();
  expect(await readEditKinds(capturePage)).toEqual([]);

  await openerPage.close();
});

test('drawing: redact edge drag resizes the existing box in place + Undo restores', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Same shape as the rect test, but for the Redact tool — confirms
  // the edge-handle gesture works uniformly for both rect-shaped
  // drawing kinds (not just crop).
  await capturePage.locator('#tool-redact').click();
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  expect(await readEditKinds(capturePage)).toEqual(['redact']);
  const before = await readLastBounds(capturePage, 'redact');
  expect(before).not.toBeNull();

  await dragEdge(capturePage, 's', before!, 0.5);
  expect(await readEditKinds(capturePage)).toEqual(['redact']);
  const after = await readLastBounds(capturePage, 'redact');
  expect(after).not.toBeNull();
  // South edge moved from ~70% to ~50% (loose ±2 since the dragged
  // pointer ends a couple px short of the target after sub-pixel
  // rounding through the image-rect mapping).
  expect(after!.y).toBeCloseTo(before!.y, 1);
  expect(after!.y + after!.h).toBeLessThan((before!.y + before!.h) - 10);
  expect(after!.y + after!.h).toBeGreaterThan(48);
  expect(after!.y + after!.h).toBeLessThan(53);

  await capturePage.locator('#undo').click();
  const restored = await readLastBounds(capturePage, 'redact');
  expect(restored!.y + restored!.h).toBeCloseTo(before!.y + before!.h, 1);

  await openerPage.close();
});

test('drawing: shift+drag near an existing box edge falls through to drawing', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Draw a rect, then Shift-drag starting near its east edge with
  // the Box tool still selected. Without Shift this would resize
  // the existing rect; with Shift the hit-test is bypassed and the
  // gesture commits a *second* rect adjacent to the first. The
  // first rect's bounds stay untouched.
  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.4, yPct: 0.4 });
  const before = await readLastBounds(capturePage, 'rect');
  expect(before).not.toBeNull();

  // Drag from just inside the existing rect's east edge outward
  // with Shift held. The Shift bypass means no resize fires; the
  // mousedown lands inside the overlay and starts a fresh Box draw.
  await dragEdge(capturePage, 'e', before!, 0.6, { shift: true });

  // Two rect edits on the stack now — the original plus the Shift
  // draw. lastRectBounds returns the most-recent rect, so the new
  // (shift-drawn) rect's east edge is past `before`'s east edge —
  // which couldn't have happened via a resize (resizes shrink only).
  expect(await readEditKinds(capturePage)).toEqual(['rect', 'rect']);
  const newest = await readLastBounds(capturePage, 'rect');
  expect(newest!.x + newest!.w).toBeGreaterThan(before!.x + before!.w);

  await openerPage.close();
});

test('drawing: topmost rect wins the resize gesture over an underlying crop', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Crop first (10..90), then draw a rect inside it (40..60). The
  // rect's east edge sits at 60%; the crop's east edge is at 90%.
  // A drag near 60% should resize the rect, not the crop, because
  // the hit-test walks the stack topmost-first.
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.9, yPct: 0.9 });
  await capturePage.locator('#tool-box').click();
  await dragRect(capturePage, { xPct: 0.4, yPct: 0.4 }, { xPct: 0.6, yPct: 0.6 });

  const cropBefore = await readLastBounds(capturePage, 'crop');
  const rectBefore = await readLastBounds(capturePage, 'rect');
  expect(cropBefore).not.toBeNull();
  expect(rectBefore).not.toBeNull();

  await dragEdge(capturePage, 'e', rectBefore!, 0.5);

  const cropAfter = await readLastBounds(capturePage, 'crop');
  const rectAfter = await readLastBounds(capturePage, 'rect');
  // Crop bounds untouched.
  expect(cropAfter!.x).toBeCloseTo(cropBefore!.x, 1);
  expect(cropAfter!.w).toBeCloseTo(cropBefore!.w, 1);
  // Rect's east edge moved inward.
  expect(rectAfter!.x + rectAfter!.w).toBeLessThan(rectBefore!.x + rectBefore!.w - 5);

  await openerPage.close();
});

// ─── Arrow-key fine adjustment during a drag ─────────────────────

// Read the previewImg's viewport-coord bounding box plus its
// natural (intrinsic) size so the arrow-key tests can convert
// between CSS-pixel mouse moves, percent-space stored bounds, and
// natural-pixel saved-output deltas. Mirrors the `imgRect()` /
// `previewImg.naturalWidth` reads the in-page handler does.
async function readPreviewRect(
  capturePage: Page,
): Promise<{ x: number; y: number; w: number; h: number; natW: number; natH: number }> {
  return capturePage.evaluate(() => {
    const img = document.getElementById('preview') as HTMLImageElement;
    const b = img.getBoundingClientRect();
    return {
      x: b.x, y: b.y, w: b.width, h: b.height,
      natW: img.naturalWidth, natH: img.naturalHeight,
    };
  });
}

test('drawing: arrow keys nudge an in-flight Box draw one output pixel each', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Start a Box draw in flight: mousedown, then a single move past
  // CLICK_THRESHOLD_PX so the drag is committed-shaped before we
  // start tapping arrows. Each ArrowRight / ArrowDown adds one
  // *natural-pixel* (= saved-output) step in that direction;
  // ArrowLeft / ArrowUp peel one back. The committed rect should
  // reflect the net cursor delta — 10 CSS px from the explicit
  // mouse move plus the net arrow nudge in natural-pixel terms.
  const r = await readPreviewRect(capturePage);
  const x1 = r.x + 100;
  const y1 = r.y + 100;
  await capturePage.mouse.move(x1, y1);
  await capturePage.mouse.down();
  await capturePage.mouse.move(x1 + 10, y1 + 10);
  for (let i = 0; i < 5; i++) await capturePage.keyboard.press('ArrowRight');
  for (let i = 0; i < 3; i++) await capturePage.keyboard.press('ArrowDown');
  await capturePage.keyboard.press('ArrowLeft');
  await capturePage.keyboard.press('ArrowUp');
  await capturePage.mouse.up();

  // Convert each axis of the committed rect to natural-pixel units,
  // which is what the saved PNG bake will use. Expected width =
  // 10 CSS px from the mouse move (≈ 10 × natW/r.w natural px) plus
  // 4 natural px from the net 4-right arrow nudge. Same shape on
  // height with 2 net down nudges.
  const bounds = await readLastBounds(capturePage, 'rect');
  expect(bounds).not.toBeNull();
  const widthNatPx = bounds!.w * r.natW / 100;
  const heightNatPx = bounds!.h * r.natH / 100;
  expect(widthNatPx).toBeCloseTo(10 * r.natW / r.w + 4, 0);
  expect(heightNatPx).toBeCloseTo(10 * r.natH / r.h + 2, 0);
  // Top-left unchanged by arrows (only the dragged corner moved).
  expect(bounds!.x).toBeCloseTo((100 / r.w) * 100, 1);
  expect(bounds!.y).toBeCloseTo((100 / r.h) * 100, 1);

  await openerPage.close();
});

test('drawing: arrow keys clamp at the image-pane edges', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Holding ArrowRight past the right edge of the preview must not
  // walk the synthetic cursor outside the image — the rect commits
  // pinned to x=100% on the east side. Mirrors `localCoords`'
  // clamp.
  const r = await readPreviewRect(capturePage);
  const x1 = r.x + r.w - 20;
  const y1 = r.y + 100;
  await capturePage.mouse.move(x1, y1);
  await capturePage.mouse.down();
  await capturePage.mouse.move(x1 + 5, y1 + 5);
  // Press ArrowRight far more times than needed to walk past the
  // right edge — the clamp stops at the image rect.
  for (let i = 0; i < 200; i++) await capturePage.keyboard.press('ArrowRight');
  await capturePage.mouse.up();

  const bounds = await readLastBounds(capturePage, 'rect');
  expect(bounds).not.toBeNull();
  // East edge clamps at 100% (within float tolerance).
  expect(bounds!.x + bounds!.w).toBeCloseTo(100, 0);

  await openerPage.close();
});

test('drawing: arrow keys nudge an in-flight Line endpoint', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Line / Arrow tools draw via the same `dragStart` path that
  // box-create tools do, so the moving endpoint is `dragCurrent` —
  // exactly what the arrow-key handler updates. The (x1, y1)
  // anchor (mousedown position) should stay put while the (x2, y2)
  // endpoint shifts by the net keyboard nudge.
  await capturePage.locator('#tool-line').click();

  const r = await readPreviewRect(capturePage);
  const x1 = r.x + 100;
  const y1 = r.y + 100;
  await capturePage.mouse.move(x1, y1);
  await capturePage.mouse.down();
  await capturePage.mouse.move(x1 + 30, y1 + 20);
  // Nudge the live endpoint: net 4 right, net 2 down (in natural
  // pixels of saved output).
  for (let i = 0; i < 5; i++) await capturePage.keyboard.press('ArrowRight');
  await capturePage.keyboard.press('ArrowLeft');
  for (let i = 0; i < 3; i++) await capturePage.keyboard.press('ArrowDown');
  await capturePage.keyboard.press('ArrowUp');
  await capturePage.mouse.up();

  const ln = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: {
        lastLineBounds: (k: string) => {
          x1: number; y1: number; x2: number; y2: number;
        } | null;
      };
    }).__seeState.lastLineBounds('line'),
  );
  expect(ln).not.toBeNull();
  // (x1, y1) anchor: the mousedown CSS-pixel position projected
  // onto the image rect.
  expect(ln!.x1).toBeCloseTo((100 / r.w) * 100, 1);
  expect(ln!.y1).toBeCloseTo((100 / r.h) * 100, 1);
  // (x2, y2) endpoint: 30 CSS px (mouse) plus 4 natural-px nudge
  // on x; 20 CSS px (mouse) plus 2 natural-px nudge on y.
  const x2NatPx = ln!.x2 * r.natW / 100;
  const y2NatPx = ln!.y2 * r.natH / 100;
  expect(x2NatPx).toBeCloseTo((100 + 30) * r.natW / r.w + 4, 0);
  expect(y2NatPx).toBeCloseTo((100 + 20) * r.natH / r.h + 2, 0);

  await openerPage.close();
});

test('drawing: arrow-key nudge on an east handle is x-only', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Edge handles are 1-DOF — only arrows on the matching axis nudge
  // the geometry. Up / Down on the east handle should be silently
  // discarded by the handler; only Left / Right walk the dragged
  // edge.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });
  const before = await readLastBounds(capturePage, 'rect');
  expect(before).not.toBeNull();

  // Grab the east edge inline (don't use dragEdge since we need to
  // hold the press across keypresses). Mouse-down inset HANDLE_PX
  // (=6) from the east edge so detectBoxHandle picks 'e'.
  const r = await readPreviewRect(capturePage);
  const eX = r.x + r.w * (before!.x + before!.w) / 100 - 4;
  const midY = r.y + r.h * (before!.y + before!.h / 2) / 100;
  await capturePage.mouse.move(eX, midY);
  await capturePage.mouse.down();
  // Move past CLICK_THRESHOLD_PX so the drag is no-longer-ignorable.
  await capturePage.mouse.move(eX - 5, midY);
  // ArrowDown / ArrowUp must not affect geometry on an east handle.
  for (let i = 0; i < 5; i++) await capturePage.keyboard.press('ArrowDown');
  // ArrowLeft pulls the east edge inward by one CSS pixel each.
  for (let i = 0; i < 5; i++) await capturePage.keyboard.press('ArrowLeft');
  await capturePage.mouse.up();

  const after = await readLastBounds(capturePage, 'rect');
  expect(after).not.toBeNull();
  // North / south edges unchanged — ArrowDown was discarded.
  expect(after!.y).toBeCloseTo(before!.y, 1);
  expect(after!.h).toBeCloseTo(before!.h, 1);
  // East edge moved inward by 5 CSS px (mouse move) plus 5 natural
  // px (the arrow nudges, each = one saved-output pixel). Compare
  // in natural-pixel space so the assertion is independent of the
  // test viewport's display scale.
  const eastBefore = before!.x + before!.w;
  const eastAfter = after!.x + after!.w;
  const shiftNatPx = (eastBefore - eastAfter) * r.natW / 100;
  expect(shiftNatPx).toBeCloseTo(5 * r.natW / r.w + 5, 0);

  await openerPage.close();
});

// ─── Polyline (Ctrl-held multi-segment Line / Arrow chains) ─────

// Read every committed line/arrow edit's geometry in commit order.
// Mirrors `__seeState.allLineBounds` and lets the polyline tests
// assert that segments chain endpoint-to-endpoint.
async function readAllLines(
  capturePage: Page,
  kind: 'line' | 'arrow',
): Promise<Array<{ x1: number; y1: number; x2: number; y2: number }>> {
  return capturePage.evaluate(
    (k) =>
      (window as unknown as {
        __seeState: {
          allLineBounds: (k: string) => Array<{
            x1: number; y1: number; x2: number; y2: number;
          }>;
        };
      }).__seeState.allLineBounds(k),
    kind,
  );
}

test('drawing: Polyline tool chains a polyline of Line segments', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Polyline tool: each mouseup commits a segment and re-anchors
  // the chain head at the just-committed endpoint. A second drag
  // commits a segment whose start is segment 1's end — even if the
  // second drag's mousedown is at a different point. Esc finishes
  // the chain.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);

  const A = { x: r.x + 100, y: r.y + 100 };
  const B = { x: r.x + 200, y: r.y + 100 };
  const C = { x: r.x + 250, y: r.y + 130 };  // mousedown for segment 2 — ignored
  const D = { x: r.x + 300, y: r.y + 200 };

  // Segment 1: A → B.
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((A.x + B.x) / 2, (A.y + B.y) / 2);
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Segment 2: chain start is B; the second mousedown's location
  // (C) doesn't anchor the segment — only its release point does.
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((C.x + D.x) / 2, (C.y + D.y) / 2);
  await capturePage.mouse.move(D.x, D.y);
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  // Helper: convert percent-space line coords back to viewport
  // CSS px so the assertions read like the input coordinates.
  const toCss = (ln: { x1: number; y1: number; x2: number; y2: number }) => ({
    x1: r.x + (ln.x1 / 100) * r.w,
    y1: r.y + (ln.y1 / 100) * r.h,
    x2: r.x + (ln.x2 / 100) * r.w,
    y2: r.y + (ln.y2 / 100) * r.h,
  });
  const seg1 = toCss(lines[0]!);
  const seg2 = toCss(lines[1]!);
  expect(seg1.x1).toBeCloseTo(A.x, 0);
  expect(seg1.y1).toBeCloseTo(A.y, 0);
  expect(seg1.x2).toBeCloseTo(B.x, 0);
  expect(seg1.y2).toBeCloseTo(B.y, 0);
  expect(seg2.x1).toBeCloseTo(B.x, 0);
  expect(seg2.y1).toBeCloseTo(B.y, 0);
  expect(seg2.x2).toBeCloseTo(D.x, 0);
  expect(seg2.y2).toBeCloseTo(D.y, 0);

  // After Esc, polyline state is gone.
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();

  await openerPage.close();
});

test('drawing: Polyline tool: click adds a polyline segment from the previous endpoint', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // After the first drag, the chain is alive. A subsequent click
  // (mousedown + mouseup at the same point, no drag) commits a
  // segment from the previous endpoint to the click point. Esc
  // ends the chain.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);

  const A = { x: r.x + 80, y: r.y + 80 };
  const B = { x: r.x + 180, y: r.y + 80 };
  const Cclick = { x: r.x + 250, y: r.y + 150 };

  // Segment 1 — drag A → B.
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Segment 2 — pure click at Cclick. Mousemove first so dragCurrent
  // reaches Cclick before the click commit.
  await capturePage.mouse.move(Cclick.x, Cclick.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const toCssX = (xPct: number) => r.x + (xPct / 100) * r.w;
  const toCssY = (yPct: number) => r.y + (yPct / 100) * r.h;
  expect(toCssX(lines[1]!.x1)).toBeCloseTo(B.x, 0);
  expect(toCssY(lines[1]!.y1)).toBeCloseTo(B.y, 0);
  expect(toCssX(lines[1]!.x2)).toBeCloseTo(Cclick.x, 0);
  expect(toCssY(lines[1]!.y2)).toBeCloseTo(Cclick.y, 0);

  await openerPage.close();
});

test('drawing: Ctrl-promote: holding Ctrl at mouseup of a Line draw enters polyline', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Line tool + Ctrl held at mouseup promotes the just-committed
  // segment to a polyline chain (legacy power-user shortcut). The
  // chain is then driven by the same state as the dedicated tool,
  // but releasing Ctrl ends it. Two distinct entry paths converge
  // on the same machine.
  await capturePage.locator('#tool-line').click();
  const r = await readPreviewRect(capturePage);

  const A = { x: r.x + 60, y: r.y + 60 };
  const B = { x: r.x + 160, y: r.y + 60 };
  const C = { x: r.x + 220, y: r.y + 200 };
  const D = { x: r.x + 320, y: r.y + 220 };

  // Plain Line draw (mousedown without Ctrl — so it doesn't pan)…
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  // …but Ctrl held by the time mouseup fires.
  await capturePage.keyboard.down('Control');
  await capturePage.mouse.up();

  // Chain is alive and tagged as Ctrl-entered.
  const entryAfterPromote = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineEntry: () => string | null };
    }).__seeState.polylineEntry(),
  );
  expect(entryAfterPromote).toBe('ctrl');

  // Releasing Ctrl ends the Ctrl-promoted chain immediately.
  await capturePage.keyboard.up('Control');
  const entryAfterRelease = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineEntry: () => string | null };
    }).__seeState.polylineEntry(),
  );
  expect(entryAfterRelease).toBeNull();

  // A subsequent (no-Ctrl) Line drag: fresh segment from C to D,
  // *not* chained from B.
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(D.x, D.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const toCssX = (xPct: number) => r.x + (xPct / 100) * r.w;
  const toCssY = (yPct: number) => r.y + (yPct / 100) * r.h;
  expect(toCssX(lines[1]!.x1)).toBeCloseTo(C.x, 0);
  expect(toCssY(lines[1]!.y1)).toBeCloseTo(C.y, 0);
  expect(toCssX(lines[1]!.x2)).toBeCloseTo(D.x, 0);
  expect(toCssY(lines[1]!.y2)).toBeCloseTo(D.y, 0);

  await openerPage.close();
});

test('drawing: Polyline tool: Esc finishes the chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Esc is the universal "I'm done" gesture for a polyline tool
  // chain. Verify the chain is alive after segment 1's commit,
  // then Esc clears it.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + 60, r.y + 60);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 200, r.y + 60);
  await capturePage.mouse.up();

  const kindAlive = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(kindAlive).toBe('line');

  await capturePage.keyboard.press('Escape');
  const kindDead = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(kindDead).toBeNull();

  await openerPage.close();
});

test('drawing: Polyline tool: zero-length click on chain head finishes the chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // After segment 1 commits, a click that doesn't move (≤ CLICK_THRESHOLD_PX
  // from the chain head) means "I'm done". Covers both the "click
  // the previous endpoint" and "double-click" patterns — a
  // double-click's first click commits a segment, the second click
  // sits at the same place and ends the chain.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 80, y: r.y + 80 };
  const B = { x: r.x + 220, y: r.y + 80 };

  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Click at B again — zero-length from chain head, ends chain.
  await capturePage.mouse.down();
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(1);  // The click-on-head didn't commit a segment.
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();

  await openerPage.close();
});

test('drawing: Polyline tool: double-click ends the chain after committing the segment', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Double-click after some segments: the first click commits a
  // segment ending at the click point, the second click (same place)
  // is zero-length and ends the chain. Net effect: a segment ending
  // at the double-click position, then exit.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 60, y: r.y + 60 };
  const B = { x: r.x + 200, y: r.y + 60 };
  const C = { x: r.x + 260, y: r.y + 200 };

  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Move to C, then double-click. Playwright's dblclick is two fast
  // mousedown/mouseup pairs at the same location.
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.mouse.down();
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);  // A→B and B→C.
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();

  await openerPage.close();
});

test('drawing: Ctrl-promote works for the Arrow tool too', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Promote path is symmetric for the Arrow tool — selecting Arrow
  // and holding Ctrl at mouseup advances the segment into an arrow
  // chain. Locks down the parallel branch the Line test covers.
  await capturePage.locator('#tool-arrow').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + 70, r.y + 70);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 170, r.y + 70);
  await capturePage.keyboard.down('Control');
  await capturePage.mouse.up();
  const state = await capturePage.evaluate(() => {
    const s = (window as unknown as {
      __seeState: {
        polylineKind: () => string | null;
        polylineEntry: () => string | null;
      };
    }).__seeState;
    return { kind: s.polylineKind(), entry: s.polylineEntry() };
  });
  expect(state.kind).toBe('arrow');
  expect(state.entry).toBe('ctrl');
  await capturePage.keyboard.up('Control');

  await openerPage.close();
});

test('drawing: window blur ends an active polyline chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Window blur is the defensive cleanup path — if focus leaves the
  // capture page mid-chain (alt-tab, focus another window), the chain
  // must clear so a stuck ghost segment doesn't haunt the next
  // focus-in. Simulated by firing a blur event on the page.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + 80, r.y + 80);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 180, r.y + 80);
  await capturePage.mouse.up();
  // Chain alive.
  expect(await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  )).toBe('line');

  // Dispatch blur — the window listener clears the chain.
  await capturePage.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  )).toBeNull();

  await openerPage.close();
});

test('drawing: Polyline tool ignores Ctrl release (only Ctrl-promoted chains exit on Ctrl)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // A chain entered via the Polyline tool button is independent of
  // Ctrl — even if the user incidentally taps Ctrl/Cmd between
  // segments, the chain must stay alive. The exit is Esc / click on
  // chain head / tool switch.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  // Segment 1.
  await capturePage.mouse.move(r.x + 60, r.y + 60);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 160, r.y + 60);
  await capturePage.mouse.up();

  // Tap Ctrl on and off — must not end the chain.
  await capturePage.keyboard.down('Control');
  await capturePage.keyboard.up('Control');
  const entry = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineEntry: () => string | null };
    }).__seeState.polylineEntry(),
  );
  expect(entry).toBe('tool');

  await capturePage.keyboard.press('Escape');

  await openerPage.close();
});

test('drawing: Poly-arrow tool chains arrows the same way Polyline chains lines', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Same chain semantics as Polyline, but each commit is an Arrow.
  // Two drags should produce two arrows whose endpoints chain.
  await capturePage.locator('#tool-polyarrow').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 90, y: r.y + 90 };
  const B = { x: r.x + 190, y: r.y + 110 };
  const D = { x: r.x + 280, y: r.y + 200 };

  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  await capturePage.mouse.move(D.x, D.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const arrows = await readAllLines(capturePage, 'arrow');
  expect(arrows).toHaveLength(2);
  const kinds = await readEditKinds(capturePage);
  expect(kinds).toEqual(['arrow', 'arrow']);
  const toCssX = (xPct: number) => r.x + (xPct / 100) * r.w;
  const toCssY = (yPct: number) => r.y + (yPct / 100) * r.h;
  // Arrow #2 chains from arrow #1's endpoint.
  expect(toCssX(arrows[1]!.x1)).toBeCloseTo(B.x, 0);
  expect(toCssY(arrows[1]!.y1)).toBeCloseTo(B.y, 0);

  await openerPage.close();
});

test('drawing: arrow keys nudge polyline endpoints — mid-drag and between segments', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Polyline mode keeps `dragStart` non-null between segments, so
  // the arrow-key handler can nudge `dragCurrent` whether or not
  // the mouse button is pressed. Each press = one natural-pixel
  // step; the segment commit uses the *nudged* endpoint, and the
  // next segment continues from that nudged point.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 80, y: r.y + 80 };
  const Bdrag = { x: r.x + 180, y: r.y + 80 };
  const Cphys = { x: r.x + 240, y: r.y + 130 };
  const NUDGE_MID = 4;     // ArrowRight presses while dragging seg 1
  const NUDGE_BETWEEN = 3; // ArrowDown presses while between segments

  // Segment 1: drag A → near B, then nudge right by 4 natural pixels.
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(Bdrag.x, Bdrag.y);
  for (let i = 0; i < NUDGE_MID; i++) await capturePage.keyboard.press('ArrowRight');
  await capturePage.mouse.up();
  // Between segments: no mouse held but `dragStart` is alive.
  // ArrowDown nudges `dragCurrent` so segment 2's endpoint shifts
  // even though the OS cursor is at Cphys. Move first so the
  // physical-pointer reset on the previous mouseup doesn't leave
  // us at Bdrag.
  await capturePage.mouse.move(Cphys.x, Cphys.y);
  for (let i = 0; i < NUDGE_BETWEEN; i++) await capturePage.keyboard.press('ArrowDown');
  // Click commits segment 2 from the (nudged) seg-1 endpoint to
  // the (nudged) current synthetic cursor.
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  // Segment 1's endpoint is Bdrag shifted right by NUDGE_MID natural
  // pixels. Compare in natural-pixel space so the assertion is
  // independent of the test viewport's display scale.
  const seg1EndXNat = lines[0]!.x2 * r.natW / 100;
  expect(seg1EndXNat).toBeCloseTo(
    (Bdrag.x - r.x) * r.natW / r.w + NUDGE_MID,
    0,
  );
  // Segment 2 starts where segment 1 ended (chain anchor) — the
  // chain re-anchors to the nudged endpoint, not the physical
  // mouse position at mouseup.
  expect(lines[1]!.x1).toBeCloseTo(lines[0]!.x2, 1);
  expect(lines[1]!.y1).toBeCloseTo(lines[0]!.y2, 1);
  // Segment 2's endpoint is Cphys shifted down by NUDGE_BETWEEN
  // natural pixels. Cphys's CSS-pixel y on the image rect plus the
  // nudge in natural-pixel terms.
  const seg2EndYNat = lines[1]!.y2 * r.natH / 100;
  expect(seg2EndYNat).toBeCloseTo(
    (Cphys.y - r.y) * r.natH / r.h + NUDGE_BETWEEN,
    0,
  );

  await openerPage.close();
});

test('drawing: releasing Ctrl mid-segment-drag commits the segment and ends the chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Exercises the keyup handler's *mid-drag* branch — which only
  // fires when `polylineLineKind !== null` AND the chain was entered
  // via Ctrl-promote. Segment 1 must have already committed (with
  // Ctrl held at its mouseup, promoting to a chain) before we
  // release Ctrl during segment 2's drag. The keyup clears
  // `polylineLineKind` but leaves `dragStart` / `dragCurrent` alone
  // so the upcoming mouseup can still commit segment 2; that mouseup
  // then sees `ctrlKey === false` and ends the chain.
  await capturePage.locator('#tool-line').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 80, y: r.y + 80 };
  const B = { x: r.x + 200, y: r.y + 80 };
  const Cdown = { x: r.x + 220, y: r.y + 110 };
  const Dup = { x: r.x + 340, y: r.y + 200 };
  const E = { x: r.x + 380, y: r.y + 260 };
  const F = { x: r.x + 460, y: r.y + 300 };

  // Segment 1: plain Line draw A→B, but Ctrl held at mouseup so the
  // segment is promoted to a chain.
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.keyboard.down('Control');
  await capturePage.mouse.up();
  // Chain is alive — verify before continuing.
  const polyKindMid = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKindMid).toBe('line');

  // Segment 2: Ctrl-drag from Cdown toward Dup. While the mouse is
  // still pressed, release Ctrl — this is the mid-drag keyup case.
  // The polyline state machine should clear `polylineLineKind`
  // immediately but leave `dragStart` / `dragCurrent` alive so
  // mouseup can still commit segment 2 (anchored at the chain's
  // prior endpoint B, not at Cdown).
  await capturePage.mouse.move(Cdown.x, Cdown.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(Dup.x, Dup.y);
  await capturePage.keyboard.up('Control');
  // Inline assertion — at this moment, `polylineLineKind` should
  // already be null (mid-drag keyup branch), but the in-flight
  // drag is preserved.
  const polyKindAfterKeyup = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKindAfterKeyup).toBeNull();
  await capturePage.mouse.up();

  // Segment 2 should have committed, anchored at B (chain anchor).
  let lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const toCssX = (xPct: number) => r.x + (xPct / 100) * r.w;
  const toCssY = (yPct: number) => r.y + (yPct / 100) * r.h;
  expect(toCssX(lines[1]!.x1)).toBeCloseTo(B.x, 0);
  expect(toCssY(lines[1]!.y1)).toBeCloseTo(B.y, 0);
  expect(toCssX(lines[1]!.x2)).toBeCloseTo(Dup.x, 0);
  expect(toCssY(lines[1]!.y2)).toBeCloseTo(Dup.y, 0);

  // Chain is dead — a subsequent (no-Ctrl) Line drag should
  // commit fresh from E, not chained from Dup.
  await capturePage.mouse.move(E.x, E.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(F.x, F.y);
  await capturePage.mouse.up();
  lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(3);
  expect(toCssX(lines[2]!.x1)).toBeCloseTo(E.x, 0);
  expect(toCssY(lines[2]!.y1)).toBeCloseTo(E.y, 0);

  await openerPage.close();
});

test('drawing: switching tools mid-polyline ends the chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // After committing the first polyline segment, switching to
  // another tool must clear the chain state so a subsequent draw
  // with the new tool isn't contaminated by the previous chain.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);

  await capturePage.mouse.move(r.x + 80, r.y + 80);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 180, r.y + 80);
  await capturePage.mouse.up();
  // Switch tools — chain should end here.
  await capturePage.locator('#tool-box').click();
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();

  await openerPage.close();
});

// ─── Snap-to ─────────────────────────────────────────────────────
//
// A fresh draw's *start* and a live drag's *target* snap to nearby
// committed geometry (within ~8 CSS px): box corners, the image
// bounding box's corners, line endpoints, and the nearest point on
// any box edge (incl. the image bbox edges). Shift disables snap.
// Arrow-key nudges bypass snap (one natural pixel per press, on top
// of the snapped position). When a polyline chain is alive, the
// chain's first anchor is an extra snap target — clicking near it
// closes the loop, and the chain stays alive afterwards.
//
// Reading the chain-start anchor (mirror of __seeState.polylineChainStart)
// for tests that want to verify the loop-close target.
async function readPolylineChainStart(
  capturePage: Page,
): Promise<{ x: number; y: number } | null> {
  return capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineChainStart: () => { x: number; y: number } | null };
    }).__seeState.polylineChainStart(),
  );
}

test('drawing: snap-to: line endpoint snaps to a nearby box corner', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Draw a rect, then start a Line draw whose endpoint passes within
  // SNAP_PX (8) of the rect's NE corner. The committed line's end
  // should be *exactly* the corner, not the cursor position.
  const r = await readPreviewRect(capturePage);
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.5, yPct: 0.5 },
  );
  // Read the rect's actual committed bounds — dragRect uses `#overlay`
  // coords, which can differ from `#preview` (imgRect) coords by a
  // sub-pixel offset, so deriving the NE corner directly from the
  // dragRect inputs would mis-target the snap.
  const rectB = (await readLastBounds(capturePage, 'rect'))!;
  const ne = {
    x: r.x + ((rectB.x + rectB.w) / 100) * r.w,
    y: r.y + (rectB.y / 100) * r.h,
  };

  await capturePage.locator('#tool-line').click();
  const lineStart = { x: r.x + r.w * 0.1, y: r.y + r.h * 0.7 };
  // Aim outside the rect's row + column so the corner is the
  // unambiguous winner — an aim inside the rect's column would
  // project onto the (closer) top edge instead, which is correct
  // snap behaviour but a different test.
  const aim = { x: ne.x + 3, y: ne.y - 3 };
  await capturePage.mouse.move(lineStart.x, lineStart.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((lineStart.x + aim.x) / 2, (lineStart.y + aim.y) / 2);
  await capturePage.mouse.move(aim.x, aim.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(1);
  // Endpoint snapped onto the rect's NE corner (in image-percent space).
  const endXcss = r.x + (lines[0]!.x2 / 100) * r.w;
  const endYcss = r.y + (lines[0]!.y2 / 100) * r.h;
  expect(endXcss).toBeCloseTo(ne.x, 0);
  expect(endYcss).toBeCloseTo(ne.y, 0);

  await openerPage.close();
});

test('drawing: snap-to: line endpoint snaps to the nearest point on a box edge', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Box edges snap to the *projected* nearest point — sliding along
  // the edge, the snapped endpoint tracks the cursor's perpendicular
  // foot on that edge.
  const r = await readPreviewRect(capturePage);
  const rectNW = { x: r.x + r.w * 0.3, y: r.y + r.h * 0.3 };
  const rectSE = { x: r.x + r.w * 0.5, y: r.y + r.h * 0.5 };
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.5, yPct: 0.5 },
  );
  await capturePage.locator('#tool-line').click();
  // Aim 3 px outside the west edge, midway between top and bottom —
  // far from any corner.
  const aim = { x: rectNW.x - 3, y: (rectNW.y + rectSE.y) / 2 };
  const lineStart = { x: r.x + r.w * 0.05, y: r.y + r.h * 0.1 };
  await capturePage.mouse.move(lineStart.x, lineStart.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((lineStart.x + aim.x) / 2, (lineStart.y + aim.y) / 2);
  await capturePage.mouse.move(aim.x, aim.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(1);
  const endXcss = r.x + (lines[0]!.x2 / 100) * r.w;
  const endYcss = r.y + (lines[0]!.y2 / 100) * r.h;
  // Projects onto the west edge: x = rectNW.x, y = aim.y (already
  // between the edge's top and bottom).
  expect(endXcss).toBeCloseTo(rectNW.x, 0);
  expect(endYcss).toBeCloseTo(aim.y, 0);

  await openerPage.close();
});

test('drawing: snap-to: line endpoint snaps to a prior line endpoint', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  const r = await readPreviewRect(capturePage);
  // First line A→B.
  await capturePage.locator('#tool-line').click();
  const A = { x: r.x + 100, y: r.y + 100 };
  const B = { x: r.x + 300, y: r.y + 100 };
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((A.x + B.x) / 2, A.y);
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();

  // Second line aiming 5 px short of B — should snap onto B.
  const C = { x: r.x + 100, y: r.y + 300 };
  const aim = { x: B.x - 5, y: B.y + 2 };
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((C.x + aim.x) / 2, (C.y + aim.y) / 2);
  await capturePage.mouse.move(aim.x, aim.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const endXcss = r.x + (lines[1]!.x2 / 100) * r.w;
  const endYcss = r.y + (lines[1]!.y2 / 100) * r.h;
  expect(endXcss).toBeCloseTo(B.x, 0);
  expect(endYcss).toBeCloseTo(B.y, 0);

  await openerPage.close();
});

test('drawing: snap-to: holding Shift disables snap', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Same setup as the "snap to line endpoint" test, but holding
  // Shift across the second drag. Endpoint should remain at the
  // cursor's released position, not snap onto B.
  const r = await readPreviewRect(capturePage);
  await capturePage.locator('#tool-line').click();
  const A = { x: r.x + 100, y: r.y + 100 };
  const B = { x: r.x + 300, y: r.y + 100 };
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((A.x + B.x) / 2, A.y);
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();

  const C = { x: r.x + 100, y: r.y + 300 };
  const aim = { x: B.x - 5, y: B.y + 2 };
  await capturePage.keyboard.down('Shift');
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((C.x + aim.x) / 2, (C.y + aim.y) / 2);
  await capturePage.mouse.move(aim.x, aim.y);
  await capturePage.mouse.up();
  await capturePage.keyboard.up('Shift');

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const endXcss = r.x + (lines[1]!.x2 / 100) * r.w;
  const endYcss = r.y + (lines[1]!.y2 / 100) * r.h;
  // Stays at the un-snapped pointer position.
  expect(endXcss).toBeCloseTo(aim.x, 0);
  expect(endYcss).toBeCloseTo(aim.y, 0);

  await openerPage.close();
});

test('drawing: snap-to: arrow-key nudge bypasses snap (steps off the snapped target)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Snap onto a prior line's endpoint, then nudge with the keyboard.
  // The nudge moves the endpoint one natural-pixel away — the snap
  // logic doesn't re-grab it (arrow nudges bypass snap).
  const r = await readPreviewRect(capturePage);
  await capturePage.locator('#tool-line').click();
  const A = { x: r.x + 100, y: r.y + 100 };
  const B = { x: r.x + 300, y: r.y + 100 };
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((A.x + B.x) / 2, A.y);
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();

  const C = { x: r.x + 100, y: r.y + 300 };
  // Land snapped right on B.
  const onB = { x: B.x, y: B.y };
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((C.x + onB.x) / 2, (C.y + onB.y) / 2);
  await capturePage.mouse.move(onB.x, onB.y);
  // Step one natural pixel right with the keyboard. With the cursor
  // sitting directly on a snap target, snap would still resolve onto
  // B on a fresh mousemove; the arrow path skips that and shifts
  // dragCurrent by one natural-px on its own.
  await capturePage.keyboard.press('ArrowRight');
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const endX = lines[1]!.x2;
  // Expected end-x in image-percent = B's percent + one natural-px
  // worth of percent (1/natW * 100).
  const expectedX = (B.x - r.x) / r.w * 100 + (100 / r.natW);
  expect(endX).toBeCloseTo(expectedX, 1);

  await openerPage.close();
});

test('drawing: snap-to: polyline loop closes when endpoint lands near the chain start', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Polyline chain: A → B → C → near-A. The last click lands within
  // snap radius of A, so the final segment ends exactly at A —
  // closing the polygon. The closing segment commits, then the
  // chain auto-exits (polygon-close is one of the chain-end gestures).
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 100, y: r.y + 100 };
  const B = { x: r.x + 250, y: r.y + 100 };
  const C = { x: r.x + 200, y: r.y + 250 };
  // 5 px from A — within SNAP_PX.
  const nearA = { x: A.x + 5, y: A.y + 3 };

  // Segment 1: A → B (drag).
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Segment 2: B → C (click at C, having moved there).
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  // Segment 3: C → near-A. Mousemove to nearA so dragCurrent snaps
  // onto A before the click commits.
  await capturePage.mouse.move(nearA.x, nearA.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();

  // Polygon closed — chain auto-exited.
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();
  const cs = await readPolylineChainStart(capturePage);
  expect(cs).toBeNull();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(3);
  // Segment 3 ends exactly at A (snapped from nearA).
  const endXcss = r.x + (lines[2]!.x2 / 100) * r.w;
  const endYcss = r.y + (lines[2]!.y2 / 100) * r.h;
  expect(endXcss).toBeCloseTo(A.x, 0);
  expect(endYcss).toBeCloseTo(A.y, 0);

  await openerPage.close();
});

test('drawing: snap-to: Ctrl+Shift bypasses the resize hit-test but keeps snap on', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // With the Box tool, a plain mousedown within HANDLE_PX of an
  // existing rect's edge would start a resize. Shift alone bypasses
  // that *and* disables snap (existing "force a fresh draw" gesture).
  // Ctrl+Shift bypasses the resize too, but keeps snap on — lets the
  // user start a fresh shape exactly against an existing edge.
  const r = await readPreviewRect(capturePage);
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.5, yPct: 0.5 },
  );
  const rectB = (await readLastBounds(capturePage, 'rect'))!;
  const ne = {
    x: r.x + ((rectB.x + rectB.w) / 100) * r.w,
    y: r.y + (rectB.y / 100) * r.h,
  };

  // Start a Box draw with Ctrl+Shift held, mousedown inside the
  // existing rect's handle band (would normally resize). Without
  // Ctrl+Shift the gesture would resize rect 1; with Ctrl+Shift it
  // creates a second rect. Drag end is far from any snap target so
  // CLICK_THRESHOLD_PX is comfortably cleared (a near-corner snap on
  // both mousedown and mouseup can pull the two anchors back onto
  // each other, leaving no commit — the dedicated corner-snap test
  // above already covers that behaviour).
  // Mousedown sits outside the rect's row+column but within
  // HANDLE_PX of its NE corner (sqrt(3²+3²) ≈ 4.2 < 6 = HANDLE_PX),
  // so the regular hit-test would grab the corner handle. With
  // Ctrl+Shift the hit-test is bypassed but the snap still sees a
  // nearby target; placing the down outside the rect's extents means
  // the corner wins the snap over any edge projection.
  const downAt = { x: ne.x + 3, y: ne.y - 3 };
  const endAt = { x: r.x + r.w * 0.8, y: r.y + r.h * 0.8 };

  await capturePage.keyboard.down('Control');
  await capturePage.keyboard.down('Shift');
  await capturePage.mouse.move(downAt.x, downAt.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((downAt.x + endAt.x) / 2, (downAt.y + endAt.y) / 2);
  await capturePage.mouse.move(endAt.x, endAt.y);
  await capturePage.mouse.up();
  await capturePage.keyboard.up('Shift');
  await capturePage.keyboard.up('Control');

  // Two rects committed — proves the resize hit-test was bypassed.
  const kinds = await readEditKinds(capturePage);
  expect(kinds.filter((k) => k === 'rect').length).toBe(2);
  // Snap landed the new rect's NW corner onto rect 1's NE corner —
  // the mousedown was 3 px from it and Ctrl+Shift kept snap on.
  const newRect = (await readLastBounds(capturePage, 'rect'))!;
  const newCornersCss = [
    { x: r.x + (newRect.x / 100) * r.w, y: r.y + (newRect.y / 100) * r.h },
    { x: r.x + ((newRect.x + newRect.w) / 100) * r.w, y: r.y + (newRect.y / 100) * r.h },
    { x: r.x + (newRect.x / 100) * r.w, y: r.y + ((newRect.y + newRect.h) / 100) * r.h },
    { x: r.x + ((newRect.x + newRect.w) / 100) * r.w, y: r.y + ((newRect.y + newRect.h) / 100) * r.h },
  ];
  const matched = newCornersCss.some(
    (c) => Math.abs(c.x - ne.x) < 1 && Math.abs(c.y - ne.y) < 1,
  );
  expect(matched, `no corner of new rect at (${ne.x}, ${ne.y}); saw ${JSON.stringify(newCornersCss)}`).toBe(true);

  await openerPage.close();
});

test('drawing: snap-to: endpoint priority beats a slightly-closer corner', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Place a line endpoint and a box corner near each other, aim
  // between them so the corner is closer than the endpoint (both
  // within snap radius). Tier priority means the endpoint wins
  // anyway: the second line's start snaps onto the endpoint.
  const r = await readPreviewRect(capturePage);
  // Box first (default tool is 'rect'); its NW corner is the
  // tier-2 candidate.
  await dragRect(
    capturePage,
    { xPct: 0.25, yPct: 0.30 },
    { xPct: 0.50, yPct: 0.50 },
  );
  const rectB = (await readLastBounds(capturePage, 'rect'))!;
  const cornerNW = {
    x: r.x + (rectB.x / 100) * r.w,
    y: r.y + (rectB.y / 100) * r.h,
  };
  // Line A→B where B sits 14 px west of cornerNW (well outside
  // HANDLE_PX so the rect's corner-handle hit-test won't fire from
  // aim). Aim 6.5 px west of cornerNW = 7.5 px east of B: corner
  // closer (6.5 < 7.5), both within SNAP_PX (8), both outside
  // HANDLE_PX (6). Tier priority must pull the second draw's
  // anchor onto B.
  await capturePage.locator('#tool-line').click();
  const A = { x: r.x + r.w * 0.05, y: cornerNW.y };
  const B = { x: cornerNW.x - 14, y: cornerNW.y };
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((A.x + B.x) / 2, A.y);
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();

  const aim = { x: cornerNW.x - 6.5, y: cornerNW.y };
  // Sanity-assert the geometry: aim in radius of both, corner closer
  // than endpoint, but outside HANDLE_PX (6) so no resize gesture.
  const dB = Math.hypot(aim.x - B.x, aim.y - B.y);
  const dC = Math.hypot(aim.x - cornerNW.x, aim.y - cornerNW.y);
  expect(dB).toBeLessThan(8);
  expect(dC).toBeLessThan(8);
  expect(dC).toBeGreaterThan(6);
  expect(dC).toBeLessThan(dB);

  // Second line; start should snap to B (endpoint tier) even though
  // cornerNW is closer. End far from any snap target so the segment
  // commits a 2-rect... err 2-line stack regardless of axis-align.
  const farEnd = { x: r.x + r.w * 0.7, y: r.y + r.h * 0.6 };
  await capturePage.mouse.move(aim.x, aim.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((aim.x + farEnd.x) / 2, (aim.y + farEnd.y) / 2);
  await capturePage.mouse.move(farEnd.x, farEnd.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const startXcss = r.x + (lines[1]!.x1 / 100) * r.w;
  const startYcss = r.y + (lines[1]!.y1 / 100) * r.h;
  expect(startXcss).toBeCloseTo(B.x, 0);
  expect(startYcss).toBeCloseTo(B.y, 0);

  await openerPage.close();
});

test('drawing: snap-to: line draw snaps to horizontal when near axis-aligned', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Draw a Line that's *almost* horizontal (dy = 3 px); the
  // axis-align snap should pull the endpoint onto the start's y.
  await capturePage.locator('#tool-line').click();
  const r = await readPreviewRect(capturePage);
  const start = { x: r.x + r.w * 0.1, y: r.y + r.h * 0.4 };
  const end = { x: r.x + r.w * 0.6, y: start.y + 3 };
  await capturePage.mouse.move(start.x, start.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2);
  await capturePage.mouse.move(end.x, end.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(1);
  // y1 == y2 exactly (axis-aligned).
  expect(lines[0]!.y2).toBeCloseTo(lines[0]!.y1, 5);

  await openerPage.close();
});

test('drawing: snap-to: Shift disables axis-align', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Same near-horizontal draw, with Shift held. The 3 px y-delta
  // should be preserved (no axis-align).
  await capturePage.locator('#tool-line').click();
  const r = await readPreviewRect(capturePage);
  const start = { x: r.x + r.w * 0.1, y: r.y + r.h * 0.4 };
  const end = { x: r.x + r.w * 0.6, y: start.y + 3 };
  await capturePage.keyboard.down('Shift');
  await capturePage.mouse.move(start.x, start.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2);
  await capturePage.mouse.move(end.x, end.y);
  await capturePage.mouse.up();
  await capturePage.keyboard.up('Shift');

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(1);
  // y1 != y2; the un-snapped 3 px delta survives.
  const dy = Math.abs(lines[0]!.y2 - lines[0]!.y1);
  expect(dy).toBeGreaterThan(0);

  await openerPage.close();
});

test('drawing: snap-to: line projection snaps to a diagonal line', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // First draw a diagonal line. Then start a second line whose end
  // passes close to the diagonal — the tier-3 line projection
  // should snap the endpoint onto the line.
  await capturePage.locator('#tool-line').click();
  const r = await readPreviewRect(capturePage);
  const a = { x: r.x + r.w * 0.10, y: r.y + r.h * 0.10 };
  const b = { x: r.x + r.w * 0.50, y: r.y + r.h * 0.50 };
  await capturePage.mouse.move(a.x, a.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await capturePage.mouse.move(b.x, b.y);
  await capturePage.mouse.up();

  // Midpoint of the diagonal in viewport CSS.
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // Aim a few pixels off the midpoint, perpendicular to the line
  // (which has slope 1). Normal direction (1, -1) / √2; offset 3 px.
  const off = 3 / Math.SQRT2;
  const aim = { x: mid.x + off, y: mid.y - off };
  const start2 = { x: r.x + r.w * 0.8, y: r.y + r.h * 0.15 };
  await capturePage.mouse.move(start2.x, start2.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((start2.x + aim.x) / 2, (start2.y + aim.y) / 2);
  await capturePage.mouse.move(aim.x, aim.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  // The committed endpoint should land on the diagonal, i.e. its
  // (x,y) projects back to within ~0.5 px of itself on the line —
  // equivalently x2 == y2 in percent (since a→b has slope 1 and
  // anchors at equal percentages).
  expect(lines[1]!.x2).toBeCloseTo(lines[1]!.y2, 0);

  await openerPage.close();
});

test('drawing: snap-to: polyline preview does not pull back onto the previous endpoint', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // After segment 1 of a polyline, `dragStart` holds segment 1's
  // endpoint — which is also a committed line endpoint and thus a
  // snap candidate. Without the explicit exclusion, segment 2's
  // endpoint would snap right back onto segment 1's endpoint
  // whenever the cursor was within snap radius. Move the cursor
  // ~6 px from B (well inside the radius); the commit should sit
  // at the cursor, not at B.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + r.w * 0.2, y: r.y + r.h * 0.2 };
  const B = { x: r.x + r.w * 0.5, y: r.y + r.h * 0.2 };
  // Click 6 px south of B for segment 2 — within SNAP_PX (8) of B
  // *and* above CLICK_THRESHOLD_PX (4) so a non-snapped commit is
  // possible. Without the exclusion, snap would pull onto B and the
  // segment would collapse to length 0.
  const justSouth = { x: B.x, y: B.y + 6 };

  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Segment 2: pure click at justSouth.
  await capturePage.mouse.move(justSouth.x, justSouth.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const lines = await readAllLines(capturePage, 'line');
  // Two segments committed: A→B and B→justSouth. The second's end
  // must sit ~near the un-snapped cursor location (snap to B was
  // suppressed). Without the exclusion this would either commit a
  // zero-length B→B (no-op, no segment 2) or snap back to B.
  expect(lines).toHaveLength(2);
  // Segment 2 must have non-trivial length — if snap had pulled
  // back to B the y delta would be 0 (or below the click threshold).
  const seg2_dy_pct = Math.abs(lines[1]!.y2 - lines[1]!.y1);
  expect(seg2_dy_pct).toBeGreaterThan(0);
  const endYcss = r.y + (lines[1]!.y2 / 100) * r.h;
  // Browser rounds clientY to an integer, and the preview's left
  // edge sits at a sub-pixel x — so allow ~1.5 px of slop on the
  // CSS-pixel comparison.
  expect(Math.abs(endYcss - justSouth.y)).toBeLessThan(1.5);

  await openerPage.close();
});

test('drawing: snap-to: box-resize edge drag snaps the moving edge onto another box edge', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Two rects side-by-side. Drag rect-A's east edge toward rect-B's
  // west edge from a few pixels short — the edge snaps onto rect-B's
  // west edge (via the edge-projection snap candidate).
  const r = await readPreviewRect(capturePage);
  // Rect A: 20%–40%, rect B: 50%–70%.
  await dragRect(capturePage, { xPct: 0.20, yPct: 0.30 }, { xPct: 0.40, yPct: 0.50 });
  await dragRect(capturePage, { xPct: 0.50, yPct: 0.30 }, { xPct: 0.70, yPct: 0.50 });

  // Rect A is the *earlier* edit. `__seeState.lastRectBounds`
  // returns rect B, so we work from the dragRect inputs (they map
  // 1:1 onto image-percent space) and verify rect A's east edge by
  // scanning all SVG <rect> elements below.
  const rectA_eastX = r.x + r.w * 0.40;
  const rectB_westX = r.x + r.w * 0.50;
  const midY = r.y + r.h * 0.40;

  // Drag rect A's east handle. The mousedown inset and the drag inset
  // are *different* on purpose: equal insets would cancel out and the
  // un-snapped delta would already land the edge on rectB.westX,
  // making the test pass without exercising snap. With unequal
  // insets, only the snap can pull the edge exactly onto 50%.
  const mouseDownX = rectA_eastX - 2;
  const targetX = rectB_westX - 6;
  await capturePage.mouse.move(mouseDownX, midY);
  await capturePage.mouse.down();
  await capturePage.mouse.move((mouseDownX + targetX) / 2, midY);
  await capturePage.mouse.move(targetX, midY);
  await capturePage.mouse.up();

  // Rect A's new east edge should sit exactly at rect B's west edge
  // (50%). aBefore captured rect B before the resize, so re-read all
  // edits and pick the resized one (the first 'rect' in stack order
  // is rect A).
  const both = await capturePage.evaluate(() => {
    const all = (window as unknown as {
      __seeState: {
        // Not exposed — use a small inline read of editKinds + bounds
        // by id. Fall back to two lastRectBounds reads.
        editKinds: () => string[];
        lastRectBounds: (k: string) => { x: number; y: number; w: number; h: number };
      };
    }).__seeState;
    return { kinds: all.editKinds() };
  });
  expect(both.kinds.filter((k) => k === 'rect').length).toBe(2);
  // Walk the SVG overlay to find rect A's bounds — most reliable here
  // since the test hook returns only the *last* rect. We assert that
  // *some* rect on the stack has its east edge at 50%.
  const eastEdges = await capturePage.evaluate(() => {
    const svg = document.getElementById('overlay') as unknown as SVGSVGElement;
    const rects = Array.from(svg.querySelectorAll('rect')) as SVGRectElement[];
    return rects.map((el) => {
      const x = parseFloat(el.getAttribute('x') || '0');
      const w = parseFloat(el.getAttribute('width') || '0');
      return x + w;
    });
  });
  // Convert rect B's west edge (50%) to CSS px and find a matching east edge.
  const targetEastCss = rectB_westX - r.x;
  const matched = eastEdges.some((e) => Math.abs(e - targetEastCss) < 1.5);
  expect(matched, `no rect's east edge snapped to ${targetEastCss}; saw ${eastEdges.join(',')}`).toBe(true);

  await openerPage.close();
});

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

test('shrink: never grows the box on any edge (partial-advance)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Regression for a class of bug where the Box edges drift
  // outward / oscillate across repeated Shrink clicks.
  //
  // Set up a partial-advance starting state by:
  //  1. Loose-drag a Box and Shrink — gives the canonical
  //     "1 px outside content on every edge" state.
  //  2. Mutate the rect to extend its right edge well past the
  //     block. Now top / bottom / left sit 1 px outside content
  //     (the algorithm can't advance them — snap is bg, the next
  //     line in is content) while right is loose (advances).
  //  3. Click Shrink. The pre-fix code unconditionally added 1 px
  //     of outward padding on all four edges of the tight result,
  //     so non-advanced edges (top / bottom / left) grew outward
  //     by 1 px each click, even though the right edge correctly
  //     tightened. The user observed this as drift / oscillation.
  //
  // Invariant (post-fix): a Shrink click must never move any edge
  // outward. We assert that directly on the pct-space bounds.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );

  await dragRect(
    capturePage,
    { xPct: 0.1, yPct: 0.1 },
    { xPct: 0.9, yPct: 0.9 },
  );
  await capturePage.locator('#shrink').click();
  const tight = await readLastRectBounds(capturePage, 'rect');
  expect(tight).not.toBeNull();

  // Extend the right edge by 10 pct points so it sits in bg, well
  // past the central block. Top / bottom / left stay at their
  // post-shrink "1 px outside content" positions.
  await capturePage.evaluate((bounds) => {
    (window as unknown as {
      __seeState: {
        setLastRectBounds: (
          kind: 'rect' | 'redact' | 'crop',
          b: { x: number; y: number; w: number; h: number },
        ) => boolean;
      };
    }).__seeState.setLastRectBounds('rect', bounds);
  }, { x: tight!.x, y: tight!.y, w: tight!.w + 10, h: tight!.h });

  const before = await readLastRectBounds(capturePage, 'rect');
  expect(before).not.toBeNull();

  await capturePage.locator('#shrink').click();
  const after = await readLastRectBounds(capturePage, 'rect');
  expect(after).not.toBeNull();

  // The hard invariant: no edge moved outward. Use a tiny
  // epsilon (well below any real geometry shift) to absorb
  // pct-space rounding from the round-trip through pixel space.
  const eps = 1e-6;
  expect(after!.x).toBeGreaterThanOrEqual(before!.x - eps);
  expect(after!.y).toBeGreaterThanOrEqual(before!.y - eps);
  expect(after!.x + after!.w).toBeLessThanOrEqual(before!.x + before!.w + eps);
  expect(after!.y + after!.h).toBeLessThanOrEqual(before!.y + before!.h + eps);

  // And it must have actually shrunk — the loose right edge had
  // 10 pct of slack to trim, so the new right should be well
  // inside the old right.
  expect(after!.x + after!.w).toBeLessThan(before!.x + before!.w - 5);

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
