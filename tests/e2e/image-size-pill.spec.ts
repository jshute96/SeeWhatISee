// E2E coverage for the Capture-page Image-size pill —
// `#image-size-badge`. The pill reads
// "<FORMAT> · <W>×<H> · <size>" and is supposed to track the bytes
// that *would* be saved right now. Three behaviors covered here:
//
//   1. Pill text matches the bytes / dimensions that actually land
//      on disk after Save (PNG capture, no edits).
//   2. Drawing on a JPG-source capture keeps the label as JPG
//      (sticky format) and on a WEBP-source capture flips the label
//      to PNG (non-PNG/JPG sources re-encode); in both cases the
//      post-bake dimensions and bytes still agree with the saved file.
//   3. Dimensions update *live* while the user is drawing a crop
//      box with the Crop tool — before mouseup commits — so the
//      readout works as a selection-size preview.

import fs from 'node:fs';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import {
  configureAndCapture,
  dragRect,
  findCapturedDownload,
  openDetailsFlow,
  openImageDetailsFlow,
} from './details-helpers';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Mirrors the cushion in capture-drawing.spec.ts so neighboring
// captures don't trip the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// Pill text shape: `${LABEL} · ${W}×${H} · ${formatBytes(bytes)}`.
// `formatBytes` emits `123 B`, `1.5 KB`, or `12 MB` (1 decimal under
// 10, integer otherwise). Captured as named groups so each test can
// assert on whatever subset matters.
const PILL_RE = /^(?<label>PNG|JPG|WEBP|GIF) · (?<w>\d+)×(?<h>\d+) · (?<size>\d+(?:\.\d)? (?:B|KB|MB|GB|TB))$/;

interface ParsedPill {
  label: string;
  width: number;
  height: number;
  size: string;
}

async function readImagePill(page: Page): Promise<ParsedPill> {
  const text = await page.locator('#image-size-badge').innerText();
  const m = PILL_RE.exec(text);
  if (!m || !m.groups) {
    throw new Error(`Unexpected #image-size-badge text: ${JSON.stringify(text)}`);
  }
  return {
    label: m.groups.label!,
    width: Number(m.groups.w),
    height: Number(m.groups.h),
    size: m.groups.size!,
  };
}

// Mirror of capture-page.ts's `formatBytes` so a saved file's
// byte count can be compared against the pill's `size` portion.
// Tiny enough to keep inline (vs. the ceremony of importing TS
// from src/ into a Playwright test).
// **Must stay in sync with `formatBytes` in src/capture-page.ts.**
// If a future change tweaks the source formatter (precision
// threshold, binary vs. SI prefixes, etc.), update this mirror in
// the same change — otherwise these tests will silently start
// asserting the *old* format.
function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const formatted = v < 10 ? v.toFixed(1) : Math.round(v).toString();
  return formatted + ' ' + units[i];
}

// ─── 1. PNG capture: pill matches the saved bytes / dims ──────────

test('image pill: PNG capture shows format + dims + size matching the saved file', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Pill renders once previewImg has decoded — `applyZoom` runs on
  // the load event and triggers `render() → composeImageBadgeText`.
  // Wait for the dimension portion to appear (the cache key is keyed
  // on naturalWidth, so the pill briefly reads "PNG · X KB" with no
  // dims before the load fires).
  await expect(capturePage.locator('#image-size-badge')).toBeVisible();
  await expect(capturePage.locator('#image-size-badge')).toHaveText(PILL_RE);
  const pill = await readImagePill(capturePage);
  expect(pill.label).toBe('PNG');
  expect(pill.width).toBeGreaterThan(0);
  expect(pill.height).toBeGreaterThan(0);

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const pngPath = await findCapturedDownload(sw, '.png');
  const buf = fs.readFileSync(pngPath);
  const png = PNG.sync.read(buf);

  // Dimensions: pill exactly matches the saved PNG. Routed through
  // pctRectToPixels in both the pill and the bake, so even partial-
  // pixel crop fractions don't drift between display and disk.
  expect(png.width).toBe(pill.width);
  expect(png.height).toBe(pill.height);

  // Bytes: pill's formatted size matches the saved file's bytes
  // run through the same formatter. No-edit path short-circuits
  // renderHighlightedPng to previewImg.src verbatim, so the disk
  // bytes are byte-identical to what the pill measured.
  expect(formatBytes(buf.length)).toBe(pill.size);

  await openerPage.close();
});

// ─── 2a. JPG source stays JPG across a bake (sticky format) ──────

test('image pill: JPG-source capture stays JPG after a draw, and matches the saved file', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
    undefined,
    undefined,
    '#http-jpeg', // 200×200 JPEG served with image/jpeg.
  );

  await expect(capturePage.locator('#image-size-badge')).toHaveText(PILL_RE);
  const before = await readImagePill(capturePage);
  expect(before.label).toBe('JPG');
  expect(before.width).toBe(200);
  expect(before.height).toBe(200);

  // Draw a Box highlight. The bake re-encodes as JPEG (sticky
  // output format) — pill label stays `JPG`. Bytes still change
  // because the re-encode is a different JPEG than the original.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });

  await expect(capturePage.locator('#image-size-badge')).toHaveText(/^JPG ·/);
  const after = await readImagePill(capturePage);
  expect(after.label).toBe('JPG');
  expect(after.width).toBe(200);
  expect(after.height).toBe(200);

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const jpgPath = await findCapturedDownload(sw, '.jpg');
  const buf = fs.readFileSync(jpgPath);
  // No JPEG decode helper handy — assert the saved size matches
  // the pill, which is enough to prove the pill tracked the bytes.
  expect(formatBytes(buf.length)).toBe(after.size);
  // And the bytes are real JPEG (`FF D8 FF`).
  expect(buf[0]).toBe(0xff);
  expect(buf[1]).toBe(0xd8);
  expect(buf[2]).toBe(0xff);

  await openerPage.close();
});

// ─── 2b. WEBP → PNG flip after a bake (non-PNG/JPG source) ───────

test('image pill: WEBP-source capture flips to PNG after a draw, and matches the saved file', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openImageDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'red-image.html',
    undefined,
    undefined,
    '#http-webp', // 200×200 WEBP served with image/webp.
  );

  await expect(capturePage.locator('#image-size-badge')).toHaveText(PILL_RE);
  const before = await readImagePill(capturePage);
  expect(before.label).toBe('WEBP');
  expect(before.width).toBe(200);
  expect(before.height).toBe(200);

  // Draw a Box highlight. Bakes the canvas as PNG (WEBP is not in
  // the sticky-format allow-list), so the pill's label flips.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.7, yPct: 0.7 });

  await expect(capturePage.locator('#image-size-badge')).toHaveText(/^PNG ·/);
  const after = await readImagePill(capturePage);
  expect(after.label).toBe('PNG');
  expect(after.width).toBe(200);
  expect(after.height).toBe(200);

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const pngPath = await findCapturedDownload(sw, '.png');
  const buf = fs.readFileSync(pngPath);
  const png = PNG.sync.read(buf);
  expect(png.width).toBe(after.width);
  expect(png.height).toBe(after.height);
  expect(formatBytes(buf.length)).toBe(after.size);

  await openerPage.close();
});

// ─── 3. Live dimension preview while drawing a crop ───────────────

test('image pill: dimensions update live while drawing a Crop-tool box', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Capture the pre-draw dims so we can confirm the in-flight
  // numbers actually changed (the test would silently pass if both
  // happened to read the same value).
  await expect(capturePage.locator('#image-size-badge')).toHaveText(PILL_RE);
  const initial = await readImagePill(capturePage);

  await capturePage.locator('#tool-crop').click();

  // Tap into `#preview` (not `#overlay`) to mirror the page's own
  // `imgRect()` reference frame — `composeImageBadgeText` projects
  // drag positions through `previewImg.getBoundingClientRect()`.
  const box = await capturePage.locator('#preview').boundingBox();
  if (!box) throw new Error('preview has no bounding box');

  // Helper to locate a (xPct, yPct) on the preview in absolute
  // viewport coords. Same convention as `dragRect`.
  const at = (xPct: number, yPct: number): { x: number; y: number } => ({
    x: box.x + box.width * xPct,
    y: box.y + box.height * yPct,
  });

  const start = at(0.2, 0.2);
  const mid = at(0.4, 0.4);
  const end = at(0.6, 0.6);

  await capturePage.mouse.move(start.x, start.y);
  await capturePage.mouse.down();
  // First mousemove establishes the drag — `dragStart`/`dragCurrent`
  // are now both set, so `liveCropDimensions` returns a non-null
  // rectangle and `composeImageBadgeText` swaps the pill's dims to
  // the in-flight crop size.
  await capturePage.mouse.move(mid.x, mid.y);
  await expect(capturePage.locator('#image-size-badge')).toHaveText(PILL_RE);
  const atMid = await readImagePill(capturePage);
  // 20%×20% of the natural image; allow a 1px slack on each axis
  // for sub-pixel rounding (round-then-subtract via pctRectToPixels).
  expect(atMid.width).toBeGreaterThanOrEqual(Math.round(initial.width * 0.2) - 1);
  expect(atMid.width).toBeLessThanOrEqual(Math.round(initial.width * 0.2) + 1);
  expect(atMid.height).toBeGreaterThanOrEqual(Math.round(initial.height * 0.2) - 1);
  expect(atMid.height).toBeLessThanOrEqual(Math.round(initial.height * 0.2) + 1);

  // Move further. The dims should grow with the rectangle — this is
  // what fails if the cache check in updateImageSizeBadge isn't
  // bypassed by the per-render composeImageBadgeText pass.
  await capturePage.mouse.move(end.x, end.y);
  await expect(capturePage.locator('#image-size-badge')).not.toHaveText(
    `${atMid.label} · ${atMid.width}×${atMid.height} · ${atMid.size}`,
  );
  const atEnd = await readImagePill(capturePage);
  expect(atEnd.width).toBeGreaterThan(atMid.width);
  expect(atEnd.height).toBeGreaterThan(atMid.height);

  // Commit. After mouseup, editVersion bumps; updateImageSizeBadge
  // does a full re-eval (now with `activeCrop()` returning the
  // committed crop). Dimensions stay at the same value the live
  // preview last showed — the user's eyes track the same number
  // they just released on.
  await capturePage.mouse.up();
  await expect(capturePage.locator('#image-size-badge')).toHaveText(PILL_RE);
  const committed = await readImagePill(capturePage);
  expect(committed.width).toBe(atEnd.width);
  expect(committed.height).toBe(atEnd.height);

  // And the saved file matches the committed pill — closes the
  // loop end-to-end (live → commit → disk).
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const pngPath = await findCapturedDownload(sw, '.png');
  const buf = fs.readFileSync(pngPath);
  const png = PNG.sync.read(buf);
  expect(png.width).toBe(committed.width);
  expect(png.height).toBe(committed.height);
  expect(formatBytes(buf.length)).toBe(committed.size);

  await openerPage.close();
});
