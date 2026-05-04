// Shrink: tighten a rectangle around its content.
//
// Given an RGBA pixel buffer and a starting rectangle, walk each of
// the four edges inward as long as the line one step deeper in still
// matches the *original* edge line (sliced to the current
// perpendicular range). The original edges are taken as the
// reference for "background" — comparing every candidate line
// against the original snapshot means the algorithm doesn't slide
// past the far side of the content into a now-uniform interior
// strip, which is what an iterative "compare to neighbour" rule
// does once the perpendicular range narrows onto solid content.
//
// The returned rect tightly bounds the *content*: each edge sits on
// the first row/column whose pixels differ from the snapshot, so a
// crop produces an image with no extra border and a redaction
// covers the object with no leakage. Callers that want a one-pixel
// margin (e.g. a Box stroke that should stand just outside the
// wrapped object) expand the result by 1 themselves.
//
// Pure module: no DOM, no Image, no Canvas. The capture page wraps
// a rendered image into ImageData via a temporary canvas before
// calling. Tests build synthetic ImageData-shaped objects directly.

export interface PixelBuffer {
  width: number;
  height: number;
  // RGBA, 4 bytes/pixel, row-major (matches CanvasRenderingContext2D
  // ImageData / `getImageData(...).data`).
  data: Uint8ClampedArray | Uint8Array;
}

export interface Rect {
  // Pixel coordinates within the buffer. Half-open on the right /
  // bottom: the rect spans [x, x + w) × [y, y + h). x and y must be
  // ≥ 0 and (x + w) ≤ width, (y + h) ≤ height.
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShrinkOptions {
  // Maximum per-channel absolute difference (0–255) for two pixels
  // to count as "the same". 2–3 absorbs JPEG noise + light
  // anti-aliasing; 0 is exact match.
  tolerance?: number;
}

const DEFAULT_TOLERANCE = 3;

// Compare two pixels (4 bytes each) at the given byte offsets.
// Returns true iff every channel differs by ≤ tol. Alpha is
// included so a fully-transparent edge against opaque content still
// shows as different.
function pixelsMatch(
  data: PixelBuffer['data'],
  aIdx: number,
  bIdx: number,
  tol: number,
): boolean {
  // Inlined per-channel compare — runs O(perimeter × shrink-depth)
  // times in the worst case, so per-call overhead matters.
  if (Math.abs(data[aIdx]! - data[bIdx]!) > tol) return false;
  if (Math.abs(data[aIdx + 1]! - data[bIdx + 1]!) > tol) return false;
  if (Math.abs(data[aIdx + 2]! - data[bIdx + 2]!) > tol) return false;
  if (Math.abs(data[aIdx + 3]! - data[bIdx + 3]!) > tol) return false;
  return true;
}

// Compare row yA to row yB across columns [x0, x1). yA == yB short-
// circuits to true (a row trivially equals itself).
function rowsEqual(
  buf: PixelBuffer,
  yA: number,
  yB: number,
  x0: number,
  x1: number,
  tol: number,
): boolean {
  if (yA === yB) return true;
  const stride = buf.width * 4;
  const aBase = yA * stride;
  const bBase = yB * stride;
  for (let x = x0; x < x1; x++) {
    if (!pixelsMatch(buf.data, aBase + x * 4, bBase + x * 4, tol)) return false;
  }
  return true;
}

// Compare column xA to column xB across rows [y0, y1).
function colsEqual(
  buf: PixelBuffer,
  xA: number,
  xB: number,
  y0: number,
  y1: number,
  tol: number,
): boolean {
  if (xA === xB) return true;
  const stride = buf.width * 4;
  for (let y = y0; y < y1; y++) {
    const base = y * stride;
    if (!pixelsMatch(buf.data, base + xA * 4, base + xB * 4, tol)) return false;
  }
  return true;
}

// Tighten the rectangle around its content. Returns the tightened
// rect, or `null` if any dimension would collapse before the
// algorithm settles (signals "no content found inside" — typically
// because the starting rect was entirely inside a uniform area, or
// the starting edges weren't on the content's outside).
//
// The starting rect is clamped to the buffer first; coordinates
// outside the buffer are dropped. A caller passing `(0, 0, W, H)`
// (the full image) gets the natural "trim solid borders" behaviour.
export function shrink(
  buf: PixelBuffer,
  rect: Rect,
  opts: ShrinkOptions = {},
): Rect | null {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const { width: W, height: H } = buf;

  // Clamp to the buffer so a "full image" caller can pass
  // (0, 0, W, H) without worrying about off-by-ones.
  let x0 = Math.max(0, Math.floor(rect.x));
  let y0 = Math.max(0, Math.floor(rect.y));
  let x1 = Math.min(W, Math.ceil(rect.x + rect.w));
  let y1 = Math.min(H, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return null;

  // Snapshot the four original edge indices. Every shrink step
  // compares the candidate "next line in" against the corresponding
  // original edge line (sliced to the *current* perpendicular
  // range). Using the original — not the previous step or the
  // previous-pass edge — keeps the algorithm anchored to "what bg
  // looked like" instead of drifting onto the interior of solid
  // content once the perpendicular range narrows.
  const topOrig = y0;
  const botOrig = y1 - 1;
  const leftOrig = x0;
  const rightOrig = x1 - 1;

  // Each edge loop uses look-ahead semantics: advance the edge iff
  // the line *one step inward* still matches the original edge.
  // That way a gradient (where every row differs from the snapshot,
  // including the line right next to the edge) leaves the edge in
  // place — no spurious one-pixel shrink. After the loop, if we
  // walked at all, step one further so the edge lands on the first
  // content line (tight-on-object semantics).
  //
  // Iterate until a full pass moves nothing — perpendicular
  // shrinking on pass N can narrow the range enough that an edge
  // that couldn't shrink on pass N-1 (because some lone content
  // pixel sat in the original perpendicular range) now can.
  while (true) {
    let moved = false;

    // Top.
    {
      const start = y0;
      while (y0 + 1 < y1 && rowsEqual(buf, topOrig, y0 + 1, x0, x1, tol)) y0++;
      if (y0 !== start) {
        // Loop walked through bg-like rows. y0 is now the last
        // bg-like row; y0 + 1 is the first row that doesn't match
        // the snapshot — i.e. the first content row.
        if (y0 + 1 >= y1) return null; // entire range was bg-like
        y0++;
        moved = true;
      }
    }

    // Bottom (mirror of Top).
    {
      const start = y1;
      while (y1 - 1 > y0 && rowsEqual(buf, botOrig, y1 - 2, x0, x1, tol)) y1--;
      if (y1 !== start) {
        if (y1 - 1 <= y0) return null;
        y1--;
        moved = true;
      }
    }

    // Left.
    {
      const start = x0;
      while (x0 + 1 < x1 && colsEqual(buf, leftOrig, x0 + 1, y0, y1, tol)) x0++;
      if (x0 !== start) {
        if (x0 + 1 >= x1) return null;
        x0++;
        moved = true;
      }
    }

    // Right.
    {
      const start = x1;
      while (x1 - 1 > x0 && colsEqual(buf, rightOrig, x1 - 2, y0, y1, tol)) x1--;
      if (x1 !== start) {
        if (x1 - 1 <= x0) return null;
        x1--;
        moved = true;
      }
    }

    if (!moved) break;
  }

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
