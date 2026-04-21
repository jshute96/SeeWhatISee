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

/**
 * Three-value `SelectionFormat` literal union, duplicated here
 * because the details page loads via a classic (non-module)
 * `<script>` tag and can't `import type` from capture.ts without
 * turning itself into a module. The SW ships this exact same union
 * on the wire; keep the three sites (`src/capture.ts`,
 * `src/background.ts`, here) in sync.
 */
type SelectionFormat = 'html' | 'text' | 'markdown';

/**
 * Wire kind used on `ensureDownloaded` / `updateArtifact` messages
 * for a given selection format. The SW holds the matching reverse
 * lookup (`WIRE_TO_SELECTION_FORMAT` in `background.ts`); keep both
 * sites in sync.
 */
const SELECTION_WIRE_KIND: Record<SelectionFormat, EditableArtifactKind> = {
  html: 'selectionHtml',
  text: 'selectionText',
  markdown: 'selectionMarkdown',
};

const SELECTION_FORMATS: SelectionFormat[] = ['html', 'text', 'markdown'];

interface DetailsData {
  screenshotDataUrl: string;
  html: string;
  url: string;
  /**
   * Captured selection bodies, one per storage format. Present iff
   * the SW saw a selection on the active tab at capture time; each
   * format's entry may be an empty string on its own (e.g. `text`
   * is empty when the user selected an image-only region). The
   * details page uses each format's emptiness to gate its Save
   * selection row independently.
   */
  selections?: { html: string; text: string; markdown: string };
  /**
   * Reason HTML couldn't be captured (e.g. restricted URL). When
   * set, we grey out the Save HTML row + disable its Copy and Edit
   * buttons and show a hoverable error icon explaining why. The
   * details flow still opens so the user can capture just a URL /
   * screenshot / prompt / highlights.
   */
  htmlError?: string;
  /**
   * Reason the page selection couldn't be captured. Same handling
   * as `htmlError` but applies uniformly to every Save-selection-as-…
   * row. Fires alongside `htmlError` when the whole `executeScript`
   * scrape failed.
   */
  selectionError?: string;
}

/**
 * Monotonic edit counter. Bumped every time the highlight stack
 * changes (drawn rect/line, undo, clear). Sent to the SW with
 * every Copy and Capture request so it can decide whether the
 * cached on-disk PNG still represents the user's current state or
 * needs to be re-downloaded with the new highlights baked in.
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

const screenshotBox = document.getElementById('cap-screenshot') as HTMLInputElement;
const htmlBox = document.getElementById('cap-html') as HTMLInputElement;
const captureBtn = document.getElementById('capture') as HTMLButtonElement;
const promptInput = document.getElementById('prompt-text') as HTMLTextAreaElement;
const previewImg = document.getElementById('preview') as HTMLImageElement;
const capturedUrlInput = document.getElementById('captured-url') as HTMLInputElement;
const htmlSizeEl = document.getElementById('html-size') as HTMLSpanElement;
const copyScreenshotBtn = document.getElementById('copy-screenshot-name') as HTMLButtonElement;
const copyHtmlBtn = document.getElementById('copy-html-name') as HTMLButtonElement;
const htmlRow = document.getElementById('row-html') as HTMLDivElement;
const htmlErrorIcon = document.getElementById('error-html') as HTMLSpanElement;
const editHtmlBtn = document.getElementById('edit-html') as HTMLButtonElement;

// Master "Save selection:" checkbox + its row and shared error
// icon. The checkbox drives the "save selection at all?" decision;
// the three per-format radios below pick which serialization gets
// written. See loadData() / wireSelectionControls() for the full
// master ↔ radio coupling.
const selectionBox = document.getElementById('cap-selection') as HTMLInputElement;
const selectionRow = document.getElementById('row-selection') as HTMLDivElement;
const selectionErrorIcon = document.getElementById('error-selection') as HTMLSpanElement;
// Wrapper around the three format radio rows. Hidden by default
// and only revealed when at least one format has content — see
// loadData(). The per-format rows + their error icons never show
// when this wrapper is hidden, so the master row alone carries
// any error state.
const selectionFormatsEl = document.querySelector('.selection-formats') as HTMLDivElement;

// Per-selection-format controls. Three parallel groups of radio
// + copy + edit + error-icon controls, one per format row in the
// details page. Gated independently by loadData() — enabled iff
// the SW scraped non-empty content for that format. Only one row's
// radio can be checked at a time (browser-enforced by the shared
// `name="cap-selection-format"`), and the Capture button's
// `selectionFormat` payload reads whichever is checked.
interface SelectionRow {
  format: SelectionFormat;
  row: HTMLDivElement;
  radio: HTMLInputElement;
  copyBtn: HTMLButtonElement;
  editBtn: HTMLButtonElement;
  errorIcon: HTMLSpanElement;
}
const selectionRows: Record<SelectionFormat, SelectionRow> = SELECTION_FORMATS.reduce(
  (acc, format) => {
    acc[format] = {
      format,
      row: document.getElementById(`row-selection-${format}`) as HTMLDivElement,
      radio: document.getElementById(`cap-selection-${format}`) as HTMLInputElement,
      copyBtn: document.getElementById(`copy-selection-${format}-name`) as HTMLButtonElement,
      editBtn: document.getElementById(`edit-selection-${format}-btn`) as HTMLButtonElement,
      errorIcon: document.getElementById(`error-selection-${format}`) as HTMLSpanElement,
    };
    return acc;
  },
  {} as Record<SelectionFormat, SelectionRow>,
);

// Local mirrors of the SW's captured bodies, keyed by artifact
// kind. Seeded by loadData() and updated whenever the user saves
// an edit. Kept on the page side so the dialogs can prefill their
// textareas without an extra round-trip and so any per-kind
// readouts (e.g. HTML-size) stay in sync with the SW's
// authoritative copy. New editable kinds append one entry here.
const captured: Record<EditableArtifactKind, string> = {
  html: '',
  selectionHtml: '',
  selectionText: '',
  selectionMarkdown: '',
};

/**
 * Format to restore when the user re-checks the master "Save
 * selection" checkbox after having unchecked it. Seeded by
 * loadData() with the first non-empty format (same rule as the
 * initial default-check) so the user's first click always lands
 * on a format with content. Updated whenever the user explicitly
 * picks a different radio so the restore feels sticky.
 */
let defaultSelectionFormat: SelectionFormat | null = null;

/**
 * Returns the selection format to save, or `null` when no
 * selection is being saved. The master checkbox gates the whole
 * group: if it's unchecked we never save, regardless of which
 * radio happens to still be checked. If it's checked but no radio
 * is (shouldn't happen once wireSelectionControls runs, but
 * defensive), we also return null. Written to
 * `SaveDetailsMessage.selectionFormat` at Capture time.
 */
function selectedSelectionFormat(): SelectionFormat | null {
  if (!selectionBox.checked) return null;
  for (const format of SELECTION_FORMATS) {
    if (selectionRows[format].radio.checked) return format;
  }
  return null;
}

/**
 * Couple the master "Save selection" checkbox to the three
 * per-format radios:
 *   - Clicking a radio implies "yes save the selection," so flip
 *     the master on.
 *   - Unchecking the master clears all three radios (per the
 *     design: "unclicking the checkbox unclicks all the radios").
 *   - Checking the master re-selects the remembered default
 *     format so the save payload is never master-checked-but-no-
 *     format-chosen.
 * Each row's disabled state is managed by loadData(); this
 * function only wires the persistent event listeners.
 */
function wireSelectionControls(): void {
  for (const format of SELECTION_FORMATS) {
    selectionRows[format].radio.addEventListener('change', () => {
      if (selectionRows[format].radio.checked) {
        selectionBox.checked = true;
        defaultSelectionFormat = format;
      }
    });
  }
  selectionBox.addEventListener('change', () => {
    if (selectionBox.checked) {
      // Pick the remembered default; fall back to the first
      // enabled format if the default is somehow unavailable
      // (e.g. its body was later edited to empty — not reachable
      // today but cheap to be defensive).
      const preferred = defaultSelectionFormat;
      const pickFrom: SelectionFormat[] = preferred
        ? [preferred, ...SELECTION_FORMATS.filter((f) => f !== preferred)]
        : [...SELECTION_FORMATS];
      for (const format of pickFrom) {
        if (!selectionRows[format].radio.disabled) {
          selectionRows[format].radio.checked = true;
          return;
        }
      }
      // No enabled formats — leave master checked but nothing
      // picked. The save payload's null-fallback covers this.
    } else {
      for (const format of SELECTION_FORMATS) {
        selectionRows[format].radio.checked = false;
      }
    }
  });
}
wireSelectionControls();
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
  // Suspend the page-wide hotkeys while any edit dialog is up —
  // e.g. Alt+H in the HTML dialog should type `h`, not silently
  // flip the Save HTML checkbox behind the modal.
  if (anyEditDialogOpen()) return;
  if (!e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  // Alt+S / Alt+H toggle the screenshot / HTML checkboxes. Alt+N
  // toggles the master "Save selection" checkbox. Alt+L / Alt+T /
  // Alt+M pick one of the three format radios (and auto-check the
  // master via the change listener wired in
  // wireSelectionControls). Each is a no-op when its control is
  // disabled so the hotkey matches what's on screen. The label
  // underlines in capture.html mirror these keys.
  const selectionFormat: Partial<Record<string, SelectionFormat>> = {
    l: 'html', t: 'text', m: 'markdown',
  };
  if (key === 's') {
    e.preventDefault();
    screenshotBox.checked = !screenshotBox.checked;
  } else if (key === 'h') {
    if (htmlBox.disabled) return;
    e.preventDefault();
    htmlBox.checked = !htmlBox.checked;
  } else if (key === 'n') {
    if (selectionBox.disabled) return;
    e.preventDefault();
    selectionBox.checked = !selectionBox.checked;
    // `.checked = …` doesn't fire `change`, but the coupling to
    // the radios lives there — dispatch manually.
    selectionBox.dispatchEvent(new Event('change'));
  } else {
    const format = selectionFormat[key];
    if (!format) return;
    const row = selectionRows[format];
    if (row.radio.disabled) return;
    e.preventDefault();
    row.radio.checked = true;
    // Radio changes via JS don't fire `change` either; dispatch
    // so the master checkbox auto-checks.
    row.radio.dispatchEvent(new Event('change'));
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
//
// A crop that covers the entire image (all four edges at the image
// boundary) is returned as `undefined` — it's functionally a no-op
// (the saved PNG matches the original) and visually has nothing to
// show (no dim outside, no meaningful edges), so we treat it as
// "no crop" everywhere: rendering, the `isCropped` flag on the
// saved record, and the bake-in transform. The edit itself stays
// in the stack so Undo can still walk back through it.
function activeCrop(): RectEdit | undefined {
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    if (e.kind === 'crop') {
      if (e.x === 0 && e.y === 0 && e.w === 100 && e.h === 100) return undefined;
      return e;
    }
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
//   - Dragged edges clamp at `MIN_CROP_PCT` away from the opposite
//     (undragged) edge. The opposite edge never moves — a shrink
//     drag just stops once it bottoms out at the minimum. This
//     keeps the behavior symmetric across all four sides; an
//     earlier version allowed the west/north clamps to push the
//     opposite edge outward, which made N/W drags feel different
//     from S/E drags.
function applyCropDrag(
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
  // `MIN_CROP_PCT` away from the opposite edge. The opposite edge
  // stays at its starting position because we only read its value
  // (never assign to it) inside each branch.
  if (draggingTop) {
    top = Math.max(0, Math.min(bottom - MIN_CROP_PCT, top + dyPct));
  }
  if (draggingBottom) {
    bottom = Math.min(100, Math.max(top + MIN_CROP_PCT, bottom + dyPct));
  }
  if (draggingLeft) {
    left = Math.max(0, Math.min(right - MIN_CROP_PCT, left + dxPct));
  }
  if (draggingRight) {
    right = Math.min(100, Math.max(left + MIN_CROP_PCT, right + dxPct));
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
    overlay.appendChild(frame);
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
      overlay.appendChild(line);
    };
    if (cy > 0) dashed(cx, cy, cx + cw, cy);
    if (cy + ch < h) dashed(cx, cy + ch, cx + cw, cy + ch);
    if (cx > 0) dashed(cx, cy, cx, cy + ch);
    if (cx + cw < w) dashed(cx + cw, cy, cx + cw, cy + ch);
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
  // A drag is already in flight (left-button crop or rect/line).
  // Ignore the second button press so the state machine can't end
  // up with both `cropDrag` and `dragStart` non-null at the same
  // time. The mousemove branches below bail on the "wrong" state,
  // and the mouseup handler only clears one drag per up event —
  // so a chorded press would otherwise strand the first drag when
  // the second button releases first.
  if (cropDrag !== null || dragStart !== null) return;
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
  // Reset any idle-hover resize cursor — we're committing to a
  // rect/line draw from this spot, and the resize cursor would
  // mislead the user if they started right on a handle. The
  // window.mousemove handler for the normal drag path doesn't
  // touch cursor, so without this the resize cursor would stick
  // for the duration of the draw.
  overlay.style.cursor = 'crosshair';
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
    // Apply per-artifact error states first so the HTML size readout
    // below reflects the right value (a dash placeholder rather than
    // the empty-string byte count of a failed scrape).
    if (response.htmlError) {
      // HTML couldn't be scraped (restricted URL, blocked injection,
      // etc.). Disable + uncheck Save HTML, hide its Copy / Edit
      // buttons, and flag the row with a hoverable error icon so the
      // user understands why it's greyed out — while still letting
      // them use the rest of the capture flow. The reason itself
      // lives on the row's error-icon tooltip; the size field just
      // gets a dash so the layout stays stable without restating the
      // same message twice.
      htmlBox.checked = false;
      htmlBox.disabled = true;
      copyHtmlBtn.disabled = true;
      editHtmlBtn.disabled = true;
      htmlRow.classList.add('has-error');
      htmlErrorIcon.title = `Unable to capture HTML contents: ${response.htmlError}`;
      htmlSizeEl.textContent = '—';
    } else {
      captured.html = response.html;
      // True UTF-8 byte count of the captured HTML, not the JS string
      // length (which counts UTF-16 code units).
      htmlSizeEl.textContent = formatBytes(new Blob([captured.html]).size);
    }
    if (response.selectionError && !response.htmlError) {
      // Selection couldn't be scraped *independently* of HTML. In
      // practice this never fires today — `executeScript` reads both
      // in one call so the two errors are always twins — but the UI
      // is ready for a future SW that reports them separately. When
      // the two fire together, we suppress the icon here: the HTML
      // row's icon already explains the situation and a duplicate
      // would just be visual noise. The master + all three format
      // rows stay in their default disabled state regardless.
      selectionRow.classList.add('has-error');
      selectionErrorIcon.title = `Unable to capture selection: ${response.selectionError}`;
    } else if (response.selections) {
      // Selection was scraped. Seed each format row's body and
      // mark per-format emptiness before deciding the master
      // state — the master is only enabled if at least one
      // format has non-empty content. A whitespace-only selection
      // produces non-null `selections` (the raw `innerHTML` is
      // non-empty) but every format trims to empty, so the group
      // collapses to the "no usable selection" case.
      let anyFormatHasContent = false;
      for (const format of SELECTION_FORMATS) {
        const body = response.selections[format];
        const r = selectionRows[format];
        captured[SELECTION_WIRE_KIND[format]] = body;
        if (body && body.trim().length > 0) {
          r.radio.disabled = false;
          r.copyBtn.disabled = false;
          r.editBtn.disabled = false;
          if (defaultSelectionFormat === null) {
            r.radio.checked = true;
            defaultSelectionFormat = format;
          }
          anyFormatHasContent = true;
        } else {
          // Selection *was* captured, but this specific format came
          // out empty (e.g. image-only selection → empty text, or
          // a whitespace-only selection across all three). Show the
          // per-format error icon so the user understands the row
          // isn't disabled for mysterious reasons.
          r.row.classList.add('has-error');
          r.errorIcon.title = `Selection has no ${format} content`;
        }
      }
      if (anyFormatHasContent) {
        // At least one format is saveable — enable the master,
        // default-check it, and reveal the format rows. A user
        // who bothered to select text almost certainly wants it
        // in the record.
        selectionBox.disabled = false;
        selectionBox.checked = true;
        selectionFormatsEl.hidden = false;
      } else {
        // Every format is empty (typically a whitespace-only
        // selection). Leave the format rows hidden and surface a
        // single error on the master row — the per-format icons
        // are inside the hidden block so the master's reason is
        // the only thing the user sees.
        selectionRow.classList.add('has-error');
        selectionErrorIcon.title = 'Selection has no saveable content';
      }
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
// re-download with the new baked-in PNG; for HTML / selection, the
// cache is unconditional until the user saves an edit in the
// corresponding Edit dialog, which sends `updateArtifact` and
// drops the cache entry.
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
for (const format of SELECTION_FORMATS) {
  selectionRows[format].copyBtn.addEventListener('click', () => {
    void copyArtifactPath(SELECTION_WIRE_KIND[format]);
  });
}

// ─── Edit dialogs (catalog-driven) ────────────────────────────────
//
// Each editable artifact kind gets one dialog cloned from
// `#edit-dialog-template` in capture.html. A Save pushes the new
// body to the SW via `updateArtifact`, which invalidates the
// corresponding download cache so the next Copy / Capture writes
// the edited content. Adding a future kind is one entry in
// `EDIT_KINDS` below plus a pencil button in the markup.

// Kept in sync with the canonical declaration in `src/capture.ts`
// and the `EDITABLE_ARTIFACTS` dispatch table in `src/background.ts`.
// Can't `import type` the shared union because the extension page
// loads `capture-page.js` via a non-module `<script>` tag; any
// import turns the file into a module and tsc emits `export {}`,
// which is a parse error under script semantics. New editable
// kinds must be added to all three sites.
type EditableArtifactKind =
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

interface EditKindSpec {
  kind: EditableArtifactKind;
  /** Hyphenated DOM-id slug used by `createEditDialog` to stamp the
   * cloned template's ids (e.g. `edit-<slug>-dialog`). Separate from
   * `kind` so camelCase editable kinds (`selectionMarkdown`) map to
   * readable DOM ids (`edit-selection-markdown-dialog`) without
   * forcing the TypeScript union into hyphens. Keep in sync with
   * the matching button ids in `capture.html`. */
  domSlug: string;
  /** Modal heading + textarea aria-label. Short, user-visible. */
  title: string;
  /** The pencil button inside the details-page row for this kind. */
  openBtn: HTMLButtonElement;
  /** Optional post-save hook — e.g. refresh the HTML-size readout. */
  onSaved?: (value: string) => void;
}

const EDIT_KINDS: EditKindSpec[] = [
  {
    kind: 'html',
    domSlug: 'html',
    title: 'Edit page contents HTML',
    openBtn: editHtmlBtn,
    onSaved: (v) => {
      htmlSizeEl.textContent = formatBytes(new Blob([v]).size);
    },
  },
  {
    kind: 'selectionHtml',
    domSlug: 'selection-html',
    title: 'Edit selection HTML',
    openBtn: selectionRows.html.editBtn,
  },
  {
    kind: 'selectionText',
    domSlug: 'selection-text',
    title: 'Edit selection text',
    openBtn: selectionRows.text.editBtn,
  },
  {
    kind: 'selectionMarkdown',
    domSlug: 'selection-markdown',
    title: 'Edit selection markdown',
    openBtn: selectionRows.markdown.editBtn,
  },
];

// Populated by `bindEditDialog` once the DOM is cloned from the
// template; insertion order matches `EDIT_KINDS` so
// `anyEditDialogOpen()` and future iteration see the same order.
const editDialogs: HTMLDialogElement[] = [];

interface EditDialogParts {
  dialog: HTMLDialogElement;
  textarea: HTMLTextAreaElement;
  saveBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  errorEl: HTMLParagraphElement;
}

/**
 * Clone the edit-dialog template, fill in per-kind ids / text /
 * aria wiring, and append the new <dialog> to document.body.
 * Returns refs to the interactive parts so the caller can wire
 * them up.
 *
 * Per-instance ids follow the `edit-${kind}-${role}` convention
 * (e.g. `edit-html-dialog`, `edit-selection-textarea`) so e2e
 * tests can target a specific kind without knowing the full
 * catalog.
 */
function createEditDialog(domSlug: string, title: string): EditDialogParts {
  const tpl = document.getElementById('edit-dialog-template') as HTMLTemplateElement;
  const frag = tpl.content.cloneNode(true) as DocumentFragment;
  const dialog = frag.querySelector('.edit-dialog') as HTMLDialogElement;
  const titleEl = dialog.querySelector('.edit-dialog-title') as HTMLHeadingElement;
  const textarea = dialog.querySelector('.edit-dialog-textarea') as HTMLTextAreaElement;
  const errorEl = dialog.querySelector('.edit-dialog-error') as HTMLParagraphElement;
  const saveBtn = dialog.querySelector('.edit-dialog-save') as HTMLButtonElement;
  const cancelBtn = dialog.querySelector('.edit-dialog-cancel') as HTMLButtonElement;

  dialog.id = `edit-${domSlug}-dialog`;
  titleEl.id = `edit-${domSlug}-title`;
  titleEl.textContent = title;
  dialog.setAttribute('aria-labelledby', titleEl.id);
  textarea.id = `edit-${domSlug}-textarea`;
  textarea.setAttribute('aria-label', title);
  errorEl.id = `edit-${domSlug}-error`;
  saveBtn.id = `edit-${domSlug}-save`;
  cancelBtn.id = `edit-${domSlug}-cancel`;

  document.body.appendChild(dialog);
  return { dialog, textarea, saveBtn, cancelBtn, errorEl };
}

function bindEditDialog(spec: EditKindSpec): void {
  const parts = createEditDialog(spec.domSlug, spec.title);
  editDialogs.push(parts.dialog);

  spec.openBtn.addEventListener('click', () => {
    parts.textarea.value = captured[spec.kind];
    clearError();
    parts.dialog.showModal();
    // Defer focus so showModal's own autofocus doesn't overwrite us.
    requestAnimationFrame(() => {
      parts.textarea.focus();
      // Place the caret at the start — bodies are often long and
      // the user is most likely to want to search / scroll from the
      // top rather than land at the end.
      parts.textarea.setSelectionRange(0, 0);
      parts.textarea.scrollTop = 0;
    });
  });

  parts.cancelBtn.addEventListener('click', () => {
    parts.dialog.close();
  });

  parts.saveBtn.addEventListener('click', () => {
    void save();
  });

  async function save(): Promise<void> {
    const newValue = parts.textarea.value;
    // No-op when unchanged: avoid an SW round-trip (and the cache
    // invalidation side-effect that would re-download on next Copy).
    if (newValue === captured[spec.kind]) {
      parts.dialog.close();
      return;
    }
    clearError();
    // Disable both Save and Cancel while the SW round-trip is in
    // flight. The SW has no abort path — if Cancel closed the
    // dialog mid-await, the edit would still commit server-side and
    // the "Cancel didn't cancel" drift would show up on the next
    // dialog open (local mirror stale vs. SW state). Also suppress
    // Escape via a transient `cancel` listener so the native
    // dialog-close path can't backdoor around the disabled buttons.
    parts.saveBtn.disabled = true;
    parts.cancelBtn.disabled = true;
    const suppressEscape = (e: Event): void => e.preventDefault();
    parts.dialog.addEventListener('cancel', suppressEscape);
    try {
      const response = (await chrome.runtime.sendMessage({
        action: 'updateArtifact',
        kind: spec.kind,
        value: newValue,
      })) as { ok?: boolean; error?: string } | undefined;
      if (!response?.ok) {
        const detail = response?.error ?? 'no response from background';
        console.warn(`[SeeWhatISee] updateArtifact(${spec.kind}) failed:`, detail);
        showError(`Couldn't save edit: ${detail}`);
        return;
      }
      captured[spec.kind] = newValue;
      spec.onSaved?.(newValue);
      parts.dialog.close();
    } finally {
      parts.dialog.removeEventListener('cancel', suppressEscape);
      parts.saveBtn.disabled = false;
      parts.cancelBtn.disabled = false;
    }
  }

  function showError(message: string): void {
    parts.errorEl.textContent = message;
    parts.errorEl.hidden = false;
  }

  function clearError(): void {
    parts.errorEl.textContent = '';
    parts.errorEl.hidden = true;
  }
}

for (const spec of EDIT_KINDS) bindEditDialog(spec);

function anyEditDialogOpen(): boolean {
  return editDialogs.some((d) => d.open);
}

// Last `editVersion` we sent the SW with a screenshot override. If
// the user hasn't drawn / undone since, we skip the (potentially
// multi-MB) PNG bake + message-channel copy on the next click — the
// SW will hit its cache anyway and ignore any override we'd send.
// Reset to -1 so the very first Copy with edits forces a bake.
let lastSentScreenshotEditVersion = -1;

async function copyArtifactPath(
  kind: 'screenshot' | 'html' | 'selectionHtml' | 'selectionText' | 'selectionMarkdown',
): Promise<void> {
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
// effective crop. A crop that covers the whole image contributes
// nothing to the bake (`activeCrop()` returns undefined for it),
// so a stack whose only edits are full-image crops skips the bake
// and the saved PNG stays identical to the untouched capture.
function hasBakeableEdits(): boolean {
  if (edits.some((e) => e.kind !== 'crop')) return true;
  return activeCrop() !== undefined;
}

// Per-kind flags reported to the SW so the saved record's screenshot
// artifact can carry `hasHighlights` / `hasRedactions` / `isCropped`
// independently. A single red rectangle that the user converts to a
// redaction flips only `hasRedactions` — not `hasHighlights` —
// because after conversion the rectangle is no longer a red
// highlight in the saved PNG.
//
// `isCropped` uses `activeCrop()` (not "any crop edit in the stack")
// so a crop that's been dragged back out to the full image reports
// as *not cropped* — the saved PNG matches the original, so the
// flag would mislead downstream consumers.
function editFlags(): { hasHighlights: boolean; hasRedactions: boolean; isCropped: boolean } {
  let hasHighlights = false;
  let hasRedactions = false;
  for (const e of edits) {
    if (e.kind === 'rect' || e.kind === 'line') hasHighlights = true;
    else if (e.kind === 'redact') hasRedactions = true;
  }
  return { hasHighlights, hasRedactions, isCropped: activeCrop() !== undefined };
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
    // Per-kind flags only matter when we're actually saving the
    // screenshot — they describe what's baked into the PNG, so
    // there's nothing for the SW to flag on a record that doesn't
    // include the image. `bakeIn` already folds both conditions in.
    const flags = bakeIn
      ? editFlags()
      : { hasHighlights: false, hasRedactions: false, isCropped: false };

    void chrome.runtime.sendMessage({
      action: 'saveDetails',
      screenshot: screenshotBox.checked,
      html: htmlBox.checked,
      selectionFormat: selectedSelectionFormat(),
      prompt: promptInput.value.trim(),
      highlights: flags.hasHighlights,
      hasRedactions: flags.hasRedactions,
      isCropped: flags.isCropped,
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

// Test hook: lets the drawing e2e spec inspect the edit stack and
// the effective crop without resorting to pixel-sampling tricks or
// fixture-content probes. Harmless in production: nothing reads
// `window.__seeState` at runtime, and it only surfaces values that
// we already ship back to the SW via `saveDetails` / the bake.
(window as unknown as { __seeState?: unknown }).__seeState = {
  effectiveCrop: () => {
    const c = activeCrop();
    return c ? { x: c.x, y: c.y, w: c.w, h: c.h } : null;
  },
  flags: () => editFlags(),
  editKinds: () => edits.map((e) => e.kind),
};
