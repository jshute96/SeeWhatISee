// Image fit / Zoom / Pan for the Capture page. `initZoom(ctx)`
// wires the zoom dropdown, Ctrl+wheel / pinch and Alt+± zoom, the
// middle-click + Ctrl-left pan, and the window resize / image-load
// re-fit hooks. Also owns the `lastMousePos` cache that drawing's
// arrow-key nudge reads and writes, and `naturalPixelStep()` — the
// one-output-pixel step both arrow-key paths (drawing's nudge and
// the fine pan) measure in.
//
// Two display modes:
//   - 'fit' (default) — image shrinks to the remaining viewport
//     (height-bounded by `window.innerHeight - imageBoxTop -
//     reserved`, width-bounded by `.image-box`'s flex slot). Sticky:
//     re-fits on every resize / prompt grow.
//   - a scale factor — any number in [ZOOM_MIN, ZOOM_MAX], not just
//     the menu's presets. Image renders at `targetCssSize() * N` CSS
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
import { createMenuPopover, type MenuPopover } from './menu-popover.js';

// Zoom is a continuous scale factor, not a rung on a ladder: `1`
// renders at the editor's 1× CSS size (natural / DPR), `2.37` at
// 2.37× that. 'fit' stays a distinct *mode* rather than the scale it
// currently resolves to, because it re-fits on every window resize /
// prompt grow — a number would freeze at whatever the window
// happened to be when it was set.
export type ZoomMode = 'fit' | number;

// Menu presets — not the set of reachable zooms. Wheel and keyboard
// land anywhere in [ZOOM_MIN, ZOOM_MAX].
const ZOOM_PRESET_SCALES = [1, 2, 4, 8] as const;
const ZOOM_PRESETS: ZoomMode[] = ['fit', ...ZOOM_PRESET_SCALES];
const ZOOM_MIN = 0.125;
const ZOOM_MAX = 8;
let zoomMode: ZoomMode = 'fit';

// `NaN` in would otherwise stick: it survives min/max, renders as
// "NaN%", makes `applyZoom` skip sizing (its `w > 0` guard), and
// poisons every later multiply. Not reachable from the wheel path
// (`exp()` of ±Infinity lands on a bound) but the `__seeState`
// test hook and future callers can pass anything.
const clampZoom = (s: number): number =>
  Number.isFinite(s) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s)) : 1;

// How close a scale has to be to a preset for the menu to show that
// preset as the active one.
//
// Deliberately tighter than the 0.0033 that drawing's stroke-width
// epsilon absorbs (`ceil(3·ratio − 0.01)`), so the 1× radio can't
// read as active while strokes have already stepped up to the 4 px
// bucket.
const PRESET_MATCH_TOL = 0.003;

// The preset this scale is sitting on, or null when it's between
// presets (the normal case under continuous zoom). Presets are ≥ 2×
// apart, so the first match within tolerance is the only match.
function presetAt(scale: number): number | null {
  return ZOOM_PRESET_SCALES.find(
    (p) => Math.abs(scale - p) <= p * PRESET_MATCH_TOL,
  ) ?? null;
}

// Menu item labels. The button itself is a static "Zoom…" — under
// continuous zoom it would otherwise be showing an arbitrary
// percentage that changes on every wheel event, which reads as noise
// rather than state (and, being inside a `width: fit-content` column,
// would resize the palette mid-gesture). The scale is visible in the
// image; what *isn't* visible is whether Fit is still armed, and the
// menu's check mark carries that.
function presetLabel(m: ZoomMode): string {
  return m === 'fit' ? 'Fit' : `${m}×`;
}

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
  /** The `<hr>` above the image area. Everything below it is the
   *  image's territory as far as Ctrl+wheel is concerned. */
  mainSeparator: HTMLElement;

  /** Drawing module's `render()` — applyZoom calls it after sizing
   *  changes so stroke widths re-derive from the new display ratio. */
  render(): void;
  /** Drawing module's `drawViewportEdges()` — applyZoom calls it
   *  so the dashed virtual-edge SVG re-lays-out after sizing. */
  drawViewportEdges(): void;
  /** Drawing's `visibleImageRect()` — used by the polyline
   *  forgiveness helpers (isOverVisibleImage etc.). */
  visibleImageRect(): { left: number; top: number; right: number; bottom: number };
  /** Drawing's `imgRect()` — used by the cursor-centered zoom to read
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

/**
 * The scale Fit mode renders at right now, or `null` when the image
 * hasn't decoded (nothing to fit). Capped at 1 — Fit shrinks to the
 * viewport but never magnifies.
 *
 * Shared by `applyZoom`'s Fit branch and the zoom-out floor, so the
 * two can't drift: "as far out as Fit" has to mean one thing.
 *
 * Note it reads `clientWidth`, which excludes a scrollbar the current
 * zoom may have produced — so while zoomed in this can come back a
 * few px smaller than the scale Fit would settle at. That only makes
 * the floor marginally more permissive, which is harmless.
 */
function fitScale(): number | null {
  const { w: targetW, h: targetH } = targetCssSize();
  const wMax = Math.max(0, ctx.imageBox.clientWidth - 2 * WRAP_MARGIN);
  const hMax = availableImageHeight().image;
  if (!(targetW > 0 && targetH > 0 && wMax > 0 && hMax > 0)) return null;
  return Math.min(1, wMax / targetW, hMax / targetH);
}

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
    // `fitScale()` owns this number — the zoom-out floor reads the
    // same helper, so the two can't disagree about what "as far out
    // as Fit" means. It returns null in exactly the not-yet-loaded /
    // degenerate case the else branch handles.
    const scale = fitScale();
    if (scale !== null) {
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

export function setZoom(m: ZoomMode): void {
  zoomMode = typeof m === 'number' ? clampZoom(m) : m;
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

// ─── Zoom menu (popover) ──────────────────────────────────────────
//
// Built lazily on first open and inserted into `.highlight-controls`
// with `position: absolute; left: calc(100% + 6px)` so it floats to
// the right of the column without taking layout space — opening the
// menu doesn't push the image, just paints over the gap between the
// column and the image-box. Open / close / dismiss behaviour (top
// alignment, `aria-expanded`, Escape, outside-click) is shared with
// the More… menu through `createMenuPopover`; the menu items close
// it themselves as well.

let zoomMenuEl: HTMLDivElement | null = null;
let zoomPopover: MenuPopover | null = null;

function buildZoomMenu(): HTMLDivElement {
  const menu = document.createElement('div');
  menu.className = 'zoom-menu';
  menu.setAttribute('role', 'menu');
  // Same wiring the More menu carries in `capture.html`: the id lets
  // the button point at it with `aria-controls`, and `aria-labelledby`
  // gives the menu its accessible name.
  menu.id = 'zoom-menu';
  menu.setAttribute('aria-labelledby', 'zoom');
  menu.hidden = true;
  for (const value of ZOOM_PRESETS) {
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
    label.textContent = presetLabel(value);
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
  zoomPopover = createMenuPopover({
    menu,
    button: ctx.zoomBtn,
    // Check marks track the current mode, which can change between
    // opens (wheel zoom, Alt+±).
    onBeforeOpen: refreshZoomMenuChecks,
  });
  return menu;
}

function refreshZoomMenuChecks(): void {
  if (!zoomMenuEl) return;
  const items = Array.from(
    zoomMenuEl.querySelectorAll<HTMLButtonElement>('.zoom-menu-item'),
  );
  // Continuous zoom means the current scale usually sits between
  // presets — then nothing is checked, which is the honest reading of
  // a radio group whose options are all "off".
  const checked =
    zoomMode === 'fit' ? 'fit' : String(presetAt(zoomMode) ?? '');
  for (const item of items) {
    const v = item.dataset.zoom!;
    item.setAttribute('aria-checked', v === checked ? 'true' : 'false');
  }
}

function openZoomMenu(): void {
  if (!zoomMenuEl) zoomMenuEl = buildZoomMenu();
  zoomPopover?.open();
}

function closeZoomMenu(): void {
  zoomPopover?.close();
}

// ─── Wheel + keyboard zoom ────────────────────────────────────────
//
// Zoom is driven by Ctrl/Cmd+wheel and Alt+-/+ (Alt+= is a quiet
// no-shift alias for Alt++). Plain wheel / trackpad swipes are
// left alone so they fall through to native `.image-box` scroll —
// important for panning a tall image when zoomed in.
//
// Cursor-centered: the image-relative fraction the cursor (or last-
// known mouse position, for keyboard shortcuts) was over pre-zoom is
// preserved post-zoom by re-scrolling the box. When the focal point
// is outside the visible image (or unknown), the scale just changes.

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

// The scale the image is *actually* rendered at right now, measured
// rather than read off `zoomMode` — in Fit mode there is no number to
// read. This is what lets a wheel gesture leave Fit continuously:
// the first event picks up exactly where Fit had landed instead of
// jumping to some nominal level.
function renderedScale(): number {
  const { w } = targetCssSize();
  const r = ctx.imgRect();
  return w > 0 && r.width > 0 ? r.width / w : 1;
}

// Multiply zoom by `factor`, keeping (focalX, focalY) viewport coords
// stable. Wraps `cursorCenteredZoomTo` with the "what scale are we at
// now" question, which differs between Fit (measure it) and an
// explicit scale (read it).
function cursorCenteredZoomBy(
  factor: number,
  focalX: number | null,
  focalY: number | null,
): boolean {
  return cursorCenteredZoomTo(currentZoomScale() * factor, focalX, focalY);
}

// The scale a gesture continues from: measured in Fit mode, read
// directly otherwise.
function currentZoomScale(): number {
  return zoomMode === 'fit' ? renderedScale() : zoomMode;
}

// Zoom to `scale`, keeping (focalX, focalY) viewport coords stable
// when the focal point is over the visible image. We use natural
// fractions (the image-relative position the cursor was over) rather
// than displayed coords because the displayed image shrinks/grows
// around the same natural pixel under the cursor. The browser clamps
// `scrollLeft / scrollTop` to the new content bounds, so a target
// outside the scroll range simply scrolls maximally that way.
//
// Returns true if the zoom changed.
function cursorCenteredZoomTo(
  scale: number,
  focalX: number | null,
  focalY: number | null,
): boolean {
  // Nothing meaningful to zoom relative to until the image decodes:
  // `renderedScale()` would report a placeholder 1, and acting on it
  // would drop Fit mode and pin the page at ~1× — the load handler
  // honours a number, so it would never re-fit.
  if (!ctx.previewImg.naturalWidth) return false;

  // Zooming out stops at Fit: shrinking the image below the size
  // that already fits the window isn't useful, and it drags in side
  // effects — a small enough image leaves most of the pane bare, and
  // a Ctrl+wheel over that bare area misses `.image-box` entirely and
  // reaches the browser's own page zoom instead.
  //
  // `Math.min(…, cur)` keeps the floor from ever clamping *upward*:
  // Fit is height-bounded, so a squashed window (or a menu preset set
  // while the window was larger) can leave the current scale below
  // the floor, and a bare clamp would make the first zoom-out step
  // jump the image bigger — the opposite of what was asked for.
  // Zooming out can never grow the image; it just stops.
  const cur = currentZoomScale();
  const fit = fitScale();
  const floor = Math.min(fit ?? ZOOM_MIN, cur);
  const next = Math.min(ZOOM_MAX, Math.max(floor, scale));
  // No change — skip the re-render and the scroll rewrite, which
  // would otherwise nudge the view while the user keeps spinning the
  // wheel at a clamp bound.
  //
  // The comparison is against the *resolved* scale, not `zoomMode`,
  // so it holds in Fit mode too. That matters: a zero-delta
  // Ctrl+wheel (Ctrl + horizontal two-finger scroll sends deltaX
  // only) has factor 1, and converting Fit to the equal number would
  // silently freeze it — Fit would stop re-fitting on resize with no
  // visible change at the moment it happened.
  if (next === cur) return false;
  // Zooming out while Fit is armed: Fit already *is* the floor, so
  // there's nowhere to go — keep the mode rather than resolving it to
  // a number. Without this the tiny float gap between the measured
  // `renderedScale()` and the computed `fitScale()` is enough for
  // `next !== cur`, and Fit would be silently disarmed by a gesture
  // that changed nothing on screen. (Zooming *in* from Fit still
  // leaves the mode, which is the point.)
  if (zoomMode === 'fit' && next <= cur) return false;

  // Landing on the floor from above re-arms Fit rather than parking a
  // number that happens to equal it. Otherwise "zoom out until it
  // fits" leaves a frozen size that looks identical but stops
  // re-fitting on the next resize — two states, same pixels,
  // different behaviour later. Only when the floor really is the Fit
  // scale: a squashed window can floor at `cur` instead, and that
  // isn't Fit. The focal re-anchor below is unaffected — it measures
  // the post-zoom rects either way.
  const target: ZoomMode =
    fit !== null && next === floor && next === fit ? 'fit' : next;

  const useFocal =
    focalX !== null && focalY !== null &&
    isOverVisibleImage(focalX, focalY);
  let fx = 0, fy = 0;
  if (useFocal) {
    const r = ctx.imgRect();
    fx = (focalX! - r.left) / Math.max(1, r.width);
    fy = (focalY! - r.top) / Math.max(1, r.height);
  }

  setZoom(target);

  if (useFocal) {
    const r2 = ctx.imgRect();
    // Everything here is measured *after* the zoom, in the box's
    // scroll-content space.
    //
    // `scrollContentOrigin()` is what makes this land on the pixel:
    // the image's top-left is NOT at the box's content origin — the
    // `.image-wrap` margin offsets it, and a smaller-than-box image
    // is centered on top of that. The old math assumed that offset
    // away, which cost ~4 px per event. That was tolerable at one
    // event per detent, but a continuous gesture re-anchors ~30
    // times, and each step re-measures from the position the last
    // error produced — so the "fixed" pixel visibly crawled out from
    // under the cursor.
    //
    // Post-zoom is also the correct time to read the box: the scroll
    // target is defined in post-zoom layout.
    const origin = scrollContentOrigin();
    const box = ctx.imageBox.getBoundingClientRect();
    const contentX = box.left + ctx.imageBox.clientLeft;
    const contentY = box.top + ctx.imageBox.clientTop;
    // Put image-fraction (fx, fy) back under (focalX, focalY). The
    // browser clamps to the scroll range, so a focal near an edge (or
    // an image too small to scroll) simply goes as far as it can.
    ctx.imageBox.scrollLeft = origin.x + fx * r2.width - (focalX! - contentX);
    ctx.imageBox.scrollTop  = origin.y + fy * r2.height - (focalY! - contentY);
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

// Wheel / pinch zoom sensitivity, in log-scale units per pixel of
// `deltaY`: `scale *= exp(-deltaY * k)`. Exponential rather than
// additive so a given gesture multiplies the zoom by the same factor
// at every level — zooming 1× → 2× takes exactly as much wheel as
// 4× → 8×, which is what makes it feel uniform.
//
// This replaced a discretized ladder (fit / 1 / 2 / 4 / 8 stepped by
// an accumulator with idle + direction resets). The ladder's steps
// were doublings, so every step overshot, and the accumulator needed
// device-dependent thresholds to avoid a trackpad flying through all
// of them in one swipe. Nothing here is device-dependent except `k`.
//
// One 100 px mouse detent = e^0.25 ≈ 1.28×, i.e. ~2.8 detents per
// doubling.
const WHEEL_ZOOM_K = 0.0025;
// Trackpad pinch needs its own constant, not because the math
// differs but because Chrome reports pinch deltas roughly 8×
// smaller per unit of finger travel than a wheel detent — measured
// on ChromeOS, where WHEEL_ZOOM_K alone felt sluggish to the point
// of being unusable.
const PINCH_ZOOM_K = 0.02;
// Alt+± steps by a doubling, deliberately *not* matching the wheel's
// ~1.28× detent. A keypress is a discrete act — you press it to get
// somewhere, and needing three presses to reach a useful zoom makes
// the shortcut feel broken. The wheel is the continuous control; the
// keyboard is the coarse one. Doubling also lands on the 1 / 2 / 4 /
// 8 presets when starting from one.
const KEY_ZOOM_FACTOR = 2;

// Wheel deltas can arrive in lines or pages (`deltaMode`); normalize
// to pixels so `k` means one thing. Chrome sends pixels for both
// wheel and pinch, so these are defensive — Firefox and some Linux
// builds use line mode, where a detent is deltaY 3.
//
// `deltaX` is ignored: no shipping browser expresses a zoom gesture
// on the X axis, and a horizontal scroll under a held Ctrl shouldn't
// zoom.
const LINE_HEIGHT_PX = 40;
// A page is scaled like a few detents rather than like a viewport
// height — page mode is unreachable in Chrome, and using the box
// height (hundreds of px) would slam a single event straight to a
// clamp bound if it ever did arrive.
const PAGE_DELTA_PX = 200;
function wheelDeltaPixels(e: WheelEvent): number {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * LINE_HEIGHT_PX;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * PAGE_DELTA_PX;
  return e.deltaY;
}

// Does a Ctrl+wheel at this viewport Y belong to the image?
//
// Everything below the `<hr>` above the image area counts, not just
// `.image-box`. The image rarely fills that region — there's the tool
// palette to its left, gray surround to its right, and bare page
// below a short image — and a Ctrl+wheel that lands in any of it was
// still aimed at the image. Letting those through means an accidental
// *browser page* zoom, which is never what's wanted mid-edit and is
// annoying to undo.
//
// Above the separator (prompt, save options, capture card) it still
// passes through: that's ordinary page content where the browser's
// own zoom is a reasonable thing to ask for.
//
// A degenerate rect means the separator is hidden (it carries
// `data-capture-main`, so it goes with the rest in stale mode) — then
// no region qualifies, rather than the whole window qualifying.
function isInZoomRegion(vy: number): boolean {
  const r = ctx.mainSeparator.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return vy >= r.bottom;
}

// Is a Ctrl/Cmd modifier physically held? Chrome delivers a trackpad
// pinch as a wheel event with `ctrlKey: true` even though no key is
// down, so tracking the real key state is the only reliable way to
// tell a pinch from Ctrl+wheel — and the two need different `k`s.
//
// Magnitude can't substitute: a high-resolution scroll wheel (free-
// spin mice, and Chrome's high-precision wheel events generally)
// emits the same small fractional deltas a pinch does, so a
// threshold would hand those the 8× pinch constant and send the zoom
// flying. Erring the other way is harmless by comparison — a pinch
// misread as a wheel is merely slow.
let physicalZoomModifierDown = false;

function isSynthesizedPinch(e: WheelEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !physicalZoomModifierDown;
}

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
  // Re-fit whenever a new base image decodes. `initZoom` must stay
  // *after* `initDrawing` in capture-page.ts: drawing registers its
  // own `load` listener to clear the base-image swap guard, and
  // listeners fire in registration order — this `applyZoom → render`
  // is the one that has to see the guard already down, so it refreshes
  // the Image-size pill at the new size.
  ctx.previewImg.addEventListener('load', applyZoom);

  ctx.zoomBtn.addEventListener('click', () => {
    if (zoomPopover?.isOpen()) closeZoomMenu();
    else openZoomMenu();
  });

  // Physical Ctrl/Cmd tracking for `isSynthesizedPinch`. Capture
  // phase so a handler that stops propagation can't desync it, and a
  // blur reset because alt-tabbing away with Ctrl held never delivers
  // the keyup — leaving it stuck "down" would make every subsequent
  // pinch zoom at the slow wheel rate.
  const syncZoomModifier = (e: KeyboardEvent): void => {
    physicalZoomModifierDown = e.ctrlKey || e.metaKey;
  };
  window.addEventListener('keydown', syncZoomModifier, true);
  window.addEventListener('keyup', syncZoomModifier, true);
  // The blur reset lives in the shared focus-loss handler below,
  // which already exists for the same missed-Ctrl-keyup reason.

  // Listening on `window`, not `.image-box`, so the whole area below
  // the separator answers to Ctrl+wheel — see `isInZoomRegion`.
  // Chrome makes `wheel` on window passive by default, so
  // `passive: false` is required for `preventDefault` to take.
  window.addEventListener('wheel', (e) => {
    // Image zoom requires Ctrl (Cmd on macOS) — which a trackpad
    // pinch reports too, so pinch lands here as well. Plain wheel /
    // trackpad scroll falls through to native scrolling, necessary
    // for panning a tall image while zoomed in.
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!isInZoomRegion(e.clientY)) return;
    // Match the keyboard path: a modal edit dialog owns the page, and
    // the stale-capture state has no image worth zooming.
    if (ctx.anyEditDialogOpen() || ctx.isStaleMode()) return;

    // Always swallow Ctrl/Cmd+wheel here: the browser default would
    // page-zoom on top of (or instead of) our app zoom, which is
    // rarely what the user wants while editing a screenshot.
    e.preventDefault();

    const k = isSynthesizedPinch(e) ? PINCH_ZOOM_K : WHEEL_ZOOM_K;
    cursorCenteredZoomBy(
      Math.exp(-wheelDeltaPixels(e) * k),
      e.clientX,
      e.clientY,
    );
  }, { passive: false });

  window.addEventListener('mousemove', (e) => {
    lastMousePos = { x: e.clientX, y: e.clientY };
    // Re-sync the modifier from a real mouse event. `keydown` alone
    // misses the case where Ctrl was already held when the window
    // took focus (alt-tab back, Ctrl+click to focus), which leaves
    // the flag false and hands the next Ctrl+wheel the 8× pinch
    // constant — a runaway, the exact failure this design removed.
    //
    // A `mousemove`'s `ctrlKey` is trustworthy in both directions:
    // Chrome fabricates the modifier only on the synthetic *wheel*
    // event, never on pointer events, and a pinch produces no
    // mousemove at all. The hand on the wheel is the hand on the
    // mouse, so any real wheel gesture is preceded by one of these.
    physicalZoomModifierDown = e.ctrlKey || e.metaKey;
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
    cursorCenteredZoomBy(
      dir === 1 ? KEY_ZOOM_FACTOR : 1 / KEY_ZOOM_FACTOR,
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
    // Same missed-keyup story for the zoom modifier: alt-tabbing with
    // Ctrl held never delivers the keyup, and a stuck-true flag would
    // make every later pinch zoom at the slow wheel rate.
    physicalZoomModifierDown = false;
    if (panState) {
      panState = null;
      document.body.classList.remove('panning');
    }
    if (ctx.isPolylineActive()) ctx.endPolylineChain();
  });
}
