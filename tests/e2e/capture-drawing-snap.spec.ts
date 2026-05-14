// E2E coverage for the snap-to behavior of fresh draws and live drag
// targets.
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
// See `capture-drawing-polyline.spec.ts` for the rest of the polyline
// chain-lifetime tests; only loop-closing snap lives here.

import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow } from './details-helpers';
import {
  readAllLines,
  readEditKinds,
  readLastBounds,
  readPolylineChainStart,
  readPreviewRect,
} from './capture-drawing-helpers';

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
  // Sub-pixel-drift trap: `dragRect` uses `#overlay` coords for its
  // mouse positions, but the rect-edit and line-edit percentages are
  // stored against `imgRect()` in capture-page.ts, which can be a
  // fraction of a pixel offset *and* can shift between the rect-
  // commit and the line-commit (e.g. layout settling). Re-read the
  // image rect now so we're decoding both percentages in the same
  // frame as the line was committed in; converted back, the line's
  // endpoint should land at the aim's viewport y exactly and at the
  // rect's west edge (which lives at `rectB.x` in any frame, since
  // both `rectB.x` and the snap target round-trip through the same
  // imgRect at line-commit time).
  const rectB = (await readLastBounds(capturePage, 'rect'))!;
  const endXcss = r.x + (lines[0]!.x2 / 100) * r.w;
  const endYcss = r.y + (lines[0]!.y2 / 100) * r.h;
  // Snap target on this path:
  //   - x lands on the rect's west edge — derived from `rectB.x`
  //     (rather than `rectNW.x = r.x + r.w * 0.3`) because Playwright
  //     hands mouse coords to the page as integers (`MouseEvent.client*`
  //     is `long` per spec), so the rect-edit's stored percentages
  //     come out fractionally below 0.3 / 0.5 of `r`. The corner test
  //     above documents the same trap.
  //   - y matches the aim's cursor row, but again — `aim.y = 456.8`
  //     arrives in the page as `456`, so we compare against
  //     `Math.floor(aim.y)`.
  const westEdgeXcss = r.x + (rectB.x / 100) * r.w;
  expect(endXcss).toBeCloseTo(westEdgeXcss, 0);
  expect(endYcss).toBeCloseTo(Math.floor(aim.y), 0);

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
