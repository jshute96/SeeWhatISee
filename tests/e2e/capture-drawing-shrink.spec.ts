// E2E coverage for the Shrink-tool operator on the Capture page —
// the "tighten the rect around its content" button (`#shrink`).
//
// `shrink-target.html` is a grey page with a single black block
// from 25%–75% horizontally and vertically. That gives the algorithm
// a deterministic bg→content boundary on every edge, independent of
// viewport size — Shrink should trim the grey margins to expose the
// block.
//
// `shrink-nested.html` nests a red inner block (25%–75%) inside a
// blue card (10%–90%) on a grey page — used by the "drill further"
// tests that exercise repeated Shrink clicks across uniform borders.
//
// The underlying pixel algorithm has its own unit tests in
// `tests/unit/shrink.test.mjs`; this file focuses on the button's
// integration with the edit-stack (history / Undo) and the per-tool
// enable/disable rules.

import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow } from './details-helpers';
import {
  readEffectiveCrop,
  readLastBounds,
} from './capture-drawing-helpers';

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
  const before = await readLastBounds(capturePage, 'rect');
  expect(before).not.toBeNull();
  expect(before!.w).toBeGreaterThan(70);
  expect(before!.h).toBeGreaterThan(70);

  await capturePage.locator('#shrink').click();
  const after = await readLastBounds(capturePage, 'rect');
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
  const afterTwice = await readLastBounds(capturePage, 'rect');
  expect(afterTwice).not.toBeNull();
  expect(afterTwice!.x).toBeCloseTo(after!.x, 6);
  expect(afterTwice!.y).toBeCloseTo(after!.y, 6);
  expect(afterTwice!.w).toBeCloseTo(after!.w, 6);
  expect(afterTwice!.h).toBeCloseTo(after!.h, 6);

  // Undo once should restore the pre-shrink geometry in place
  // (the second click was a no-op, so it didn't push history).
  await capturePage.locator('#undo').click();
  const restored = await readLastBounds(capturePage, 'rect');
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
  const afterFirst = await readLastBounds(capturePage, 'rect');
  expect(afterFirst).not.toBeNull();
  // First click wraps the blue card with a 1-pixel margin
  // (~10%–90% in fixture pct, with a ±1-pixel slop).
  expect(afterFirst!.x).toBeGreaterThan(5);
  expect(afterFirst!.x).toBeLessThan(15);
  expect(afterFirst!.w).toBeGreaterThan(70);
  expect(afterFirst!.w).toBeLessThan(90);

  await capturePage.locator('#shrink').click();
  const afterSecond = await readLastBounds(capturePage, 'rect');
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
  const afterThird = await readLastBounds(capturePage, 'rect');
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
  const tight = await readLastBounds(capturePage, 'rect');
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

  const before = await readLastBounds(capturePage, 'rect');
  expect(before).not.toBeNull();

  await capturePage.locator('#shrink').click();
  const after = await readLastBounds(capturePage, 'rect');
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
