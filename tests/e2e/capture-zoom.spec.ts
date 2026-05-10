// E2E coverage for the Capture-page zoom modes' sizing math and the
// SVG-overlay stroke widths derived from them.
//
// "1×" means 1 source-CSS-pixel = 1 editor CSS pixel — i.e.
// `naturalSize / window.devicePixelRatio`. The `applyZoom()` Fit
// branch caps at the same target so Fit and 1× match. Stroke widths
// are piecewise in `ratio = renderedW / targetW`, dropping by 1 px
// at each halving below 1×:
//   ratio ≥ 1          → ceil(3·ratio − 0.01)   (3 / 6 / 12 / 24)
//   0.5 ≤ ratio < 1    → 3
//   0.25 ≤ ratio < 0.5 → 2
//   ratio < 0.25       → 1
// The −0.01 epsilon swallows pixel-snap float drift between our
// math and Chrome's `getBoundingClientRect()` readout.
//
// Tests:
//   - Sizing at the real DPR: rendered width tracks targetCssSize × N
//     for each integer zoom; Fit fills the box and never overshoots.
//   - Stroke-width on a drawn rect: 3 / 6 / 12 / 24 at 1× / 2× / 4× / 8×.
//   - DPR-stubbed regression: overriding `window.devicePixelRatio` to
//     2 (clean) and 1.5 (lossy) and re-applying zoom should leave 1×
//     at sw = 3 — the float-drift case the −0.01 epsilon defends.
//   - Fit shrinkage between half- and full-size: stroke holds at 3 px
//     (no premature narrowing).
//   - Fit shrinkage well below half-size: stroke narrows per the
//     piecewise formula and ends up < 3.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { openDetailsFlow, dragRect } from './details-helpers';

type ZoomMode = 'fit' | 1 | 2 | 4 | 8;

interface SeeStateZoom {
  setZoom: (m: ZoomMode) => void;
  applyZoom: () => void;
  displayScale: () => number;
  targetCssSize: () => { w: number; h: number };
}

async function applyZoomMode(page: Page, mode: ZoomMode): Promise<void> {
  await page.evaluate(
    (m) => (window as unknown as { __seeState: SeeStateZoom }).__seeState.setZoom(m),
    mode,
  );
}

async function readDisplayScale(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __seeState: SeeStateZoom }).__seeState.displayScale(),
  );
}

async function readTargetCssSize(page: Page): Promise<{ w: number; h: number }> {
  return page.evaluate(
    () => (window as unknown as { __seeState: SeeStateZoom }).__seeState.targetCssSize(),
  );
}

async function readImageMetrics(
  page: Page,
): Promise<{ rendered: number; natural: number; dpr: number }> {
  return page.evaluate(() => {
    const img = document.getElementById('preview') as HTMLImageElement;
    return {
      rendered: img.getBoundingClientRect().width,
      natural: img.naturalWidth,
      dpr: window.devicePixelRatio,
    };
  });
}

// Read the `stroke-width` attribute off the most recently drawn rect
// in the SVG overlay. SVG paint order = document order, so the
// last-of-type entry is the topmost (most recent) rect. The overlay
// is rebuilt every `render()` call, so this reads the *current*
// width — which is what the user sees after a zoom change re-renders
// the same edit.
async function readDrawnRectStrokeWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rects = document.querySelectorAll<SVGRectElement>(
      '#overlay rect[stroke="red"]',
    );
    const rect = rects[rects.length - 1];
    if (!rect) throw new Error('no red rect in overlay');
    return Number(rect.getAttribute('stroke-width'));
  });
}

// Override `window.devicePixelRatio` and re-run `applyZoom()` so the
// page recomputes `targetCssSize()`. `defineProperty` with
// `configurable: true` lets a follow-up override (or restore) replace
// the stub without throwing.
async function stubDpr(page: Page, dpr: number): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(window, 'devicePixelRatio', {
      value,
      configurable: true,
    });
    (window as unknown as { __seeState: SeeStateZoom }).__seeState.applyZoom();
  }, dpr);
}

// Wait until the screenshot has decoded. `applyZoom` is a no-op
// before `naturalWidth` is set; running the test against a 0×0
// preview would assert against meaningless metrics.
async function waitForImageLoaded(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (document.getElementById('preview') as HTMLImageElement | null)
        ?.naturalWidth ?? 0,
    null,
    { timeout: 5000 },
  );
}

test('zoom: 1× / 2× / 4× / 8× render at targetCssSize × N CSS pixels', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  const target = await readTargetCssSize(capturePage);
  const { natural, dpr } = await readImageMetrics(capturePage);
  // targetCssSize must equal naturalWidth / DPR by construction.
  expect(target.w).toBeCloseTo(natural / dpr, 4);

  for (const mode of [1, 2, 4, 8] as const) {
    await applyZoomMode(capturePage, mode);
    const m = await readImageMetrics(capturePage);
    // Rendered width is a CSS pixel value, not always integer (style
    // accepts fractional px). Tolerance of 1 px swallows browser
    // pixel-snap; the regression we're guarding is the *2× / DPR×
    // class* of mistake, not sub-pixel layout.
    expect(m.rendered, `rendered width at ${mode}×`).toBeCloseTo(target.w * mode, 0);
    // displayScale lives in the same frame as zoom mode by design.
    expect(await readDisplayScale(capturePage), `displayScale at ${mode}×`)
      .toBeCloseTo(mode, 2);
  }

  await openerPage.close();
});

test('zoom: Fit caps at 1×, never grows past targetCssSize', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  await applyZoomMode(capturePage, 'fit');
  const target = await readTargetCssSize(capturePage);
  const { rendered } = await readImageMetrics(capturePage);
  // Fit's `Math.min(1, …)` ceiling means rendered ≤ target.w +
  // sub-pixel slop. A 1 CSS-px tolerance covers pixel-snapping.
  expect(rendered).toBeLessThanOrEqual(target.w + 1);
  // `displayScale` mirrors the same ratio; it must stay ≤ 1.
  expect(await readDisplayScale(capturePage)).toBeLessThanOrEqual(1.0001);

  await openerPage.close();
});

test('zoom: drawn rect stroke-width is ceil(3 × ratio) at 1× / 2× / 4× / 8×', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  // Draw the rect once at Fit (the default) where the image fits in
  // the viewport — `dragRect` uses the visible overlay box, so any
  // zoom that overflows the image-box would put parts of the
  // overlay outside the viewport. The edit is stored in percent-
  // coords and re-renders on every `setZoom`, so subsequent zoom
  // changes refresh the stroke-width without redrawing.
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.5, yPct: 0.5 },
  );

  // Map of zoom mode → expected sw (3 CSS px at 1×, scaling with
  // mode). The −0.01 epsilon means an exact integer ratio stays
  // at the integer rather than tipping `ceil()` over to integer + 1.
  const expectations: [ZoomMode, number][] = [
    [1, 3],
    [2, 6],
    [4, 12],
    [8, 24],
  ];
  for (const [mode, expected] of expectations) {
    await applyZoomMode(capturePage, mode);
    const sw = await readDrawnRectStrokeWidth(capturePage);
    expect(sw, `stroke-width at ${mode}×`).toBe(expected);
  }

  await openerPage.close();
});

test('zoom: stubbed DPR=2 puts 1× at half the natural pixel width', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  // Pretend the editor is on a 2× DPR display. With the real DPR=1
  // capture, naturalWidth equals the source-CSS width — so 1× under
  // the stub should render at half of natural.
  await stubDpr(capturePage, 2);
  await applyZoomMode(capturePage, 1);

  const m = await readImageMetrics(capturePage);
  // m.dpr is the real `window.devicePixelRatio` (the stub from
  // `defineProperty` is reflected here too because it shadows the
  // real getter on `window`). Our code reads exactly that property,
  // so the test of the algebra is honest:
  expect(m.dpr).toBe(2);
  expect(m.rendered).toBeCloseTo(m.natural / 2, 0);
  expect(await readDisplayScale(capturePage)).toBeCloseTo(1, 2);

  await openerPage.close();
});

test('zoom: stubbed DPR=1.5 keeps 1× stroke-width at 3 (epsilon regression)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  // Draw a rect we can read the stroke-width off.
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.5, yPct: 0.5 },
  );

  // 1.5 makes `naturalWidth / 1.5` fractional — the case that
  // surfaced the bug at DPR=1.359375 in real-world use. Without the
  // −0.01 epsilon, ratio = 1.0000003 → ceil(3.0000009) = 4. With it,
  // sw stays at 3.
  await stubDpr(capturePage, 1.5);
  await applyZoomMode(capturePage, 1);

  expect(await readDrawnRectStrokeWidth(capturePage)).toBe(3);

  await openerPage.close();
});

test('zoom: Fit between half- and full-size holds stroke-width at 3', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  // Draw a rect to read the stroke-width off.
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.5, yPct: 0.5 },
  );

  // Force Fit-mode shrinkage above half-size: stub DPR > 1 so
  // `targetCssSize() = naturalWidth / DPR` is *smaller* than
  // naturalWidth, but still larger than the editor viewport (the
  // Playwright fixture's natural width is bigger than the test
  // window's CSS width). DPR = 1.5 lands the Fit ratio comfortably in
  // the half-to-full window — the flat region of the piecewise
  // formula where strokes must NOT narrow (this is the regression
  // the new formula is meant to prevent — the previous
  // `ceil(3·ratio)` formula here would produce sw = 2).
  await stubDpr(capturePage, 1.5);
  await applyZoomMode(capturePage, 'fit');

  const ratio = await readDisplayScale(capturePage);
  // The exact ratio depends on the editor viewport vs naturalWidth,
  // but should land in [0.5, 1] under the standard Playwright
  // viewport / fixture sizes — the flat region of the new formula.
  // (toBeLessThanOrEqual covers the ratio = 1 cap when the Fit
  // ratio would otherwise exceed 1.)
  expect(ratio, `displayScale at Fit/DPR=1.5`).toBeGreaterThanOrEqual(0.5);
  expect(ratio, `displayScale at Fit/DPR=1.5`).toBeLessThanOrEqual(1.0001);
  // In this regime the formula's `max(3, …)` clause keeps the stroke
  // pinned to 3 — the visible behavior the user requested.
  expect(await readDrawnRectStrokeWidth(capturePage), `stroke-width at Fit/DPR=1.5`)
    .toBe(3);

  await openerPage.close();
});

test('zoom: Fit well below half-size narrows stroke-width to <3', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  // Draw a rect to read the stroke-width off.
  await dragRect(
    capturePage,
    { xPct: 0.3, yPct: 0.3 },
    { xPct: 0.5, yPct: 0.5 },
  );

  // DPR = 0.25 quadruples targetW, so the Fit ratio drops well below
  // 0.5 (the threshold where the piecewise formula first steps below
  // 3 px). The exact ratio depends on the viewport, so we assert
  // against the same piecewise rule the production code uses rather
  // than a hard-coded number — the regression we're catching is
  // "always 3" at deeply shrunken sizes, not the specific value.
  await stubDpr(capturePage, 0.25);
  await applyZoomMode(capturePage, 'fit');

  const ratio = await readDisplayScale(capturePage);
  expect(ratio, `displayScale at Fit/DPR=0.25`).toBeLessThan(0.5);
  const expected =
    ratio >= 1 ? Math.ceil(3 * ratio - 0.01)
    : ratio >= 0.5 ? 3
    : ratio >= 0.25 ? 2
    : 1;
  expect(await readDrawnRectStrokeWidth(capturePage), `stroke-width at Fit/DPR=0.25`)
    .toBe(expected);
  // And — independent of the formula — we *do* expect it to land
  // narrower than the at-1× default so the regression catches a
  // future change that re-introduces the "always 3" behavior.
  expect(expected).toBeLessThan(3);
  expect(expected).toBeGreaterThanOrEqual(1);

  await openerPage.close();
});
