// E2E coverage for basic Capture-page drawing flows: a draw + save
// round-trip per tool (Box / Line / Arrow / Crop / Redact), undo /
// clear button state, and the per-kind flags the saved record carries
// (`hasHighlights`, `hasRedactions`, `isCropped`).
//
// Sibling drawing specs cover:
//   - `capture-drawing-resize-nudge.spec.ts` — edge-handle resize and
//     arrow-key fine-adjustment during a drag.
//   - `capture-drawing-polyline.spec.ts`    — Ctrl-promote / dedicated
//     multi-segment Line and Arrow chains.
//   - `capture-drawing-snap.spec.ts`        — snap-to behavior (corners,
//     edges, endpoints, axis-align, projection).
//   - `capture-drawing-palette.spec.ts`     — palette Save / Copy buttons.
//   - `capture-drawing-shrink.spec.ts`      — the Shrink-tool operator.

import fs from 'node:fs';
import { PNG } from 'pngjs';
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
import {
  dragEdge,
  readEditKinds,
  readEffectiveCrop,
} from './capture-drawing-helpers';

// ─── Basic draw → bake → save round-trips ────────────────────────

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
