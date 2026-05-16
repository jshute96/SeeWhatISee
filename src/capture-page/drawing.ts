// Highlight overlay + canvas bake for the Capture page. Owns the
// entire annotation surface: the edit stack (`edits`, `editHistory`,
// `editVersion`), the tool palette and selection state, snap-to,
// box-resize handles, polyline chains, the live SVG `render()`, the
// dashed viewport-edge indicators, Shrink, and `renderHighlightedImage`
// — the canvas twin of `render()` that bakes the same edits into
// natural-resolution PNG/JPEG bytes for save / clipboard / Ask.
// `initDrawing(ctx)` is the only entry point.
//
// Drawing is *modal*: one of the tool buttons (Box / Line / Arrow /
// Redact / Crop) is selected at a time, and a left-button drag on the
// overlay produces an edit of that kind:
//
//   - Box     — red stroked rectangle (highlights a region).
//   - Line    — red diagonal line.
//   - Arrow   — red line with a barbed arrowhead at the click-release
//     end; barbs scale with segment length up to a fixed cap.
//   - Redact  — drag paints a filled black rectangle live, matching
//     the committed appearance — opaque black box that hides
//     whatever was underneath in the saved PNG.
//   - Crop    — drag paints the live cropped preview (dim frame
//     outside the drag bounds, dashed border, corner grips), so the
//     user sees what the cropped result will look like. Commits as
//     a crop region on mouseup; the saved PNG is shrunk to the
//     crop. Multiple crops stack; the most-recent active one wins.
//
// There's no right-click drawing. There's no in-place conversion
// between kinds: every drag commits one new edit of the active
// tool's kind, and Undo simply removes the last edit (Clear wipes
// the stack). Coordinates are percentages of the image so edits
// survive resizes and prompt growth.
//
// Edge-handle resize works alongside the tool palette: the four
// edges and four corners of any rect-shaped edit (rect / redact /
// crop) and — when no crop exists — the four edges of the image
// itself are draggable. Hit-testing walks the edit stack topmost-
// first so a newer box on top of an older one wins. Resize gestures
// mutate the targeted edit in place and record a Shrink-style `prev`
// history op so Undo restores the pre-drag geometry one click at a
// time. The image-edge fallback (only fires when no active crop
// exists) commits a fresh `crop` edit instead — that's the "drag
// image edge to start a crop" affordance.
//
// The HANDLE_PX hit band normally wins over the selected tool, so a
// Box drag that starts in the band starts a resize instead of a
// Box draw. Holding Shift on mousedown bypasses the hit test, which
// lets the user start a fresh draw flush against an existing box's
// edge.

import { shrink as shrinkRect } from '../shrink.js';
import {
  currentDisplayScale,
  isOverVisibleImage,
  isOverImageBoxScrollbar,
  isWithinEdgeCommitBuffer,
  startPan,
  getLastMousePos,
  setLastMousePos,
} from './zoom.js';

export type Point = { x: number; y: number };
export type RectKind = 'rect' | 'redact' | 'crop';
export type LineKind = 'line' | 'arrow';
// Tool palette identifiers. `polyline` / `polyarrow` are the
// dedicated polyline tools: each commits as a regular 'line' or
// 'arrow' edit (see `polylineToolLineKind`) but the tool drives the
// chain-mode entry semantics — no Ctrl modifier required.
export type PolylineTool = 'polyline' | 'polyarrow';
export type Tool = RectKind | LineKind | PolylineTool;

// Map a polyline tool to the line-edit kind it commits. Returns
// null for non-polyline tools so callers can branch cleanly.
function polylineToolLineKind(t: Tool): LineKind | null {
  if (t === 'polyline') return 'line';
  if (t === 'polyarrow') return 'arrow';
  return null;
}

// True for any tool that draws a line-shaped edit (line / arrow /
// polyline / polyarrow). Used wherever the drawing pipeline branches
// "line-family vs box-family" — stroke shape, cursor, Shrink-disabled,
// arrow-key nudge direction filter, etc.
function isLineFamilyTool(t: Tool): boolean {
  return t === 'line' || t === 'arrow' || polylineToolLineKind(t) !== null;
}

export interface RectEdit {
  id: number;
  kind: RectKind;
  x: number; y: number; w: number; h: number;
}
export interface LineEdit {
  id: number;
  kind: LineKind;
  x1: number; y1: number; x2: number; y2: number;
}
export type Edit = RectEdit | LineEdit;

// History is a log of edit-stack mutations. Undo pops the most
// recent entry and reverses it:
//
//   - No `prev` field — the op was an "add", so undo removes the
//     matching edit from the stack (the original behaviour).
//   - `prev` field set — the op mutated an existing edit's geometry
//     in place; undo restores those pre-mutation coordinates so the
//     user can step back through a chain of in-place edits one
//     click at a time. Pushed by both Shrink clicks and edge-handle
//     resize drags (rect / redact / crop) — both operations share
//     the same in-place-mutate shape.
type HistoryOp = {
  id: number;
  prev?: { x: number; y: number; w: number; h: number };
};

const SVG_NS = 'http://www.w3.org/2000/svg';
// Movement under this many CSS pixels counts as a stray click, not
// a drag — discarded so a single click never produces a degenerate
// zero-size rectangle or a zero-length line.
const CLICK_THRESHOLD_PX = 4;

const edits: Edit[] = [];
// Named `editHistory` (not `history`) because the browser globals
// include a read-only `window.history` that a bare `history`
// identifier would otherwise collide with at type-checking time.
const editHistory: HistoryOp[] = [];
let nextEditId = 1;
let dragStart: Point | null = null;
let dragCurrent: Point | null = null;

// Currently selected drawing tool. Default 'rect' matches the
// `.selected` class on the Box button in capture.html. Updated by
// the tool-button click handler below; only ever read inside
// render() and the mouseup handler.
let selectedTool: Tool = 'rect';

/**
 * Monotonic edit counter. Bumped every time the highlight stack
 * changes (drawn rect/line, undo, clear, shrink). Read by main's
 * Copy / Capture flow so the SW can decide whether the cached
 * on-disk PNG still represents the user's current state.
 *
 * HTML and selection are also editable (via the Edit dialogs), but
 * they don't need a parallel counter: the SW invalidates their
 * download cache by dropping the entry on `updateArtifact`, and the
 * page never speculatively materializes them — only Copy / Capture
 * trigger a download, and that download path always reads the SW's
 * authoritative body. The screenshot is the only artifact whose
 * "current state" lives entirely on the page (in the SVG overlay)
 * and so needs a version handshake to coordinate cache validity.
 */
let editVersion = 0;

// ─── Polyline (multi-line / multi-arrow) state ────────────────────
//
// Set when the user holds Ctrl (Cmd on macOS) while drawing with
// the Line or Arrow tool — at the *commit* (mouseup) of each
// segment, the next segment's start is anchored at the segment's
// endpoint and `dragStart` stays non-null so the live preview keeps
// drawing from there. The chain ends when:
//   - Ctrl/Meta is released (window keyup handler clears state),
//   - the user switches tools (`setSelectedTool` clears state), or
//   - the user mouses-up without Ctrl held (the mouseup path
//     commits the current segment and exits the chain).
//
// While active and the mouse button is *not* pressed, mousemove
// keeps updating `dragCurrent` because `dragStart` stays set, so
// the preview tracks the cursor between clicks. A click in this
// state commits the segment from previous endpoint to click point;
// a drag in this state commits to the release point. Both shapes
// are handled by the same line/arrow mouseup branch.
let polylineLineKind: LineKind | null = null;

// True between mousedown and mouseup of any left-button overlay
// gesture during line/arrow tool — captures both the initial
// polyline-entry mousedown and a mid-chain continuation mousedown.
// Lets the keyup handler decide whether Ctrl/Meta release should
// clear the in-flight drag immediately (between segments) or defer
// to the upcoming mouseup (mid-drag, so the in-flight segment can
// still commit). Cleared on mouseup and on window blur.
let polylineMouseHeld = false;

// First segment's anchor for the active polyline chain, captured at
// the first segment's commit (so the chain is already known to be
// alive). Lets a subsequent segment's endpoint snap to it, closing
// the chain into a polygon. Cleared alongside `polylineLineKind` on
// every chain-ending path.
let polylineChainStart: Point | null = null;

// Tracks how the active chain was entered:
//   - `true` — Ctrl/Cmd was held at mouseup of a Line/Arrow draw and
//     promoted the segment to a chain. Ctrl/Meta release ends the
//     chain (legacy modifier-driven semantics).
//   - `false` — entered via the Polyline / Poly-arrow tool button.
//     Ctrl/Meta release does *nothing*; the user finishes with Esc,
//     a click on the chain head, a tool switch, or window blur.
// Distinguishing the two lets us keep the ergonomic Ctrl shortcut
// for Line/Arrow without bricking the dedicated-tool chain when the
// user incidentally taps Ctrl.
let polylineEntryWasCtrl = false;

// Centralises the chain-end cleanup so every exit path (mouseup
// without continue, keyup, Esc, click-on-head, setSelectedTool, blur)
// clears state the same way. Re-renders so the live preview ghost
// disappears immediately.
export function endPolylineChain(): void {
  polylineLineKind = null;
  polylineChainStart = null;
  polylineEntryWasCtrl = false;
  polylineMouseHeld = false;
  dragStart = null;
  dragCurrent = null;
  render();
}

export function isPolylineActive(): boolean {
  return polylineLineKind !== null;
}

// Rescale every CSS-pixel position stored at module scope. Called
// from `applyZoom()` whenever the image's rendered dimensions change
// (zoom step, Fit re-layout on window resize, etc.). Committed edits
// are stored in percentages and are unaffected — only the in-flight
// drag/polyline anchors live in image-rect-local CSS px and would
// otherwise drift after a zoom change, leaving e.g. the next polyline
// segment disconnected from the previous endpoint and breaking the
// loop-close hit-test.
export function rescaleAfterImageResize(scaleX: number, scaleY: number): void {
  if (scaleX === 1 && scaleY === 1) return;
  if (dragStart !== null) {
    dragStart = { x: dragStart.x * scaleX, y: dragStart.y * scaleY };
  }
  if (dragCurrent !== null) {
    dragCurrent = { x: dragCurrent.x * scaleX, y: dragCurrent.y * scaleY };
  }
  if (polylineChainStart !== null) {
    polylineChainStart = {
      x: polylineChainStart.x * scaleX,
      y: polylineChainStart.y * scaleY,
    };
  }
  if (boxDrag !== null) {
    boxDrag.originX *= scaleX;
    boxDrag.originY *= scaleY;
  }
}

// ─── Box-resize drag state ────────────────────────────────────────
//
// Drives edge-handle drags on rect-shaped edits (rect / redact /
// crop) and on the image edges (the "no crop yet → drag to crop"
// affordance). The current target is identified by `editId`:
//   - `editId !== null` — resize an existing edit in place. Mouseup
//     mutates the targeted edit's bounds and records a Shrink-style
//     `prev` history op so Undo restores the pre-drag geometry.
//     Used for all three rect-shaped kinds — the visual stack stays
//     stable (no spurious duplicate boxes appearing on each drag).
//   - `editId === null` — create a brand-new `crop` edit from the
//     image bounds. Mouseup pushes a fresh edit onto the stack with
//     a plain `add` history op.
//
// Handles are sampled by hit-testing a `HANDLE_PX` band around the
// edges of the candidate rectangle. Corner regions take precedence
// over edges (the four-way cursor beats the one-axis cursor).
type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
// Alias for readability at this section's call sites — same set as
// `RectKind` (the kinds that carry rectangular geometry); kept as a
// separate name so the box-resize code reads naturally.
type BoxKind = RectKind;

// Width of the edge-hit band in CSS pixels. Tuned by feel: large
// enough to grab without precision aiming, small enough that
// drawing a fresh box close to an existing one's edge isn't a fight.
// Reduced from a previous wider band that felt sticky on small
// boxes.
const HANDLE_PX = 6;

// Minimum width/height as a fraction of the image, so a resize
// drag can't collapse a box to 0×0 (which would make it impossible
// to grab the handles on the next drag). 1.5% picks up ~9 px on a
// 600 px preview — enough room to click on without being a wasted
// constraint. Shared across rect / redact / crop so the floor
// behavior is uniform.
const MIN_BOX_PCT = 1.5;

interface BoxDragState {
  // Which kind of box this drag is editing. Drives commit semantics
  // and the live render path (rect/redact draw inline; crop drives
  // the dim-frame preview).
  kind: BoxKind;
  // Edit being mutated, or null when the gesture is creating a fresh
  // `crop` edit from the image-edge fallback.
  editId: number | null;
  handle: CropHandle;
  // Starting geometry in percentages — the box we're editing.
  // Either the targeted edit's bounds or, for the image-edge crop-
  // create gesture, the full image (0, 0, 100, 100).
  startX: number; startY: number; startW: number; startH: number;
  // Where the pointer was when the drag began, in display pixels.
  // We track deltas rather than absolute positions so a drag that
  // starts slightly off-edge (within HANDLE_PX) still produces the
  // expected motion.
  originX: number; originY: number;
  // Live proposed bounds, updated every mousemove and rendered as
  // the preview box. Commit-on-mouseup either mutates the targeted
  // edit (in-place) or pushes a fresh `crop` edit, depending on
  // `editId`.
  curX: number; curY: number; curW: number; curH: number;
}
let boxDrag: BoxDragState | null = null;

// ─── DOM refs + main-side callbacks, set by initDrawing ──────────
//
// All drawing-side state lives at module scope, but the DOM nodes
// and the main-side bridges arrive via the context passed to
// `initDrawing`. Internal functions close over the `ctx` binding
// rather than recapturing each field — keeps callsites tidy and
// makes drawing trivially re-init-able for tests.

/**
 * Everything the drawing module needs from the rest of the Capture
 * page. Passed once at init time; all internal functions read
 * `ctx.*`.
 */
export interface DrawingContext {
  previewImg: HTMLImageElement;
  imageBox: HTMLDivElement;
  overlay: SVGSVGElement;
  edgesSvg: SVGSVGElement;
  shrinkBtn: HTMLButtonElement;
  undoBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  /** All `.tool-btn` elements in DOM order. Drawing reads
   *  `dataset.tool`, toggles `.selected` / `aria-pressed`, and wires
   *  the mousedown handler. */
  toolButtons: HTMLButtonElement[];

  /** Re-derive the Image-size pill's bake-derived parts. Called
   *  from `render()` after every edit-stack change so the
   *  pill's format / bytes track the current state. */
  updateImageSizeBadge(): void;
  /** Recompose the Image-size pill's textContent from the cached
   *  parts + live crop dimensions. Called from `render()` so a
   *  crop-drag mousemove refreshes the displayed size in real
   *  time without re-baking. */
  composeImageBadgeText(): void;
}

let ctx: DrawingContext;

export function imgRect(): DOMRect {
  return ctx.previewImg.getBoundingClientRect();
}

// The *visible* image pane, in viewport coords: the intersection of
// the image's bounding rect and the image-box's content area
// (`clientWidth/Height` to exclude scrollbars). In Fit mode this
// equals `imgRect`. In Nx zoom modes the image extends past the
// box and only a smaller scroll-window is on screen — clamping to
// this rect (rather than the raw image) keeps drag previews and
// polyline segments from drifting into scrolled-out regions the
// user can't see.
export function visibleImageRect(): { left: number; top: number; right: number; bottom: number } {
  const r = imgRect();
  const boxRect = ctx.imageBox.getBoundingClientRect();
  // `clientLeft / clientTop` are the box's border widths — both 0
  // today since `.image-box` carries no CSS border, but added
  // defensively so a future border doesn't silently clamp drags
  // one pixel past the content area.
  const contentLeft = boxRect.left + ctx.imageBox.clientLeft;
  const contentTop = boxRect.top + ctx.imageBox.clientTop;
  return {
    left: Math.max(contentLeft, r.left),
    top: Math.max(contentTop, r.top),
    right: Math.min(contentLeft + ctx.imageBox.clientWidth, r.right),
    bottom: Math.min(contentTop + ctx.imageBox.clientHeight, r.bottom),
  };
}

function localCoords(e: MouseEvent): Point {
  const r = imgRect();
  // Clamp the cursor to the visible-pane rect (see
  // `visibleImageRect` above), then express in image-relative
  // coords. Off-screen cursor positions get pinned to the nearest
  // visible edge, so any drag commit / polyline segment ends at a
  // point the user can actually see.
  const v = visibleImageRect();
  const vx = Math.min(Math.max(e.clientX, v.left), v.right);
  const vy = Math.min(Math.max(e.clientY, v.top), v.bottom);
  return {
    x: vx - r.left,
    y: vy - r.top,
  };
}

// The effective crop rectangle is the most-recently-added 'crop'
// edit still in the stack. Earlier crops are hidden by the newer
// one's dim overlay; on save, only the newest crop bounds the output.
//
// A crop that covers the entire image (all four edges at the image
// boundary) is returned as `undefined` — it's functionally a no-op
// (the saved PNG matches the original) and visually has nothing to
// show (no dim outside, no meaningful edges), so we treat it as
// "no crop" everywhere: rendering, the `isCropped` flag on the
// saved record, and the bake-in transform. The edit itself stays
// in the stack so Undo can still walk back through it.
//
// The boundary check uses a small EPS slack because edge-handle
// drags route the cursor through `cssPx / r.width * 100` and the
// resulting percent can land at 99.999… instead of exactly 100 on
// some viewport sizes. EPS is 0.001 percent — well under one
// natural pixel even for very large images (1 px in 100 000 px),
// so collapsing within that band is safely indistinguishable from
// an exact full-image crop.
const FULL_IMAGE_EPS = 0.001;
// The "effective crop region" used to position the dim frame, the
// dashed border, and the corner grips: the live drag bounds if a
// crop drag is in flight (either a Crop-tool *creation* drag or a
// handle *resize* drag), else the committed `activeCrop`, else
// the implicit full image (returned to callers as `undefined`).
function computeCropPreview(): { x: number; y: number; w: number; h: number } | undefined {
  if (selectedTool === 'crop' && dragStart && dragCurrent) {
    const r = imgRect();
    return {
      x: (Math.min(dragStart.x, dragCurrent.x) / r.width) * 100,
      y: (Math.min(dragStart.y, dragCurrent.y) / r.height) * 100,
      w: (Math.abs(dragCurrent.x - dragStart.x) / r.width) * 100,
      h: (Math.abs(dragCurrent.y - dragStart.y) / r.height) * 100,
    };
  } else if (boxDrag && boxDrag.kind === 'crop') {
    return { x: boxDrag.curX, y: boxDrag.curY, w: boxDrag.curW, h: boxDrag.curH };
  }
  const crop = activeCrop();
  if (crop) return { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
  return undefined;
}

export function activeCrop(): RectEdit | undefined {
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    if (e.kind === 'crop') {
      if (
        e.x <= FULL_IMAGE_EPS &&
        e.y <= FULL_IMAGE_EPS &&
        e.w >= 100 - FULL_IMAGE_EPS &&
        e.h >= 100 - FULL_IMAGE_EPS
      ) {
        return undefined;
      }
      return e;
    }
  }
  return undefined;
}

function cursorForHandle(h: CropHandle): string {
  switch (h) {
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'nw': case 'se': return 'nwse-resize';
  }
}

// Hit-test the pointer against a single rectangle's edges, in
// percent-space coordinates. Returns which handle (if any) the
// pointer is inside the HANDLE_PX band of. Corners take precedence
// over plain edges: a pointer that's near both the top and the left
// counts as the 'nw' corner handle.
//
// Edge bands only match when the pointer is also inside the
// perpendicular extent of the rectangle (plus a small outside band
// so the handle is grabbable when the rect is flush with the image
// edge). Without this clamp, a pointer halfway down the image in
// empty space beside the rect would count as "near the left edge"
// and flip the cursor to resize, which is confusing.
function handleAtRect(
  p: Point,
  rectPct: { x: number; y: number; w: number; h: number },
): CropHandle | null {
  const r = imgRect();
  const cx = (rectPct.x / 100) * r.width;
  const cy = (rectPct.y / 100) * r.height;
  const cw = (rectPct.w / 100) * r.width;
  const ch = (rectPct.h / 100) * r.height;

  const nearLeft = Math.abs(p.x - cx) <= HANDLE_PX;
  const nearRight = Math.abs(p.x - (cx + cw)) <= HANDLE_PX;
  const nearTop = Math.abs(p.y - cy) <= HANDLE_PX;
  const nearBottom = Math.abs(p.y - (cy + ch)) <= HANDLE_PX;

  const withinY = p.y >= cy - HANDLE_PX && p.y <= cy + ch + HANDLE_PX;
  const withinX = p.x >= cx - HANDLE_PX && p.x <= cx + cw + HANDLE_PX;

  if (nearTop && nearLeft) return 'nw';
  if (nearTop && nearRight) return 'ne';
  if (nearBottom && nearLeft) return 'sw';
  if (nearBottom && nearRight) return 'se';
  if (nearTop && withinX) return 'n';
  if (nearBottom && withinX) return 's';
  if (nearLeft && withinY) return 'w';
  if (nearRight && withinY) return 'e';
  return null;
}

// What the next mousedown would grab if it landed at `p`: the
// topmost rect-shaped edit whose edge is within HANDLE_PX, or the
// image-edge fallback (only when no active crop exists) for the
// "drag image edge to start a crop" gesture. Caller is responsible
// for honouring Shift-bypass — this function doesn't know about
// modifier state.
type BoxHandleHit = {
  kind: BoxKind;
  // null when targeting the image edges (no active crop). On commit
  // a fresh `crop` edit is pushed onto the stack instead of
  // mutating an existing one.
  editId: number | null;
  bounds: { x: number; y: number; w: number; h: number };
  handle: CropHandle;
};
function detectBoxHandle(p: Point): BoxHandleHit | null {
  // Walk the stack topmost-first so a newer box layered on top of
  // an older one wins the gesture — matches what the user sees.
  // Older `crop` edits are functionally invisible (the active crop's
  // dim frame masks them) so we skip them and let the active crop
  // (if any) match through its own iteration step.
  const ac = activeCrop();
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    if (e.kind !== 'rect' && e.kind !== 'redact' && e.kind !== 'crop') continue;
    if (e.kind === 'crop' && (!ac || ac.id !== e.id)) continue;
    const handle = handleAtRect(p, { x: e.x, y: e.y, w: e.w, h: e.h });
    if (handle) {
      return {
        kind: e.kind,
        editId: e.id,
        bounds: { x: e.x, y: e.y, w: e.w, h: e.h },
        handle,
      };
    }
  }
  // Image-edge fallback: only when there's no active crop, since
  // the active crop's edges already covered any near-image-edge
  // hits above.
  if (!ac) {
    const handle = handleAtRect(p, { x: 0, y: 0, w: 100, h: 100 });
    if (handle) {
      return {
        kind: 'crop',
        editId: null,
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        handle,
      };
    }
  }
  return null;
}

// ─── Snap-to ──────────────────────────────────────────────────────
//
// During any pointer-driven drag (line / arrow draw, box draw, box
// edge / corner resize), the moving target point snaps to nearby
// "interesting" geometry when it lands within `SNAP_PX`. Targets
// are organised into priority tiers (highest first) — the snap
// picks the closest candidate in the *highest non-empty tier within
// radius*, so a slightly-further endpoint always wins over a
// slightly-closer edge projection. The user's intent on a
// "near-something" gesture usually targets a specific feature, not
// whichever pixel happened to be closest:
//
//   Tier 1 — endpoints:
//     - Endpoints of every line / arrow edit (`(x1,y1)` and `(x2,y2)`).
//     - The polyline chain start (when drawing a polyline) — snapping
//       a segment's endpoint to it closes the loop into a polygon.
//   Tier 2 — corners:
//     - The four corners of every box-shaped edit (rect / redact / crop).
//     - The four corners of the image bounding box.
//   Tier 3 — edges:
//     - The nearest point on any box edge (incl. the image bounding
//       box's edges) — projects the cursor onto the edge segment,
//       so a near-edge slide "tracks" along the edge.
//
// Holding Shift disables snap entirely (and is already used elsewhere
// to bypass affordances like box-handle hit-testing). Arrow-key
// nudges bypass snap too — they call `updateDragFromLocalPoint`
// directly without passing through the snap step, so a user who
// snapped onto a target with the mouse can still fine-tune one
// natural pixel at a time with the keyboard.
//
// A drag never snaps to its own geometry: the in-flight box-resize
// excludes the edit it's mutating, and a fresh-draw box has no
// committed geometry yet to snap to. The image-edge "create a fresh
// crop" gesture (boxDrag with `editId === null`) additionally
// excludes the image bounding box from snap candidates — otherwise
// the cursor would re-snap to the edge it's trying to leave.
const SNAP_PX = 8;

// Returns the closest point on `rect`'s edges to `p`. `rect` is in
// image-percent coordinates; `p` and the return value are in
// display CSS pixels. Picks the closest of the edge-projected
// candidates by Euclidean distance.
function nearestPointOnRectEdges(
  p: Point,
  rect: { x: number; y: number; w: number; h: number },
): Point {
  const r = imgRect();
  const left = (rect.x / 100) * r.width;
  const top = (rect.y / 100) * r.height;
  const right = left + (rect.w / 100) * r.width;
  const bottom = top + (rect.h / 100) * r.height;
  // Project p onto each edge segment by clamping the free axis into
  // the edge's extent.
  const candidates: Point[] = [
    { x: Math.max(left, Math.min(right, p.x)), y: top },
    { x: Math.max(left, Math.min(right, p.x)), y: bottom },
    { x: left,  y: Math.max(top, Math.min(bottom, p.y)) },
    { x: right, y: Math.max(top, Math.min(bottom, p.y)) },
  ];
  let best = candidates[0]!;
  let bestD = Math.hypot(best.x - p.x, best.y - p.y);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// Returns the closest point on the segment from `a` to `b` to `p`,
// in the same coordinate space as the inputs. Projects `p` onto the
// segment's infinite line and clamps the parameter to `[0, 1]` so
// the result stays on the segment. Used for diagonal line / arrow
// snap-projection in the lowest priority tier; box edges have a
// faster axis-aligned form (`nearestPointOnRectEdges`).
function nearestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

interface SnapOptions {
  // Polyline chain origin; when the user is mid-chain and the cursor
  // lands within `SNAP_PX` of it, snap there to close the loop. Pass
  // `null` (or omit) when no chain is active.
  chainStart?: Point | null;
  // Candidate filter: skip any target within `~0.5 CSS px` of this
  // point. Used by the polyline live preview to drop the previous
  // segment's endpoint (= `dragStart`) from the candidate set —
  // without this, the in-flight endpoint would snap *back* onto its
  // own anchor every time the cursor crossed within `SNAP_PX` of it,
  // leaving a zero-length preview until the cursor cleared the
  // radius. Box-resize uses its own self-exclusion path
  // (`snapBoxDragCursor` filters by `bd.editId`), so this field is
  // only set for the line/arrow point-snap path.
  excludeAnchor?: Point | null;
}

// Returns the snapped version of `p` (in image-rect-local CSS px),
// or `p` itself when no candidate is within `SNAP_PX`. Priority
// tiers (highest first): endpoints → corners → edges. The closest
// candidate in the *highest non-empty tier within radius* wins, so a
// slightly-further endpoint always beats a slightly-closer corner or
// edge projection. See the section header above for the full rules.
function snapPoint(p: Point, opts: SnapOptions = {}): Point {
  const r = imgRect();
  const endpoints: Point[] = [];
  const corners: Point[] = [];
  const edgePoints: Point[] = [];
  // Polyline chain start is treated as an endpoint (tier 1) — it IS
  // segment 1's start point, and the loop-close gesture wants the
  // strong "snap onto this exact feature" priority.
  if (opts.chainStart) endpoints.push(opts.chainStart);
  corners.push({ x: 0,       y: 0        });
  corners.push({ x: r.width, y: 0        });
  corners.push({ x: 0,       y: r.height });
  corners.push({ x: r.width, y: r.height });
  edgePoints.push(nearestPointOnRectEdges(p, { x: 0, y: 0, w: 100, h: 100 }));
  for (const e of edits) {
    if (e.kind === 'rect' || e.kind === 'redact' || e.kind === 'crop') {
      const x = (e.x / 100) * r.width;
      const y = (e.y / 100) * r.height;
      const w = (e.w / 100) * r.width;
      const h = (e.h / 100) * r.height;
      corners.push({ x,        y        });
      corners.push({ x: x + w, y        });
      corners.push({ x,        y: y + h });
      corners.push({ x: x + w, y: y + h });
      edgePoints.push(nearestPointOnRectEdges(p, e));
    } else if (e.kind === 'line' || e.kind === 'arrow') {
      const a = { x: (e.x1 / 100) * r.width, y: (e.y1 / 100) * r.height };
      const b = { x: (e.x2 / 100) * r.width, y: (e.y2 / 100) * r.height };
      endpoints.push(a);
      endpoints.push(b);
      // Tier-3 projection onto the line itself — picks up diagonals
      // that aren't covered by box-edge projections. Endpoint-tier
      // dominates this when the cursor is near either end.
      edgePoints.push(nearestPointOnSegment(p, a, b));
    }
  }
  // Filter targets within ~0.5 CSS px of an explicit exclude anchor
  // (polyline preview drops its own start anchor — see SnapOptions).
  const anchor = opts.excludeAnchor ?? null;
  const keep = (t: Point): boolean =>
    anchor === null || Math.hypot(t.x - anchor.x, t.y - anchor.y) >= 0.5;
  // Walk tiers in priority order; first tier with a within-radius
  // candidate wins, and its closest non-excluded member is the snap
  // target.
  for (const tier of [endpoints, corners, edgePoints]) {
    let best: Point | null = null;
    let bestD = SNAP_PX;
    for (const t of tier) {
      if (!keep(t)) continue;
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best !== null) return best;
  }
  return p;
}

// Convenience: assemble the SnapOptions for a fresh-draw or line/
// arrow drag (point-based snap). Box-resize uses `snapBoxDragCursor`
// below instead — the edge being moved needs to land on the target
// axis, which isn't the same as snapping the cursor.
//
// When polyline mode is alive, `dragStart` holds the previous
// segment's snapped endpoint — which is ALSO a committed line
// endpoint in `edits`. Without explicit exclusion the in-flight
// preview would snap right back onto its anchor, leaving a zero-
// length segment until the cursor cleared the snap radius.
function pointSnapOptions(): SnapOptions {
  return {
    chainStart: polylineChainStart,
    excludeAnchor: polylineLineKind !== null ? dragStart : null,
  };
}

// Snap a line/arrow segment to horizontal or vertical when the
// off-axis delta is within `SNAP_PX`. `anchor` is the segment's
// start (= `dragStart` for fresh draws and for polyline segments);
// `p` is the candidate endpoint. The axis with the smaller absolute
// delta wins on a tie — "closer to axis-aligned".
//
// Applied AFTER feature snap (and only when feature snap didn't
// fire). Landing on a specific endpoint / corner / edge expresses
// stronger intent than "make it horizontal", so feature snap takes
// precedence — the user who wants axis-align over a nearby feature
// can hold Shift to disable both, then re-aim.
function snapAxisAligned(p: Point, anchor: Point): Point {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (ady < SNAP_PX && ady <= adx) return { x: p.x, y: anchor.y };
  if (adx < SNAP_PX && adx < ady)  return { x: anchor.x, y: p.y };
  return p;
}

// Axis-aware snap for a box edge / corner resize drag. Instead of
// snapping the *cursor* (which would offset the edge by the
// mousedown-inside-the-handle inset), this shifts the cursor delta
// just enough that the dragged edge lands exactly on a nearby axis
// of interest. Each free axis snaps independently:
//   - East / west drags consider only x candidates (other boxes'
//     vertical edges, line endpoints' x, and — except for the
//     image-edge crop-create case — the image bbox left/right x).
//   - North / south drags consider only y candidates.
//   - Corner handles consider both axes; a corner of another box
//     contributes its x to the x pool and its y to the y pool, but
//     the two axes resolve independently so the dragged corner can
//     align with one box's column and another box's row.
//
// Returns the snapped cursor position. The caller passes this into
// `updateDragFromLocalPoint`, which re-derives dxPct/dyPct from the
// shifted cursor and feeds `applyEdgeDrag` — landing the edge
// exactly on the snap axis after the percent rounding.
function snapBoxDragCursor(p: Point, bd: BoxDragState): Point {
  const r = imgRect();
  const h = bd.handle;
  const draggingTop = h === 'n' || h === 'ne' || h === 'nw';
  const draggingBottom = h === 's' || h === 'se' || h === 'sw';
  const draggingLeft = h === 'w' || h === 'nw' || h === 'sw';
  const draggingRight = h === 'e' || h === 'ne' || h === 'se';

  // Where the dragged edges currently sit (in CSS px image-local),
  // given the un-snapped cursor `p`. The delta is computed the same
  // way `updateDragFromLocalPoint` does — keeping the two in sync is
  // why we shift the cursor by `(target - current)` below.
  const dxCss = p.x - bd.originX;
  const dyCss = p.y - bd.originY;
  const startLeftCss = (bd.startX / 100) * r.width;
  const startTopCss = (bd.startY / 100) * r.height;
  const startRightCss = startLeftCss + (bd.startW / 100) * r.width;
  const startBottomCss = startTopCss + (bd.startH / 100) * r.height;

  const edgeXCss: number | null =
    draggingLeft  ? startLeftCss  + dxCss :
    draggingRight ? startRightCss + dxCss :
    null;
  const edgeYCss: number | null =
    draggingTop    ? startTopCss    + dyCss :
    draggingBottom ? startBottomCss + dyCss :
    null;

  // Same priority tiers as `snapPoint`, restricted to the moving
  // axes: endpoints first, then corners. Box edges contribute the
  // same x / y values as box corners (every rect has 2 corner x's
  // that also serve as left/right edge x's, likewise for y), so
  // there's no separate "edges" tier for axis snap.
  const endpointXs: number[] = [];
  const endpointYs: number[] = [];
  const cornerXs: number[] = [];
  const cornerYs: number[] = [];
  // The image-edge "create a fresh crop" gesture (editId === null)
  // is the only case where the dragged geometry IS the image bbox —
  // including the bbox in the candidate pool would re-snap the edge
  // back onto itself. Every other drag treats the bbox as a valid
  // reference.
  const excludeImageBbox = bd.editId === null;
  if (!excludeImageBbox) {
    cornerXs.push(0, r.width);
    cornerYs.push(0, r.height);
  }
  for (const ed of edits) {
    if (ed.id === bd.editId) continue;
    if (ed.kind === 'rect' || ed.kind === 'redact' || ed.kind === 'crop') {
      const x = (ed.x / 100) * r.width;
      const w = (ed.w / 100) * r.width;
      const y = (ed.y / 100) * r.height;
      const hPx = (ed.h / 100) * r.height;
      cornerXs.push(x, x + w);
      cornerYs.push(y, y + hPx);
    } else if (ed.kind === 'line' || ed.kind === 'arrow') {
      endpointXs.push((ed.x1 / 100) * r.width, (ed.x2 / 100) * r.width);
      endpointYs.push((ed.y1 / 100) * r.height, (ed.y2 / 100) * r.height);
    }
  }

  // Walk tiers in priority order; the first one with a within-radius
  // candidate decides the shift. Returns 0 when the axis isn't free
  // (null `cur`) or nothing snaps.
  const bestAxisShift = (cur: number | null, tiers: number[][]): number => {
    if (cur === null) return 0;
    for (const tier of tiers) {
      let bestD = SNAP_PX;
      let shift = 0;
      for (const c of tier) {
        const d = Math.abs(c - cur);
        if (d < bestD) { bestD = d; shift = c - cur; }
      }
      if (bestD < SNAP_PX) return shift;
    }
    return 0;
  };
  const shiftX = bestAxisShift(edgeXCss, [endpointXs, cornerXs]);
  const shiftY = bestAxisShift(edgeYCss, [endpointYs, cornerYs]);
  return { x: p.x + shiftX, y: p.y + shiftY };
}

// Given an initial rectangle and a pointer delta (in display
// pixels) on a specific handle, compute the proposed new rectangle
// in percentages. Caller already translated the pointer delta;
// this function only enforces:
//   - Correct axis for each handle (n/s move only the top/bottom
//     edge; e/w move only the left/right; corners move two edges).
//   - The rect stays inside the image (0 ≤ x, x+w ≤ 100, likewise y).
//   - Dragged edges clamp at `MIN_BOX_PCT` away from the opposite
//     (undragged) edge. The opposite edge never moves — a shrink
//     drag just stops once it bottoms out at the minimum. This
//     keeps the behavior symmetric across all four sides; an
//     earlier version allowed the west/north clamps to push the
//     opposite edge outward, which made N/W drags feel different
//     from S/E drags.
//
// Shared between rect / redact / crop resize gestures (and the
// image-edge crop-create gesture); the constraints are uniform
// across all four since the same MIN_BOX_PCT minimum applies.
function applyEdgeDrag(
  start: { startX: number; startY: number; startW: number; startH: number },
  handle: CropHandle,
  dxPct: number, dyPct: number,
): { x: number; y: number; w: number; h: number } {
  const draggingTop = handle === 'n' || handle === 'ne' || handle === 'nw';
  const draggingBottom = handle === 's' || handle === 'se' || handle === 'sw';
  const draggingLeft = handle === 'w' || handle === 'nw' || handle === 'sw';
  const draggingRight = handle === 'e' || handle === 'ne' || handle === 'se';

  let left = start.startX;
  let top = start.startY;
  let right = start.startX + start.startW;
  let bottom = start.startY + start.startH;

  // Clamp each dragged edge into `[0, 100]` and keep it at least
  // `MIN_BOX_PCT` away from the opposite edge. The opposite edge
  // stays at its starting position because we only read its value
  // (never assign to it) inside each branch.
  if (draggingTop) {
    top = Math.max(0, Math.min(bottom - MIN_BOX_PCT, top + dyPct));
  }
  if (draggingBottom) {
    bottom = Math.min(100, Math.max(top + MIN_BOX_PCT, bottom + dyPct));
  }
  if (draggingLeft) {
    left = Math.max(0, Math.min(right - MIN_BOX_PCT, left + dxPct));
  }
  if (draggingRight) {
    right = Math.min(100, Math.max(left + MIN_BOX_PCT, right + dxPct));
  }

  return { x: left, y: top, w: right - left, h: bottom - top };
}

function makeStrokedRect(
  x: number, y: number, w: number, h: number,
  stroke: string, width = 3,
): SVGRectElement {
  const el = document.createElementNS(SVG_NS, 'rect');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', String(width));
  return el;
}

function makeFilledRect(
  x: number, y: number, w: number, h: number,
  fill: string,
): SVGRectElement {
  const el = document.createElementNS(SVG_NS, 'rect');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.setAttribute('fill', fill);
  return el;
}

function makeLine(
  x1: number, y1: number, x2: number, y2: number,
  width = 3,
): SVGLineElement {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', String(x1));
  el.setAttribute('y1', String(y1));
  el.setAttribute('x2', String(x2));
  el.setAttribute('y2', String(y2));
  el.setAttribute('stroke', 'red');
  el.setAttribute('stroke-width', String(width));
  el.setAttribute('stroke-linecap', 'round');
  return el;
}

// Arrowhead barbs scale with the segment length so a tiny arrow keeps
// a proportional head, but cap so a very long arrow doesn't grow a
// disproportionately large head. ARROW_HEAD_RATIO is the barb length
// as a fraction of the segment length; ARROW_HEAD_MAX_PX caps it.
// ARROW_HEAD_ANGLE is the angle each barb makes against the reverse
// line direction.
const ARROW_HEAD_RATIO = 0.25;
export const ARROW_HEAD_MAX_PX = 18;
const ARROW_HEAD_ANGLE = (28 * Math.PI) / 180;

// Compute the two barb endpoints for an arrowhead at (x2,y2) on the
// segment from (x1,y1)→(x2,y2). Returned in the same coordinate
// system as the inputs. `maxHeadPx` caps the barb length in those
// same units — both the overlay and the bake-in path leave it at
// the default cap.
export function arrowBarbs(
  x1: number, y1: number, x2: number, y2: number,
  maxHeadPx: number = ARROW_HEAD_MAX_PX,
): { ax: number; ay: number; bx: number; by: number } | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const head = Math.min(len * ARROW_HEAD_RATIO, maxHeadPx);
  // Reverse-direction unit vector.
  const ux = -dx / len;
  const uy = -dy / len;
  const cos = Math.cos(ARROW_HEAD_ANGLE);
  const sin = Math.sin(ARROW_HEAD_ANGLE);
  // Rotate the reverse direction by ±ARROW_HEAD_ANGLE for the two barbs.
  const ax = x2 + head * (ux * cos - uy * sin);
  const ay = y2 + head * (ux * sin + uy * cos);
  const bx = x2 + head * (ux * cos + uy * sin);
  const by = y2 + head * (-ux * sin + uy * cos);
  return { ax, ay, bx, by };
}

// Draw an arrow (line + arrowhead) onto the SVG overlay. Returns
// nothing — appends `<line>` shapes to `overlay`. `strokePx` is the
// stroke width all three lines share; the head-cap argument scales
// proportionally so a zoomed-in arrow keeps the stroke / head-size
// ratio constant.
function appendArrow(
  x1: number, y1: number, x2: number, y2: number,
  strokePx: number = 3,
): void {
  ctx.overlay.appendChild(makeLine(x1, y1, x2, y2, strokePx));
  // Scale the head-cap with the stroke so the barbs grow together
  // with the line at higher zoom levels.
  const headCap = ARROW_HEAD_MAX_PX * (strokePx / 3);
  const b = arrowBarbs(x1, y1, x2, y2, headCap);
  if (!b) return;
  ctx.overlay.appendChild(makeLine(b.ax, b.ay, x2, y2, strokePx));
  ctx.overlay.appendChild(makeLine(b.bx, b.by, x2, y2, strokePx));
}

export function render(): void {
  while (ctx.overlay.firstChild) ctx.overlay.removeChild(ctx.overlay.firstChild);
  const r = imgRect();
  const w = r.width;
  const h = r.height;
  // Solid black image-edge border: a 1 px stroke centered at
  // half-pixel offsets one pixel outside the image on each side, with
  // each side extending 1 px past the corner so the four lines meet
  // flush. `#overlay` is `overflow: visible`, so these are allowed to
  // paint outside the SVG's nominal viewBox; `.image-box`'s
  // `overflow: auto` then clips the segments that scroll out of the
  // viewport — which is the "shows up if inside the scrolled pane"
  // behavior we want. Drawn first so subsequent overlay children
  // (annotations, crop dashes, grips) paint on top — the grip
  // squares occlude the border at corners just like the prior
  // CSS-border-with-SVG-overlay did.
  {
    const lines: Array<[number, number, number, number]> = [
      [-0.5, -1, -0.5, h + 1],         // left
      [w + 0.5, -1, w + 0.5, h + 1],   // right
      [-1, -0.5, w + 1, -0.5],         // top
      [-1, h + 0.5, w + 1, h + 0.5],   // bottom
    ];
    for (const [x1, y1, x2, y2] of lines) {
      const el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', String(x1));
      el.setAttribute('y1', String(y1));
      el.setAttribute('x2', String(x2));
      el.setAttribute('y2', String(y2));
      el.setAttribute('stroke', '#000');
      el.setAttribute('stroke-width', '1');
      ctx.overlay.appendChild(el);
    }
  }
  // Stroke width for the user's artistic edits (Box / Line / Arrow):
  // tracks the visual size of the image, dropping by 1 px at each
  // halving below 1× until it bottoms out at 1 px. Crop dashes and
  // corner grips stay at 1 px (UI affordances, not picture content).
  //
  //   ratio ≥ 1      → ceil(3·ratio − 0.01)  — 3 / 6 / 12 / 24 at
  //                    1× / 2× / 4× / 8×.
  //   0.5 ≤ ratio < 1  → 3   (Fit shrinkage above half-size doesn't
  //                          narrow the strokes — the regression
  //                          this rule was added to prevent.)
  //   0.25 ≤ ratio < 0.5 → 2
  //   ratio < 0.25     → 1
  //
  // The −0.01 epsilon keeps an exact 1× / 2× / 4× / 8× zoom from
  // tipping over the next integer due to float drift between
  // `targetCssSize()` math and Chrome's pixel-snapped
  // `getBoundingClientRect()` readout (a ratio like 1.0000003 would
  // otherwise push `ceil(3.0000009)` to 4).
  const ratio = currentDisplayScale();
  const sw =
    ratio >= 1 ? Math.ceil(3 * ratio - 0.01)
    : ratio >= 0.5 ? 3
    : ratio >= 0.25 ? 2
    : 1;

  // While a rect/redact resize drag is in flight, draw the targeted
  // edit at its live (`boxDrag.cur*`) bounds rather than its stored
  // values — gives the user a real-time preview that matches what
  // mouseup will commit. Crop drags follow the same idea below
  // through the cropPreview path (dim frame + dashed border).
  const liveResize =
    boxDrag && boxDrag.editId !== null && boxDrag.kind !== 'crop'
      ? { id: boxDrag.editId, x: boxDrag.curX, y: boxDrag.curY, w: boxDrag.curW, h: boxDrag.curH }
      : null;

  for (const e of edits) {
    if (e.kind === 'line' || e.kind === 'arrow') {
      const ax1 = (e.x1 / 100) * w;
      const ay1 = (e.y1 / 100) * h;
      const ax2 = (e.x2 / 100) * w;
      const ay2 = (e.y2 / 100) * h;
      if (e.kind === 'arrow') {
        appendArrow(ax1, ay1, ax2, ay2, sw);
      } else {
        ctx.overlay.appendChild(makeLine(ax1, ay1, ax2, ay2, sw));
      }
    } else if (e.kind === 'rect' || e.kind === 'redact') {
      const live = liveResize && liveResize.id === e.id ? liveResize : e;
      const x = (live.x / 100) * w;
      const y = (live.y / 100) * h;
      const dw = (live.w / 100) * w;
      const dh = (live.h / 100) * h;
      if (e.kind === 'rect') {
        ctx.overlay.appendChild(makeStrokedRect(x, y, dw, dh, 'red', sw));
      } else {
        ctx.overlay.appendChild(makeFilledRect(x, y, dw, dh, 'black'));
      }
    }
    // 'crop' is not drawn inline — it's painted as a single
    // "outside-is-dimmed" overlay below using the active crop
    // (only the most recent crop is visible).
  }

  // Render the crop as the drag preview if a crop drag is in
  // progress (either a Crop-tool *creation* drag or a handle
  // *resize* drag), else the committed active crop, else nothing.
  // All three states share the same visual (dim surround + dashed
  // border + corner grips), so the user sees the final cropped
  // result live while dragging — including a Crop-tool create
  // drag, where the dim frame appears under the bounds the user
  // is currently dragging.
  const cropPreview = computeCropPreview();
  if (cropPreview) {
    const cx = (cropPreview.x / 100) * w;
    const cy = (cropPreview.y / 100) * h;
    const cw = (cropPreview.w / 100) * w;
    const ch = (cropPreview.h / 100) * h;
    const dim = 'rgba(0,0,0,0.55)';
    // Single `<path>` with fill-rule="evenodd" to paint the dim
    // "picture frame" outside the crop. An earlier version used
    // four adjacent dim rects (top/bottom/left/right strips), but
    // that produced faint horizontal guide lines at the crop's
    // top and bottom edges: the pixel row straddling y=cy (or
    // y=cy+ch) got partial coverage from two different dim rects
    // rather than one solid fill, and composited alpha-over-alpha
    // comes out brighter than a single dim fill (e.g. white under
    // 0.55 dim = 0.45, but 0.3-coverage then 0.7-coverage of the
    // same dim ≈ 0.51 — about 14% lighter). The same seam didn't
    // show vertically because the left/right strip's inner edge
    // borders un-dim content, not a second dim rect, so the
    // antialiased transition was a smooth ramp instead of a
    // brighter spike. One shape → no internal seams.
    const frame = document.createElementNS(SVG_NS, 'path');
    frame.setAttribute(
      'd',
      `M0 0 H${w} V${h} H0 Z M${cx} ${cy} H${cx + cw} V${cy + ch} H${cx} Z`,
    );
    frame.setAttribute('fill', dim);
    frame.setAttribute('fill-rule', 'evenodd');
    ctx.overlay.appendChild(frame);
    // Dashed white border on the crop edges so the region is
    // legible even when the underlying pixels are low-contrast.
    // Drawn per-side (not as one `<rect>`) so a side flush with
    // the image edge is simply omitted — a dashed line at the
    // image boundary would be cosmetic noise, and drawing one
    // there while omitting it on the other axis (the asymmetric
    // case a full-width-but-not-full-height crop produces) looks
    // like a guide line extending past the crop.
    const dashed = (x1: number, y1: number, x2: number, y2: number): void => {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.setAttribute('stroke', '#fff');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('stroke-dasharray', '4 3');
      ctx.overlay.appendChild(line);
    };
    if (cy > 0) dashed(cx, cy, cx + cw, cy);
    if (cy + ch < h) dashed(cx, cy + ch, cx + cw, cy + ch);
    if (cx > 0) dashed(cx, cy, cx, cy + ch);
    if (cx + cw < w) dashed(cx + cw, cy, cx + cw, cy + ch);
  }

  // Small square grips at the four corners of the effective crop
  // region (the cropPreview if a drag is in flight, the active crop
  // if one exists, else the image's own corners). Drawn even with
  // no crop so the image hints that its edges are draggable —
  // without them the edge hit band is invisible. White fill with a
  // 1px dark outline so they read on both light and dark
  // backgrounds. Grips render centered on the corner and may extend
  // past the image edge — `#overlay` is `overflow: visible` so the
  // square is fully drawn even at a boundary corner. The 4 px
  // margin on `.image-wrap` keeps the half-outside portion inside
  // `.image-box`'s clipping area.
  {
    const region = cropPreview ?? { x: 0, y: 0, w: 100, h: 100 };
    const gx0 = (region.x / 100) * w;
    const gy0 = (region.y / 100) * h;
    const gw = (region.w / 100) * w;
    const gh = (region.h / 100) * h;
    const gripSize = 6;
    const corners: Array<[number, number]> = [
      [gx0, gy0], [gx0 + gw, gy0], [gx0, gy0 + gh], [gx0 + gw, gy0 + gh],
    ];
    for (const [gx, gy] of corners) {
      const g = makeFilledRect(gx - gripSize / 2, gy - gripSize / 2, gripSize, gripSize, '#fff');
      g.setAttribute('stroke', '#333');
      g.setAttribute('stroke-width', '1');
      ctx.overlay.appendChild(g);
    }
  }

  if (dragStart && dragCurrent) {
    // Live-preview shape mirrors what mouseup will commit. The
    // polyline tools commit each segment as a plain line / arrow
    // edit, so their preview is the same as the matching base tool.
    const previewKind = polylineToolLineKind(selectedTool) ?? selectedTool;
    if (previewKind === 'line') {
      ctx.overlay.appendChild(makeLine(
        dragStart.x, dragStart.y, dragCurrent.x, dragCurrent.y, sw,
      ));
    } else if (previewKind === 'arrow') {
      appendArrow(
        dragStart.x, dragStart.y, dragCurrent.x, dragCurrent.y, sw,
      );
    } else if (previewKind === 'rect' || previewKind === 'redact') {
      // Both tools draw exactly what they'll commit, so the user
      // sees the final result live: Box → red stroked rect, Redact
      // → filled black rect. Crop is handled above via `cropPreview`
      // (dim frame around the live drag bounds), so it doesn't
      // appear in this branch.
      const x = Math.min(dragStart.x, dragCurrent.x);
      const y = Math.min(dragStart.y, dragCurrent.y);
      const dw = Math.abs(dragCurrent.x - dragStart.x);
      const dh = Math.abs(dragCurrent.y - dragStart.y);
      if (selectedTool === 'rect') {
        ctx.overlay.appendChild(makeStrokedRect(x, y, dw, dh, 'red', sw));
      } else {
        ctx.overlay.appendChild(makeFilledRect(x, y, dw, dh, 'black'));
      }
    }
  }

  const hasEditHistory = editHistory.length > 0;
  ctx.undoBtn.disabled = !hasEditHistory;
  ctx.clearBtn.disabled = !hasEditHistory;
  ctx.shrinkBtn.disabled = !shrinkTarget();
  // Refresh the Image-size pill ("PNG · 1920×1080 · 312 KB").
  // `updateImageSizeBadge` is keyed on editVersion + natural dims
  // and short-circuits when nothing relevant changed — so the
  // resize / zoom callers of render() don't pay for a re-bake.
  // `composeImageBadgeText` then recomposes the pill text picking
  // up live `liveCropDimensions` if a crop drag is in flight, so
  // the user sees the selection size update in real time. Bytes
  // stay at the last committed value during a drag — re-baking
  // each frame would cost too much.
  ctx.updateImageSizeBadge();
  ctx.composeImageBadgeText();
}

// Viewport-edge indicators. The "real" image-edge border (solid
// black, 1 px outside the image) is drawn inside `#overlay` and so
// scrolls with the image — clipped naturally by `.image-box`'s
// `overflow: auto` when it slips off-screen. When that happens on a
// given side, we paint a "virtual" replacement at the corresponding
// viewport edge instead: a 1 px dashed medium-grey line spanning the
// same perpendicular extent as the original border would have, just
// shifted onto the viewport edge.
//
// The virtual lines live in a separate top-level SVG (`#viewport-
// edges`) that sits *outside* `.image-box`'s scroll region, sized
// and positioned each call to cover the box's content area
// (excluding scrollbars). Painting above `.image-box` puts the
// dashed line on top of user annotations near the edge, which is
// what we want — a red box drawn flush against the image edge
// shouldn't visually replace the viewport indicator.
//
// Edge detection compares the image's measured rect against the
// box's content area (rather than scroll offsets) so it picks up
// the wrap's 4 px margin: scrolling 0..4 px keeps the image's actual
// left edge still inside the viewport, no virtual border yet.
// 0.5 px tolerance covers Chrome's fractional readouts on HiDPI.
const EDGE_DASHED_COLOR = '#aaa';
export function drawViewportEdges(): void {
  // Size + position the SVG to overlay `.image-box`'s content area.
  // `offsetParent` is `.image-and-highlights` (made `position:
  // relative` for this purpose). `clientLeft / clientTop` shift past
  // any border on `.image-box` (currently 0); `clientWidth /
  // clientHeight` exclude scrollbars so the dashed line never paints
  // over a scrollbar gutter.
  const boxRect = ctx.imageBox.getBoundingClientRect();
  const parent = (ctx.imageBox.offsetParent as HTMLElement | null) ?? document.body;
  const parentRect = parent.getBoundingClientRect();
  const contentX = boxRect.left + ctx.imageBox.clientLeft - parentRect.left;
  const contentY = boxRect.top + ctx.imageBox.clientTop - parentRect.top;
  const vW = ctx.imageBox.clientWidth;
  const vH = ctx.imageBox.clientHeight;
  ctx.edgesSvg.style.left = contentX + 'px';
  ctx.edgesSvg.style.top = contentY + 'px';
  ctx.edgesSvg.style.width = vW + 'px';
  ctx.edgesSvg.style.height = vH + 'px';

  while (ctx.edgesSvg.firstChild) ctx.edgesSvg.removeChild(ctx.edgesSvg.firstChild);

  // Image rect in SVG-local coords (SVG (0,0) = box content top-left).
  const imgR = ctx.previewImg.getBoundingClientRect();
  const iL = imgR.left - (boxRect.left + ctx.imageBox.clientLeft);
  const iT = imgR.top - (boxRect.top + ctx.imageBox.clientTop);
  const iR = iL + imgR.width;
  const iB = iT + imgR.height;

  // "Show the virtual replacement" once the real border is at least
  // half-clipped. The real left-side line strokes the column from
  // `iL-1` to `iL`; that column is fully visible iff `iL >= 1`,
  // fully clipped iff `iL <= 0`, and half-covered at `iL = 0.5`. We
  // hand off at the half-coverage mark — earlier than that would
  // briefly stack the virtual on top of a still-visible real line;
  // later (e.g. `iL < 0` or `< -0.5`) would leave a 0.5-1 px window
  // along the edge where neither line is drawn.
  const leftOff   = iL < 0.5;
  const rightOff  = iR > vW - 0.5;
  const topOff    = iT < 0.5;
  const bottomOff = iB > vH - 0.5;

  if (!(leftOff || rightOff || topOff || bottomOff)) return;

  // Perpendicular extents — same as where the real black border
  // went (1 px past each image corner). SVG `overflow: hidden`
  // clips anything past the viewport bounds.
  const yTop = iT - 1;
  const yBot = iB + 1;
  const xLeft = iL - 1;
  const xRight = iR + 1;

  const dashed = (x1: number, y1: number, x2: number, y2: number): void => {
    const el = document.createElementNS(SVG_NS, 'line');
    el.setAttribute('x1', String(x1));
    el.setAttribute('y1', String(y1));
    el.setAttribute('x2', String(x2));
    el.setAttribute('y2', String(y2));
    el.setAttribute('stroke', EDGE_DASHED_COLOR);
    el.setAttribute('stroke-width', '1');
    el.setAttribute('stroke-dasharray', '4 3');
    ctx.edgesSvg.appendChild(el);
  };

  // Half-pixel inset of the dashed line from the viewport edge
  // keeps the 1 px stroke landing on a single pixel row/column.
  if (leftOff)   dashed(0.5,      yTop,    0.5,      yBot);
  if (rightOff)  dashed(vW - 0.5, yTop,    vW - 0.5, yBot);
  if (topOff)    dashed(xLeft,    0.5,     xRight,   0.5);
  if (bottomOff) dashed(xLeft,    vH - 0.5, xRight,  vH - 0.5);
}

// Apply a drag update from a pointer position in image-rect-local
// coordinates (i.e. already passed through `localCoords` or its
// equivalent clamp). Shared between the physical-mousemove path
// (clientX from the event) and the arrow-key nudge path, which
// needs to drive the drag with sub-CSS-pixel precision that Chrome
// would otherwise round away through the MouseEvent's `clientX`.
function updateDragFromLocalPoint(p: Point): void {
  if (boxDrag) {
    const r = imgRect();
    const dxPct = ((p.x - boxDrag.originX) / r.width) * 100;
    const dyPct = ((p.y - boxDrag.originY) / r.height) * 100;
    const next = applyEdgeDrag(boxDrag, boxDrag.handle, dxPct, dyPct);
    boxDrag.curX = next.x;
    boxDrag.curY = next.y;
    boxDrag.curW = next.w;
    boxDrag.curH = next.h;
    ctx.overlay.style.cursor = cursorForHandle(boxDrag.handle);
    render();
    return;
  }
  if (dragStart === null) return;
  dragCurrent = p;
  render();
}

// ─── Shrink ───────────────────────────────────────────────────────
//
// The Shrink action tightens a rectangle around its content by
// reading the pre-edit base image and asking `src/shrink.ts` to
// trim solid borders. Which rectangle gets shrunk is decided by
// the currently selected tool:
//
//   - 'rect' / 'redact' — the most recent edit of that kind. If
//     the stack has none, the button is disabled.
//   - 'crop'            — the active crop, or (if there is none)
//     the full image: that case commits a *new* crop edit so the
//     user can shrink straight from "no crop yet" to "crop fitting
//     the page content".
//   - 'line' / 'arrow'  — disabled (lines have no rectangular
//     extent to tighten).
//
// We never shrink against the rendered overlay: redactions paint
// over the object you'd want to wrap, so the algorithm has to see
// the pristine base image. `previewImg` always holds the raw
// `captureVisibleTab` data URL — bake-in is computed on demand
// elsewhere — so reading its natural-resolution pixels gives that
// pristine view.

type ShrinkTarget =
  | { kind: 'rect-edit'; edit: RectEdit }
  | { kind: 'new-crop' };

// Picks the rect that the next Shrink click would act on, or
// `null` if Shrink would have nothing to do. Used both to gate the
// button's disabled state (in `render()`) and to look up the
// target inside the click handler.
function shrinkTarget(): ShrinkTarget | null {
  if (selectedTool === 'rect' || selectedTool === 'redact') {
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i]!;
      if (e.kind === selectedTool) return { kind: 'rect-edit', edit: e };
    }
    return null;
  }
  if (selectedTool === 'crop') {
    const c = activeCrop();
    return c ? { kind: 'rect-edit', edit: c } : { kind: 'new-crop' };
  }
  return null;
}

// Cache of the natural-resolution base-image pixel buffer. Reading
// `previewImg` into a canvas costs ~5–20 ms for a typical viewport
// screenshot; caching it keeps repeated Shrink clicks responsive.
// The cache key is `previewImg.src` so a re-capture (which changes
// the data URL) invalidates without explicit teardown.
let basePixelsCache: { src: string; buf: ImageData } | null = null;
function getBasePixels(): ImageData | null {
  if (basePixelsCache && basePixelsCache.src === ctx.previewImg.src) {
    return basePixelsCache.buf;
  }
  const w = ctx.previewImg.naturalWidth;
  const h = ctx.previewImg.naturalHeight;
  if (w === 0 || h === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c2 = canvas.getContext('2d', { willReadFrequently: true });
  if (!c2) return null;
  c2.drawImage(ctx.previewImg, 0, 0);
  const buf = c2.getImageData(0, 0, w, h);
  basePixelsCache = { src: ctx.previewImg.src, buf };
  return buf;
}

// Convert a percentage-space rect (matching what edits store) to a
// natural-pixel rect on the base image, and back. Pixel rects are
// rounded to integer bounds since the shrink algorithm operates on
// whole pixels.
export function pctRectToPixels(
  r: { x: number; y: number; w: number; h: number },
  natW: number,
  natH: number,
): { x: number; y: number; w: number; h: number } {
  const x = Math.round((r.x / 100) * natW);
  const y = Math.round((r.y / 100) * natH);
  const w = Math.round(((r.x + r.w) / 100) * natW) - x;
  const h = Math.round(((r.y + r.h) / 100) * natH) - y;
  return { x, y, w, h };
}
function pixelsToPctRect(
  r: { x: number; y: number; w: number; h: number },
  natW: number,
  natH: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: (r.x / natW) * 100,
    y: (r.y / natH) * 100,
    w: (r.w / natW) * 100,
    h: (r.h / natH) * 100,
  };
}

// Tool selection. Each `.tool-btn` carries `data-tool` matching one
// of `Tool`'s string values. Clicking a button updates `selectedTool`
// and toggles the `.selected` / `aria-pressed` state across the
// whole group so exactly one is pushed-down at a time.
function setSelectedTool(tool: Tool): void {
  selectedTool = tool;
  // Switching tools (or re-selecting the same one) ends any
  // in-flight polyline chain so the new tool doesn't inherit a
  // half-drawn segment. Also applies when switching between the
  // two polyline tools — the chain's commit kind is fixed at entry,
  // so e.g. Polyline → Poly-arrow needs a clean slate. `boxDrag`
  // state is intentionally untouched: a box-handle resize drag is
  // independent of polyline mode and a tool switch shouldn't abort
  // it.
  if (polylineLineKind !== null) endPolylineChain();
  for (const btn of ctx.toolButtons) {
    const isMine = btn.dataset.tool === tool;
    btn.classList.toggle('selected', isMine);
    btn.setAttribute('aria-pressed', isMine ? 'true' : 'false');
  }
  // Shrink's enabled state depends on the selected tool (it
  // operates on the last matching edit, or on the crop region in
  // Crop mode), so a re-render keeps its disabled flag in sync.
  render();
}

// ─── Bake-flag helpers (read by main's Capture submit + bake) ────

// True iff there is at least one edit whose effect must be baked
// into the saved image: any red rect / line / redaction, or an
// effective crop. A crop that covers the whole image contributes
// nothing to the bake (`activeCrop()` returns undefined for it),
// so a stack whose only edits are full-image crops skips the bake
// and the saved PNG stays identical to the untouched capture.
export function hasBakeableEdits(): boolean {
  if (edits.some((e) => e.kind !== 'crop')) return true;
  return activeCrop() !== undefined;
}

export interface EditFlags {
  hasHighlights: boolean;
  hasRedactions: boolean;
  isCropped: boolean;
}

// Per-kind flags reported to the SW so the saved record's screenshot
// artifact can carry `hasHighlights` / `hasRedactions` / `isCropped`
// independently. Each tool-kind flips its own flag: Box-tool boxes,
// Line-tool lines, and Arrow-tool arrows all count as `hasHighlights`;
// redactions and crops are separate kinds and flip `hasRedactions` /
// `isCropped`.
//
// `isCropped` uses `activeCrop()` (not "any crop edit in the stack")
// so a crop that's been dragged back out to the full image reports
// as *not cropped* — the saved PNG matches the original, so the
// flag would mislead downstream consumers.
export function editFlags(): EditFlags {
  let hasHighlights = false;
  let hasRedactions = false;
  for (const e of edits) {
    if (e.kind === 'rect' || e.kind === 'line' || e.kind === 'arrow') hasHighlights = true;
    else if (e.kind === 'redact') hasRedactions = true;
  }
  return { hasHighlights, hasRedactions, isCropped: activeCrop() !== undefined };
}

// ─── Bake (canvas counterpart to render()) ───────────────────────
//
// `renderHighlightedImage` is the bake-time twin of `render()`:
// `render()` paints the live overlay into SVG, this paints the same
// edit stack into an output `<canvas>` at natural resolution and
// returns a data URL. It iterates the same `edits` with the same
// `arrowBarbs` / `pctRectToPixels` / `activeCrop` helpers, so the
// SVG preview and the saved bytes stay in lockstep.

// MIME type of the current preview image's source data URL. Used by
// `bakeMime` / `bakeExt` to keep the saved format sticky: a JPG that
// the user draws on stays a JPG; PNG stays PNG; anything else
// (WEBP / GIF / AVIF / …) becomes PNG, since those are the only two
// encodings the bake canvas writes.
export function sourceMime(): string {
  const m = /^data:([^;,]+)[;,]/.exec(ctx.previewImg.src);
  return m ? m[1]!.toLowerCase() : '';
}

// Format the bake should produce for save / Ask: JPG passes through,
// everything else writes PNG. The page caches this on edit-version
// changes via the badge cache, but the function itself is cheap (a
// regex on a short prefix) so callers can read it freely.
export function bakeMime(): 'image/png' | 'image/jpeg' {
  return sourceMime() === 'image/jpeg' ? 'image/jpeg' : 'image/png';
}

// Filename extension matching `bakeMime`. Used for the Save-as
// dialog's default name and the Ask attachment filename.
export function bakeExt(): 'png' | 'jpg' {
  return bakeMime() === 'image/jpeg' ? 'jpg' : 'png';
}

// JPEG quality for the bake re-encode. 0.92 mirrors what most browsers
// pick when `toDataURL('image/jpeg')` is called with no explicit
// quality — high enough that overlay markings stay crisp, low enough
// that a photographic JPG-source capture doesn't blow up in size the
// way a PNG re-encode of the same pixels would.
const JPEG_BAKE_QUALITY = 0.92;

// Render the preview image with all current edits baked into image
// bytes at the screenshot's natural resolution. Used when the user
// saves a screenshot that has edits — we want the saved file to show
// the markup (and the cropped region, if any), not just the underlying
// screenshot.
//
// Output format follows the sticky rule above unless the caller forces
// one (the clipboard path forces `image/png` because that's the only
// image MIME `ClipboardItem` accepts reliably across browsers).
//
// Strokes in the saved image are always rendered at the same default
// width (3 natural px), independent of the display→natural ratio
// at the moment of save. The overlay still scales its stroke with
// the visible image (so editing at 4× shows fatter lines than
// editing in Fit), but those visual differences are intentionally
// not baked in — earlier we scaled the bake's stroke up by
// natural/display, which produced unpleasantly fat lines on
// high-resolution captures viewed at Fit.
//
// When an active crop exists, the canvas is sized to the crop
// region (not the full image) and every edit's coordinates are
// translated into the cropped frame so the bake-in output shows
// exactly what the user saw through the dim overlay.
//
// Short-circuits to `previewImg.src` (the original capture data URL)
// when there are no bake-able edits — same pixels, but avoids the
// 30–100ms canvas re-encode AND preserves byte identity with the
// original capture. Callers without a `forceMime` get back the
// source bytes regardless of format (WEBP / GIF / … stay as-is on a
// no-edits save). When the caller forces a specific output MIME
// (clipboard path: `image/png`), the re-encode still has to run on
// a no-edits source whose MIME doesn't already match — otherwise
// the caller's `ClipboardItem` MIME would mismatch the bytes.
export function renderHighlightedImage(forceMime?: 'image/png' | 'image/jpeg'): string {
  if (!hasBakeableEdits()) {
    if (!forceMime || sourceMime() === forceMime) return ctx.previewImg.src;
  }
  const outMime: 'image/png' | 'image/jpeg' = forceMime ?? bakeMime();
  const natW = ctx.previewImg.naturalWidth;
  const natH = ctx.previewImg.naturalHeight;
  const crop = activeCrop();

  // Source rectangle on the natural-resolution image. For an
  // un-cropped save this is the whole image; for a cropped save
  // we route through `pctRectToPixels` so the integer dimensions
  // line up exactly with what the Image-size pill displays
  // (`savedImageDimensions` uses the same helper). Earlier this
  // computed `(crop.w/100)*natW` directly and let
  // `canvas.width = <float>` truncate — which produced an
  // occasional 1-pixel mismatch between the pill ("PNG ·
  // 800×600") and `file <saved>.png` ("PNG image data, 799 x 600").
  const cropPx = crop ? pctRectToPixels(crop, natW, natH) : null;
  const sx = cropPx ? cropPx.x : 0;
  const sy = cropPx ? cropPx.y : 0;
  const sw = cropPx ? cropPx.w : natW;
  const sh = cropPx ? cropPx.h : natH;

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  // Local name `c2d` (not `ctx`) avoids shadowing this module's
  // `ctx: DrawingContext` binding. The two share no fields but
  // reading `ctx.foo` mid-function would be confusing.
  const c2d = canvas.getContext('2d');
  if (!c2d) throw new Error('Failed to get 2D context for highlight rendering');
  c2d.drawImage(ctx.previewImg, sx, sy, sw, sh, 0, 0, sw, sh);

  // Default stroke width in natural pixels — same value the overlay
  // uses at 1× zoom. Held constant on the bake so the saved PNG
  // doesn't get fat lines just because the preview was zoomed out.
  const strokePx = 3;

  // Clip every highlight to the canvas bounds so edits that extend
  // past the crop don't paint onto the un-cropped neighbors (the
  // crop rectangle already imposes a coordinate system; without the
  // clip, a redaction that poked outside the crop would bleed into
  // the saved image's margin). Un-cropped save: clip is the whole
  // image, which is a no-op.
  c2d.save();
  c2d.beginPath();
  c2d.rect(0, 0, sw, sh);
  c2d.clip();

  for (const e of edits) {
    if (e.kind === 'crop') continue; // the crop is realized by the canvas size itself
    if (e.kind === 'line' || e.kind === 'arrow') {
      const x1 = (e.x1 / 100) * natW - sx;
      const y1 = (e.y1 / 100) * natH - sy;
      const x2 = (e.x2 / 100) * natW - sx;
      const y2 = (e.y2 / 100) * natH - sy;
      c2d.strokeStyle = 'red';
      c2d.lineWidth = strokePx;
      c2d.lineCap = 'round';
      c2d.lineJoin = 'round';
      c2d.beginPath();
      c2d.moveTo(x1, y1);
      c2d.lineTo(x2, y2);
      if (e.kind === 'arrow') {
        // Default head cap (no display-scale multiplier) so the
        // baked arrowhead matches the default 3 px stroke above.
        const b = arrowBarbs(x1, y1, x2, y2, ARROW_HEAD_MAX_PX);
        if (b) {
          c2d.moveTo(b.ax, b.ay);
          c2d.lineTo(x2, y2);
          c2d.lineTo(b.bx, b.by);
        }
      }
      c2d.stroke();
    } else if (e.kind === 'rect') {
      c2d.strokeStyle = 'red';
      c2d.lineWidth = strokePx;
      c2d.strokeRect(
        (e.x / 100) * natW - sx,
        (e.y / 100) * natH - sy,
        (e.w / 100) * natW,
        (e.h / 100) * natH,
      );
    } else if (e.kind === 'redact') {
      c2d.fillStyle = 'black';
      c2d.fillRect(
        (e.x / 100) * natW - sx,
        (e.y / 100) * natH - sy,
        (e.w / 100) * natW,
        (e.h / 100) * natH,
      );
    }
  }
  c2d.restore();

  return outMime === 'image/jpeg'
    ? canvas.toDataURL('image/jpeg', JPEG_BAKE_QUALITY)
    : canvas.toDataURL('image/png');
}

// ─── State accessors (read by main's bake, image-size pill, etc.) ─

/** Live edits array, by reference. Main's `renderHighlightedImage`
 *  iterates over this to draw highlights / redactions onto the
 *  canvas. Mutating the returned array would corrupt drawing's
 *  state — `readonly` enforces "read-only" at the type level. */
export function getEdits(): readonly Edit[] {
  return edits;
}

export function getEditVersion(): number {
  return editVersion;
}

/** Currently-selected drawing tool. Read by main's
 *  `liveCropDimensions` to detect a Crop-tool drag in flight. */
export function getSelectedTool(): Tool {
  return selectedTool;
}

/** Current box-drag state (null when no drag is in flight). Read
 *  by main's `liveCropDimensions` so the pill text reflects a
 *  crop-resize drag's live bounds. */
export function getBoxDrag():
  | { kind: RectKind; curX: number; curY: number; curW: number; curH: number }
  | null {
  if (!boxDrag) return null;
  return {
    kind: boxDrag.kind,
    curX: boxDrag.curX,
    curY: boxDrag.curY,
    curW: boxDrag.curW,
    curH: boxDrag.curH,
  };
}

/** Current fresh-draw drag start / current positions (display-pixel
 *  coordinates inside the image rect). Read by main's
 *  `liveCropDimensions` for the Crop-tool create-drag path. */
export function getDragStart(): Point | null {
  return dragStart;
}
export function getDragCurrent(): Point | null {
  return dragCurrent;
}

// ─── Test-only state hooks (consumed by main's `__seeState`) ─────

export interface DrawingTestHooks {
  /** Live polyline kind ('line' / 'arrow') or null when no chain
   *  is active. */
  getPolylineKind(): LineKind | null;
  /** Polyline chain start anchor in image-rect-local CSS px, or
   *  null. */
  getPolylineChainStart(): Point | null;
  /** How the active chain was entered ('ctrl' / 'tool'), or null. */
  getPolylineEntry(): 'ctrl' | 'tool' | null;
  /** All edit kinds in commit order. */
  getEditKinds(): Edit['kind'][];
  /** Bounds of the most-recent edit matching `kind`. */
  getLastRectBounds(
    kind: 'rect' | 'redact' | 'crop',
  ): { x: number; y: number; w: number; h: number } | null;
  /** Endpoints of the most-recent line / arrow edit. */
  getLastLineBounds(
    kind: 'line' | 'arrow',
  ): { x1: number; y1: number; x2: number; y2: number } | null;
  /** All line / arrow segments of the requested kind, in commit
   *  order. */
  getAllLineBounds(
    kind: 'line' | 'arrow',
  ): Array<{ x1: number; y1: number; x2: number; y2: number }>;
  /** Test-only setter — overwrites the most-recent rect-shaped
   *  edit's geometry and bumps `editVersion`. Returns false when
   *  no matching edit exists. */
  setLastRectBounds(
    kind: 'rect' | 'redact' | 'crop',
    bounds: { x: number; y: number; w: number; h: number },
  ): boolean;
}

export function getTestHooks(): DrawingTestHooks {
  return {
    getPolylineKind: () => polylineLineKind,
    getPolylineChainStart: () =>
      polylineChainStart === null
        ? null
        : { x: polylineChainStart.x, y: polylineChainStart.y },
    getPolylineEntry: () =>
      polylineLineKind === null ? null : polylineEntryWasCtrl ? 'ctrl' : 'tool',
    getEditKinds: () => edits.map((e) => e.kind),
    getLastRectBounds: (kind) => {
      for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i]!;
        if (e.kind === kind) return { x: e.x, y: e.y, w: e.w, h: e.h };
      }
      return null;
    },
    getLastLineBounds: (kind) => {
      for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i]!;
        if (e.kind === kind) return { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 };
      }
      return null;
    },
    getAllLineBounds: (kind) => {
      const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
      for (const e of edits) {
        if (e.kind === kind) out.push({ x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 });
      }
      return out;
    },
    setLastRectBounds: (kind, bounds) => {
      for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i]!;
        if (e.kind === kind) {
          e.x = bounds.x;
          e.y = bounds.y;
          e.w = bounds.w;
          e.h = bounds.h;
          editVersion++;
          render();
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Wire all drawing-side handlers (overlay drags, window key/mouse,
 * Shrink / Undo / Clear / tool-button clicks) and trigger the first
 * render. Called once by capture-page.ts after the static DOM has
 * loaded.
 */
export function initDrawing(context: DrawingContext): void {
  ctx = context;

  // Pan via `.image-box` scroll changes which sides have scrolled-out
  // content, so the per-side dashed indicator needs to re-evaluate.
  ctx.imageBox.addEventListener('scroll', drawViewportEdges, { passive: true });

  ctx.overlay.addEventListener('mousedown', (e) => {
    const me = e as MouseEvent;
    // A draw / resize drag is already in flight (e.g. the previous
    // mouseup was lost to a window blur). Ignore *every* fresh
    // mousedown — drawing branches below, the Ctrl-left pan branch,
    // and the middle-click preventDefault — so we don't layer a pan
    // on top of stuck draw state, which would leave `panState` and
    // `dragStart`/`boxDrag` both live until the next normal
    // left-mouseup. Sits above the Ctrl-left branch deliberately.
    //
    // Polyline mode is the one exception on the `dragStart` side: the
    // chain leaves `dragStart` set between segments deliberately, and
    // the next mousedown is meant to start a new segment (its mouseup
    // commits). Fall through to the polyline-continuation branch
    // below, which preventDefaults and returns without disturbing
    // state.
    if (boxDrag !== null) return;
    if (dragStart !== null && polylineLineKind === null) return;
    // Polyline continuation: a fresh left mousedown while the chain
    // is alive. Don't reset `dragStart` (it's the previous segment's
    // endpoint, anchoring the next segment); don't pan; just swallow
    // the press so it doesn't bubble to imageBox (which would start
    // a Ctrl-left pan). Mouseup commits the segment.
    if (dragStart !== null && polylineLineKind !== null) {
      if (me.button !== 0) return;
      me.preventDefault();
      me.stopPropagation();
      polylineMouseHeld = true;
      // Deliberately *don't* overwrite `dragCurrent` here. The chain
      // composes with arrow-key nudges: a user can press arrow keys
      // between segments to fine-tune the next endpoint, and
      // refreshing `dragCurrent` to the physical click point would
      // erase that nudge. Real input always has a mousemove between
      // mouseup and the next mousedown, so `dragCurrent` is already
      // up to date by the time we get here. Synthetic input that
      // skips mousemove would land a no-op segment — acceptable
      // edge case.
      //
      // Also note: `dragStart` is NOT re-snapped here either. The
      // chain anchor is fixed at the previous segment's snapped
      // endpoint; re-running `snapPoint` on it would (a) be a no-op
      // because the anchor is already on a feature, or (b) drag it to
      // a different nearby feature, which would silently move the
      // chain. The polyline-mousedown path is the only mousedown that
      // doesn't pass through the snap step — by design.
      return;
    }
    // Ctrl/Cmd + left = pan, mirroring middle-click. Uniform across
    // all tools — the polyline entry no longer rides on the modifier
    // (dedicated Polyline / Poly-arrow tools serve that purpose).
    // Polyline chains promoted via "Ctrl held at mouseup of a regular
    // Line/Arrow draw" still work because that path is decided at
    // mouseup, not at this mousedown.
    //
    // The Ctrl-promote path is also why we don't pre-empt mousedowns
    // *without* Ctrl on the line/arrow tools: a user who plans to
    // promote will hold Ctrl only at release. The mousedown stays a
    // plain fresh-draw.
    if (me.button === 0 && (me.ctrlKey || me.metaKey) && !me.shiftKey) {
      me.preventDefault();
      me.stopPropagation();
      startPan(me);
      return;
    }
    // Ctrl/Cmd + Shift falls through this pan branch on purpose: it
    // means "force a fresh draw, but keep snap on" — the upcoming
    // box-handle hit-test is bypassed by the Shift check below, and
    // the snap-disable check in `mousemove` re-enables snap when Ctrl
    // is held alongside Shift.
    // Left button only — there's no right-click drawing in the new
    // tool model. The browser will surface the right-button context
    // menu untouched.
    if (me.button !== 0) {
      // For middle-click, suppress the browser's default actions on
      // the way down — autoscroll mode (the spinning compass icon)
      // and, on Linux, the X11 primary-selection paste that would
      // otherwise fire on the *focused* editable (the prompt
      // textarea) regardless of where the click happened. Doing it
      // here as well as on `imageBox` mousedown is belt-and-
      // suspenders: middle clicks on the SVG overlay (which sits
      // over the image) hit this listener first.
      if (me.button === 1) me.preventDefault();
      return;
    }
    const p = localCoords(me);
    // Box-handle drag wins over the selected tool: hit-tests every
    // rect-shaped edit (rect / redact / crop) topmost-first, plus
    // the image edges as a fallback when no crop exists. Holding
    // Shift bypasses this so the user can start a fresh draw flush
    // against an existing box's edge — e.g. drawing a redact box
    // right next to a crop's edge without snapping the crop instead.
    const hit = me.shiftKey ? null : detectBoxHandle(p);
    if (hit) {
      me.preventDefault();
      boxDrag = {
        kind: hit.kind,
        editId: hit.editId,
        handle: hit.handle,
        startX: hit.bounds.x, startY: hit.bounds.y,
        startW: hit.bounds.w, startH: hit.bounds.h,
        originX: p.x, originY: p.y,
        curX: hit.bounds.x, curY: hit.bounds.y,
        curW: hit.bounds.w, curH: hit.bounds.h,
      };
      render();
      return;
    }
    me.preventDefault();
    // Snap the drag's anchor onto nearby targets when starting a fresh
    // draw (line / arrow / box / redact / crop) — gives the user a way
    // to begin a new shape exactly at an existing corner / endpoint /
    // edge point without precision aiming. Plain Shift suppresses both
    // snap *and* the resize-handle hit-test above (cleanest "force a
    // fresh draw here" affordance). Ctrl/Cmd + Shift keeps snap on
    // while still bypassing the resize hit-test — handy for placing a
    // new shape exactly against an existing edge handle. No edit
    // exists yet to exclude; the polyline chain start is irrelevant
    // at the *start* of a segment (chain-close is endpoint-side).
    const snapOff = me.shiftKey && !(me.ctrlKey || me.metaKey);
    dragStart = snapOff ? p : snapPoint(p);
    dragCurrent = dragStart;
    // Track the mouse-held window for the polyline keyup logic.
    // Scoped to line-family tools (Line / Arrow / Polyline / Poly-arrow)
    // — the box / crop / redact tools don't participate in polyline
    // mode, so leaving the flag false for them keeps the keyup path's
    // reasoning narrow.
    if (isLineFamilyTool(selectedTool)) {
      polylineMouseHeld = true;
    }
    // Reset any idle-hover resize cursor — we're committing to a
    // tool-driven draw from this spot, and the resize cursor would
    // mislead the user if they started right on a handle.
    ctx.overlay.style.cursor = 'crosshair';
    render();
  });

  // Idle-hover cursor feedback. The hit-test matches the mousedown
  // path's, so the user gets a resize cursor before committing — on
  // any rect-shaped edit's edge, or the image edges (for "drag here
  // to start cropping") when no crop exists. Holding Shift suppresses
  // the resize cursor too, mirroring the mousedown bypass so the
  // user sees that a Shift-drag will fall through to drawing.
  ctx.overlay.addEventListener('mousemove', (e) => {
    if (dragStart || boxDrag) return;
    const hit = e.shiftKey ? null : detectBoxHandle(localCoords(e));
    ctx.overlay.style.cursor = hit ? cursorForHandle(hit.handle) : 'crosshair';
  });

  window.addEventListener('mousemove', (e) => {
    if (boxDrag === null && dragStart === null) return;
    // Snap the live target to nearby geometry — see the "Snap-to"
    // section above for the rules. Shift bypasses. Box-resize uses
    // axis-aware snap so the dragged *edge* lands on the target;
    // fresh-draw and line/arrow drags use point snap on the cursor.
    // Both snaps are skipped in the arrow-key nudge path, which calls
    // `updateDragFromLocalPoint` directly (one natural-pixel step,
    // composes with a previously-snapped position).
    const raw = localCoords(e);
    let p = raw;
    // Plain Shift turns snap off. Ctrl/Cmd + Shift turns it back on
    // (useful when the user wants to bypass the resize hit-test on
    // mousedown but still snap the in-flight target).
    const snapOff = e.shiftKey && !(e.ctrlKey || e.metaKey);
    if (!snapOff) {
      if (boxDrag !== null) {
        p = snapBoxDragCursor(raw, boxDrag);
      } else {
        p = snapPoint(raw, pointSnapOptions());
        // Line / arrow draws additionally snap to horizontal /
        // vertical when feature snap didn't fire and the cursor is
        // within `SNAP_PX` of an axis-aligned segment. Polyline
        // segments use the chain head (`dragStart`) as the anchor, so
        // each segment can be independently axis-aligned. Feature
        // snap takes precedence — landing on an existing endpoint or
        // corner is stronger intent than "make it horizontal".
        if (p === raw && dragStart !== null && isLineFamilyTool(selectedTool)) {
          p = snapAxisAligned(raw, dragStart);
        }
      }
    }
    updateDragFromLocalPoint(p);
  });

  window.addEventListener('mouseup', (e) => {
    if (boxDrag) {
      // Left-button only for resize drag — ignore any stray right-up.
      if (e.button !== 0) return;
      // Commit only if the proposed bounds actually changed from the
      // pre-drag geometry. Cheaper-and-more-correct than the pointer-
      // distance check it replaces: it survives arrow-key nudges that
      // move the synthetic cursor without a physical mouse move (so
      // `localCoords(e)` would still report the un-nudged position).
      const movedEnough =
        boxDrag.curX !== boxDrag.startX ||
        boxDrag.curY !== boxDrag.startY ||
        boxDrag.curW !== boxDrag.startW ||
        boxDrag.curH !== boxDrag.startH;
      // Only commit if the drag actually moved — a bare click on a
      // handle shouldn't push or mutate (would pollute Undo history
      // with no-ops).
      if (movedEnough) {
        const next = { x: boxDrag.curX, y: boxDrag.curY, w: boxDrag.curW, h: boxDrag.curH };
        // Skip no-op commits — drags that physically moved past the
        // CLICK_THRESHOLD_PX guard above but landed pixel-identical
        // to the pre-drag geometry (e.g. dragged out against a
        // boundary clamp and back). Without this, the create branch
        // can push an identity (0,0,100,100) crop that's functionally
        // invisible but eats an Undo press.
        const same =
          boxDrag.startX === next.x && boxDrag.startY === next.y &&
          boxDrag.startW === next.w && boxDrag.startH === next.h;
        if (same) {
          // fall through to the cleanup below
        } else if (boxDrag.editId === null) {
          // Image-edge "create a new crop" gesture — push a fresh
          // crop edit. Plain `add` history op so Undo removes it.
          const id = nextEditId++;
          edits.push({ id, kind: 'crop', ...next });
          editHistory.push({ id });
          editVersion++;
        } else {
          // Resize an existing edit in place. Mutate the bounds and
          // record a Shrink-style `prev` history op so Undo restores
          // the pre-drag geometry one click at a time. Same shape as
          // the Shrink path — the two operations stack naturally. The
          // outer `same` check above already filters no-op drags.
          const idx = edits.findIndex((ed) => ed.id === boxDrag!.editId);
          if (idx >= 0) {
            const target = edits[idx]!;
            if (target.kind === 'rect' || target.kind === 'redact' || target.kind === 'crop') {
              const prev = { x: target.x, y: target.y, w: target.w, h: target.h };
              target.x = next.x;
              target.y = next.y;
              target.w = next.w;
              target.h = next.h;
              editHistory.push({ id: target.id, prev });
              editVersion++;
            }
          }
        }
      }
      boxDrag = null;
      ctx.overlay.style.cursor = 'crosshair';
      render();
      return;
    }

    if (dragStart === null) return;
    // Left button only matches the mousedown gate.
    if (e.button !== 0) return;
    // Stray mouseup during an *active* polyline chain — every
    // legitimate polyline mousedown (line-family tool entry,
    // overlay continuation, edge-commit buffer) sets
    // `polylineMouseHeld = true` on press. Press paths that
    // deliberately don't set it (image-box scrollbar clicks, which
    // the cancel-on-outside listener lets fall through to the
    // browser's scroll behaviour) shouldn't commit on the matching
    // release. Scoped to chain-active state — fresh Box / Crop /
    // Redact draws never set the flag either, and that's normal:
    // they fall through to the commit branch as before.
    if (polylineLineKind !== null && !polylineMouseHeld) return;
    // Mouse is no longer held — ends the keyup handler's mid-drag
    // window. Cleared even when the upcoming branches end up
    // commit-or-skip in different ways.
    polylineMouseHeld = false;
    // Use the last tracked drag position — `dragCurrent` already
    // reflects every mousemove (including ones synthesised by the
    // arrow-key nudge handler), whereas `localCoords(e)` would snap
    // back to the physical mouseup position and lose the keyboard
    // adjustment. `dragCurrent` is set to `dragStart` on mousedown,
    // so it's never null by the time we get here.
    const end = dragCurrent ?? dragStart;
    const r = imgRect();
    const dx = end.x - dragStart.x;
    const dy = end.y - dragStart.y;
    const moved = Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX;
    // Real movement required — a bare click shouldn't push a
    // degenerate zero-size shape.
    // Resolve the commit kind. Polyline / Poly-arrow tools commit as
    // their underlying line / arrow edit kind; everything else commits
    // as itself.
    const lineKindForCommit: LineKind | null =
      polylineToolLineKind(selectedTool)
      ?? (selectedTool === 'line' || selectedTool === 'arrow' ? selectedTool : null);
    let pending: Edit | null = null;
    if (moved) {
      const id = nextEditId;
      if (lineKindForCommit !== null) {
        pending = {
          id,
          kind: lineKindForCommit,
          x1: (dragStart.x / r.width) * 100,
          y1: (dragStart.y / r.height) * 100,
          x2: (end.x / r.width) * 100,
          y2: (end.y / r.height) * 100,
        };
      } else if (selectedTool === 'rect' || selectedTool === 'redact' || selectedTool === 'crop') {
        const x = Math.min(dragStart.x, end.x);
        const y = Math.min(dragStart.y, end.y);
        const wPct = (Math.abs(dx) / r.width) * 100;
        const hPct = (Math.abs(dy) / r.height) * 100;
        // Crop needs each side ≥ MIN_BOX_PCT so the resulting crop's
        // edge handles stay grabbable. The handle-resize path enforces
        // this between opposing edges; the create path has to enforce
        // it at commit time too — a diagonal CLICK_THRESHOLD_PX drag
        // would otherwise commit a sub-1% crop that can't be re-grabbed.
        const tooSmall = selectedTool === 'crop' && (wPct < MIN_BOX_PCT || hPct < MIN_BOX_PCT);
        if (!tooSmall) {
          pending = {
            id,
            kind: selectedTool,
            x: (x / r.width) * 100,
            y: (y / r.height) * 100,
            w: wPct,
            h: hPct,
          };
        }
      }
    }
    if (pending) {
      edits.push(pending);
      editHistory.push({ id: pending.id });
      nextEditId++;
      editVersion++;
    }
    // Polyline continuation: tool-entered and Ctrl-promoted both end
    // up in the same state machine.
    //   1. Dedicated tool — the chain advances on every mouseup of a
    //      Polyline / Poly-arrow draw, regardless of modifiers. Exit
    //      gestures: Esc, click on chain head (zero-length click after
    //      the chain is alive), double-click, tool switch, window blur.
    //   2. Ctrl-promote — a regular Line / Arrow draw whose mouseup
    //      sees Ctrl/Cmd held promotes to a chain. Releasing Ctrl is
    //      the primary exit (legacy modifier semantics, kept as a
    //      power-user shortcut). The same Esc / click-on-head / tool
    //      switch / blur exits also work.
    // Empty-segment mouseups still advance the chain (so the first
    // mouseup of a Polyline tool draw with no movement still enters
    // chain mode), but a zero-length mouseup *after* the chain is
    // already alive ends it — that's the "click on the chain head to
    // finish" gesture.
    const isPolylineToolEntry = polylineToolLineKind(selectedTool) !== null;
    const isCtrlPromote =
      (e.ctrlKey || e.metaKey)
      && (selectedTool === 'line' || selectedTool === 'arrow');
    const continuePolyline = isPolylineToolEntry || isCtrlPromote;
    const chainWasAlive = polylineLineKind !== null;
    if (continuePolyline) {
      if (chainWasAlive && !moved) {
        // Click on the chain head (or a sub-CLICK_THRESHOLD drag) with
        // the chain already alive — finish.
        endPolylineChain();
        return;
      }
      // Polygon-close exit: the just-committed segment ended at the
      // chain's first anchor (typically via snap pulling onto it).
      // The closing segment is already in `edits` above, so end the
      // chain — the polygon is complete and further clicks would be
      // additional disconnected segments, which the user almost
      // certainly didn't intend. Only meaningful from segment 2 on
      // (chainWasAlive); segment 1's commit is when the chain start
      // is first captured.
      if (chainWasAlive && polylineChainStart !== null) {
        const dxClose = end.x - polylineChainStart.x;
        const dyClose = end.y - polylineChainStart.y;
        if (Math.hypot(dxClose, dyClose) < 0.5) {
          endPolylineChain();
          return;
        }
      }
      // Capture the chain's origin once, at the *first* commit. Read
      // from `dragStart` while it still holds segment 1's start —
      // before the `dragStart = end` reassignment below shifts it to
      // the just-committed endpoint. Subsequent segments' commits
      // leave this point alone, so the loop-close target stays
      // anchored at the user's very first click for the entire chain.
      if (polylineChainStart === null) {
        polylineChainStart = { x: dragStart.x, y: dragStart.y };
        polylineEntryWasCtrl = isCtrlPromote;
      }
      polylineLineKind = lineKindForCommit;
      dragStart = end;
      // Re-anchor the next segment's *preview* at the physical
      // pointer, not at the just-committed endpoint. Two reasons:
      //   1. If the user fine-tuned this segment with arrow nudges,
      //      `end` is the synthetic (nudged) point — we don't want
      //      the next preview line to start there and aim back at
      //      it. The user wants the next segment to point at where
      //      the OS cursor visibly is now.
      //   2. The next physical mousemove would do the same snap on
      //      its own; doing it now means there's no zero-length
      //      preview frame between segments.
      // `lastMousePos` is also reset to the physical viewport
      // position so subsequent arrow nudges step from there rather
      // than from the consumed nudge.
      dragCurrent = localCoords(e);
      setLastMousePos({ x: e.clientX, y: e.clientY });
    } else {
      endPolylineChain();
      return;
    }
    render();
  });

  // ─── Arrow-key fine adjustment during a drag ────────────────────
  //
  // While a left-button draw / resize drag is in flight on the image
  // overlay, an arrow keypress steps the cursor by exactly one
  // *natural* (saved-output) pixel in that direction, clamped to the
  // image-pane edges. Lets the user finish a drag with output-pixel
  // precision without inching the physical mouse.
  //
  // Also runs during polyline mode (Ctrl/Cmd-held Line / Arrow chain),
  // even between segments when the mouse button isn't pressed —
  // `dragStart` stays set across the chain, so the same nudge logic
  // shifts `dragCurrent` and the live preview tracks. Releasing Ctrl
  // would normally end the chain, so the modifier gate below admits
  // the Ctrl-held case for polyline (active chain or first-segment
  // entry-drag) while still bailing on Ctrl-Arrow for non-polyline
  // drags. Alt remains blocked because Alt+Left / Alt+Right are
  // Chrome's Back / Forward history-navigation shortcuts.
  //
  // Direction filter mirrors the handle's degrees of freedom:
  //   - n / s (top or bottom edge): up / down only.
  //   - e / w (left or right edge): left / right only.
  //   - corner handle (nw / ne / sw / se), or a fresh draw via the
  //     `dragStart` path: all four arrows step. The dragStart path
  //     covers Box / Crop / Redact rect-creates and the Line / Arrow
  //     tools — for Line / Arrow the moving endpoint lives in
  //     `dragCurrent`, so the same nudge logic adjusts it live and
  //     the committed line / arrow inherits the shifted endpoint on
  //     mouseup.
  //
  // Snap-back is the price of not chasing the OS pointer: the browser
  // can't move the hardware cursor, and the next physical mousemove
  // picks the drag back up at the OS-pointer position — which keeps
  // "where the cursor visibly is" and "where the drag is" in sync.
  //
  // `lastMousePos` (owned by the zoom module for the keyboard-zoom
  // path) gives us the last known pointer position; we feed the drag
  // handler directly via `updateDragFromLocalPoint`. Capture phase so
  // the prompt textarea's default arrow-key behaviour doesn't swallow
  // the press when focus happens to sit there during the drag.
  window.addEventListener('keydown', (e) => {
    if (boxDrag === null && dragStart === null) return;
    // Alt is excluded — Alt+Left / Alt+Right are Chrome's Back /
    // Forward history-navigation shortcuts.
    if (e.altKey) return;
    // Ctrl / Meta gate:
    //   - Allowed when a Ctrl-promoted polyline chain is active — the
    //     chain requires Ctrl to stay held, so suppressing nudges would
    //     defeat the feature.
    //   - Allowed during a Line / Arrow draw with Ctrl held — the
    //     upcoming mouseup is the Ctrl-promote moment, and the user
    //     may be fine-tuning the segment end via arrow nudges before
    //     releasing.
    //   - Blocked otherwise. The user could in principle start a
    //     non-polyline Box/Crop/Redact drag and then press Ctrl
    //     mid-drag (which would set `dragStart` non-null with Ctrl
    //     held) — but Ctrl+Arrow in that case has no in-page meaning,
    //     and allowing it would suppress the textarea's "move caret by
    //     word" behaviour for no reason. Same for tool-entered polyline
    //     chains: Ctrl plays no role there, so Ctrl+Arrow is blocked.
    const ctrlPromoteActive =
      polylineLineKind !== null && polylineEntryWasCtrl;
    const ctrlPromoteEntryDrag =
      (e.ctrlKey || e.metaKey) &&
      (selectedTool === 'line' || selectedTool === 'arrow');
    if ((e.ctrlKey || e.metaKey) && !ctrlPromoteActive && !ctrlPromoteEntryDrag) return;
    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case 'ArrowLeft':  dx = -1; break;
      case 'ArrowRight': dx =  1; break;
      case 'ArrowUp':    dy = -1; break;
      case 'ArrowDown':  dy =  1; break;
      default: return;
    }
    // Once we're committed to handling an arrow keypress during a
    // drag, swallow it unconditionally — even on branches we end up
    // discarding (perpendicular axis on an edge handle, no
    // `lastMousePos` yet). Otherwise the press leaks through to the
    // focused element, which is typically the prompt textarea, and
    // the user gets a caret jump instead of the "no effect" they'd
    // expect from a key the drag can't consume.
    e.preventDefault();
    if (boxDrag) {
      const h = boxDrag.handle;
      const isCorner = h === 'nw' || h === 'ne' || h === 'sw' || h === 'se';
      if (!isCorner) {
        // Edge handle is 1-DOF — discard arrows on the perpendicular
        // axis. They're already swallowed above, so nothing reaches
        // the textarea; this branch just means no nudge happens.
        if ((h === 'n' || h === 's') && dx !== 0) return;
        if ((h === 'e' || h === 'w') && dy !== 0) return;
      }
    }
    const mp = getLastMousePos();
    if (mp === null) return;
    // One arrow press → one natural (output) pixel of change in the
    // saved image, regardless of zoom or DPR. The drag handler maps
    // a CSS-pixel cursor delta to a percent-space delta via
    // `cssPx / r.width`, which becomes natural pixels at bake time
    // via `pct * naturalWidth / 100`. Solving for "one natural px"
    // gives `stepX = r.width / naturalWidth` (and similarly stepY).
    // At 1× zoom with DPR=1 this is exactly 1 CSS px; on HiDPI or
    // when zoomed in the step shrinks below 1 (sub-pixel positions
    // are fine — the drag math is float). Zoomed out it grows above
    // 1 so each press still bumps the output by exactly one pixel.
    const r = imgRect();
    const natW = ctx.previewImg.naturalWidth;
    const natH = ctx.previewImg.naturalHeight;
    const stepX = natW > 0 ? r.width / natW : 1;
    const stepY = natH > 0 ? r.height / natH : 1;
    // Clamp to the visible-pane rect — mirrors `localCoords` so the
    // synthetic cursor can't wander past what the user can see, even
    // when zoomed and a chunk of the image lives in the scroll
    // overflow. Plain `imgRect` would let a string of nudges drift
    // the drag target into scrolled-out territory.
    const v = visibleImageRect();
    const nextX = Math.max(v.left, Math.min(v.right, mp.x + dx * stepX));
    const nextY = Math.max(v.top,  Math.min(v.bottom, mp.y + dy * stepY));
    if (nextX === mp.x && nextY === mp.y) return;
    setLastMousePos({ x: nextX, y: nextY });
    // Drive the drag handler directly with the float-precise position.
    // Going through `dispatchEvent(new MouseEvent('mousemove', {...}))`
    // would lose the sub-CSS-pixel precision: Chrome rounds `clientX`
    // / `clientY` to integers in the dispatched event, so a
    // zoomed-in / HiDPI step (always sub-pixel here) would snap back
    // to the integer pre-press position and successive presses would
    // never accumulate.
    updateDragFromLocalPoint({
      x: nextX - r.left,
      y: nextY - r.top,
    });
  }, true);

  // ─── Polyline-mode end on Ctrl/Meta release (Ctrl-promoted only)
  //
  // Only applies to chains entered via the Ctrl-on-release shortcut
  // on the Line / Arrow tools (`polylineEntryWasCtrl === true`). Chains
  // entered via the dedicated Polyline / Poly-arrow tool buttons ignore
  // Ctrl entirely — those exit via Esc, click-on-head, tool switch, or
  // window blur.
  //
  // Two cases for the Ctrl-promoted chain:
  //   - Mouse held (mid-segment drag): `polylineMouseHeld` is true.
  //     Just clear `polylineLineKind` so the upcoming mouseup commits
  //     the in-flight segment but won't continue the chain. Don't
  //     touch `dragStart` / `dragCurrent` — they're driving the live
  //     preview of the segment that's about to commit.
  //   - Mouse not held (between segments): clear everything so the
  //     ghost preview disappears immediately. No mouseup is coming.
  window.addEventListener('keyup', (e) => {
    if (polylineLineKind === null) return;
    if (!polylineEntryWasCtrl) return;
    if (e.key !== 'Control' && e.key !== 'Meta') return;
    // Use post-keyup synthesised modifier state — promote accepts
    // either Ctrl OR Meta, so releasing one while the other is still
    // held shouldn't end the chain. Without this gate, a Mac user
    // incidentally holding both modifiers would lose the chain on the
    // first release.
    if (e.ctrlKey || e.metaKey) return;
    if (polylineMouseHeld) {
      // Defer the drag-state clear to the upcoming mouseup so the
      // in-flight segment can still commit. Just clear the chain
      // markers.
      polylineLineKind = null;
      polylineChainStart = null;
      polylineEntryWasCtrl = false;
    } else {
      endPolylineChain();
    }
  });

  // ─── Polyline-mode end on Esc ───────────────────────────────────
  //
  // Universal cancel for the dedicated polyline tools (and any active
  // chain). Mirrors the "switch tool aborts chain" behaviour but with
  // a keyboard shortcut, so a user mid-chain can just hit Esc to bail.
  // Capture phase so the prompt textarea (if focused) doesn't swallow
  // the press — the focus path doesn't otherwise act on bare Esc.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (polylineLineKind === null) return;
    e.preventDefault();
    endPolylineChain();
  }, true);

  // ─── Polyline-mode behavior for clicks outside the visible image
  //
  // While a chain is alive, a left-mousedown lands in one of the
  // zones below; this listener routes them. Capture phase so we run before
  // any bubble-phase handlers on the click target — Save / Copy /
  // Undo / textarea-focus all happen *after* the chain decision is
  // made, so the user gets a single intentional action either way.
  //
  // Zones (checked in order; the first match wins):
  //
  //   1. On the visible image — the overlay's own bubble-phase
  //      mousedown handler runs the polyline-continuation branch.
  //      We don't touch the event.
  //   2. On an `imageBox` scrollbar gutter — let the browser scroll
  //      the image. The chain stays alive untouched; scrolling is
  //      navigation, not a draw or a cancel. Checked before the
  //      buffer test because in zoomed modes the scrollbar sits
  //      flush against the visible-pane edge.
  //   3. In the `EDGE_COMMIT_BUFFER_PX` halo just outside the
  //      visible image — forgive the overshoot and commit the
  //      segment at the visible-pane edge. The check is a pure
  //      distance test (no container gate): the layout keeps every
  //      interactable element farther than the buffer width from
  //      the image, so palette / prompt clicks naturally fall into
  //      zone 4 instead. We swallow the event (preventDefault +
  //      stopPropagation) and set `polylineMouseHeld`; the window
  //      mouseup then fires the normal commit branch using
  //      `dragCurrent` (already clamped to the visible edge by the
  //      window-mousemove handler's `localCoords` call).
  //   4. Anywhere else (deeper into the page — palette, prompt,
  //      zoom menu popover, page background) — end the chain and
  //      let the click propagate to its real target, no
  //      `preventDefault`.
  //
  // Middle-click pan (button 1) and right-click context menu
  // (button 2) are exempt — neither feels like "click somewhere
  // else", and middle-click pan is a legitimate way to reposition
  // the image mid-chain.
  document.addEventListener('mousedown', (e) => {
    const me = e as MouseEvent;
    if (me.button !== 0) return;
    if (polylineLineKind === null) return;
    if (isOverVisibleImage(me.clientX, me.clientY)) return;
    if (isOverImageBoxScrollbar(me.clientX, me.clientY)) return;
    if (isWithinEdgeCommitBuffer(me.clientX, me.clientY)) {
      me.preventDefault();
      me.stopPropagation();
      polylineMouseHeld = true;
      return;
    }
    endPolylineChain();
  }, true);

  ctx.undoBtn.addEventListener('click', () => {
    const last = editHistory.pop();
    if (!last) return;
    const idx = edits.findIndex((e) => e.id === last.id);
    if (idx >= 0) {
      if (last.prev) {
        // In-place geometry op (Shrink click or edge-handle resize)
        // — restore the rect's pre-mutation geometry. Only rect-shaped
        // edits (rect / redact / crop) carry resizable geometry, so
        // this branch is unreachable for line / arrow.
        const e = edits[idx]!;
        if (e.kind === 'rect' || e.kind === 'redact' || e.kind === 'crop') {
          e.x = last.prev.x;
          e.y = last.prev.y;
          e.w = last.prev.w;
          e.h = last.prev.h;
        }
      } else {
        edits.splice(idx, 1);
      }
    }
    editVersion++;
    render();
  });

  ctx.clearBtn.addEventListener('click', () => {
    edits.length = 0;
    editHistory.length = 0;
    editVersion++;
    render();
  });

  ctx.shrinkBtn.addEventListener('click', () => {
    const target = shrinkTarget();
    if (!target) return;
    const base = getBasePixels();
    if (!base) return;
    const natW = ctx.previewImg.naturalWidth;
    const natH = ctx.previewImg.naturalHeight;

    const startPct = target.kind === 'rect-edit'
      ? { x: target.edit.x, y: target.edit.y, w: target.edit.w, h: target.edit.h }
      : { x: 0, y: 0, w: 100, h: 100 };
    const startPx = pctRectToPixels(startPct, natW, natH);
    const isBox = target.kind === 'rect-edit' && target.edit.kind === 'rect';

    const rectsEqual = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number },
    ): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

    let tightPx = shrinkRect(base, startPx);

    // Box-mode multi-step drilling: a previously-shrunk Box has its
    // edges 1 pixel *outside* the content (the +1 expansion), so the
    // algorithm's snapshot from `startPx` is plain bg and the next
    // line in is content — no advance. Crop / Redact don't have this
    // problem because their edges already sit ON the content. To let
    // Box drill into nested content the same way (e.g. a coarse box
    // → tight around a text+divider block on click 1 → tight around
    // just the text on click 2 once the divider's uniform pixels
    // become the new snapshot), retry from the rect contracted by 1
    // when the first attempt couldn't advance. The contracted rect's
    // edges sit on the previous content's outer pixels, mirroring the
    // Crop / Redact starting state.
    //
    // The retry is all-or-nothing: it fires only when the first
    // attempt advanced *zero* edges. Partially-advanced results (e.g.
    // top/bottom drill but left/right don't) keep the partial result
    // — the user can click again to drill the remaining edges.
    if (isBox && (!tightPx || rectsEqual(tightPx, startPx))) {
      const contractedW = Math.max(0, startPx.w - 2);
      const contractedH = Math.max(0, startPx.h - 2);
      if (contractedW > 0 && contractedH > 0) {
        const contracted = {
          x: startPx.x + 1,
          y: startPx.y + 1,
          w: contractedW,
          h: contractedH,
        };
        const drilled = shrinkRect(base, contracted);
        // Only adopt the drilled result if the algorithm actually
        // advanced past the contracted starting rect — otherwise
        // we'd be calling a no-op "tighter than contracted" and
        // shrinking the box for no reason.
        if (drilled && !rectsEqual(drilled, contracted)) {
          tightPx = drilled;
        }
      }
    }

    if (!tightPx) return;

    // Algorithm-noop guard: if no edge moved (the start was already
    // wrapping the content as tightly as the snapshot rule allows
    // — including the Box drilling retry above), bail *before* the
    // Box +1 expansion. Without this, repeated Box clicks would
    // unconditionally re-expand by 1 each click — pulsing on clean
    // content, growing on noisy content.
    if (rectsEqual(tightPx, startPx)) return;

    // For Box outlines, the rect is the stroke geometry — the user
    // wants the stroke centerline to sit just outside the wrapped
    // object, not painted across it. Expanding the tight content
    // rect by 1 natural pixel on every side puts the centerline one
    // pixel outside the content; on a heavily-downscaled preview
    // the stroke's half-width can still cross the boundary by a
    // fraction of a display pixel, which is the best we can do
    // without scaling the expansion to the live display ratio.
    // Crop and Redact keep the tight rect (crop = exactly the
    // content, redact = covers exactly the content).
    let finalPx;
    if (isBox) {
      // Compute the box-stroke rect as the tight content rect
      // expanded by 1 pixel on every side, clamped *both* to the
      // image bounds AND to startPx. The startPx clamp enforces the
      // hard invariant that Shrink must never grow the box on any
      // edge. `shrinkRect` works in integer pixels and either holds
      // an edge fixed (advance = 0) or moves it inward by ≥ 1, so
      // the only case the clamp catches is the held-fixed one:
      // there `tightPx.edge == startPx.edge`, and the raw
      // `tightPx ± 1` would land 1 px past startPx — i.e. grow it.
      // Clamping to startPx pulls those held edges back. Without
      // this, a partial advance (e.g. only the right edge had slack
      // because top/bot/left already sat 1 px outside content from a
      // previous Shrink) grew the non-advanced edges every click —
      // the user saw this as the Box drifting / getting bigger /
      // oscillating.
      // Edges of tightPx that genuinely advanced ≥ 1 px sit ≥ 1 px
      // inside startPx, so `tightPx - 1` is already ≤ startPx and
      // the clamp is a no-op for those edges.
      const sxr = startPx.x + startPx.w;
      const syb = startPx.y + startPx.h;
      const fx = Math.max(startPx.x, Math.max(0, tightPx.x - 1));
      const fy = Math.max(startPx.y, Math.max(0, tightPx.y - 1));
      const fr = Math.min(sxr, Math.min(natW, tightPx.x + tightPx.w + 1));
      const fb = Math.min(syb, Math.min(natH, tightPx.y + tightPx.h + 1));
      finalPx = { x: fx, y: fy, w: fr - fx, h: fb - fy };
    } else {
      finalPx = tightPx;
    }

    const finalPct = pixelsToPctRect(finalPx, natW, natH);

    // No-op guard: if rounding (or already-tight content) produces
    // the same percentage rect, don't push a no-op onto the history
    // stack — Undo would then have to walk past silent entries.
    const same =
      Math.abs(finalPct.x - startPct.x) < 0.001 &&
      Math.abs(finalPct.y - startPct.y) < 0.001 &&
      Math.abs(finalPct.w - startPct.w) < 0.001 &&
      Math.abs(finalPct.h - startPct.h) < 0.001;
    if (same) return;

    if (target.kind === 'rect-edit') {
      const e = target.edit;
      editHistory.push({
        id: e.id,
        prev: { x: e.x, y: e.y, w: e.w, h: e.h },
      });
      e.x = finalPct.x;
      e.y = finalPct.y;
      e.w = finalPct.w;
      e.h = finalPct.h;
    } else {
      // Promote the implicit full-image crop to a real crop edit.
      const id = nextEditId++;
      edits.push({ id, kind: 'crop', ...finalPct });
      editHistory.push({ id });
    }
    editVersion++;
    render();
  });

  for (const btn of ctx.toolButtons) {
    // Switch on mousedown (not click) so the previously-selected tool
    // loses its `.selected` look the moment the user presses a new
    // one. Otherwise the old tool stays highlighted alongside the new
    // tool's `:active` press feedback for the entire mousedown→mouseup
    // window — two pressed-looking buttons at once. Filter to button 0
    // so a stray right-click doesn't switch tools.
    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const tool = btn.dataset.tool as Tool | undefined;
      if (tool) setSelectedTool(tool);
    });
  }
}
