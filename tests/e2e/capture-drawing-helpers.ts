// Shared helpers for the `capture-drawing-*.spec.ts` family.
//
// These read the `__seeState` debug hooks that capture-page.ts installs
// at load time, plus a couple of pure utilities (PNG colour sampling,
// edge-handle drag synthesis) that several drawing specs reach for.
//
// This module is intentionally *not* a `.spec.ts` so Playwright's test
// discovery doesn't pick it up. Each drawing spec imports just what
// it needs.

import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { expect } from '../fixtures/extension';

// Sample the drawn-rect's red stroke around x≈20%, y≈30% of the PNG
// and assert at least one pixel along that horizontal band is red
// (high R, low G/B). Scans a small ±3 px window because the stroke
// is only 3 px wide and the rectangle's left edge at exactly x=20%
// can land sub-pixel — a single Math.round'd sample can land on the
// stroke's antialiased fringe instead of its fully-saturated center.
// Shared between the palette Save / Copy tests since both round-trip
// the same edited PNG bytes.
export function expectRedAtRectEdge(buf: Buffer): void {
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

// Read the current effective crop bounds (or null when no crop is
// effective) straight out of the Capture page. Relies on the
// `__seeState` hook capture-page.ts installs at load time.
export async function readEffectiveCrop(
  capturePage: Page,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return capturePage.evaluate(() =>
    (window as unknown as { __seeState: { effectiveCrop: () => unknown } }).__seeState.effectiveCrop() as
      | { x: number; y: number; w: number; h: number }
      | null,
  );
}

export async function readEditKinds(capturePage: Page): Promise<string[]> {
  return capturePage.evaluate(() =>
    (window as unknown as { __seeState: { editKinds: () => string[] } }).__seeState.editKinds(),
  );
}

// Read the most-recent edit of the given kind's bounds, or null when
// no such edit exists. Mirrors `__seeState.lastRectBounds`.
export async function readLastBounds(
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
export async function dragEdge(
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

// Read the previewImg's viewport-coord bounding box plus its
// natural (intrinsic) size so the arrow-key tests can convert
// between CSS-pixel mouse moves, percent-space stored bounds, and
// natural-pixel saved-output deltas. Mirrors the `imgRect()` /
// `previewImg.naturalWidth` reads the in-page handler does.
export async function readPreviewRect(
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

// Read every committed line/arrow edit's geometry in commit order.
// Mirrors `__seeState.allLineBounds` and lets the polyline tests
// assert that segments chain endpoint-to-endpoint.
export async function readAllLines(
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

// Read the chain-start anchor (mirror of `__seeState.polylineChainStart`)
// for tests that want to verify the loop-close target.
export async function readPolylineChainStart(
  capturePage: Page,
): Promise<{ x: number; y: number } | null> {
  return capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineChainStart: () => { x: number; y: number } | null };
    }).__seeState.polylineChainStart(),
  );
}
