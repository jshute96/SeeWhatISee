// Unit tests for `src/shrink.ts` — the Shrink-tool image operator
// that tightens a rectangle around its content.
//
// Runs under `node --test`. The `pretest:unit` script builds
// `dist/` first, so `npm run test:unit` is enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shrink } from '../../dist/shrink.js';

// ---------------------------------------------------------------
// Test image construction.
//
// Every test builds a small RGBA image with `makeImage(w, h, fn)`,
// where `fn(x, y)` returns a 4-tuple `[r, g, b, a]`. Helpers below
// produce common patterns (solid bg, bg with one inner content
// rect, h-line, v-line, vertical/horizontal gradient).
// ---------------------------------------------------------------

function makeImage(width, height, pixelFn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

const BG = [240, 240, 240, 255];
const FG = [20, 20, 20, 255];

// `inside` is half-open: [x0, x1) × [y0, y1).
function withRect({ width, height, bg = BG, fg = FG, x0, y0, x1, y1 }) {
  return makeImage(width, height, (x, y) => (
    x >= x0 && x < x1 && y >= y0 && y < y1 ? fg : bg
  ));
}

test('shrink wraps a content rect tightly when starting from a coarse box', () => {
  // 20×20 bg with a 4×3 fg block at (8..12, 6..9).
  const img = withRect({
    width: 20, height: 20,
    x0: 8, y0: 6, x1: 12, y1: 9,
  });
  const out = shrink(img, { x: 2, y: 2, w: 16, h: 16 });
  assert.deepEqual(out, { x: 8, y: 6, w: 4, h: 3 });
});

test('shrink wraps a content rect when starting from the full image', () => {
  const img = withRect({
    width: 20, height: 20,
    x0: 8, y0: 6, x1: 12, y1: 9,
  });
  const out = shrink(img, { x: 0, y: 0, w: 20, h: 20 });
  assert.deepEqual(out, { x: 8, y: 6, w: 4, h: 3 });
});

test('shrink returns null when the box is entirely solid (nothing to wrap)', () => {
  const img = makeImage(10, 10, () => BG);
  const out = shrink(img, { x: 1, y: 1, w: 8, h: 8 });
  assert.equal(out, null);
});

test('shrink can shrink left/right past a horizontal line that crosses the box', () => {
  // Horizontal red bar at rows 4..5, but only across columns 5..14.
  // Top/bottom can shrink in to bracket the bar; left/right can
  // shrink because both sides of the bar are bg, so columns
  // outside the bar match each other vertically.
  const img = makeImage(20, 10, (x, y) => (
    y >= 4 && y < 6 && x >= 5 && x < 15 ? [200, 0, 0, 255] : BG
  ));
  const out = shrink(img, { x: 0, y: 0, w: 20, h: 10 });
  assert.deepEqual(out, { x: 5, y: 4, w: 10, h: 2 });
});

test('shrink handles a vertical gradient — left/right collapse, top/bottom hold', () => {
  // Each row is a slightly different shade (5 per row). Within the
  // bg region columns are identical (each column shows the same
  // vertical gradient), so left/right can shrink. Adjacent rows
  // differ by 5 (> default tol of 3), so top/bottom never advance.
  // A small content rect at (4..7, 4..6) breaks both vertical and
  // horizontal uniformity at its location.
  const img = makeImage(12, 10, (x, y) => {
    const inContent = x >= 4 && x < 7 && y >= 4 && y < 6;
    if (inContent) return [255, 0, 0, 255];
    const v = 50 + y * 5;
    return [v, v, v, 255];
  });
  const out = shrink(img, { x: 0, y: 0, w: 12, h: 10 });
  // Top/bottom held at full extent (gradient defeats vertical shrink);
  // left/right tightened around the content's x-extent.
  assert.deepEqual(out, { x: 4, y: 0, w: 3, h: 10 });
});

test('shrink absorbs small per-channel noise within the tolerance', () => {
  // Bg has a 2-unit value swing between alternating rows / cols —
  // each adjacent pair stays within the default tolerance of 3, so
  // every snapshot-vs-line comparison passes and the algorithm
  // shrinks past the noisy bg to the solid red content.
  const img = makeImage(14, 14, (x, y) => {
    if (x >= 6 && x < 8 && y >= 6 && y < 8) return [255, 0, 0, 255];
    const v = 128 + ((x + y) % 2 === 0 ? 0 : 2);
    return [v, v, v, 255];
  });
  const out = shrink(img, { x: 0, y: 0, w: 14, h: 14 });
  assert.deepEqual(out, { x: 6, y: 6, w: 2, h: 2 });
});

test('shrink with tolerance 0 rejects matches that the default would accept', () => {
  // Bg is alternating exact 100 / 102 stripes — adjacent rows
  // differ by 2. Default tolerance (3) accepts → top/bottom can
  // shrink. Tolerance 0 rejects → top/bottom stay put.
  const img = makeImage(8, 8, (_x, y) => {
    const v = (y % 2 === 0) ? 100 : 102;
    return [v, v, v, 255];
  });
  const tight = shrink(img, { x: 0, y: 0, w: 8, h: 8 });
  // Default tol=3: rows 0 and 1 match, rows 1 and 2 match, etc.,
  // entire image is uniform — collapses to null.
  assert.equal(tight, null);
  const strict = shrink(img, { x: 0, y: 0, w: 8, h: 8 }, { tolerance: 0 });
  // tol=0: adjacent rows differ → no top/bottom shrink.
  // Adjacent columns are equal → left/right would shrink fully and
  // collapse, returning null (no content to wrap).
  assert.equal(strict, null);
});

test('shrink is a no-op when the rect already tightly bounds patterned content', () => {
  // Patterned content (checkerboard) inside a bg field. With the
  // rect already flush to the content's edges, the snapshot rows
  // (the content's outermost rows) don't match any neighbour, so
  // no edge advances — a no-op return.
  const img = makeImage(20, 20, (x, y) => {
    if (x >= 5 && x < 12 && y >= 5 && y < 11) {
      return ((x + y) % 2 === 0) ? [255, 0, 0, 255] : [0, 0, 255, 255];
    }
    return BG;
  });
  const out = shrink(img, { x: 5, y: 5, w: 7, h: 6 });
  assert.deepEqual(out, { x: 5, y: 5, w: 7, h: 6 });
});

test('shrink clamps a starting rect that pokes past the image edge', () => {
  // Content sits well inside the image so the snapshot rows /
  // columns are real bg; user "drew" the rect way past the image
  // edges. shrink should clamp and tighten to the content.
  const img = withRect({
    width: 12, height: 12,
    x0: 2, y0: 2, x1: 7, y1: 6,
  });
  const out = shrink(img, { x: -3, y: -3, w: 30, h: 30 });
  assert.deepEqual(out, { x: 2, y: 2, w: 5, h: 4 });
});

test('shrink returns null when the starting rect lives entirely inside a uniform area', () => {
  // Box drawn entirely inside a solid colour patch — no edges to
  // bracket, algorithm collapses.
  const img = withRect({
    width: 30, height: 30,
    x0: 5, y0: 5, x1: 25, y1: 25,
  });
  // Box from (10..20, 10..20): all FG inside, nothing to wrap.
  const out = shrink(img, { x: 10, y: 10, w: 10, h: 10 });
  assert.equal(out, null);
});

test('shrink iterates multi-pass — perpendicular narrowing unblocks an axis the first pass could not shrink', () => {
  // 12×12 grey bg with two pieces of content:
  //   - A 3×3 black block at cols 4–6, rows 5–7.
  //   - A single isolated black pixel at (10, 3).
  //
  // The isolated pixel makes col 10 non-uniform within the
  // initial y-range [0, 12) — so on pass 1 the *right* edge is
  // blocked (col 10 differs from col 11 across the full range)
  // and the *top* edge is blocked at row 3 (the isolated pixel
  // sits in row 3). Pass 1 still narrows y down to [3, 8) and x
  // to [4, 12).
  //
  // On pass 2 the perpendicular range for the right edge is now
  // [3, 8) — but col 10 is uniform within [4, 8), so the
  // top-edge re-pass also advances past the isolated pixel's
  // row, and once both top and right re-tighten the algorithm
  // settles on the 3×3 block exactly. Without the outer loop the
  // result would still include the isolated pixel's row and
  // would extend to the image's right edge.
  const img = makeImage(12, 12, (x, y) => {
    if (x >= 4 && x < 7 && y >= 5 && y < 8) return [0, 0, 0, 255];
    if (x === 10 && y === 3) return [0, 0, 0, 255];
    return BG;
  });
  const out = shrink(img, { x: 0, y: 0, w: 12, h: 12 });
  assert.deepEqual(out, { x: 4, y: 5, w: 3, h: 3 });
});

test('shrink wraps content with non-uniform interior (real-world icon-ish)', () => {
  // A patterned 4×4 content block (diagonal stripes) sitting in a
  // larger bg. The inside is intentionally non-uniform — shrink
  // should still find the outer bounds because the rows/cols
  // *outside* the block remain uniform.
  const img = makeImage(20, 20, (x, y) => {
    if (x >= 6 && x < 10 && y >= 5 && y < 9) {
      return ((x + y) % 2 === 0) ? [255, 0, 0, 255] : [0, 0, 255, 255];
    }
    return BG;
  });
  const out = shrink(img, { x: 1, y: 1, w: 18, h: 18 });
  assert.deepEqual(out, { x: 6, y: 5, w: 4, h: 4 });
});
