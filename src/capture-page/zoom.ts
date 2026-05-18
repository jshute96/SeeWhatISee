// Image fit / Zoom / Pan for the Capture page. `initZoom(ctx)`
// wires the zoom dropdown, Ctrl+wheel and Alt+± stepping, the
// middle-click + Ctrl-left pan, and the window resize / image-load
// re-fit hooks. Also owns the `lastMousePos` cache that drawing's
// arrow-key nudge reads and writes.
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
// Module also owns pan (middle-click + Ctrl/Cmd-left-drag) and the
// cursor-position cache that the keyboard zoom + drawing's
// arrow-key nudge both read.
//
// `applyZoom()` is the single entry point for sizing: writes the
// box's max-height, the image's width / height + max-* (mode-
// dependent), and re-renders so stroke widths track the new
// display→natural ratio.

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

/** Current zoom mode — `'fit'` or one of the discrete Nx steps.
 *  Read by the last-capture push so a restore lands the page back
 *  on whatever zoom the user closed with. */
export function getZoomMode(): ZoomMode {
  return zoomMode;
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
// Ctrl-left needs to fire from over the SVG overlay too (the
// overlay covers the image), so the overlay's `mousedown` handler
// in the drawing module has a Ctrl-left branch that calls `startPan`
// + `stopPropagation`. Outside the overlay (the box's surround) the
// imageBox handler catches it directly.
//
// `panState.button` records which button started the drag so the
// matching `mouseup` releases it — a stray right-up shouldn't end
// a Ctrl-left pan.

let panState: { prevX: number; prevY: number; button: number } | null = null;
// Timestamp of the last middle-mousedown on the image-box. Used by
// the prompt's paste guard to recognise X11 primary-selection
// pastes that the OS dispatched in response to the click and refuse
// them — `preventDefault` on the various mouse events alone has
// proven not to catch every Linux Chromium build's paste path.
let lastImageMiddleDownTime = 0;

export function startPan(e: MouseEvent): void {
  panState = { prevX: e.clientX, prevY: e.clientY, button: e.button };
  // Class on body so the cursor change applies even over `#overlay`,
  // whose own `cursor: crosshair` rule would otherwise outrank a
  // style set on `imageBox`.
  document.body.classList.add('panning');
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

  window.addEventListener('mousemove', (e) => {
    if (!panState) return;
    const dx = e.clientX - panState.prevX;
    const dy = e.clientY - panState.prevY;
    panState.prevX = e.clientX;
    panState.prevY = e.clientY;
    ctx.imageBox.scrollLeft -= dx;
    ctx.imageBox.scrollTop -= dy;
  });

  window.addEventListener('mouseup', (e) => {
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
    if (panState) {
      panState = null;
      document.body.classList.remove('panning');
    }
    if (ctx.isPolylineActive()) ctx.endPolylineChain();
  });

  updateZoomButtonLabel();
}
