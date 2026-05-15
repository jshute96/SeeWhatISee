// Image / HTML / Selection size pills on the Capture page card.
//
// Each pill describes one of the artifacts available to save. Two
// pills (HTML, Selection) are byte counts only; the image pill also
// carries the bake-derived format label and the live cropped
// dimensions. `initPills(ctx)` is the only entry point; the
// per-pill refreshers (`updateSelectionSizeBadge`,
// `updateImageSizeBadge`, `composeImageBadgeText`) are exported for
// the main file to call from its load / edit / radio listeners and
// for the drawing module's `render()` context.
//
// `formatBytes` is also exported because the main file uses it for
// the HTML pill (whose text is updated directly in loadData /
// edit-dialog onSaved hooks rather than via a per-pill refresher).

// Inlined for the same reason as in the other capture-page
// submodules — keeps the page's wire contract independent of the
// SW module.
type SelectionFormat = 'html' | 'text' | 'markdown';
type EditableArtifactKind =
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

const SELECTION_FORMATS: readonly SelectionFormat[] = ['html', 'text', 'markdown'];

/** Loose structural shapes so this module doesn't pull in the full
 *  drawing types (which would tie pills to drawing's internals). */
interface BoxDragLike {
  kind: string;
  curX: number;
  curY: number;
  curW: number;
  curH: number;
}
interface PointLike { x: number; y: number }
interface RectPctLike { x: number; y: number; w: number; h: number }

export interface PillContext {
  // DOM refs (read every refresh).
  imageSizeBadge: HTMLSpanElement;
  htmlSizeBadge: HTMLSpanElement;
  selectionSizeBadge: HTMLSpanElement;
  capturedPills: HTMLDivElement;
  previewImg: HTMLImageElement;

  // Per-format selection-row radio reads — pills only needs the
  // checked flag, so loosen the type.
  selectionRows: Record<SelectionFormat, { radio: { checked: boolean } }>;
  /** Live mirror of the SW's captured bodies. Pills reads the
   *  selection body for the active format's pill text. */
  captured: Record<EditableArtifactKind, string>;
  /** Sticky selection format the master checkbox restores when no
   *  radio is checked. Read on every pill refresh; returns null
   *  before any format has been picked. */
  getDefaultSelectionFormat(): SelectionFormat | null;
  /** Map of `SelectionFormat → EditableArtifactKind` used to index
   *  `captured` from a selection-radio's format. */
  selectionWireKind: Record<SelectionFormat, EditableArtifactKind>;

  // Bake / edit-state readers — sourced from `drawing.ts`.
  getEditVersion(): number;
  renderHighlightedImage(forceMime?: 'image/png' | 'image/jpeg'): string;
  activeCrop(): RectPctLike | undefined;
  pctRectToPixels(
    r: RectPctLike,
    natW: number,
    natH: number,
  ): { x: number; y: number; w: number; h: number };
  getBoxDrag(): BoxDragLike | null;
  getDragStart(): PointLike | null;
  getDragCurrent(): PointLike | null;
  getSelectedTool(): string;
  imgRect(): DOMRect;
}

let ctx: PillContext;

// Internal pill state.
let lastImageBadgeKey = '';
let screenshotErrored = false;
let lastImageBadgeParts: { label: string; bytes: number } | null = null;

export function initPills(context: PillContext): void {
  ctx = context;
}

/**
 * Latch the "screenshot capture failed" flag. The main file calls
 * `setScreenshotErrored(true)` from `loadData` when the SW reports a
 * screenshot scrape failure. With the flag set, `updateImageSizeBadge`
 * hides the pill outright so resize-driven render() calls don't
 * briefly show an "PNG · 0 B" pill from a bogus empty data URL.
 */
export function setScreenshotErrored(v: boolean): void {
  screenshotErrored = v;
}

/**
 * Refresh the Selection size pill. The pill describes what was
 * captured and is available to save — mirroring the HTML pill — so
 * its visibility is gated on "did we capture any selection?", NOT
 * on whether the master "Save selection" checkbox is currently on.
 * Format-of-display: the radio that's checked when the master is
 * on, else the sticky last-picked format
 * (`getDefaultSelectionFormat()`), so unchecking the master leaves
 * the pill showing the same size it had a moment earlier. Hidden
 * only when no selection was captured at all (no format had
 * saveable content), in which case `getDefaultSelectionFormat()` is
 * still its initial null.
 *
 * Called on every selection-format change, master toggle, and
 * Edit-selection-* save — the body in `captured` is always the
 * live, post-edit value, so the byte count tracks user edits
 * without a separate cache.
 */
export function updateSelectionSizeBadge(): void {
  const radioFormat = SELECTION_FORMATS.find((f) => ctx.selectionRows[f].radio.checked);
  const format = radioFormat ?? ctx.getDefaultSelectionFormat();
  if (format === null) {
    ctx.selectionSizeBadge.hidden = true;
    refreshPillsCompactness();
    return;
  }
  const body = ctx.captured[ctx.selectionWireKind[format]];
  ctx.selectionSizeBadge.hidden = false;
  ctx.selectionSizeBadge.textContent =
    `Selection · ${formatBytes(new Blob([body]).size)}`;
  refreshPillsCompactness();
}

/**
 * Toggle `.compact` on the pill column when all three pills (Image
 * / HTML / Selection) end up visible at the same time. The CSS
 * rule pulls the column above and below the card's vertical
 * padding with negative margins, then uses `space-evenly` so the
 * three pills distribute as four equal gaps across the card height
 * (instead of stacking against the top edge). Called from every
 * site that flips a badge's `hidden` state.
 */
function refreshPillsCompactness(): void {
  const visible =
    (ctx.imageSizeBadge.hidden ? 0 : 1) +
    (ctx.htmlSizeBadge.hidden ? 0 : 1) +
    (ctx.selectionSizeBadge.hidden ? 0 : 1);
  ctx.capturedPills.classList.toggle('compact', visible >= 3);
}

/**
 * Refresh the Image size pill's bake-derived parts (format + bytes).
 * Hidden when no screenshot was captured (`screenshotErrored`),
 * otherwise reflects what *would* be saved right now: the
 * freshly-baked image when the user has any drawn / cropped /
 * redacted edits, else the original captureVisibleTab data URL
 * verbatim. Format label comes from the data URL's MIME prefix; on
 * a bake the label is "PNG" or "JPG" depending on the sticky output
 * format `renderHighlightedImage` picks (`bakeMime`).
 *
 * The pill's text isn't written here directly — it's composed
 * by `composeImageBadgeText`, which adds the live dimensions
 * portion. Splitting the two lets a crop-handle drag refresh just
 * the dimensions on every mousemove (cheap text formatting)
 * without paying for a re-bake (potentially multi-megabyte) on
 * every frame.
 *
 * Cached by `editVersion` + the previewImg's natural dimensions so
 * resize / zoom-driven `render()` calls don't trigger a re-bake.
 * The natural-dimension half of the key matters at startup: the
 * first call from `loadData` runs synchronously after
 * `previewImg.src = …`, before the image has decoded, so
 * `naturalWidth` is briefly 0; once the load event fires
 * `applyZoom → render → updateImageSizeBadge`, the key flips and
 * the pill refreshes with real dimensions. After that, only edit
 * commits / undos / clears / shrinks bump the key.
 */
export function updateImageSizeBadge(): void {
  if (screenshotErrored) {
    ctx.imageSizeBadge.hidden = true;
    lastImageBadgeParts = null;
    refreshPillsCompactness();
    return;
  }
  const key = `${ctx.getEditVersion()}|${ctx.previewImg.naturalWidth}|${ctx.previewImg.naturalHeight}`;
  if (lastImageBadgeKey === key && !ctx.imageSizeBadge.hidden) return;
  lastImageBadgeKey = key;
  // `renderHighlightedImage` short-circuits to `previewImg.src` when
  // no edits need baking and the source already matches `bakeMime`,
  // so the no-edits path is just the original capture data URL — no
  // canvas re-encode.
  const dataUrl = ctx.renderHighlightedImage();
  const formatted = formatImageDataUrl(dataUrl);
  if (!formatted) {
    ctx.imageSizeBadge.hidden = true;
    lastImageBadgeParts = null;
    refreshPillsCompactness();
    return;
  }
  lastImageBadgeParts = { label: formatted.label, bytes: formatted.bytes };
  ctx.imageSizeBadge.hidden = false;
  // Compose the text now too, not only via the `render()`-driven
  // path — `loadData` calls this synchronously *before* the
  // `await previewImg.load`, and we don't want to rely on the load
  // listener's render() to fill in the text (defensive against a
  // hypothetical sync-load edge case where the listener doesn't
  // fire before body visibility flips). The `render()` call is
  // still needed for the live-drag refresh; the cost of one
  // duplicate textContent write per edit commit is negligible.
  composeImageBadgeText();
  refreshPillsCompactness();
}

/**
 * Compose the Image pill's textContent from the cached bake-derived
 * parts (format + bytes) and the live dimensions
 * (`liveCropDimensions` while a crop drag is in flight, else
 * `savedImageDimensions`). Cheap — no allocations beyond the
 * template string and the DOM update — so calling this on every
 * mousemove during a crop drag is fine. Bails when the bake-derived
 * parts haven't been computed yet (e.g. a `screenshotErrored`
 * capture; pill is hidden in that branch anyway).
 */
export function composeImageBadgeText(): void {
  if (!lastImageBadgeParts) return;
  const dims = liveCropDimensions() ?? savedImageDimensions();
  const dimText = dims ? ` · ${dims.width}×${dims.height}` : '';
  ctx.imageSizeBadge.textContent =
    `${lastImageBadgeParts.label}${dimText} · ${formatBytes(lastImageBadgeParts.bytes)}`;
}

/**
 * Pixel dimensions of the image that `renderHighlightedImage` would
 * produce right now: the active crop's pixel size when one exists,
 * else `previewImg`'s natural size. Returns null while the
 * previewImg is still decoding (`naturalWidth === 0`) — callers
 * elide the dimension portion of the pill text in that window.
 *
 * Routed through `pctRectToPixels` so the integer derivation
 * matches the canvas the bake actually allocates (round-then-
 * subtract, vs. a `Math.round(w * factor)` that can land 1px
 * different from the floor that `canvas.width = float` would
 * apply). Otherwise the pill could disagree with `file <saved>.png`
 * by a pixel for some crop fractions.
 */
function savedImageDimensions(): { width: number; height: number } | null {
  const natW = ctx.previewImg.naturalWidth;
  const natH = ctx.previewImg.naturalHeight;
  if (!natW || !natH) return null;
  const crop = ctx.activeCrop();
  if (crop) {
    const px = ctx.pctRectToPixels(crop, natW, natH);
    return { width: px.w, height: px.h };
  }
  return { width: natW, height: natH };
}

/**
 * Pixel dimensions of the crop currently being dragged, if any —
 * the rectangle the user is interactively reshaping or drawing,
 * before they release the mouse and commit. Returns null when no
 * such drag is in flight; callers fall back to
 * `savedImageDimensions` so the pill shows the committed crop
 * (or full image) at rest.
 *
 * Two drag flavors:
 *   - `boxDrag` with `kind === 'crop'` — handle-resize on an
 *     existing crop, or the image-edge "create a new crop" gesture.
 *     Already in percent coordinates, mirrors the values painted by
 *     `render`. A rect/redact resize drag also lives in `boxDrag`
 *     but doesn't change the cropped dims, so we ignore it here.
 *   - Crop-tool create drag — `dragStart` + `dragCurrent` in
 *     display pixels, projected to percent against `imgRect`.
 */
function liveCropDimensions(): { width: number; height: number } | null {
  const natW = ctx.previewImg.naturalWidth;
  const natH = ctx.previewImg.naturalHeight;
  if (!natW || !natH) return null;
  // Both branches build a percent-space rect mirroring what would
  // commit on mouseup, then route through `pctRectToPixels` so the
  // live preview uses the same integer derivation as the eventual
  // bake (and hence `savedImageDimensions`).
  const bd = ctx.getBoxDrag();
  if (bd && bd.kind === 'crop') {
    const px = ctx.pctRectToPixels(
      { x: bd.curX, y: bd.curY, w: bd.curW, h: bd.curH },
      natW,
      natH,
    );
    return { width: px.w, height: px.h };
  }
  const ds = ctx.getDragStart();
  const dc = ctx.getDragCurrent();
  if (ctx.getSelectedTool() === 'crop' && ds && dc) {
    const r = ctx.imgRect();
    if (!r.width || !r.height) return null;
    // Zero-area "drag" — mousedown without movement. The mousedown
    // handler sets `dragCurrent = dragStart` before the first
    // mousemove arrives, so without this guard the pill would flash
    // "0×0" the moment the user pressed the mouse button.
    if (ds.x === dc.x && ds.y === dc.y) {
      return null;
    }
    const x = (Math.min(ds.x, dc.x) / r.width) * 100;
    const y = (Math.min(ds.y, dc.y) / r.height) * 100;
    const w = (Math.abs(dc.x - ds.x) / r.width) * 100;
    const h = (Math.abs(dc.y - ds.y) / r.height) * 100;
    const px = ctx.pctRectToPixels({ x, y, w, h }, natW, natH);
    return { width: px.w, height: px.h };
  }
  return null;
}

/**
 * Pull the format label and decoded byte count out of a
 * `data:image/...;base64,...` URL. The byte count is computed from
 * the base64 length (not from a Blob) so we avoid the allocation —
 * `dataUrl.length` is already in memory. Returns null for empty /
 * non-image / non-base64 URLs (e.g. the empty string Chrome
 * resolves to the document URL when previewImg.src is left blank).
 */
function formatImageDataUrl(
  dataUrl: string,
): { label: string; bytes: number } | null {
  const m = /^data:image\/([^;,]+);base64,/.exec(dataUrl);
  if (!m) return null;
  const subtype = m[1]!.toLowerCase();
  // "JPG" reads more naturally than "JPEG" in the pill; everything
  // else just uppercases the MIME subtype (PNG / WEBP / GIF / …).
  const label = subtype === 'jpeg' ? 'JPG' : subtype.toUpperCase();
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;
  return { label, bytes };
}

export function formatBytes(n: number): string {
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
