// One-shot generator for the error-state action icons.
//
// Produces `src/icons/icon-error-{16,48,128}.png` by reading the base
// icon at each size and painting a solid red rounded-rect "badge" in
// the bottom-right corner with a white `!` centered inside it. The
// badge occupies a box of (size/2) × (size/2) pixels by default
// (see `paintErrorBadge`'s `scale` parameter — production uses
// scale=2 on a base of size/4, so the badge side is size/2).
//
// This is NOT run on every build — the error icons are committed to
// `src/icons/` alongside the base icons and picked up by the regular
// recursive copy in `scripts/build.mjs`. Re-run this only when the
// base icons change or when you want to tweak the badge.
//
//   node scripts/generate-error-icons.mjs
//
// The sizing + placement constants are deliberately kept in code so
// that tweaking the mark (size, position, color) is a one-line edit,
// rather than the usual "go open Photoshop and hand-paint each size"
// workflow. All three sizes share the same formulas.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(__dirname, '..', 'src', 'icons');

const SIZES = [16, 48, 128];

// Badge fill color — a saturated red that stays readable on a
// white-ish browser toolbar and on the dark body of the base camera
// icon. Slightly brighter than pure #c00 so the solid fill pops.
const BADGE_R = 220;
const BADGE_G = 38;
const BADGE_B = 38;

// Glyph color — pure white for maximum contrast with the red fill.
const GLYPH_R = 255;
const GLYPH_G = 255;
const GLYPH_B = 255;

/**
 * Paint a solid red rounded-rect badge with a centered white `!` in
 * the bottom-right corner of `png`. The badge box is `size/4` on a
 * side with a small margin from the icon edge.
 *
 * The rounded-rect is rendered by a pixel-inside test: every pixel
 * in the badge's bounding box is either inside the rounded shape
 * (filled red) or outside it (left alone). No anti-aliasing — pngjs
 * is raw RGBA and at these sizes jagged edges aren't visible.
 *
 * The white `!` inside the badge is laid out as a vertical stem
 * plus a square dot, both horizontally centered in the badge box,
 * with the whole glyph vertically centered. Stem width scales with
 * the badge size (~18%) so the glyph stays readable at 16px.
 */
function paintErrorBadge(png, size, scale = 2) {
  // `scale` is a multiplier on a base badge side length of size/4.
  // The production default is scale=2 (so the badge is size/2 on a
  // side — half the icon, picked by eye from the `--variants`
  // preview grid in tmp/icon-size-variants/). scale=1 reproduces the
  // original too-small look; the `--variants` mode sweeps from 1.0
  // up to 2.5 to preview other sizes at 16px.
  const badge = Math.min(size, Math.max(1, Math.floor((size / 4) * scale)));
  // Tiny inset from the bottom-right corner so the badge isn't
  // flush against the icon edge. Scales with size so a 128px icon
  // gets a 2px inset and a 16px icon still gets 1px.
  const margin = Math.max(1, Math.floor(size / 64));

  const boxX = size - badge - margin;
  const boxY = size - badge - margin;
  // Corner radius ≈ 20% of badge side. `Math.min` so we can never
  // produce a radius so large it inverts the rounded-rect test at
  // very small sizes.
  const radius = Math.min(Math.floor(badge / 2), Math.max(0, Math.round(badge * 0.2)));

  // Glyph geometry, all in terms of the badge side so a single tweak
  // to `badge` rescales everything.
  const stemW = Math.max(1, Math.round(badge * 0.18));
  const stemH = Math.max(2, Math.round(badge * 0.5));
  const gap = Math.max(1, Math.round(badge * 0.08));
  // Square dot; same width as the stem keeps the glyph proportions
  // consistent across sizes.
  const dotSide = stemW;
  const glyphH = stemH + gap + dotSide;

  const stemX = boxX + Math.round((badge - stemW) / 2);
  const stemY = boxY + Math.round((badge - glyphH) / 2);
  const dotX = boxX + Math.round((badge - dotSide) / 2);
  const dotY = stemY + stemH + gap;

  const setPixel = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const idx = (y * size + x) * 4;
    png.data[idx] = r;
    png.data[idx + 1] = g;
    png.data[idx + 2] = b;
    png.data[idx + 3] = 255;
  };

  const fillRect = (x, y, w, h, r, g, b) => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        setPixel(x + dx, y + dy, r, g, b);
      }
    }
  };

  // Rounded-rect inside test. A pixel (px, py) that falls inside one
  // of the four "corner squares" of side `radius` must also lie
  // inside the inscribed quarter-circle; pixels in the middle rows
  // / middle columns are always inside. Using `badge - 1` as the
  // far edge because we're doing a closed-interval test on integer
  // pixel indices.
  const insideRoundedRect = (px, py) => {
    const localX = px - boxX;
    const localY = py - boxY;
    if (localX < 0 || localY < 0 || localX >= badge || localY >= badge) return false;
    if (radius === 0) return true;
    // Find the nearest corner center. For pixels outside the
    // corner-square regions, `dx` / `dy` will be <= 0 and the
    // Pythagorean test trivially passes.
    const cxLeft = radius;
    const cxRight = badge - 1 - radius;
    const cyTop = radius;
    const cyBottom = badge - 1 - radius;
    let dx = 0;
    let dy = 0;
    if (localX < cxLeft) dx = cxLeft - localX;
    else if (localX > cxRight) dx = localX - cxRight;
    if (localY < cyTop) dy = cyTop - localY;
    else if (localY > cyBottom) dy = localY - cyBottom;
    return dx * dx + dy * dy <= radius * radius;
  };

  // Fill the rounded-rect badge in solid red.
  for (let py = boxY; py < boxY + badge; py++) {
    for (let px = boxX; px < boxX + badge; px++) {
      if (insideRoundedRect(px, py)) {
        setPixel(px, py, BADGE_R, BADGE_G, BADGE_B);
      }
    }
  }

  // White `!` on top of the red fill.
  fillRect(stemX, stemY, stemW, stemH, GLYPH_R, GLYPH_G, GLYPH_B);
  fillRect(dotX, dotY, dotSide, dotSide, GLYPH_R, GLYPH_G, GLYPH_B);
}

/**
 * Read `icon-${size}.png` from the source icons dir as a fresh PNG
 * object we can scribble on. Returns a new object each call so the
 * caller can paint without affecting later reads.
 */
function readBaseIcon(size) {
  const inputPath = path.join(iconsDir, `icon-${size}.png`);
  const buf = fs.readFileSync(inputPath);
  const png = PNG.sync.read(buf);
  if (png.width !== size || png.height !== size) {
    throw new Error(
      `${inputPath}: expected ${size}x${size}, got ${png.width}x${png.height}`,
    );
  }
  return png;
}

const variantsMode = process.argv.includes('--variants');

if (variantsMode) {
  // Experiment mode: write a grid of icon-16 variants at badge
  // scales 1.0x through 2.5x (step 0.1), so the final badge size
  // can be chosen by eye. Output goes to tmp/ to keep the
  // production icons dir clean — these files are throwaway.
  const outDir = path.resolve(__dirname, '..', 'tmp', 'icon-size-variants');
  fs.mkdirSync(outDir, { recursive: true });

  // Loop in integer tenths to avoid the usual float-accumulation
  // ugliness (1.0, 1.1, 1.20000000001, ...).
  for (let tenth = 10; tenth <= 25; tenth++) {
    const scale = tenth / 10;
    const png = readBaseIcon(16);
    paintErrorBadge(png, 16, scale);
    const name = `icon-${scale.toFixed(1)}x-16.png`;
    const outPath = path.join(outDir, name);
    fs.writeFileSync(outPath, PNG.sync.write(png));
    console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  }
} else {
  // Production mode: rewrite the committed error icon variants in
  // src/icons/ from the current base icons at the default scale
  // (see `paintErrorBadge`; currently scale=2 so the badge side
  // length is size/2).
  for (const size of SIZES) {
    const outputPath = path.join(iconsDir, `icon-error-${size}.png`);
    const png = readBaseIcon(size);
    paintErrorBadge(png, size);
    fs.writeFileSync(outputPath, PNG.sync.write(png));
    console.log(`wrote ${path.relative(process.cwd(), outputPath)}`);
  }
}
