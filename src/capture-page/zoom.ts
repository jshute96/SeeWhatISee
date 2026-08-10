// Image fit / Zoom / Pan for the Capture page. `initZoom(ctx)`
// wires the zoom dropdown, Ctrl+wheel and Alt+± stepping, the
// middle-click + Ctrl-left pan, and the window resize / image-load
// re-fit hooks. Also owns the `lastMousePos` cache that drawing's
// arrow-key nudge reads and writes, and `naturalPixelStep()` — the
// one-output-pixel step both arrow-key paths (drawing's nudge and
// the fine pan) measure in.
//
// Two display modes:
//   - 'fit' (default) — image shrinks to the remaining viewport
//     (height-bounded by `window.innerHeight - imageBoxTop -
//     reserved`, width-bounded by `.image-box`'s flex slot).
//   - 1 / 2 / 4 / 8 — image renders at `targetCssSize() * N` CSS
//     pixels (i.e. naturalSize / DPR * N — see `targetCssSize`).
//     `.image-box` shows scrollbars when the wrap overflows. The
//     overlay scales with the image because it's `100%` of the
//     image-wrap, which sizes from the image element itself.
//
// Zoom doesn't change what gets saved (the bake renders at natural
// resolution either way) — it only controls what the user sees
// while editing.
//
// Module also owns pan (middle-click + Ctrl/Cmd-left-drag or a
// scrollbar drag, plus the one-image-pixel arrow-key nudge while one
// of those is held), the snap that parks a crop / box edit flush
// against the visible pane's edges mid-drag, and the
// cursor-position cache that the keyboard zoom + drawing's
// arrow-key nudge both read.
//
// `applyZoom()` is the single entry point for sizing: writes the
// box's max-height, the image's width / height + max-* (mode-
// dependent), and re-renders so stroke widths track the new
// display→natural ratio.

// Type-only import: erased at compile time, so it doesn't create a
// runtime dependency back on `drawing.ts` (which imports from here).
// Everything this module needs at runtime still arrives via
// `ZoomContext`.
import type { RectPct } from './drawing.js';

export type ZoomMode = 'fit' | 1 | 2 | 4 | 8;
const ZOOM_LEVELS: ZoomMode[] = ['fit', 1, 2, 4, 8];
let zoomMode: ZoomMode = 'fit';

const ZOOM_LABELS: Record<string, string> = {
  fit: 'Fit',
  '1': '1×',
  '2': '2×',
  '4': '4×',
  '8': '8×',
};

/**
 * Everything the zoom + pan module needs from the rest of the
 * Capture page. Passed once at init time; all internal functions
 * close over `ctx`.
 */
export interface ZoomContext {
  previewImg: HTMLImageElement;
  imageBox: HTMLDivElement;
  highlightControls: HTMLDivElement;
  zoomBtn: HTMLButtonElement;

  /** Drawing module's `render()` — applyZoom calls it after sizing
   *  changes so stroke widths re-derive from the new display ratio. */
  render(): void;
  /** Drawing module's `drawViewportEdges()` — applyZoom calls it
   *  so the dashed virtual-edge SVG re-lays-out after sizing. */
  drawViewportEdges(): void;
  /** Drawing's `visibleImageRect()` — used by the polyline
   *  forgiveness helpers (isOverVisibleImage etc.). */
  visibleImageRect(): { left: number; top: number; right: number; bottom: number };
  /** Drawing's `imgRect()` — used by cursorCenteredZoomStep to read
   *  the image's current measured rect in viewport coords. */
  imgRect(): DOMRect;

  /** Drawing's polyline state and exit hook. The blur handler ends
   *  any active polyline chain alongside the pan-state reset; doing
   *  both in one listener keeps the focus-loss semantics in one
   *  place. */
  isPolylineActive(): boolean;
  endPolylineChain(): void;

  /** Drawing's `rescaleAfterImageResize()` — applyZoom calls it after
   *  the image's CSS dimensions change so in-flight drag / polyline
   *  anchors (stored in image-rect-local CSS px) move with the image
   *  instead of pointing at stale offsets. Without this, a Ctrl+wheel
   *  zoom mid-polyline would jump the previous endpoint and break the
   *  loop-close hit-test. */
  rescaleAfterImageResize(scaleX: number, scaleY: number): void;

  /** Drawing's `panSnapRects()` — the box-shaped edits a pan drag
   *  snaps the visible pane's edges to, in image-percent coords. */
  panSnapRects(): RectPct[];
  /** Drawing's `SNAP_PX` — the same "close enough to mean it"
   *  radius the drawing snaps use, so pan snap feels identical. */
  snapRadiusPx: number;

  /** True iff an edit dialog is up — the Alt+± zoom shortcut bails
   *  in that state so the key isn't swallowed mid-edit. */
  anyEditDialogOpen(): boolean;
  /** True iff the page is in the no-session error mode — every
   *  Alt-shortcut bails in that state for the same reason as the
   *  main file's Alt-hotkey handler. */
  isStaleMode(): boolean;

  /** Re-grow the prompt textarea + reapply zoom — wired to the
   *  window-resize handler here so the chain runs on every viewport
   *  change. */
  autoGrowPrompt(): void;
}

let ctx: ZoomContext;

// Pixel budgets for sizing the box and the image inside it.
//
// The box's outer height (its `maxHeight` cap) is bounded only by
// the viewport's bottom and the body's bottom margin.
//
// The image's available area is the box's content area minus
// 2 × `WRAP_MARGIN` (the .image-wrap's outer margin, which keeps
// the corner crop grips from being clipped by the box's
// `overflow: auto`). `.image-box` and `.image-wrap` have no CSS
// borders of their own — the image-edge black line is drawn in
// `#overlay` 1 px outside the image, inside the wrap's halo.
//
// `imageBox.style.maxHeight` is *not* cleared before measuring: the
// box's top is set by elements above it in the flex row (the
// prompt, the page-card), not by its own height — the measurement
// is stable across re-runs. Clearing maxHeight would briefly
// remove the overflow constraint, snap `scrollTop` / `scrollLeft`
// back to 0 (no overflow → no scroll), and the user's pan
// position would be lost on every applyZoom() call.
const WRAP_MARGIN = 4;

export function availableImageHeight(): { box: number; image: number } {
  const top = ctx.imageBox.getBoundingClientRect().top;
  const bodyMargin = 24;
  const box = Math.max(0, window.innerHeight - top - bodyMargin);
  const image = Math.max(0, box - 2 * WRAP_MARGIN);
  return { box, image };
}

// CSS-pixel target dimensions at "1× zoom". `chrome.tabs.captureVisibleTab`
// returns a PNG sized in *device* pixels — so on a 2× DPR display, a
// 1920 CSS-px-wide page comes back as a 3840-image-px-wide PNG. If we
// rendered the image at `naturalWidth` CSS px the editor would be 2×
// the apparent size of the source page. Dividing by the editor's
// `devicePixelRatio` lines 1× back up with the source page when both
// are on the same display (the side-by-side comparison case).
//
// (Cross-DPR multimon — editor on 1× monitor, source on 2× — would
// need the source page's DPR plumbed through the scrape; we don't do
// that yet.)
export function targetCssSize(): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  return {
    w: ctx.previewImg.naturalWidth / dpr,
    h: ctx.previewImg.naturalHeight / dpr,
  };
}

export function applyZoom(): void {
  // Capture the pre-resize image dimensions so we can scale any
  // in-flight drag / polyline anchors after the resize. A zero-size
  // pre-rect (image not yet loaded, or a degenerate measurement)
  // means there's nothing meaningful to scale relative to — skip
  // the rescale in that case so we don't divide by zero.
  const preRect = ctx.imgRect();
  const preW = preRect.width;
  const preH = preRect.height;

  const avail = availableImageHeight();
  ctx.imageBox.style.maxHeight = avail.box + 'px';
  if (zoomMode === 'fit') {
    // Fit mode used to rely on `max-width: 100%` + `max-height:
    // <px>` and let the browser pick aspect-preserving dimensions.
    // That was unreliable: `.image-wrap` is `display: inline-block`,
    // making the image's own containing block circular (the wrap
    // sizes to its child, the image), so `max-width: 100%` doesn't
    // actually constrain the image's width — vertical scrollbars
    // would appear when the image rendered taller than the box.
    //
    // Instead we compute the displayed dimensions ourselves from
    // the natural aspect ratio and the available content area, then
    // assign explicit pixel `width` and `height`. No surprises, no
    // overflow. Sizes are derived from `targetCssSize()` (1× CSS
    // dimensions) so Fit's `Math.min(1, …)` ceiling matches 1×.
    // `clientWidth` excludes the box's border regardless of
    // `box-sizing`, so it's already the box's inner content area.
    // The wrap's outer footprint inside is its own margins + border.
    const boxW = ctx.imageBox.clientWidth;
    const wMax = Math.max(0, boxW - 2 * WRAP_MARGIN);
    const hMax = avail.image;
    const { w: targetW, h: targetH } = targetCssSize();
    if (targetW > 0 && targetH > 0 && wMax > 0 && hMax > 0) {
      const scale = Math.min(1, wMax / targetW, hMax / targetH);
      ctx.previewImg.style.width = targetW * scale + 'px';
      ctx.previewImg.style.height = targetH * scale + 'px';
      ctx.previewImg.style.maxWidth = '';
      ctx.previewImg.style.maxHeight = '';
    } else {
      // Image not yet loaded — leave dimensions to the browser's
      // intrinsic sizing. The load-event handler re-runs
      // applyZoom with the natural sizes available.
      ctx.previewImg.style.width = '';
      ctx.previewImg.style.height = '';
      ctx.previewImg.style.maxWidth = wMax + 'px';
      ctx.previewImg.style.maxHeight = hMax + 'px';
    }
  } else {
    const n = zoomMode;
    const { w: targetW, h: targetH } = targetCssSize();
    const w = targetW * n;
    const h = targetH * n;
    // Don't set explicit dimensions before the image has loaded —
    // would otherwise pin the box to 0×0 until the load handler
    // re-runs applyZoom and is harmless either way (the load event
    // runs applyZoom).
    if (w > 0 && h > 0) {
      ctx.previewImg.style.width = w + 'px';
      ctx.previewImg.style.height = h + 'px';
    }
    ctx.previewImg.style.maxWidth = 'none';
    ctx.previewImg.style.maxHeight = 'none';
  }
  // Rescale in-flight drag / polyline state BEFORE render() so the
  // re-rendered preview uses the post-zoom anchors rather than the
  // stale ones (which would otherwise show one frame of a disconnected
  // segment). Skip when either rect is degenerate (image not yet
  // loaded) — there's nothing meaningful in flight at that point.
  const postRect = ctx.imgRect();
  if (preW > 0 && preH > 0 && postRect.width > 0 && postRect.height > 0) {
    const sx = postRect.width / preW;
    const sy = postRect.height / preH;
    if (sx !== 1 || sy !== 1) ctx.rescaleAfterImageResize(sx, sy);
  }
  ctx.render();
  // Zoom changes both the image's measured rect and the viewport's
  // size (the box's maxHeight is also reset above), so the dashed
  // virtual-edge SVG needs a re-layout + redraw. The scroll listener
  // catches user-driven pans on its own.
  ctx.drawViewportEdges();
}

// Pre-zoom alias retained because callers historically wired this
// to the prompt-grow / resize / image-load callbacks. Same entry
// point now — the function is mode-aware.
export function fitImage(): void {
  applyZoom();
}

function updateZoomButtonLabel(): void {
  ctx.zoomBtn.textContent = `Zoom: ${ZOOM_LABELS[String(zoomMode)] ?? 'Fit'}`;
}

export function setZoom(m: ZoomMode): void {
  zoomMode = m;
  updateZoomButtonLabel();
  applyZoom();
  // Refresh the menu's check marker too, in case the menu is open
  // (wheel-zoom while it's up should update the visible state).
  refreshZoomMenuChecks();
  // applyZoom already calls render(); skip a duplicate.
}

// Display→1× ratio used to scale overlay stroke widths so red lines
// and boxes track the visual scale of the image while editing. "1×"
// here is the editor's 1× zoom (1 source-CSS-pixel ≈ 1 editor CSS
// pixel), not the natural-pixel size of the image — so the ratio is
// 1.0 at 1×, 2.0 at 2×, and < 1 only when the editor has shrunk
// below the source page's size. The bake (`renderHighlightedImage`)
// does NOT use this — it always renders strokes at a fixed default
// width in natural pixels so the saved image looks the same regardless
// of the user's zoom level at save time.
export function currentDisplayScale(): number {
  const target = targetCssSize();
  if (!target.w) return 1;
  return ctx.imgRect().width / target.w;
}

// CSS-pixel size of one *natural* (saved-output) image pixel on
// screen right now. Shared by every "one output pixel per press"
// keyboard path: drawing's arrow-key drag / resize nudge and the
// pan module's arrow-key fine pan below.
//
// The drag handler maps a CSS-pixel cursor delta to percent space via
// `cssPx / r.width`, which becomes natural pixels at bake time via
// `pct * naturalWidth / 100`. Solving for "one natural px" gives
// `r.width / naturalWidth`. At 1× zoom with DPR=1 that's exactly 1
// CSS px; on HiDPI or zoomed in it shrinks below 1 (sub-pixel
// positions are fine — the drag and scroll math are both float);
// zoomed out it grows above 1 so each press still moves exactly one
// output pixel.
//
// Falls back to 1 before the image has loaded (natural size 0).
export function naturalPixelStep(): { x: number; y: number } {
  const r = ctx.imgRect();
  const natW = ctx.previewImg.naturalWidth;
  const natH = ctx.previewImg.naturalHeight;
  return {
    x: natW > 0 ? r.width / natW : 1,
    y: natH > 0 ? r.height / natH : 1,
  };
}

// Has Fit-mode's rendering already reached the editor's 1× display
// size? Used by the wheel handler to skip the redundant fit ↔ 1×
// hop when the image already fills fit-mode at the 1× target size
// (small images on large screens).
function fitMatches1x(): boolean {
  const { w: targetW, h: targetH } = targetCssSize();
  if (!targetW || !targetH) return false;
  // .image-box is the constraint surface. clientWidth excludes its
  // scrollbars, which would otherwise lie about available width
  // when overflow:auto has produced one in a previous mode.
  const boxW = ctx.imageBox.clientWidth;
  const availH = availableImageHeight().image;
  // Fit-mode shrinks proportionally to whichever axis is tighter
  // (`applyZoom`'s Fit branch picks `min(1, wMax/targetW, hMax/targetH)`
  // and writes the result to `style.width`/`style.height`). Scale = 1
  // → image renders at 1× in Fit. Strict equality against 1 is too
  // tight: sub-pixel rounding (border-box vs content-box, scrollbar
  // gutters) can leave us at 0.998 or similar; clamp to the 0.5 px
  // tolerance that any visible difference would have to cross to
  // actually change strokes.
  const tol = 0.5 / Math.min(targetW, targetH);
  return Math.min(boxW / targetW, availH / targetH) >= 1 - tol;
}

// ─── Zoom menu (popover) ──────────────────────────────────────────
//
// Built lazily on first open and inserted into `.highlight-controls`
// with `position: absolute; left: calc(100% + 6px)` so it floats to
// the right of the column without taking layout space — opening the
// menu doesn't push the image, just paints over the gap between the
// column and the image-box. Inline `top` aligns the menu's top edge
// with the Zoom button. Toggle is fully controlled by the Zoom
// button — we deliberately don't add an outside-click closer: it
// competed with the button's own click handler in a way that could
// leave the user unable to close the menu via the button. Escape
// (when the page has focus) and the menu items themselves also
// close it.

let zoomMenuEl: HTMLDivElement | null = null;

function buildZoomMenu(): HTMLDivElement {
  const menu = document.createElement('div');
  menu.className = 'zoom-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  for (const value of ZOOM_LEVELS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'zoom-menu-item';
    item.setAttribute('role', 'menuitemradio');
    item.dataset.zoom = String(value);
    const check = document.createElement('span');
    check.className = 'zoom-menu-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = ZOOM_LABELS[String(value)] ?? String(value);
    item.append(check, label);
    item.addEventListener('click', () => {
      setZoom(value);
      closeZoomMenu();
      ctx.zoomBtn.focus();
    });
    menu.appendChild(item);
  }
  // Place inside `.highlight-controls` so its `position: absolute`
  // anchors against the column. `left: calc(100% + 6px)` (in CSS)
  // floats it just right of the column so it sits in the parent
  // gap (and over the start of the image, but only by a few
  // pixels — narrower than putting it inline as a flex sibling,
  // which would move the image when the menu opens).
  ctx.highlightControls.appendChild(menu);
  return menu;
}

function refreshZoomMenuChecks(): void {
  if (!zoomMenuEl) return;
  const items = Array.from(
    zoomMenuEl.querySelectorAll<HTMLButtonElement>('.zoom-menu-item'),
  );
  for (const item of items) {
    const v = item.dataset.zoom!;
    item.setAttribute('aria-checked', v === String(zoomMode) ? 'true' : 'false');
  }
}

function openZoomMenu(): void {
  if (!zoomMenuEl) zoomMenuEl = buildZoomMenu();
  refreshZoomMenuChecks();
  // Align the menu's top with the Zoom button's top within the
  // column. `offsetTop` is relative to the column (the absolute-
  // positioned element's offsetParent), so it doesn't drift when
  // the page scrolls or the prompt grows.
  zoomMenuEl.style.top = ctx.zoomBtn.offsetTop + 'px';
  zoomMenuEl.hidden = false;
  ctx.zoomBtn.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onZoomMenuKey);
}

function closeZoomMenu(): void {
  if (!zoomMenuEl || zoomMenuEl.hidden) return;
  zoomMenuEl.hidden = true;
  ctx.zoomBtn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', onZoomMenuKey);
}

function onZoomMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    closeZoomMenu();
    ctx.zoomBtn.focus();
  }
}

// ─── Wheel + keyboard zoom ────────────────────────────────────────
//
// Zoom is driven by Ctrl/Cmd+wheel and Alt+−/+ (Alt+= is a quiet
// no-shift alias for Alt++). Plain wheel / trackpad swipes are
// left alone so they fall through to native `.image-box` scroll —
// important for panning a tall image at 4× / 8×, and avoids the
// trackpad-zoom-runaway where a continuous swipe with momentum tail
// would fly through every zoom level in a single gesture.
//
// Cursor-centered: the image-relative fraction the cursor (or last-
// known mouse position, for keyboard shortcuts) was over pre-zoom is
// preserved post-zoom by re-scrolling the box. When the focal point
// is outside the visible image (or unknown), the level just changes.

function nextZoomIndex(curIdx: number, dir: 1 | -1): number {
  let i = curIdx + dir;
  if (i < 0 || i >= ZOOM_LEVELS.length) return curIdx;
  // Skip fit ↔ 1× when the two are visually identical right now.
  // If the skip target is out of range (e.g. wheel-down from 1× when
  // fit and 1× look the same — there's nothing past fit), stay put
  // rather than performing the silent mode change the skip exists
  // to prevent.
  const cur = ZOOM_LEVELS[curIdx];
  const next = ZOOM_LEVELS[i];
  if (
    fitMatches1x() &&
    ((cur === 'fit' && next === 1) || (cur === 1 && next === 'fit'))
  ) {
    const j = i + dir;
    if (j < 0 || j >= ZOOM_LEVELS.length) return curIdx;
    return j;
  }
  return i;
}

// Is the viewport coord (vx, vy) over the *visible* image? Wraps
// `visibleImageRect` (which already does the imgRect ∩ box-content
// intersection, so a cursor over a scrollbar gutter or past the
// scroll edge reads as outside) with an open-right / open-bottom
// half-plane test — keeps the rect treatment consistent with the
// `clientX < right` style used elsewhere.
export function isOverVisibleImage(vx: number, vy: number): boolean {
  const v = ctx.visibleImageRect();
  return vx >= v.left && vx < v.right && vy >= v.top && vy < v.bottom;
}

// Forgiveness halo for the polyline cancel-on-outside-click rule.
// A click within `EDGE_COMMIT_BUFFER_PX` of the visible image
// edge commits the next segment at the nearest image edge
// (`localCoords` already clamps the cursor there) instead of
// cancelling the chain. The check is symmetric on all four sides
// — buffer is measured purely as distance from the visible image
// rect, with no container-bounds gate, so the user gets the same
// forgiveness whether they overshoot toward the palette, the
// prompt, or the gray space on the right / bottom.
export const EDGE_COMMIT_BUFFER_PX = 16;
export function isWithinEdgeCommitBuffer(vx: number, vy: number): boolean {
  const v = ctx.visibleImageRect();
  const B = EDGE_COMMIT_BUFFER_PX;
  return (
    vx >= v.left - B && vx < v.right + B &&
    vy >= v.top - B && vy < v.bottom + B
  );
}

// Image-box's scrollbar gutter in viewport coords: inside the
// box's bounding rect but past its content area (clientWidth /
// clientHeight exclude scrollbars). Clicking on a gutter is a
// scroll gesture — neither a draw nor a cancel — so the polyline
// cancel-on-outside-click rule explicitly carves this region out.
export function isOverImageBoxScrollbar(vx: number, vy: number): boolean {
  const box = ctx.imageBox.getBoundingClientRect();
  // Inner content-area edges; see the matching note in
  // `visibleImageRect`. `clientLeft / clientTop` would shift the
  // origin past any CSS border (both 0 today, defensive).
  const contentRight = box.left + ctx.imageBox.clientLeft + ctx.imageBox.clientWidth;
  const contentBottom = box.top + ctx.imageBox.clientTop + ctx.imageBox.clientHeight;
  return (
    vx >= box.left && vx < box.right &&
    vy >= box.top && vy < box.bottom &&
    (vx >= contentRight || vy >= contentBottom)
  );
}

// Step zoom by `dir`, keeping (focalX, focalY) viewport coords stable
// when the focal point is over the visible image. We use natural
// fractions (the image-relative position the cursor was over) rather
// than displayed coords because the displayed image shrinks/grows
// around the same natural pixel under the cursor. The browser clamps
// `scrollLeft / scrollTop` to the new content bounds, so a target
// outside the scroll range simply scrolls maximally that way.
//
// Returns true if the zoom level changed.
function cursorCenteredZoomStep(
  dir: 1 | -1,
  focalX: number | null,
  focalY: number | null,
): boolean {
  const cur = ZOOM_LEVELS.indexOf(zoomMode);
  if (cur < 0) return false;
  const next = nextZoomIndex(cur, dir);
  if (next === cur) return false;

  const useFocal =
    focalX !== null && focalY !== null &&
    isOverVisibleImage(focalX, focalY);
  let fx = 0, fy = 0, preBoxLeft = 0, preBoxTop = 0;
  if (useFocal) {
    const r = ctx.imgRect();
    const boxRect = ctx.imageBox.getBoundingClientRect();
    fx = (focalX! - r.left) / Math.max(1, r.width);
    fy = (focalY! - r.top) / Math.max(1, r.height);
    // Box viewport position doesn't change across the zoom (only the
    // image inside it resizes), so capturing pre-zoom is fine.
    preBoxLeft = boxRect.left;
    preBoxTop = boxRect.top;
  }

  setZoom(ZOOM_LEVELS[next]!);

  if (useFocal) {
    const r2 = ctx.imgRect();
    ctx.imageBox.scrollLeft = preBoxLeft + fx * r2.width - focalX!;
    ctx.imageBox.scrollTop  = preBoxTop  + fy * r2.height - focalY!;
  }
  // A zoom step can land mid-pan (Ctrl+wheel with the drag held).
  // Nothing to do here: the pan's `mousemove` notices the scroll it
  // didn't write and re-seeds from it.
  return true;
}

// Last viewport-coord cursor position. Two consumers:
//   - keyboard zoom (Alt+± below) — re-centers the zoom on the
//     cursor when known; pre-move presses just change level.
//   - arrow-key drag-nudge (drawing module) — reads it as the
//     starting position and writes back the nudged position so
//     successive presses accumulate.
// `null` until the first mousemove. The arrow-key handler treats
// that as a "do nothing" case, since there's no cursor anchor to
// nudge from.
let lastMousePos: { x: number; y: number } | null = null;

export function getLastMousePos(): { x: number; y: number } | null {
  return lastMousePos;
}
export function setLastMousePos(p: { x: number; y: number } | null): void {
  lastMousePos = p;
}

// Wheel-zoom accumulator. Trackpads emit a continuous stream of
// small-deltaY events (~10 each at 60 Hz) during a swipe and through
// the OS-level momentum tail, so a one-event-per-step mapping flies
// through every zoom level in a single gesture — the issue users hit
// on Chromebook trackpads. We accumulate |deltaY| and step only when
// the accumulator crosses one mouse-notch's worth of delta (~100),
// giving deliberate-feeling steps on trackpads while keeping mouse-
// wheel users at one step per detent. Direction change or an idle
// gap reset the accumulator so a fresh gesture doesn't carry leftover
// delta from the previous one.
//
// The accumulator-only path failed for one device class: a physical
// mouse on Chromebook (and any other browser/OS combo that emits
// per-notch `deltaY` somewhere between WHEEL_NOTCH_PIXEL_MIN and
// WHEEL_STEP_THRESHOLD). A slow turn there produces notches > 200 ms
// apart, so the idle reset wipes the accumulator between events and
// no notch ever crosses the threshold; a fast turn packs notches
// inside 200 ms and zooms. The notch-shortcut below catches these
// events explicitly so timing no longer matters — see WHEEL_NOTCH_*.
let wheelAccumDelta = 0;
let wheelLastDir: 1 | -1 = 1;
let wheelLastTime = 0;
const WHEEL_STEP_THRESHOLD = 100;
const WHEEL_IDLE_RESET_MS = 200;

// Discrete-notch shortcut. An event is treated as a complete wheel
// notch — and zooms immediately, regardless of the accumulator — when
// either:
//   - `deltaMode` is line (1) or page (2): only mouse wheels emit
//     those modes; trackpads always use DOM_DELTA_PIXEL (0).
//   - `deltaMode` is pixel but `|deltaY|` is at least
//     WHEEL_NOTCH_PIXEL_MIN. Browsers that quantize the wheel to
//     pixel units (macOS, ChromeOS, some Linux builds) still emit
//     comparatively large per-event values: typically 53, 100, or
//     120. Trackpad swipe samples sit well below 40 even at full
//     speed, with only the very start of a momentum tail occasionally
//     poking above, so 40 is the cleanest cut-point between the two
//     populations. A stray trackpad sample at 40+ pixels then zooms
//     one step immediately, where the accumulator would have needed
//     ~60 more px of follow-up to cross 100 — so a fast trackpad
//     pinch could in principle fire one extra step at the very start
//     of a gesture. Acceptable: trackpad samples typically cap well
//     under 40, and the overall trackpad-runaway protection (one
//     step per ~100 accumulated px thereafter) is unchanged.
const WHEEL_NOTCH_PIXEL_MIN = 40;

// ─── Pan (middle-click + Ctrl/Cmd-left-drag) ──────────────────────
//
// Hold middle-button OR Ctrl/Cmd-left and drag to scroll the image-
// box. The middle-button path predates the Ctrl-drag path; both
// share the same `panState` and window listeners. Listening on
// `window` for moves / release lets a drag that wanders off the
// image keep panning until the triggering button is released.
//
// While the trigger is held, arrow keys nudge the scroll by one image
// pixel each — the fine-alignment path (see the listener below). A
// held *scrollbar* drag counts as the same moment (`scrollbarDrag`):
// the user is positioning the view, just with a different grip.
//
// Ctrl-left needs to fire from over the SVG overlay too (the
// overlay covers the image), so the overlay's `mousedown` handler
// in the drawing module has a Ctrl-left branch that calls `startPan`
// + `stopPropagation`. Outside the overlay (the box's surround) the
// imageBox handler catches it directly.
//
// `panState.button` records which button started the drag so the
// matching `mouseup` releases it — a stray right-up shouldn't end
// a Ctrl-left pan.
//
// ─── Snap while panning ───
//
// A drag pan snaps the pane's visible edges onto the edges of any
// box-shaped edit (crop / rect / redact) that comes within
// `ctx.snapRadiusPx` — the same radius the drawing snaps use. The
// point is cross-image comparison: draw the same crop on two
// captures of a page, park each one flush in the pane's top-left,
// and flip between the tabs to see exactly what moved. Doing that by
// hand-dragging is hopeless; landing on the snap is not.
//
// Candidates per axis (X shown; Y is the same with top / bottom):
//   - box's left edge  → pane's left edge   (`scrollLeft = boxLeft`)
//   - box's right edge → pane's right edge  (`boxRight - clientWidth`)
// Both axes snap independently, so a corner is just both at once.
// The alignment is against the box's *outside* — the geometric rect
// the edit stores, which is what the user sees as the box's extent.
//
// Candidates that the scroll range can't reach are dropped rather
// than left for the browser to clamp: a clamped assignment lands at
// the end of the range, which is *not* the alignment that pulled the
// view there, so it reads as an unexplained jump.
//
// `desiredX / desiredY` hold the un-snapped position the drag has
// actually accumulated. Without them, a snapped scroll position
// would be re-read as the drag's own baseline on the next move and
// the pointer could never climb back out of the snap. Holding Shift
// bypasses the snap, and because `desired` kept tracking underneath,
// a bypass lands exactly where the pointer says.
//
// `appliedX / appliedY` are what we last wrote (read back, so the
// comparison isn't fighting Chrome's device-pixel quantisation). A
// scroll offset that no longer matches means something *else* moved
// the view mid-drag — the arrow-key fine pan, a plain wheel scroll
// under a held middle-button, a mid-drag zoom step, a resize re-fit —
// and that axis re-seeds `desired` from reality. Per-axis, so a
// vertical nudge doesn't discard the horizontal escape distance the
// pointer had built up.
//
// The arrow-key fine pan deliberately does *not* snap — same rule as
// drawing's arrow-key nudge, which bypasses snap so a user who
// snapped with the mouse can still step off it one pixel at a time.
// The re-seed above is what lets a pointer move resume from where the
// keyboard left the view.
//
// A nudge also turns the snap off (`snapOff`) for the rest of the
// drag. The keyboard is the precision tool: having stepped
// deliberately off a snapped position, the user shouldn't have it
// yanked back by the next twitch of a still-held mouse. Releasing and
// re-dragging arms the snap again.

let panState:
  | {
      prevX: number; prevY: number; button: number;
      desiredX: number; desiredY: number;
      appliedX: number; appliedY: number;
      snapOff: boolean;
    }
  | null = null;
// Timestamp of the last middle-mousedown on the image-box. Used by
// the prompt's paste guard to recognise X11 primary-selection
// pastes that the OS dispatched in response to the click and refuse
// them — `preventDefault` on the various mouse events alone has
// proven not to catch every Linux Chromium build's paste path.
let lastImageMiddleDownTime = 0;

// Left-button drag on one of `.image-box`'s scrollbars. The browser
// does the scrolling itself here — we only track that the gesture is
// in flight so the arrow-key fine pan works during it too.
//
// Chrome dispatches a normal `mousedown` for a scrollbar press (with
// the scrollable element as target), which is what makes this
// detectable at all; `isOverImageBoxScrollbar` distinguishes gutter
// coords from content coords. We deliberately don't `preventDefault`
// anywhere on this path — that would kill the native thumb drag.
let scrollbarDrag = false;

/** Is a pan drag in flight? Drawing's arrow-key nudge checks this so
 *  an arrow press during a pan pans and *only* pans — the two can
 *  overlap (a middle-drag pan can start while a polyline chain is
 *  alive, which leaves drawing's `dragStart` set). Scrollbar drags
 *  count: they're the same "positioning the view" moment, and the
 *  same arrow keys act on it. */
export function isPanning(): boolean {
  return panState !== null || scrollbarDrag;
}

export function startPan(e: MouseEvent): void {
  panState = {
    prevX: e.clientX,
    prevY: e.clientY,
    button: e.button,
    desiredX: ctx.imageBox.scrollLeft,
    desiredY: ctx.imageBox.scrollTop,
    appliedX: ctx.imageBox.scrollLeft,
    appliedY: ctx.imageBox.scrollTop,
    snapOff: false,
  };
  // Class on body so the cursor change applies even over `#overlay`,
  // whose own `cursor: crosshair` rule would otherwise outrank a
  // style set on `imageBox`.
  document.body.classList.add('panning');
}

/**
 * Where the image's top-left sits in the box's *scroll-content*
 * coordinates: its viewport position, un-scrolled, relative to the
 * box's content origin. Constant across scrolling (both terms move
 * together), so it's the fixed origin every scroll-space measurement
 * here is taken from. It's non-zero — `.image-wrap` carries a
 * `WRAP_MARGIN` margin — so it can't be assumed away.
 */
function scrollContentOrigin(): { x: number; y: number } {
  const r = ctx.imgRect();
  const box = ctx.imageBox.getBoundingClientRect();
  return {
    x: r.left - (box.left + ctx.imageBox.clientLeft) + ctx.imageBox.scrollLeft,
    y: r.top - (box.top + ctx.imageBox.clientTop) + ctx.imageBox.scrollTop,
  };
}

/**
 * Scroll offsets that would land a box edge flush against a pane
 * edge, per axis. See the "Snap while panning" notes above for which
 * pairings are offered and why. `maxX / maxY` are the box's scroll
 * range: offsets outside it are dropped, since the browser would
 * clamp them to somewhere that isn't the promised alignment.
 */
function panSnapTargets(maxX: number, maxY: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const rects = ctx.panSnapRects();
  // Nothing drawn is the common case — skip the layout reads below.
  if (rects.length === 0) return { xs, ys };
  const r = ctx.imgRect();
  const origin = scrollContentOrigin();
  const push = (into: number[], value: number, max: number): void => {
    if (value >= 0 && value <= max) into.push(value);
  };
  for (const b of rects) {
    const left = origin.x + (b.x / 100) * r.width;
    const top = origin.y + (b.y / 100) * r.height;
    push(xs, left, maxX);
    push(xs, left + (b.w / 100) * r.width - ctx.imageBox.clientWidth, maxX);
    push(ys, top, maxY);
    push(ys, top + (b.h / 100) * r.height - ctx.imageBox.clientHeight, maxY);
  }
  return { xs, ys };
}

/** Nearest candidate within the snap radius, or `value` unchanged.
 *  Ties go to whichever candidate came first — they can only happen
 *  when two boxes share an edge, where both answers are the same
 *  position anyway. Strict `<` against the radius matches drawing's
 *  snap helpers, so "the same radius" really is the same. */
function snapScroll(value: number, candidates: number[]): number {
  let best = value;
  let bestD = ctx.snapRadiusPx;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * Was the most recent middle-mousedown on the image-box within
 * `withinMs` of `now`? The prompt's middle-click paste guard uses
 * this to refuse a paste that the X11 primary-selection machinery
 * dispatched in response to a middle-click on the image (a pan
 * gesture, not a paste request). `now` and `withinMs` accept
 * `event.timeStamp`-style high-resolution timestamps.
 */
export function wasMiddleDownRecently(now: number, withinMs: number): boolean {
  return lastImageMiddleDownTime > 0 && now - lastImageMiddleDownTime < withinMs;
}

/**
 * Wire all zoom, wheel, keyboard-zoom, and pan handlers. Called once
 * by capture-page.ts after DOM refs are available.
 */
export function initZoom(context: ZoomContext): void {
  ctx = context;

  window.addEventListener('resize', () => {
    // Re-grow the prompt because line wrap points may have changed,
    // then re-apply the zoom (which fits the image and reads the
    // new viewport size).
    ctx.autoGrowPrompt();
  });
  ctx.previewImg.addEventListener('load', applyZoom);

  ctx.zoomBtn.addEventListener('click', () => {
    if (zoomMenuEl && !zoomMenuEl.hidden) {
      closeZoomMenu();
    } else {
      openZoomMenu();
    }
  });

  ctx.imageBox.addEventListener('wheel', (e) => {
    // Image zoom requires Ctrl (Cmd on macOS). Plain wheel/trackpad
    // falls through to native `.image-box` scroll — necessary for
    // panning a tall image at 4× / 8× and avoids the trackpad runaway
    // described above.
    if (!(e.ctrlKey || e.metaKey)) return;

    // Always swallow Ctrl/Cmd+wheel: the browser default would page-
    // zoom on top of (or instead of) our app zoom, which is rarely
    // what the user wants over the captured image.
    e.preventDefault();

    const now = e.timeStamp;
    const dir: 1 | -1 = e.deltaY < 0 ? 1 : -1;

    // Discrete-notch shortcut — step immediately and bypass the
    // accumulator. See WHEEL_NOTCH_PIXEL_MIN for the rationale.
    // Update the accumulator's bookkeeping so a follow-up trackpad
    // gesture (in either direction) starts from a clean slate rather
    // than inheriting whatever happened to be left in the accumulator
    // from before the notch event.
    const isDiscreteNotch =
      e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
      Math.abs(e.deltaY) >= WHEEL_NOTCH_PIXEL_MIN;
    if (isDiscreteNotch) {
      wheelAccumDelta = 0;
      wheelLastDir = dir;
      wheelLastTime = now;
      cursorCenteredZoomStep(dir, e.clientX, e.clientY);
      return;
    }

    if (dir !== wheelLastDir || now - wheelLastTime > WHEEL_IDLE_RESET_MS) {
      wheelAccumDelta = 0;
      wheelLastDir = dir;
    }
    wheelLastTime = now;
    wheelAccumDelta += Math.abs(e.deltaY);
    if (wheelAccumDelta < WHEEL_STEP_THRESHOLD) return;
    // Cap at one step per event regardless of accumulated delta — an
    // over-eager coalesced trackpad event with a huge deltaY shouldn't
    // blast through multiple levels at once.
    wheelAccumDelta = 0;
    cursorCenteredZoomStep(dir, e.clientX, e.clientY);
  }, { passive: false });

  window.addEventListener('mousemove', (e) => {
    lastMousePos = { x: e.clientX, y: e.clientY };
  });

  // Keyboard zoom: Alt+− / Alt++ (and the no-shift Alt+= alias).
  // When the cursor is over the visible image, zoom stays cursor-
  // centered to match the wheel path; otherwise the level just changes.
  //
  // Lives separately from the page-wide alt-hotkey listener in
  // capture-page.ts because that one early-returns on `shiftKey`
  // (Alt+S etc. are shift-less), and Alt++ requires Shift on most
  // keyboard layouts.
  document.addEventListener('keydown', (e) => {
    if (ctx.anyEditDialogOpen()) return;
    if (ctx.isStaleMode()) return;
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    let dir: 1 | -1;
    // `_` covers Shift+- on layouts where that's what the OS reports;
    // `+` and `=` are the same physical key (with/without Shift).
    if (e.key === '-' || e.key === '_') dir = -1;
    else if (e.key === '+' || e.key === '=') dir = 1;
    else return;
    e.preventDefault();
    cursorCenteredZoomStep(
      dir,
      lastMousePos?.x ?? null,
      lastMousePos?.y ?? null,
    );
  });

  // macOS uses Cmd where Ctrl appears, and Option where Alt appears,
  // in the tooltip text on every other platform. The wheel and key
  // handlers accept the underlying `metaKey` / `altKey` already; only
  // the user-facing label needs swapping.
  // `navigator.platform` is technically deprecated but still the
  // quickest reliable check in MV3 / Chromium and matches the rest
  // of the web's UA-detection conventions.
  const isMacPlatform =
    /Mac|iP(hone|ad|od)/i.test(navigator.platform || '') ||
    /Mac OS X/.test(navigator.userAgent);
  if (isMacPlatform) {
    // Swap "Ctrl" / "Alt" → "Cmd" / "Option" anywhere they appear in
    // the static HTML titles. Covers the Zoom button (Ctrl/Alt) and
    // the Line / Arrow tool buttons (Ctrl-for-multi-line hint). Any
    // future button whose title mentions either modifier picks this
    // up automatically as long as it's loaded by this point.
    const swapModifiers = (s: string): string =>
      s.replace(/\bCtrl\b/g, 'Cmd').replace(/\bAlt\b/g, 'Option');
    for (const id of ['zoom', 'tool-line', 'tool-arrow']) {
      const el = document.getElementById(id);
      const title = el?.getAttribute('title');
      if (el && title) el.setAttribute('title', swapModifiers(title));
    }
  }

  ctx.imageBox.addEventListener('mousedown', (e) => {
    const isMiddle = e.button === 1;
    // Ctrl+Shift is the "force a fresh draw with snap on" gesture
    // (overlay handler bypasses the resize hit-test for it) — don't
    // also start a pan here when the event bubbles up. Plain Ctrl-left
    // (no Shift) still pans, mirroring middle-click.
    const isCtrlLeft = e.button === 0 && (e.ctrlKey || e.metaKey) && !e.shiftKey;
    if (!isMiddle && !isCtrlLeft) return;
    if (isMiddle) {
      lastImageMiddleDownTime = e.timeStamp;
      // Suppress browser default actions for middle-mousedown:
      //   - Autoscroll mode (the spinning compass icon Chrome enters
      //     after a middle-click on a scrollable region).
      //   - On Linux, the X11 primary-selection paste that fires
      //     against the focused editable element (the prompt
      //     textarea) on middle-click regardless of click target.
      // preventDefault here cancels both. We mirror it on the
      // overlay's mousedown handler for events that target the SVG
      // overlay sitting on top of the image.
      e.preventDefault();
    } else {
      // Ctrl-left: stop the browser from also kicking off a text
      // selection or focus-shift on the box, which would race with
      // our drag.
      e.preventDefault();
    }
    startPan(e);
  });

  // Scrollbar drag: track the gesture so arrow keys can fine-tune the
  // position the user just dragged to. Listening on `window` (not
  // `.image-box`) because a scrollbar press's event target isn't
  // something we want to depend on — the coordinate test is the
  // reliable signal. No `preventDefault`: the native thumb drag has
  // to keep working, and the release is handled by the `mouseup`
  // below.
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!isOverImageBoxScrollbar(e.clientX, e.clientY)) return;
    scrollbarDrag = true;
  });

  window.addEventListener('mousemove', (e) => {
    // Belt-and-braces release for `scrollbarDrag`. `mouseup` + `blur`
    // cover the realistic paths, but the flag is invisible when stuck
    // (unlike `panState`, which paints `body.panning`) and the arrow
    // handler swallows arrows unconditionally — so a stuck flag would
    // surface as "arrow keys stopped working in the prompt" with no
    // clue why. `buttons` is authoritative on every move.
    if (scrollbarDrag && !(e.buttons & 1)) scrollbarDrag = false;
    if (!panState) return;
    const dx = e.clientX - panState.prevX;
    const dy = e.clientY - panState.prevY;
    panState.prevX = e.clientX;
    panState.prevY = e.clientY;
    // Anything that moved the scroll since our last write (arrow-key
    // nudge, plain wheel under a held middle-button, a mid-drag zoom
    // step, a resize re-fit) wins: re-seed that axis from reality
    // rather than yanking the view back by the discrepancy.
    if (ctx.imageBox.scrollLeft !== panState.appliedX) {
      panState.desiredX = ctx.imageBox.scrollLeft;
    }
    if (ctx.imageBox.scrollTop !== panState.appliedY) {
      panState.desiredY = ctx.imageBox.scrollTop;
    }
    // Accumulate into the un-snapped position, clamped to the scroll
    // range so a drag that overshoots the edge doesn't bank distance
    // the user then has to drag back through.
    const maxX = Math.max(0, ctx.imageBox.scrollWidth - ctx.imageBox.clientWidth);
    const maxY = Math.max(0, ctx.imageBox.scrollHeight - ctx.imageBox.clientHeight);
    panState.desiredX = Math.max(0, Math.min(maxX, panState.desiredX - dx));
    panState.desiredY = Math.max(0, Math.min(maxY, panState.desiredY - dy));
    // Bare `shiftKey`, unlike drawing's `shiftKey && !ctrlKey` rule:
    // Ctrl/Cmd+Shift means "fresh draw with snap on" at *mousedown*,
    // and the Ctrl-left pan holds Ctrl for its whole life — under
    // drawing's rule a Ctrl-drag could never bypass. There's no
    // competing Ctrl+Shift gesture once a pan is in flight.
    if (e.shiftKey || panState.snapOff) {
      ctx.imageBox.scrollLeft = panState.desiredX;
      ctx.imageBox.scrollTop = panState.desiredY;
    } else {
      const targets = panSnapTargets(maxX, maxY);
      ctx.imageBox.scrollLeft = snapScroll(panState.desiredX, targets.xs);
      ctx.imageBox.scrollTop = snapScroll(panState.desiredY, targets.ys);
    }
    // Read back rather than storing what we asked for: Chrome
    // quantises scroll offsets to whole device pixels, and a
    // half-pixel mismatch would read as an external scroll next move.
    panState.appliedX = ctx.imageBox.scrollLeft;
    panState.appliedY = ctx.imageBox.scrollTop;
  });

  // ─── Arrow-key fine pan (while a pan drag is in flight) ─────────
  //
  // While the pan trigger is held — middle-button, Ctrl/Cmd-left, or
  // a left-drag on one of the box's scrollbars — each arrow press
  // scrolls the box by exactly one natural (saved-output) image
  // pixel. That's the same unit drawing's arrow-key nudge steps in,
  // via the shared `naturalPixelStep()`. The mouse can't be inched a
  // single pixel by hand, so this is the way to nail a pixel-exact
  // alignment between the captured image and whatever the user is
  // comparing it against.
  //
  // Each press also *snaps* the axis it moves, so the visible area's
  // top-left lands on a whole image pixel on that axis rather than
  // mid-pixel — zoomed in, a fractional scroll offset splits the
  // source pixel grid across the pane edge, which is what defeats a
  // careful visual comparison. Only the pressed axis is touched: the
  // perpendicular offset is where the user's drag deliberately put
  // it, and silently shifting it would move the image under them in
  // a direction they didn't ask for.
  //
  // Capture phase + unconditional `preventDefault` so the press can't
  // also move the caret in the prompt textarea, which usually holds
  // focus. Ctrl/Meta are deliberately *not* excluded — the Ctrl-left
  // pan gesture holds Ctrl by definition. Alt is excluded because
  // Alt+Left / Alt+Right are Chrome's Back / Forward shortcuts.
  window.addEventListener('keydown', (e) => {
    if (!isPanning()) return;
    // Same bails as every other keyboard path in this module. A pan
    // can't realistically be in flight behind a modal today, so these
    // are for consistency rather than a live bug — but a future
    // non-modal dialog shouldn't have its arrow keys eaten.
    if (ctx.anyEditDialogOpen()) return;
    if (ctx.isStaleMode()) return;
    if (e.altKey) return;
    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case 'ArrowLeft':  dx = -1; break;
      case 'ArrowRight': dx =  1; break;
      case 'ArrowUp':    dy = -1; break;
      case 'ArrowDown':  dy =  1; break;
      default: return;
    }
    e.preventDefault();
    const step = naturalPixelStep();
    const origin = scrollContentOrigin();
    // Image pixel currently at the pane's top-left corner on this
    // axis, rounded to the nearest whole one (the snap), then
    // stepped. Sign convention matches the drag this continues: the
    // arrow points the way the *image* moves, so the scroll offset
    // goes the other way. The browser clamps to the scroll range, so
    // a step past the edge just pins there.
    if (dx !== 0) {
      const px = Math.round((ctx.imageBox.scrollLeft - origin.x) / step.x) - dx;
      ctx.imageBox.scrollLeft = origin.x + px * step.x;
    } else {
      const py = Math.round((ctx.imageBox.scrollTop - origin.y) / step.y) - dy;
      ctx.imageBox.scrollTop = origin.y + py * step.y;
    }
    // No re-seed of `panState` here: the pan's `mousemove` compares
    // against what it last wrote and picks this up on the axis that
    // moved, leaving the other axis's escape distance intact. It does
    // drop the box snap for the rest of the drag — a deliberate
    // one-pixel step shouldn't be undone by the next mouse twitch.
    if (panState) panState.snapOff = true;
  }, true);

  window.addEventListener('mouseup', (e) => {
    // Scrollbar drags end on any left-up, wherever it lands — the
    // native thumb drag follows the pointer outside the box too.
    if (e.button === 0) scrollbarDrag = false;
    if (!panState || e.button !== panState.button) return;
    if (panState.button === 1) {
      // Mirror the mousedown preventDefault on mouseup too. Some
      // browsers / build configs fire the paste / autoscroll-toggle on
      // middle-mouseup independently, so `preventDefault` on mousedown
      // alone isn't always enough.
      e.preventDefault();
    }
    panState = null;
    document.body.classList.remove('panning');
  });

  // `auxclick` is the activation event for non-primary mouse buttons
  // (middle, right) — it's where the click-action default lives in
  // modern Chromium. preventDefaulting it on the image-box catches
  // any middle-click whose mousedown / mouseup defaults somehow
  // slipped through, and also covers paste that some Linux builds
  // dispatch on the click rather than the up.
  ctx.imageBox.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  // Clear pan state if focus leaves the window mid-drag. Without this,
  // a middle-mouseup that lands outside the window doesn't reach our
  // `mouseup` listener — `panState` stays set and the next mousemove
  // after refocus would scroll the image-box.
  //
  // Also abort polyline mode on blur — a Ctrl keyup can be missed when
  // focus shifts to another window mid-chain (e.g. the user alt-tabs
  // to a different app), and a stuck polyline would keep the preview
  // line ghosting around the cursor on the next focus-in.
  window.addEventListener('blur', () => {
    // Same reasoning as `panState` below: a mouseup that lands outside
    // the window never reaches us, and a stuck `scrollbarDrag` would
    // leave arrow keys hijacked (and swallowed from the prompt
    // textarea) long after the gesture ended.
    scrollbarDrag = false;
    if (panState) {
      panState = null;
      document.body.classList.remove('panning');
    }
    if (ctx.isPolylineActive()) ctx.endPolylineChain();
  });

  updateZoomButtonLabel();
}
