// E2E coverage for in-place adjustment of an existing drawing:
//   - Box-edge resize via the corner / edge handles on rect / redact.
//   - Arrow-key fine-adjustment ("nudge") of an in-flight drag —
//     each press is one natural-pixel step on the dragged corner /
//     endpoint, with axis-locked handles only honouring the matching
//     axis.
//   - Visible-pane clamping at non-Fit zoom: both arrow-key nudges
//     and mouse drags should stop at the visible-pane edge rather
//     than walking into the scrolled-out portion of the image.
//
// See `capture-drawing-basic.spec.ts` for the per-tool draw → save
// round-trips that establish the geometry these tests adjust.

import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow } from './details-helpers';
import {
  dragEdge,
  readAllLines,
  readEditKinds,
  readLastBounds,
  readPreviewRect,
} from './capture-drawing-helpers';

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

// ─── Visible-pane clamping at non-Fit zoom ───────────────────────
//
// When the image overflows its containing box at >1× zoom, both
// arrow-key nudges and mouse drags must stop at the visible-pane
// edge rather than walking into the scrolled-out portion of the
// image (where the user can't see the in-flight target).

test('drawing: arrow-key nudge clamps at the visible-pane edge, not the image edge (zoomed)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Arrow nudges drive `dragCurrent` directly, so they bypass the
  // mouse-event coord clamp. They have their own clamp inside the
  // keydown handler — verify *that* clamp is the visible-pane rect
  // too, not raw imgRect. Without the fix, a long press of
  // ArrowRight under any Nx zoom would walk the drag target deep
  // into the scrolled-out portion of the image where the user
  // can't see it. 8× zoom keeps the press-count low (each press
  // steps ≈ 8 / DPR CSS px) so the test stays under a second.
  await capturePage.evaluate(
    () => (window as unknown as {
      __seeState: { setZoom: (m: number | 'fit') => void };
    }).__seeState.setZoom(8),
  );
  const layout = await capturePage.evaluate(() => {
    const box = document.querySelector('.image-box') as HTMLElement;
    const img = document.getElementById('preview') as HTMLImageElement;
    const br = box.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    return {
      visRight: br.left + box.clientWidth,
      visTop: Math.max(br.top, ir.top),
      imgLeft: ir.left, imgRight: ir.right, imgW: ir.width,
    };
  });
  // Sanity: image must overflow the box for the test to mean
  // anything (visible right is strictly inside image right).
  expect(layout.imgRight).toBeGreaterThan(layout.visRight + 1);

  // Start a Box draw well inside the visible pane, then mash
  // ArrowRight far past the count needed to reach the visible edge.
  // Each press steps by `r.width / naturalWidth` CSS px (≈ 8 / DPR
  // at 8× zoom), so 400 presses moves the target well over a
  // thousand CSS px — comfortably past `visRight` regardless of
  // DPR.
  const x1 = layout.imgLeft + 20;
  const y1 = layout.visTop + 20;
  await capturePage.mouse.move(x1, y1);
  await capturePage.mouse.down();
  await capturePage.mouse.move(x1 + 5, y1 + 5);
  for (let i = 0; i < 400; i++) await capturePage.keyboard.press('ArrowRight');
  await capturePage.mouse.up();

  // Convert the committed rect's east edge (stored as % of natural
  // width) back to a viewport-x. With the visible-pane clamp it
  // must sit at visRight ± slop; without it the value would be at
  // imgRight (well past visRight).
  const bounds = await readLastBounds(capturePage, 'rect');
  expect(bounds).not.toBeNull();
  const eastCss = layout.imgLeft + ((bounds!.x + bounds!.w) / 100) * layout.imgW;
  expect(eastCss).toBeGreaterThan(layout.visRight - 2);
  expect(eastCss).toBeLessThan(layout.visRight + 2);

  await openerPage.close();
});

test('drawing: drag past the visible-pane edge commits at the visible edge, not off-pane (zoomed)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Zoom in so the image extends past the image-box's content area
  // (Fit mode has visible-pane == imgRect, which wouldn't exercise
  // the new clamp). 2× is enough that the rightmost portion of the
  // image lives in the scroll overflow, off-screen.
  await capturePage.evaluate(
    () => (window as unknown as {
      __seeState: { setZoom: (m: number | 'fit') => void };
    }).__seeState.setZoom(2),
  );

  // Read the image-box's content rect (clientWidth excludes the
  // scrollbar) and the image's rect. With image-wrap pinned to the
  // box's top-left in 2× mode, `vis.right` sits at
  // `boxRect.left + clientWidth` (the content area's right edge),
  // well to the left of `imgRect.right`.
  const layout = await capturePage.evaluate(() => {
    const box = document.querySelector('.image-box') as HTMLElement;
    const img = document.getElementById('preview') as HTMLImageElement;
    const br = box.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    return {
      visRight: br.left + box.clientWidth,
      visTop: Math.max(br.top, ir.top),
      visBottom: Math.min(br.top + box.clientHeight, ir.bottom),
      imgLeft: ir.left, imgTop: ir.top, imgW: ir.width, imgH: ir.height,
    };
  });
  // Sanity: the image must actually overflow the box's content area
  // for this test to mean anything.
  expect(layout.imgLeft + layout.imgW).toBeGreaterThan(layout.visRight + 1);

  // Mousedown inside the visible pane, drag past `visRight` toward
  // the palette. With the new clamp, the committed line's far X (in
  // CSS coords) must sit at `visRight` rather than at the cursor's
  // (off-pane) position.
  await capturePage.locator('#tool-line').click();
  const startCss = { x: layout.imgLeft + 20, y: layout.visTop + 40 };
  const aimCss = { x: layout.visRight + 100, y: layout.visTop + 40 };
  await capturePage.mouse.move(startCss.x, startCss.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((startCss.x + aimCss.x) / 2, startCss.y);
  await capturePage.mouse.move(aimCss.x, aimCss.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(1);
  // Convert the stored x2 percent (of natural width) back to CSS coords.
  // The image's CSS-pixel scale is `imgW / natW`; the stored coord is a
  // percent of natural width, so `(x2/100) * imgW` gives image-relative
  // CSS px, and adding `imgLeft` lands in viewport coords.
  const endXcss = layout.imgLeft + (lines[0]!.x2 / 100) * layout.imgW;
  // Allow ~1 px of slop: Chrome rounds clientX to an integer, the
  // box's right edge can sit at a fractional CSS pixel, and the
  // round-trip through percent introduces small drift.
  expect(endXcss).toBeGreaterThan(layout.visRight - 2);
  expect(endXcss).toBeLessThan(layout.visRight + 2);

  await openerPage.close();
});
