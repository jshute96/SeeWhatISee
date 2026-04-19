// Controller script for the capture.html extension page.
//
// Flow:
//   1. background.ts captures a screenshot + page HTML into
//      chrome.storage.session (keyed by the new tab id), then opens
//      capture.html in that tab.
//   2. On load we ask background for our pre-captured data via a
//      runtime message. background reads it from session storage and
//      sends it back; we show the screenshot, the captured URL, and
//      the HTML byte size.
//   3. User picks which artifacts to save (checkboxes), types an
//      optional prompt, optionally draws highlights over the preview
//      (rectangles and lines — all in a single undo stack), and
//      clicks Capture. We send the options back to background, which
//      delegates per-artifact to its `ensure…Downloaded` helpers
//      (which short-circuit on cached pre-downloads from the Copy
//      buttons) and then writes the sidecar via
//      `recordDetailedCapture`. The tab closes once the round-trip
//      completes.
//
// Must live in a separate .js file (not inline in capture.html)
// because the default extension-page CSP forbids inline scripts.

interface DetailsData {
  screenshotDataUrl: string;
  html: string;
  url: string;
  /**
   * True when the SW captured a non-empty selection on the active
   * tab. The actual selection HTML stays in the SW's session
   * storage — the page only needs this flag to enable / default
   * the Save selection checkbox.
   */
  hasSelection?: boolean;
}

/**
 * Monotonic edit counter. Bumped every time the highlight stack
 * changes (drawn rect/line, undo, clear). Sent to the SW with
 * every Copy and Capture request so it can decide whether the
 * cached on-disk PNG still represents the user's current state or
 * needs to be re-downloaded with the new highlights baked in.
 *
 * HTML never edits, so it doesn't need an equivalent counter — the
 * SW caches the HTML download unconditionally for the session.
 */
let editVersion = 0;

const screenshotBox = document.getElementById('cap-screenshot') as HTMLInputElement;
const htmlBox = document.getElementById('cap-html') as HTMLInputElement;
const selectionBox = document.getElementById('cap-selection') as HTMLInputElement;
const captureBtn = document.getElementById('capture') as HTMLButtonElement;
const promptInput = document.getElementById('prompt-text') as HTMLTextAreaElement;
const previewImg = document.getElementById('preview') as HTMLImageElement;
const capturedUrlInput = document.getElementById('captured-url') as HTMLInputElement;
const htmlSizeEl = document.getElementById('html-size') as HTMLSpanElement;
const copyScreenshotBtn = document.getElementById('copy-screenshot-name') as HTMLButtonElement;
const copyHtmlBtn = document.getElementById('copy-html-name') as HTMLButtonElement;
const copySelectionBtn = document.getElementById('copy-selection-name') as HTMLButtonElement;
// `getElementById` returns `HTMLElement | null`. SVG elements are
// `SVGElement`, which sits on a sibling branch of the DOM type
// hierarchy — TypeScript won't let us cast directly across the
// branches without a `unknown` bridge.
const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;
const undoBtn = document.getElementById('undo') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const redactBtn = document.getElementById('redact') as HTMLButtonElement;
const cropBtn = document.getElementById('crop') as HTMLButtonElement;

promptInput.focus();

// Auto-grow the prompt textarea to fit its content, capped by CSS
// max-height. After resizing we re-fit the image because its top has
// shifted down by the same amount the textarea grew.
function autoGrowPrompt(): void {
  promptInput.style.height = 'auto';
  const sh = promptInput.scrollHeight;
  promptInput.style.height = sh + 'px';
  // Only show the scrollbar once we've hit the CSS max-height cap, so
  // short prompts stay scrollbar-free even when sub-pixel rounding
  // would otherwise nudge scrollHeight just past the rendered height.
  promptInput.style.overflowY = sh > 200 ? 'auto' : 'hidden';
  fitImage();
}
promptInput.addEventListener('input', autoGrowPrompt);

promptInput.addEventListener('keydown', (e) => {
  // Shift+Enter inserts a newline; plain Enter submits.
  if (e.key === 'Enter' && !e.shiftKey && !captureBtn.disabled) {
    e.preventDefault();
    captureBtn.click();
  }
});

document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 's') {
    e.preventDefault();
    screenshotBox.checked = !screenshotBox.checked;
  } else if (key === 'h') {
    e.preventDefault();
    htmlBox.checked = !htmlBox.checked;
  } else if (key === 'n') {
    // Alt+N toggles Save selection. No-op when the checkbox is
    // disabled (no selection was captured) so the hotkey matches
    // what's on screen.
    if (selectionBox.disabled) return;
    e.preventDefault();
    selectionBox.checked = !selectionBox.checked;
  }
});

// ─── HTML byte size formatting ────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // 1 decimal under 10, otherwise rounded — keeps display tight.
  const formatted = v < 10 ? v.toFixed(1) : Math.round(v).toString();
  return formatted + ' ' + units[i];
}

// ─── Highlight overlay ────────────────────────────────────────────
//
// Left-click-drag draws red rectangles; right-click-drag draws red
// lines. Any drawn red rectangle can be *converted* in place to one
// of two other kinds without leaving the stack:
//
//   - Redact — opaque black box that hides whatever was under it in
//     the saved PNG. The Redact button is enabled whenever any
//     unconverted red rectangle exists and converts the most recent
//     such one per click.
//   - Crop — shrinks the saved PNG to the rectangle and dims
//     everything outside in the preview. Only available when the
//     top of the stack is currently an unconverted red rectangle
//     (the user asked for this gating so a crop reliably applies
//     to the rectangle they just drew).
//
// Both conversions are themselves undoable: Undo walks back one
// history step (draw, convert, or convert again), so popping a
// conversion restores the red rectangle it came from. Clear wipes
// everything. Coordinates are percentages of the image so edits
// survive resizes and prompt growth.

type Point = { x: number; y: number };
type RectKind = 'rect' | 'redact' | 'crop';
interface RectEdit {
  id: number;
  kind: RectKind;
  x: number; y: number; w: number; h: number;
}
interface LineEdit {
  id: number;
  kind: 'line';
  x1: number; y1: number; x2: number; y2: number;
}
type Edit = RectEdit | LineEdit;

// History is an append-only log so Undo can reverse both draws and
// conversions. 'add' entries reference an edit by id so Undo can
// remove it; 'convert' entries carry the previous kind so Undo can
// put it back. Clear wipes both `edits` and `history`.
type HistoryOp =
  | { op: 'add'; id: number }
  | { op: 'convert'; id: number; from: RectKind; to: RectKind };

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
let dragButton: number | null = null;

// ─── Crop-drag state ──────────────────────────────────────────────
//
// Each of the four edges and four corners of the image (or the
// active crop, when one exists) is a draggable handle. The user can
// drag inward to create a crop from scratch or to resize an existing
// one. Every completed drag commits a new 'crop' edit on the stack,
// so it participates in Undo / Clear the same way a button-converted
// crop does — and so resizes nest naturally without mutating prior
// stack entries.
//
// Handles are sampled by hit-testing a `HANDLE_PX` band around the
// four edges of the effective crop rectangle (the active crop's
// bounds, or the full image bounds when no crop exists). Corner
// regions take precedence over edges (the four-way cursor beats the
// one-axis cursor).
type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

// Width of the edge-hit band in CSS pixels. Large enough to be
// grabbable by mouse but small enough not to eat into the interior
// region where rect/line drawing happens. Tuned by feel.
const HANDLE_PX = 10;

// Minimum crop width/height as a fraction of the image, so a drag
// can't collapse the crop to 0×0 (which would make it impossible to
// grab the handles on the next drag). 3% picks up ~20 px on a
// 600 px preview — enough room to click on without being a wasted
// constraint.
const MIN_CROP_PCT = 3;

interface CropDragState {
  handle: CropHandle;
  // Starting geometry in percentages — the crop we're editing.
  // Either the current activeCrop()'s bounds or the full image
  // (0, 0, 100, 100) when creating a fresh crop.
  startX: number; startY: number; startW: number; startH: number;
  // Where the pointer was when the drag began, in display pixels.
  // We track deltas rather than absolute positions so a drag that
  // starts slightly off-edge (within HANDLE_PX) still produces the
  // expected motion.
  originX: number; originY: number;
  // Live proposed bounds, updated every mousemove and rendered as
  // the preview crop. Commit-on-mouseup copies these into a new
  // 'crop' edit if the drag moved enough to count.
  curX: number; curY: number; curW: number; curH: number;
}
let cropDrag: CropDragState | null = null;

function imgRect(): DOMRect {
  return previewImg.getBoundingClientRect();
}

function localCoords(e: MouseEvent): Point {
  const r = imgRect();
  return {
    x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
    y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
  };
}

function findEdit(id: number): Edit | undefined {
  return edits.find((e) => e.id === id);
}

// The effective crop rectangle is the most-recently-added 'crop'
// edit still in the stack. Earlier crops are hidden by the newer
// one's dim overlay; on save, only the newest crop bounds the output.
function activeCrop(): RectEdit | undefined {
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    if (e.kind === 'crop') return e;
  }
  return undefined;
}

// The effective crop region, in percentages. When no crop exists,
// the region is the full image — which is also what the crop-handle
// hit test uses, so "drag the image edge to start cropping" falls
// out naturally.
function effectiveCropPct(): { x: number; y: number; w: number; h: number } {
  const c = activeCrop();
  if (c) return { x: c.x, y: c.y, w: c.w, h: c.h };
  return { x: 0, y: 0, w: 100, h: 100 };
}

function cursorForHandle(h: CropHandle): string {
  switch (h) {
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'nw': case 'se': return 'nwse-resize';
  }
}

// Hit-test the pointer against the effective crop's edges. Returns
// which handle (if any) the pointer is inside the HANDLE_PX band of.
// Corners take precedence over plain edges: a pointer that's near
// both the top and the left counts as the 'nw' corner handle.
function detectCropHandle(p: Point): CropHandle | null {
  const r = imgRect();
  const c = effectiveCropPct();
  const cx = (c.x / 100) * r.width;
  const cy = (c.y / 100) * r.height;
  const cw = (c.w / 100) * r.width;
  const ch = (c.h / 100) * r.height;

  const nearLeft = Math.abs(p.x - cx) <= HANDLE_PX;
  const nearRight = Math.abs(p.x - (cx + cw)) <= HANDLE_PX;
  const nearTop = Math.abs(p.y - cy) <= HANDLE_PX;
  const nearBottom = Math.abs(p.y - (cy + ch)) <= HANDLE_PX;

  // Edge bands only match when the pointer is also inside the
  // perpendicular extent of the crop (plus a small outside band so
  // the handle is grabbable when the crop is flush with the image
  // edge). Without this clamp, a pointer halfway down the image in
  // empty space beside the crop would count as "near the left edge"
  // and flip the cursor to resize, which is confusing.
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

// Given an initial crop rectangle and a pointer delta (in display
// pixels) on a specific handle, compute the proposed new crop
// rectangle in percentages. Caller already translated the pointer
// delta; this function only enforces:
//   - Correct axis for each handle (n/s move only the top/bottom
//     edge; e/w move only the left/right; corners move two edges).
//   - The crop stays inside the image (0 ≤ x, x+w ≤ 100, likewise y).
//   - The crop never collapses below MIN_CROP_PCT on either axis.
// Negative-sized drags (dragging past the opposite edge) clamp to
// MIN_CROP_PCT rather than flipping — flipping feels surprising on
// a crop tool and isn't needed for the resize workflow.
function applyCropDrag(
  start: { startX: number; startY: number; startW: number; startH: number },
  handle: CropHandle,
  dxPct: number, dyPct: number,
): { x: number; y: number; w: number; h: number } {
  let left = start.startX;
  let top = start.startY;
  let right = start.startX + start.startW;
  let bottom = start.startY + start.startH;

  if (handle === 'n' || handle === 'ne' || handle === 'nw') top += dyPct;
  if (handle === 's' || handle === 'se' || handle === 'sw') bottom += dyPct;
  if (handle === 'w' || handle === 'nw' || handle === 'sw') left += dxPct;
  if (handle === 'e' || handle === 'ne' || handle === 'se') right += dxPct;

  left = Math.max(0, Math.min(100 - MIN_CROP_PCT, left));
  right = Math.max(left + MIN_CROP_PCT, Math.min(100, right));
  top = Math.max(0, Math.min(100 - MIN_CROP_PCT, top));
  bottom = Math.max(top + MIN_CROP_PCT, Math.min(100, bottom));

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

function makeLine(x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', String(x1));
  el.setAttribute('y1', String(y1));
  el.setAttribute('x2', String(x2));
  el.setAttribute('y2', String(y2));
  el.setAttribute('stroke', 'red');
  el.setAttribute('stroke-width', '3');
  el.setAttribute('stroke-linecap', 'round');
  return el;
}

function render(): void {
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  const r = imgRect();
  const w = r.width;
  const h = r.height;

  for (const e of edits) {
    if (e.kind === 'line') {
      overlay.appendChild(makeLine(
        (e.x1 / 100) * w,
        (e.y1 / 100) * h,
        (e.x2 / 100) * w,
        (e.y2 / 100) * h,
      ));
    } else if (e.kind === 'rect') {
      overlay.appendChild(makeStrokedRect(
        (e.x / 100) * w,
        (e.y / 100) * h,
        (e.w / 100) * w,
        (e.h / 100) * h,
        'red',
      ));
    } else if (e.kind === 'redact') {
      overlay.appendChild(makeFilledRect(
        (e.x / 100) * w,
        (e.y / 100) * h,
        (e.w / 100) * w,
        (e.h / 100) * h,
        'black',
      ));
    }
    // 'crop' is not drawn inline — it's painted as a single
    // "outside-is-dimmed" overlay below using the active crop
    // (only the most recent crop is visible).
  }

  // Render the crop as the drag preview if a crop-drag is in
  // progress, else the committed active crop, else nothing. Both
  // drag-preview and committed-crop share the same visual (dim
  // surround + dashed border + grip marks), so the user sees the
  // final state live while dragging.
  let cropPreview:
    | { x: number; y: number; w: number; h: number }
    | undefined;
  if (cropDrag) {
    cropPreview = { x: cropDrag.curX, y: cropDrag.curY, w: cropDrag.curW, h: cropDrag.curH };
  } else {
    const crop = activeCrop();
    if (crop) cropPreview = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
  }
  if (cropPreview) {
    // Four dim rectangles around the crop region: top, bottom, left,
    // right. Using four rects (rather than a single evenodd-filled
    // path) keeps the SVG readable and avoids any platform-specific
    // rendering quirks around path fill rules.
    const cx = (cropPreview.x / 100) * w;
    const cy = (cropPreview.y / 100) * h;
    const cw = (cropPreview.w / 100) * w;
    const ch = (cropPreview.h / 100) * h;
    const dim = 'rgba(0,0,0,0.55)';
    if (cy > 0) overlay.appendChild(makeFilledRect(0, 0, w, cy, dim));
    if (cy + ch < h) overlay.appendChild(makeFilledRect(0, cy + ch, w, h - (cy + ch), dim));
    if (cx > 0) overlay.appendChild(makeFilledRect(0, cy, cx, ch, dim));
    if (cx + cw < w) overlay.appendChild(makeFilledRect(cx + cw, cy, w - (cx + cw), ch, dim));
    // A thin dashed border along the crop edges so the region is
    // legible even when the underlying pixels are low-contrast.
    const border = makeStrokedRect(cx, cy, cw, ch, '#fff', 1);
    border.setAttribute('stroke-dasharray', '4 3');
    overlay.appendChild(border);
    // Small square grips at the four corners so the handles are
    // discoverable without requiring the user to first hover into
    // the invisible hit band. A 6×6 white grip with a 1px dark
    // outline reads on both light and dark backgrounds.
    const gripSize = 6;
    const corners: Array<[number, number]> = [
      [cx, cy], [cx + cw, cy], [cx, cy + ch], [cx + cw, cy + ch],
    ];
    for (const [gx, gy] of corners) {
      const g = makeFilledRect(gx - gripSize / 2, gy - gripSize / 2, gripSize, gripSize, '#fff');
      g.setAttribute('stroke', '#333');
      g.setAttribute('stroke-width', '1');
      overlay.appendChild(g);
    }
  }

  if (dragStart && dragCurrent) {
    if (dragButton === 2) {
      overlay.appendChild(makeLine(
        dragStart.x, dragStart.y, dragCurrent.x, dragCurrent.y,
      ));
    } else {
      const x = Math.min(dragStart.x, dragCurrent.x);
      const y = Math.min(dragStart.y, dragCurrent.y);
      const dw = Math.abs(dragCurrent.x - dragStart.x);
      const dh = Math.abs(dragCurrent.y - dragStart.y);
      overlay.appendChild(makeStrokedRect(x, y, dw, dh, 'red'));
    }
  }

  const hasEditHistory = editHistory.length > 0;
  undoBtn.disabled = !hasEditHistory;
  clearBtn.disabled = !hasEditHistory;
  // Redact requires *any* unconverted red rect to exist; each click
  // converts the most recent one, so repeated clicks walk backward.
  redactBtn.disabled = !edits.some((e) => e.kind === 'rect');
  // Crop only applies to the most recent draw. If the top of the
  // stack is a line or already-converted rect, the button stays
  // disabled — matches the user's "this only applies to the most
  // recent red box" rule and avoids silently converting something
  // further down.
  const top = edits[edits.length - 1];
  cropBtn.disabled = !top || top.kind !== 'rect';
}

overlay.addEventListener('mousedown', (e) => {
  const me = e as MouseEvent;
  if (me.button !== 0 && me.button !== 2) return;
  const p = localCoords(me);
  // Left-button press on a crop handle starts a crop-drag instead
  // of the usual rect/line draw. Right-button always draws a line —
  // lines aren't a natural fit for "drag the crop edge."
  if (me.button === 0) {
    const handle = detectCropHandle(p);
    if (handle) {
      me.preventDefault();
      const c = effectiveCropPct();
      cropDrag = {
        handle,
        startX: c.x, startY: c.y, startW: c.w, startH: c.h,
        originX: p.x, originY: p.y,
        curX: c.x, curY: c.y, curW: c.w, curH: c.h,
      };
      render();
      return;
    }
  }
  me.preventDefault();
  dragStart = p;
  dragCurrent = dragStart;
  dragButton = me.button;
  render();
});

// Suppress the browser context menu so right-click-drag is available
// for drawing lines.
overlay.addEventListener('contextmenu', (e) => e.preventDefault());

// Idle-hover cursor feedback: match `detectCropHandle` so the user
// gets a resize cursor before committing to the drag. When a drag
// is already in flight (rect or crop) the mousemove handler below
// owns the cursor, so skip the hover branch.
overlay.addEventListener('mousemove', (e) => {
  if (dragStart || cropDrag) return;
  const handle = detectCropHandle(localCoords(e));
  overlay.style.cursor = handle ? cursorForHandle(handle) : 'crosshair';
});

window.addEventListener('mousemove', (e) => {
  if (cropDrag) {
    const r = imgRect();
    const p = localCoords(e);
    const dxPct = ((p.x - cropDrag.originX) / r.width) * 100;
    const dyPct = ((p.y - cropDrag.originY) / r.height) * 100;
    const next = applyCropDrag(cropDrag, cropDrag.handle, dxPct, dyPct);
    cropDrag.curX = next.x;
    cropDrag.curY = next.y;
    cropDrag.curW = next.w;
    cropDrag.curH = next.h;
    overlay.style.cursor = cursorForHandle(cropDrag.handle);
    render();
    return;
  }
  if (dragStart === null) return;
  dragCurrent = localCoords(e);
  render();
});

window.addEventListener('mouseup', (e) => {
  if (cropDrag) {
    // Left-button only for crop drag — ignore any stray right-up.
    if (e.button !== 0) return;
    const end = localCoords(e);
    const movedEnough =
      Math.hypot(end.x - cropDrag.originX, end.y - cropDrag.originY) >=
      CLICK_THRESHOLD_PX;
    // Only commit if the drag actually moved — a bare click on a
    // handle shouldn't add a zero-change crop edit to the stack
    // (would pollute Undo history with no-ops).
    if (movedEnough) {
      const id = nextEditId++;
      edits.push({
        id,
        kind: 'crop',
        x: cropDrag.curX,
        y: cropDrag.curY,
        w: cropDrag.curW,
        h: cropDrag.curH,
      });
      editHistory.push({ op: 'add', id });
      editVersion++;
    }
    cropDrag = null;
    overlay.style.cursor = 'crosshair';
    render();
    return;
  }

  if (dragStart === null) return;
  // dragStart and dragButton are always set/cleared together by the
  // mousedown/mouseup pair, so reaching this line implies dragButton
  // is non-null. The non-null assertion makes the intent explicit
  // and lets TypeScript narrow the comparison without an extra
  // guard the runtime would never hit.
  if (e.button !== dragButton!) return;
  const end = localCoords(e);
  const r = imgRect();
  const dx = end.x - dragStart.x;
  const dy = end.y - dragStart.y;
  const moved = Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX;
  // Both buttons require real movement to produce an edit. A bare
  // click (no drag) is discarded so we don't push a degenerate
  // zero-size rectangle / zero-length line.
  if (moved) {
    const id = nextEditId++;
    if (dragButton === 2) {
      edits.push({
        id,
        kind: 'line',
        x1: (dragStart.x / r.width) * 100,
        y1: (dragStart.y / r.height) * 100,
        x2: (end.x / r.width) * 100,
        y2: (end.y / r.height) * 100,
      });
    } else {
      const x = Math.min(dragStart.x, end.x);
      const y = Math.min(dragStart.y, end.y);
      edits.push({
        id,
        kind: 'rect',
        x: (x / r.width) * 100,
        y: (y / r.height) * 100,
        w: (Math.abs(dx) / r.width) * 100,
        h: (Math.abs(dy) / r.height) * 100,
      });
    }
    editHistory.push({ op: 'add', id });
    editVersion++;
  }
  dragStart = null;
  dragCurrent = null;
  dragButton = null;
  render();
});

undoBtn.addEventListener('click', () => {
  const last = editHistory.pop();
  if (!last) return;
  if (last.op === 'add') {
    const idx = edits.findIndex((e) => e.id === last.id);
    if (idx >= 0) edits.splice(idx, 1);
  } else {
    // Revert the conversion: find the edit and put its previous
    // kind back. Lines are never convert targets, so we know this
    // is a RectEdit.
    const e = findEdit(last.id);
    if (e && e.kind !== 'line') e.kind = last.from;
  }
  editVersion++;
  render();
});

clearBtn.addEventListener('click', () => {
  edits.length = 0;
  editHistory.length = 0;
  editVersion++;
  render();
});

// Convert the most recent unconverted red rectangle (searching back
// from the top of the stack) to a redaction. Button-disabled gate in
// render() already ensures one exists, but we re-check here so the
// handler is safe to call programmatically too.
redactBtn.addEventListener('click', () => {
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    if (e.kind === 'rect') {
      editHistory.push({ op: 'convert', id: e.id, from: 'rect', to: 'redact' });
      e.kind = 'redact';
      editVersion++;
      render();
      return;
    }
  }
});

// Convert the top-of-stack red rectangle to the active crop region.
// Disabled unless the last edit is an un-converted rect — see
// render() for the gating rule.
cropBtn.addEventListener('click', () => {
  const top = edits[edits.length - 1];
  if (!top || top.kind !== 'rect') return;
  editHistory.push({ op: 'convert', id: top.id, from: 'rect', to: 'crop' });
  top.kind = 'crop';
  editVersion++;
  render();
});

// ─── Image fit ────────────────────────────────────────────────────
//
// Shrink the image so it fits within the remaining viewport height —
// no vertical scroll. The top of the image is determined by elements
// above it, which don't depend on the image's size, so resetting
// max-height before measuring gives a stable top.

function fitImage(): void {
  previewImg.style.maxHeight = '';
  const top = previewImg.getBoundingClientRect().top;
  // 24 = body bottom margin; 2 = wrap top + bottom border (1px each).
  const reserved = 24 + 2;
  const avail = window.innerHeight - top - reserved;
  if (avail > 0) previewImg.style.maxHeight = avail + 'px';
  render();
}

window.addEventListener('resize', () => {
  // Re-grow the prompt because line wrap points may have changed,
  // then re-fit the image to whatever space is left.
  autoGrowPrompt();
});
previewImg.addEventListener('load', fitImage);

// ─── Initial data load ────────────────────────────────────────────

async function loadData(): Promise<void> {
  try {
    const response: DetailsData | undefined = await chrome.runtime.sendMessage({
      action: 'getDetailsData',
    });
    if (!response) return;
    previewImg.src = response.screenshotDataUrl;
    capturedUrlInput.value = response.url;
    // True UTF-8 byte count of the captured HTML, not the JS string
    // length (which counts UTF-16 code units).
    htmlSizeEl.textContent = formatBytes(new Blob([response.html]).size);
    // Enable + default-check the Save selection controls iff the SW
    // saw a non-empty selection at capture time. A user who bothered
    // to select text probably wants it in the record.
    if (response.hasSelection) {
      selectionBox.checked = true;
      selectionBox.disabled = false;
      copySelectionBtn.disabled = false;
    }
    // Wait for the preview image to decode before revealing, so the
    // page comes in with the screenshot already visible (not
    // popping in a frame later). `complete` is false for a freshly-
    // assigned src; data: URLs decode fast but the event is still
    // async. Treat `error` the same as `load` so a broken image
    // doesn't strand the page invisible.
    if (!previewImg.complete) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        previewImg.addEventListener('load', done, { once: true });
        previewImg.addEventListener('error', done, { once: true });
      });
    }
  } finally {
    // Reveal the body unconditionally — including on an empty
    // response or a thrown message call — so the user never stares
    // at a blank page with no recourse.
    document.body.style.visibility = 'visible';
  }
}

// ─── Copy-filename buttons ────────────────────────────────────────
//
// Each click materializes the file on disk via the SW (writing under
// the same pinned filename the eventual Save would use), then writes
// the file's absolute on-disk path to the clipboard. The SW caches
// the download per-tab so subsequent clicks (and the eventual
// Capture click) reuse the existing file. For the screenshot, the
// cache is keyed by `editVersion` so a highlight change forces a
// re-download with the new baked-in PNG; for HTML, the cache is
// unconditional (no editing UI changes the body).
//
// Extension pages have direct access to `navigator.clipboard.writeText`
// under a user gesture — no offscreen helper needed (unlike the SW's
// Copy-last-… menu entries).

copyScreenshotBtn.addEventListener('click', () => {
  void copyArtifactPath('screenshot');
});
copyHtmlBtn.addEventListener('click', () => {
  void copyArtifactPath('html');
});
copySelectionBtn.addEventListener('click', () => {
  void copyArtifactPath('selection');
});

// Last `editVersion` we sent the SW with a screenshot override. If
// the user hasn't drawn / undone since, we skip the (potentially
// multi-MB) PNG bake + message-channel copy on the next click — the
// SW will hit its cache anyway and ignore any override we'd send.
// Reset to -1 so the very first Copy with edits forces a bake.
let lastSentScreenshotEditVersion = -1;

async function copyArtifactPath(kind: 'screenshot' | 'html' | 'selection'): Promise<void> {
  // Skip the bake + override when the SW will cache-hit. The cache
  // is keyed by `editVersion`, so if we already shipped this version
  // (and therefore the SW already has the matching file on disk),
  // there's no point baking a fresh PNG just for the SW to drop.
  const needsBake =
    kind === 'screenshot' &&
    hasBakeableEdits() &&
    editVersion !== lastSentScreenshotEditVersion;
  const screenshotOverride = needsBake ? renderHighlightedPng() : undefined;
  const response = (await chrome.runtime.sendMessage({
    action: 'ensureDownloaded',
    kind,
    editVersion,
    screenshotOverride,
  })) as { path?: string; error?: string } | undefined;
  if (!response || response.error || !response.path) {
    console.warn(
      '[SeeWhatISee] copy filename failed:',
      response?.error ?? 'no response from background',
    );
    return;
  }
  if (kind === 'screenshot') lastSentScreenshotEditVersion = editVersion;
  await navigator.clipboard.writeText(response.path);
}

// Render the preview image with all current edits baked into the
// PNG bytes, at the screenshot's natural resolution. Used when the
// user saves a screenshot that has edits — we want the saved file
// to show the markup (and the cropped region, if any), not just the
// underlying screenshot.
//
// Stroke widths in the SVG overlay are CSS pixels at display size;
// we scale them up by the display→natural ratio so they look the
// same in the saved PNG as they did during editing (otherwise a 3px
// stroke on a 4×-downscaled preview would render as a hairline in
// the saved file).
//
// When an active crop exists, the canvas is sized to the crop
// region (not the full image) and every edit's coordinates are
// translated into the cropped frame so the bake-in output shows
// exactly what the user saw through the dim overlay.
function renderHighlightedPng(): string {
  const natW = previewImg.naturalWidth;
  const natH = previewImg.naturalHeight;
  const crop = activeCrop();

  // Source rectangle on the natural-resolution image. For an
  // un-cropped save this is the whole image; for a cropped save
  // it's the crop region.
  const sx = crop ? (crop.x / 100) * natW : 0;
  const sy = crop ? (crop.y / 100) * natH : 0;
  const sw = crop ? (crop.w / 100) * natW : natW;
  const sh = crop ? (crop.h / 100) * natH : natH;

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for highlight rendering');
  ctx.drawImage(previewImg, sx, sy, sw, sh, 0, 0, sw, sh);

  const displayW = previewImg.clientWidth || natW;
  const displayH = previewImg.clientHeight || natH;
  // The image always preserves its aspect ratio (max-width and the
  // JS-managed max-height both scale uniformly), so w/displayW and
  // h/displayH should be equal in theory. Averaging is just cheap
  // insurance against sub-pixel rounding drift between the two —
  // not handling for non-uniform scale.
  const scale = (natW / displayW + natH / displayH) / 2;
  const strokePx = 3 * scale;

  // Clip every highlight to the canvas bounds so edits that extend
  // past the crop don't paint onto the un-cropped neighbors (the
  // crop rectangle already imposes a coordinate system; without the
  // clip, a redaction that poked outside the crop would bleed into
  // the saved image's margin). Un-cropped save: clip is the whole
  // image, which is a no-op.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, sw, sh);
  ctx.clip();

  for (const e of edits) {
    if (e.kind === 'crop') continue; // the crop is realized by the canvas size itself
    if (e.kind === 'line') {
      ctx.strokeStyle = 'red';
      ctx.lineWidth = strokePx;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo((e.x1 / 100) * natW - sx, (e.y1 / 100) * natH - sy);
      ctx.lineTo((e.x2 / 100) * natW - sx, (e.y2 / 100) * natH - sy);
      ctx.stroke();
    } else if (e.kind === 'rect') {
      ctx.strokeStyle = 'red';
      ctx.lineWidth = strokePx;
      ctx.strokeRect(
        (e.x / 100) * natW - sx,
        (e.y / 100) * natH - sy,
        (e.w / 100) * natW,
        (e.h / 100) * natH,
      );
    } else if (e.kind === 'redact') {
      ctx.fillStyle = 'black';
      ctx.fillRect(
        (e.x / 100) * natW - sx,
        (e.y / 100) * natH - sy,
        (e.w / 100) * natW,
        (e.h / 100) * natH,
      );
    }
  }
  ctx.restore();

  return canvas.toDataURL('image/png');
}

// True iff there is at least one edit whose effect must be baked
// into the saved PNG: any red rect / line / redaction, or an
// active crop. Used to decide whether to send a `screenshotOverride`
// (and to flip the `highlights` flag on the saved record). A stack
// that contains only a 'crop' after undo-chains is still counted
// because the bake is what realizes the crop on disk.
function hasBakeableEdits(): boolean {
  return edits.length > 0;
}

captureBtn.addEventListener('click', () => {
  // Disable the button so double-clicks can't re-submit. The
  // background handler returns false from the onMessage listener
  // (no response expected), so `sendMessage` would resolve with
  // `undefined` as soon as the message is dispatched — *not* when
  // the save completes. We fire-and-forget instead of awaiting so
  // it's obvious that nothing here is waiting on the save; the
  // background closes this tab itself when `saveDetails` finishes
  // (its `recordDetailedCapture` call resolves, or fails and the
  // finally block fires).
  captureBtn.disabled = true;

  try {
    // Only bake edits into a fresh PNG when both apply: there's
    // something to bake, and the user is actually saving the image.
    // If the screenshot isn't being saved, the override would be
    // wasted bytes on the message channel. "Edits" here covers red
    // rects/lines, redactions, and the active crop — any of them
    // changes the pixels that end up on disk.
    const hasEdits = hasBakeableEdits();
    const bakeIn = hasEdits && screenshotBox.checked;
    const screenshotOverride = bakeIn ? renderHighlightedPng() : undefined;

    void chrome.runtime.sendMessage({
      action: 'saveDetails',
      screenshot: screenshotBox.checked,
      html: htmlBox.checked,
      selection: selectionBox.checked,
      prompt: promptInput.value.trim(),
      highlights: bakeIn,
      editVersion,
      screenshotOverride,
    });
  } catch (err) {
    // If renderHighlightedPng (canvas / toDataURL) or sendMessage
    // throws synchronously, we'd otherwise leave the button stuck
    // disabled with no way for the user to retry. Re-enable and
    // log the error so the user can try again.
    console.warn('[SeeWhatISee] capture submit failed:', err);
    captureBtn.disabled = false;
  }
});

// Let the background script trigger the Capture button remotely
// (e.g. when the user clicks the toolbar icon while this page is
// already open).
chrome.runtime.onMessage.addListener((msg: { action: string }) => {
  if (msg.action === 'triggerCapture' && !captureBtn.disabled) {
    captureBtn.click();
  }
});

// Initial sizing: autoGrowPrompt sizes the textarea and then
// internally calls fitImage. That first fitImage runs before the
// image has loaded (`naturalWidth`/`naturalHeight` are 0), which
// is harmless — `previewImg.addEventListener('load', fitImage)`
// re-runs once the screenshot data URL has been decoded. We do
// this initial pass anyway so the page isn't flashing an unsized
// preview between layout and image-load.
autoGrowPrompt();
void loadData();
