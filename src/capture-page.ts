// Controller script for the capture.html extension page.
//
// Flow:
//   1. background.ts captures a screenshot + page HTML into
//      chrome.storage.session (keyed by the new tab id), then opens
//      capture.html in that tab.
//   2. On load we ask background for our pre-captured data via a
//      runtime message. background reads it from session storage and
//      sends it back; we render the page-card (title, URL,
//      HTML-size badge), the screenshot preview, and the Save state.
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

import { attachHtmlAwarePaste } from './capture-page/paste.js';
import { initAsk } from './capture-page/ask.js';
import {
  initZoom,
  applyZoom,
  setZoom,
  fitImage,
  currentDisplayScale,
  targetCssSize,
  wasMiddleDownRecently,
  type ZoomMode,
} from './capture-page/zoom.js';
import {
  initDrawing,
  imgRect,
  visibleImageRect,
  activeCrop,
  pctRectToPixels,
  hasBakeableEdits,
  editFlags,
  renderHighlightedImage,
  bakeMime,
  bakeExt,
  getEditVersion,
  getBoxDrag,
  getDragStart,
  getDragCurrent,
  getSelectedTool,
  getTestHooks,
  render,
  drawViewportEdges,
  endPolylineChain,
  isPolylineActive,
} from './capture-page/drawing.js';

/**
 * Three-value `SelectionFormat` literal union, duplicated here for
 * sync between the wire sites (`src/capture.ts`, `src/background.ts`,
 * here). Kept literal rather than imported from capture.ts because
 * the SW ships this exact union on the wire and inlining it here
 * keeps the page's payload contract independent of the SW module.
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
   * Captured tab title, pinned at capture time. Rendered as the
   * primary line in the page-card (clickable link), with the URL on
   * a secondary monospace line underneath. Falls back to the URL
   * when empty.
   */
  title: string;
  /**
   * Captured selection bodies, one per storage format. Present iff
   * the SW saw a selection on the active tab at capture time; each
   * format's entry may be an empty string on its own (e.g. `text`
   * is empty when the user selected an image-only region). The
   * Capture page uses each format's emptiness to gate its Save
   * selection row independently.
   */
  selections?: { html: string; text: string; markdown: string };
  /**
   * Reason HTML couldn't be captured (e.g. restricted URL). When
   * set, we grey out the Save HTML row + disable its Copy and Edit
   * buttons and show a hoverable error icon explaining why. The
   * Capture page flow still opens so the user can capture just a URL /
   * screenshot / prompt / highlights.
   */
  htmlError?: string;
  /**
   * Image-context flow flag: HTML was deliberately not captured,
   * not failed. Disables the Save HTML row + Copy / Edit buttons
   * the same way `htmlError` does, but without the red error icon
   * — there's no failure to explain.
   */
  htmlUnavailable?: boolean;
  /**
   * URL of the right-clicked source image when the Capture page
   * was opened from the image right-click flow. Forwarded to the
   * SW on save and recorded under `imageUrl` on the log entry.
   */
  imageUrl?: string;
  /**
   * Reason the page selection couldn't be captured. Same handling
   * as `htmlError` but applies uniformly to every Save-selection-as-…
   * row. Fires alongside `htmlError` when the whole `executeScript`
   * scrape failed.
   */
  selectionError?: string;
  /**
   * Reason screenshot could not be captured. Set only when
   * captureVisibleTab failed — the Capture page reads this to flag
   * the screenshot row/preview with an error icon.
   */
  screenshotError?: string;
  /**
   * Stored "Default items to save" preferences from the Options
   * page, split by selection-presence. `loadData()` applies the
   * matching branch on first paint — the format radio comes from
   * `withSelection.format` (subject to that format having content;
   * falls back to the first non-empty format otherwise).
   */
  capturePageDefaults: {
    withoutSelection: { screenshot: boolean; html: boolean };
    withSelection: {
      screenshot: boolean;
      html: boolean;
      selection: boolean;
      format: SelectionFormat;
    };
    /** Which of the two main page buttons is the "default" — drives
     *  the highlight ring and routes Enter on the prompt + the
     *  background's `triggerCapture` toolbar-icon hand-off. */
    defaultButton: 'capture' | 'ask';
    /** Plain-Enter behaviour in the Prompt textarea: 'send' fires the
     *  default button, 'newline' inserts a newline. Shift+Enter is
     *  always newline; Ctrl+Enter is always send. */
    promptEnter: 'send' | 'newline';
  };
}

/**
 * Set true by `loadData` when the SW returns no session for this
 * tab (direct load of `capture.html`, e.g. an old bookmark, or an
 * SW-opened error tab). When set, the page is showing only the
 * header + one of the early-state panes (`#missing-session-error`,
 * `#capture-failed-error`, or `#upload-landing`) — every
 * `[data-capture-main]` block is `display:none`. Page-wide
 * Alt-shortcuts gate on this so they don't mutate hidden
 * checkboxes / "click" hidden buttons.
 */
let staleMode = false;

const optionsBtn = document.getElementById('options-btn') as HTMLButtonElement;
optionsBtn.addEventListener('click', () => {
  // `openOptionsPage` honours the manifest's `open_in_tab: true`, so
  // it lands in a new tab (or focuses an existing Options tab).
  chrome.runtime.openOptionsPage();
});

const screenshotBox = document.getElementById('cap-screenshot') as HTMLInputElement;
const htmlBox = document.getElementById('cap-html') as HTMLInputElement;
const captureBtn = document.getElementById('capture') as HTMLButtonElement;
const promptInput = document.getElementById('prompt-text') as HTMLTextAreaElement;
// `#ask-status` started life as the Ask flow's status line and now
// also surfaces Capture-flow errors. Reused rather than duplicated
// because both buttons live in the same control stack and the user
// has one place to look for "what just happened" feedback.
const pageStatus = document.getElementById('ask-status') as HTMLDivElement;
function setStatusMessage(text: string, kind: 'ok' | 'error' | 'info'): void {
  pageStatus.textContent = text;
  pageStatus.classList.remove('ask-status-ok', 'ask-status-error');
  if (kind === 'ok') pageStatus.classList.add('ask-status-ok');
  else if (kind === 'error') pageStatus.classList.add('ask-status-error');
}
const previewImg = document.getElementById('preview') as HTMLImageElement;
const capturedTitleLink = document.getElementById('captured-title') as HTMLAnchorElement;
const capturedUrlLink = document.getElementById('captured-url') as HTMLAnchorElement;
const capturedUrlText = document.getElementById('captured-url-text') as HTMLSpanElement;
const imageSizeBadge = document.getElementById('image-size-badge') as HTMLSpanElement;
const htmlSizeBadge = document.getElementById('html-size-badge') as HTMLSpanElement;
const selectionSizeBadge = document.getElementById('selection-size-badge') as HTMLSpanElement;
const capturedPills = imageSizeBadge.parentElement as HTMLDivElement;
const copyUrlBtn = document.getElementById('copy-url-btn') as HTMLButtonElement;
/**
 * Captured page URL, kept in module scope so `buildPreviewHtml`'s
 * `<base href>` can resolve relative resources against the source
 * page's origin without re-reading the anchor's `href` (which
 * normalises and would echo `chrome-extension://…` when we're in the
 * inert / no-URL state).
 */
let capturedUrl = '';
const copyScreenshotBtn = document.getElementById('copy-screenshot-name') as HTMLButtonElement;
const copyHtmlBtn = document.getElementById('copy-html-name') as HTMLButtonElement;
const screenshotRow = document.getElementById('row-screenshot') as HTMLDivElement;
const screenshotErrorIcon = document.getElementById('error-screenshot') as HTMLSpanElement;
const htmlRow = document.getElementById('row-html') as HTMLDivElement;
const htmlErrorIcon = document.getElementById('error-html') as HTMLSpanElement;
const editHtmlBtn = document.getElementById('edit-html') as HTMLButtonElement;
const downloadScreenshotBtn = document.getElementById('download-screenshot-btn') as HTMLButtonElement;
const downloadHtmlBtn = document.getElementById('download-html-btn') as HTMLButtonElement;

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
// Capture page. Gated independently by loadData() — enabled iff
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
  downloadBtn: HTMLButtonElement;
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
      downloadBtn: document.getElementById(`download-selection-${format}-btn`) as HTMLButtonElement,
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
      updateSelectionSizeBadge();
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
          break;
        }
      }
      // No enabled formats — leave master checked but nothing
      // picked. The save payload's null-fallback covers this.
    } else {
      for (const format of SELECTION_FORMATS) {
        selectionRows[format].radio.checked = false;
      }
    }
    // Single tail call: the badge's format-of-display falls back to
    // `defaultSelectionFormat` when no radio is checked, so the
    // displayed size is the same before and after the radio toggles
    // above — only a from-empty initial paint or a body edit
    // changes it. Easier to read than scattering the call across
    // each branch.
    updateSelectionSizeBadge();
  });
}
wireSelectionControls();

/**
 * Refresh the Selection size badge. The pill describes what was
 * captured and is available to save — mirroring the HTML pill — so
 * its visibility is gated on "did we capture any selection?", NOT
 * on whether the master "Save selection" checkbox is currently on.
 * Format-of-display: the radio that's checked when the master is
 * on, else the sticky last-picked format (`defaultSelectionFormat`),
 * so unchecking the master leaves the pill showing the same size it
 * had a moment earlier. Hidden only when no selection was captured
 * at all (no format had saveable content), in which case
 * `defaultSelectionFormat` is still its initial `null`.
 *
 * Called on every selection-format change, master toggle, and
 * Edit-selection-* save — the body in `captured` is always the
 * live, post-edit value, so the byte count tracks user edits
 * without a separate cache.
 */
function updateSelectionSizeBadge(): void {
  const radioFormat = SELECTION_FORMATS.find((f) => selectionRows[f].radio.checked);
  const format = radioFormat ?? defaultSelectionFormat;
  if (format === null) {
    selectionSizeBadge.hidden = true;
    refreshPillsCompactness();
    return;
  }
  const body = captured[SELECTION_WIRE_KIND[format]];
  selectionSizeBadge.hidden = false;
  selectionSizeBadge.textContent = `Selection · ${formatBytes(new Blob([body]).size)}`;
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
    (imageSizeBadge.hidden ? 0 : 1) +
    (htmlSizeBadge.hidden ? 0 : 1) +
    (selectionSizeBadge.hidden ? 0 : 1);
  capturedPills.classList.toggle('compact', visible >= 3);
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
let lastImageBadgeKey = '';
let screenshotErrored = false;
let lastImageBadgeParts: { label: string; bytes: number } | null = null;
function updateImageSizeBadge(): void {
  if (screenshotErrored) {
    imageSizeBadge.hidden = true;
    lastImageBadgeParts = null;
    refreshPillsCompactness();
    return;
  }
  const key = `${getEditVersion()}|${previewImg.naturalWidth}|${previewImg.naturalHeight}`;
  if (lastImageBadgeKey === key && !imageSizeBadge.hidden) return;
  lastImageBadgeKey = key;
  // `renderHighlightedImage` short-circuits to `previewImg.src` when
  // no edits need baking and the source already matches `bakeMime`,
  // so the no-edits path is just the original capture data URL — no
  // canvas re-encode.
  const dataUrl = renderHighlightedImage();
  const formatted = formatImageDataUrl(dataUrl);
  if (!formatted) {
    imageSizeBadge.hidden = true;
    lastImageBadgeParts = null;
    refreshPillsCompactness();
    return;
  }
  lastImageBadgeParts = { label: formatted.label, bytes: formatted.bytes };
  imageSizeBadge.hidden = false;
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
function composeImageBadgeText(): void {
  if (!lastImageBadgeParts) return;
  const dims = liveCropDimensions() ?? savedImageDimensions();
  const dimText = dims ? ` · ${dims.width}×${dims.height}` : '';
  imageSizeBadge.textContent =
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
  const natW = previewImg.naturalWidth;
  const natH = previewImg.naturalHeight;
  if (!natW || !natH) return null;
  const crop = activeCrop();
  if (crop) {
    const px = pctRectToPixels(crop, natW, natH);
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
  const natW = previewImg.naturalWidth;
  const natH = previewImg.naturalHeight;
  if (!natW || !natH) return null;
  // Both branches build a percent-space rect mirroring what would
  // commit on mouseup, then route through `pctRectToPixels` so the
  // live preview uses the same integer derivation as the eventual
  // bake (and hence `savedImageDimensions`).
  const bd = getBoxDrag();
  if (bd && bd.kind === 'crop') {
    const px = pctRectToPixels(
      { x: bd.curX, y: bd.curY, w: bd.curW, h: bd.curH },
      natW,
      natH,
    );
    return { width: px.w, height: px.h };
  }
  const ds = getDragStart();
  const dc = getDragCurrent();
  if (getSelectedTool() === 'crop' && ds && dc) {
    const r = imgRect();
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
    const px = pctRectToPixels({ x, y, w, h }, natW, natH);
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
// `getElementById` returns `HTMLElement | null`. SVG elements are
// `SVGElement`, which sits on a sibling branch of the DOM type
// hierarchy — TypeScript won't let us cast directly across the
// branches without a `unknown` bridge.
const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;
const edgesSvg = document.getElementById('viewport-edges') as unknown as SVGSVGElement;
const imageBox = document.querySelector('.image-box') as HTMLDivElement;
const highlightControls = document.querySelector(
  '.highlight-controls',
) as HTMLDivElement;
const shrinkBtn = document.getElementById('shrink') as HTMLButtonElement;
const zoomBtn = document.getElementById('zoom') as HTMLButtonElement;
const undoBtn = document.getElementById('undo') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const copyImageBtn = document.getElementById('copy-image-btn') as HTMLButtonElement;
const downloadImageBtn = document.getElementById('download-image-btn') as HTMLButtonElement;
const toolButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.tool-btn'),
);

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


// Refuse pastes that the X11 middle-click primary-selection
// machinery dispatched on the prompt while the user was middle-
// clicking on the image (panning the zoomed view). The paste fires
// on the focused editable regardless of click target on Linux
// Chromium, and not every build cancels it via mousedown /
// mouseup / auxclick preventDefault. Catch it here using a short
// timestamp window — a real Ctrl-V or right-click → Paste won't
// be preceded by a middle-click on the image-box, so they pass
// through. Capture-phase listener so we run before the html-aware
// paste handler attached just below.
const PASTE_AFTER_MIDDLE_DOWN_MS = 200;
promptInput.addEventListener(
  'paste',
  (e) => {
    if (wasMiddleDownRecently(e.timeStamp, PASTE_AFTER_MIDDLE_DOWN_MS)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);

attachHtmlAwarePaste(promptInput, 'asMarkdown');

// Which page button (Capture or Ask) is currently the user's "default"
// for the Capture page — drives the highlight ring and routes
// Enter-on-prompt + the SW's `triggerCapture` hand-off. Seeded from
// `capturePageDefaults.defaultButton` in `loadData()`; falls back to
// 'capture' for first paint before the round-trip resolves.
let currentDefaultButton: 'capture' | 'ask' = 'capture';

// Plain-Enter behaviour in the Prompt textarea — 'send' fires the
// default button, 'newline' lets the textarea insert the newline
// natively. Shift+Enter and Ctrl+Enter ignore this and always do
// newline / send respectively.
let currentPromptEnter: 'send' | 'newline' = 'send';

/**
 * Resolve a "close the Capture page after the action?" decision
 * from a click event's modifier keys. Shared by the Capture and
 * Ask buttons so both surfaces get the same modifier semantics:
 *
 *   - shift-click → keep the page open (returns `false`).
 *   - ctrl-click  → close the page (returns `true`).
 *   - plain click → the button's own default (`defaultClose`).
 *
 * shift wins over ctrl when both are held, so an ambiguous chord
 * defaults to the safer "don't disappear the preview" outcome.
 */
function closeAfterFromModifiers(e: MouseEvent, defaultClose: boolean): boolean {
  if (e.shiftKey) return false;
  if (e.ctrlKey) return true;
  return defaultClose;
}

/**
 * Apply / refresh the `.is-default` class so exactly one of the
 * Capture button or the Ask split widget shows the "default
 * action" highlight ring. The ring on the Ask side traces the
 * whole `.ask-split` (main button + caret) so the highlight reads
 * as one button — the per-provider favicon buttons stay un-ringed
 * since they're lateral-mode entries that don't fire on Alt+A or
 * Enter. Looking up `.ask-split` lazily so this helper stays safe
 * to call before that node is queried.
 */
function applyDefaultButtonHighlight(which: 'capture' | 'ask'): void {
  currentDefaultButton = which;
  captureBtn.classList.toggle('is-default', which === 'capture');
  const askSplit = document.querySelector('.ask-split');
  askSplit?.classList.toggle('is-default', which === 'ask');
}

/**
 * Fire whichever of the two main buttons is the current default.
 * Returns true if a click was dispatched — Enter / triggerCapture
 * branches use the return to decide whether to preventDefault. A
 * disabled target is a no-op so a double-press can't re-submit while
 * a save is in flight.
 *
 * The Ask path clicks `#ask-btn` (send-to-default) rather than
 * `#ask-menu-btn` (open menu) — the user has already made a steering
 * decision via Options, so honouring that without forcing a menu pick
 * keeps the keyboard path symmetric with Capture's.
 *
 * Degraded-state fallback: if the user picked `defaultButton='ask'`
 * but the Ask split widget is disabled (no provider enabled, mid-Ask
 * round-trip, etc.), fall through to Capture rather than no-op'ing
 * — better to do *something* obvious than to silently drop the user's
 * Enter.
 */
function clickDefaultPageButton(): boolean {
  if (currentDefaultButton === 'ask') {
    const askBtnEl = document.getElementById('ask-btn') as HTMLButtonElement | null;
    if (askBtnEl && !askBtnEl.disabled) {
      askBtnEl.click();
      return true;
    }
  }
  if (!captureBtn.disabled) {
    captureBtn.click();
    return true;
  }
  return false;
}

promptInput.addEventListener('keydown', (e) => {
  // Three Enter variants — fixed to avoid mode confusion:
  //   - Shift+Enter: always newline. Wins over Ctrl+Shift+Enter too —
  //     we treat any Shift hold as "user wants a literal newline".
  //   - Ctrl+Enter (no Shift): always send.
  //   - Plain Enter: follows the user's `promptEnter` setting; defaults
  //     to send. When set to 'newline' we fall through to native
  //     textarea handling.
  if (e.key !== 'Enter') return;
  // IME commit-Enter: don't intercept. The composition needs the keystroke
  // to commit, and the destructive `\` branch below would otherwise eat
  // a literal `\` that was never meant as a line-continuation marker.
  if (e.isComposing) return;
  if (e.shiftKey) return;
  // Backslash + Enter on plain Enter in send mode: erase the trailing
  // `\` and insert a newline, matching CLI coding agents. Skipped for
  // Ctrl+Enter (always submits) and 'newline' mode (plain Enter already
  // inserts a newline natively).
  if (!e.ctrlKey && currentPromptEnter === 'send') {
    const start = promptInput.selectionStart ?? 0;
    const end = promptInput.selectionEnd ?? 0;
    if (start === end && start > 0 && promptInput.value[start - 1] === '\\') {
      e.preventDefault();
      // Select just the trailing `\` and replace it via execCommand so
      // the swap lands on the textarea's native undo stack — Ctrl+Z
      // restores the backslash. setRangeText would do the right text
      // replace but bypass undo entirely.
      promptInput.setSelectionRange(start - 1, end);
      document.execCommand('insertText', false, '\n');
      return;
    }
  }
  const sendIntent = e.ctrlKey || currentPromptEnter === 'send';
  if (sendIntent) {
    if (clickDefaultPageButton()) e.preventDefault();
  }
});

document.addEventListener('keydown', (e) => {
  // Suspend the page-wide hotkeys while any edit dialog is up —
  // e.g. Alt+H in the HTML dialog should type `h`, not silently
  // flip the Save HTML checkbox behind the modal.
  // Note: this listener references `askBtn` which is declared
  // further down the file. Safe because the listener fires on user
  // input — long after all top-level `const`s have initialised.
  if (anyEditDialogOpen()) return;
  // In the no-session error state every control referenced below is
  // `display:none`. Their `.disabled` flags are still false (we
  // never wired them up), so without this guard Alt+S / Alt+H /
  // Alt+N would flip hidden checkboxes and Alt+C / Alt+A would
  // "click" hidden buttons — surprising no-ops at best.
  if (staleMode) return;
  if (!e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  // Alt+C clicks the Capture button. Alt+A opens the Ask menu.
  // Alt+S / Alt+H toggle the screenshot / HTML checkboxes. Alt+N
  // toggles the master "Save selection" checkbox. Alt+L / Alt+T /
  // Alt+M pick one of the three format radios (and auto-check the
  // master via the change listener wired in wireSelectionControls).
  // Each is a no-op when its control is disabled so the hotkey
  // matches what's on screen. The label underlines in capture.html
  // mirror these keys.
  const selectionFormat: Partial<Record<string, SelectionFormat>> = {
    l: 'html', t: 'text', m: 'markdown',
  };
  if (key === 'c') {
    // Alt+C submits the form, mirroring Enter in the prompt textarea
    // and a click on the Capture button. No-op while the button is
    // disabled (in-flight save) so a double-press can't re-submit.
    if (captureBtn.disabled) return;
    e.preventDefault();
    captureBtn.click();
  } else if (key === 'a') {
    // Alt+A fires the Ask button against the currently-resolved
    // default destination — same as a plain mouse click on
    // `#ask-btn`. The menu was rebuilt as a default-picker (see
    // the Ask flow header in this file), so opening it from the
    // keyboard would force a useless second key for "send";
    // firing immediately matches the Capture-button hotkey
    // (Alt+C) and the muscle memory the keyboard path had before
    // the menu existed. No-op while the button is disabled
    // (in-flight Ask, no providers enabled) so a double-press
    // doesn't queue a second send.
    // `#ask-btn` lives in the Ask module's owned DOM; look it up
    // each press rather than caching a ref here.
    const askBtnEl = document.getElementById('ask-btn') as HTMLButtonElement | null;
    if (!askBtnEl || askBtnEl.disabled) return;
    e.preventDefault();
    askBtnEl.click();
  } else if (key === 's') {
    if (screenshotBox.disabled) return;
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


// Click-flash for every `.btn` on the page (palette buttons, header
// Options, Capture / Ask split, edit-dialog actions). `:active`
// only paints while the mouse is physically down, which is
// invisibly brief for a fast click — `.pressed` extends the same
// pressed-look styling for ~140 ms so every click registers
// visibly. Document-level capture-phase listener so it covers
// dynamically-cloned buttons (e.g. the per-kind edit dialog
// templates) without needing to re-wire each instance.
const PRESS_FLASH_MS = 140;
document.addEventListener('click', (e) => {
  const target = (e.target as Element | null)?.closest<HTMLButtonElement>('button.btn');
  if (!target || target.disabled) return;
  target.classList.add('pressed');
  setTimeout(() => target.classList.remove('pressed'), PRESS_FLASH_MS);
}, true);


// ─── Initial data load ────────────────────────────────────────────

/**
 * Reveal the upload-landing card and wire the file picker. Called
 * from `loadData()` on the no-session path when `?upload=true` is
 * in the URL. Once the user picks an image we:
 *
 *   1. FileReader → data URL.
 *   2. Decode-validate the data URL via `<img>` so a corrupt /
 *      0-byte / mislabeled file fails here rather than rendering
 *      a broken-image preview after the navigation.
 *   3. `initializeUploadSession` to the SW (it synthesizes a
 *      `DetailsSession` and stashes it under our tab's key).
 *   4. Strip `?upload=true` from the URL via `replaceState` so a
 *      reload doesn't re-trigger this branch (we now have a real
 *      session and want the normal path).
 *   5. Re-enter `loadData()` — `getDetailsData` returns the
 *      synthetic session and the rest of the page renders.
 *
 * Errors (non-image file, decode failure, FileReader failure, SW
 * init rejection) surface in `#upload-error` below the Choose-image
 * button. The button stays functional so the user can pick a
 * different file without reloading the tab.
 */
async function handleUploadFlow(): Promise<void> {
  const landing = document.getElementById('upload-landing') as HTMLDivElement;
  const chooseBtn = document.getElementById('upload-choose-btn') as HTMLButtonElement;
  const fileInput = document.getElementById('upload-file-input') as HTMLInputElement;
  const errorEl = document.getElementById('upload-error') as HTMLDivElement;

  landing.hidden = false;

  function showError(msg: string): void {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }
  function clearError(): void {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }

  chooseBtn.addEventListener('click', () => {
    clearError();
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    // Always reset so the user can re-pick the same file after an
    // error path (the change event won't fire on identical
    // selections otherwise).
    const resetInput = (): void => { fileInput.value = ''; };

    if (!file.type.startsWith('image/')) {
      showError('Not a supported image format.');
      resetInput();
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      showError('Could not read file. Try again.');
      resetInput();
    };
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      // Decode-validate before we ship the bytes off to the SW.
      // The `accept="image/*"` attribute and the MIME-prefix check
      // above only filter on declared type — a 0-byte file or a
      // `.png` carrying garbage bytes still passes both. Loading
      // through `<img>` and waiting for `onload` / `onerror` runs
      // the same decode the Capture page would do, so anything that
      // would render as a broken-image placeholder fails here with
      // a clear message instead.
      const decodable = await new Promise<boolean>((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(probe.naturalWidth > 0 && probe.naturalHeight > 0);
        probe.onerror = () => resolve(false);
        probe.src = dataUrl;
      });
      if (!decodable) {
        showError('Not a valid image (could not decode).');
        resetInput();
        return;
      }
      let initRes: { ok?: boolean; error?: string } | undefined;
      try {
        initRes = await chrome.runtime.sendMessage({
          action: 'initializeUploadSession',
          dataUrl,
          filename: file.name,
          mimeType: file.type,
        });
      } catch (err) {
        showError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
        resetInput();
        return;
      }
      if (!initRes?.ok) {
        showError(`Upload failed: ${initRes?.error ?? 'no response from background'}`);
        resetInput();
        return;
      }
      // Synthetic session is now in place. Hide the landing, scrub
      // `?upload=true` from the URL (so reloads don't loop us back
      // here), unhide the main-content blocks the no-session
      // branch hid, clear `staleMode`, and let the normal
      // `loadData` happy-path render.
      landing.hidden = true;
      window.history.replaceState({}, document.title, window.location.pathname);
      document
        .querySelectorAll<HTMLElement>('[data-capture-main]')
        .forEach((el) => {
          el.hidden = false;
        });
      staleMode = false;
      await loadData();
    };
    reader.readAsDataURL(file);
  });
}

async function loadData(): Promise<void> {
  try {
    // Catch sendMessage rejections (SW not yet alive, "Could not
    // establish connection" on a torn-down extension context, etc.)
    // and treat them as "no session" — same broken-page failure
    // mode as a missing entry, same recovery UX.
    let response: DetailsData | undefined;
    try {
      response = await chrome.runtime.sendMessage({ action: 'getDetailsData' });
    } catch {
      response = undefined;
    }
    if (!response) {
      // No SW-side session for this tab. Two cases:
      //  - `?upload=true` in the URL: the user came from the More
      //    submenu's "Upload image to Capture..." entry. Show the
      //    upload-landing card so they can pick a file. Once they
      //    do, we send `initializeUploadSession`, the SW seeds the
      //    matching `DetailsSession`, the URL is cleaned, and we
      //    re-enter `loadData()` for the happy path.
      //  - Anything else: the page was opened directly (bookmark,
      //    history, browser restart) without the SW-seeded snapshot
      //    it's built from. Show the explanatory missing-session
      //    pane.
      // Either way we hide every main-content block, set
      // `staleMode` so Alt-shortcuts don't silently mutate hidden
      // controls, and the `finally` below still flips body
      // visibility (the prompt focus call below is a silent no-op
      // when the prompt is inside a hidden block).
      staleMode = true;
      document
        .querySelectorAll<HTMLElement>('[data-capture-main]')
        .forEach((el) => {
          el.hidden = true;
        });
      const params = new URLSearchParams(window.location.search);
      if (params.get('upload') === 'true') {
        await handleUploadFlow();
        return;
      }
      // `?error=...` means the SW tried to seed a session for us but
      // hit a hard failure (e.g. session-storage quota rejection on
      // the initial Capture). Show the dedicated "Capture failed"
      // pane with the SW-supplied message instead of the generic
      // "Invalid capture page." pane — the user wants to see *why*
      // it failed (and the proposed-vs-free MB readout it usually
      // carries), not the catch-all "open SeeWhatISee from the
      // toolbar" recovery hint.
      const errorParam = params.get('error');
      if (errorParam) {
        const failPane = document.getElementById('capture-failed-error');
        const failMsg = document.getElementById('capture-failed-message');
        if (failMsg) failMsg.textContent = errorParam;
        if (failPane) failPane.hidden = false;
        return;
      }
      const errorPane = document.getElementById('missing-session-error');
      if (errorPane) errorPane.hidden = false;
      return;
    }
    previewImg.src = response.screenshotDataUrl;
    capturedUrl = response.url;
    // Title falls back to the URL when no title was captured (covers
    // restricted pages, scrape failures, and the rare untitled tab).
    // The native `title` attribute mirrors the displayed text so
    // hovering an ellipsised row reveals the full string. The hover
    // tooltip on the URL row stays the URL itself even when the title
    // is showing the URL — readers expect the URL there.
    const titleText = response.title || response.url || '(no URL)';
    capturedTitleLink.textContent = titleText;
    capturedTitleLink.title = titleText;
    capturedUrlText.textContent = response.url;
    capturedUrlLink.title = response.url;
    // Only http(s) URLs get a live `href` — `chrome://`,
    // `chrome-extension://`, `file://`, `data:`, and `javascript:`
    // either can't be navigated to from an extension page or
    // shouldn't be made click-affordant. The rows still render the
    // captured string and the Copy URL button still works on any
    // non-empty value (copying `chrome://...` is legitimately useful).
    const linkable = response.url && /^https?:/i.test(response.url);
    if (linkable) {
      capturedTitleLink.href = response.url;
      capturedUrlLink.href = response.url;
    } else {
      // Keep the markup but inert. The CSS `:not([href])` rule strips
      // the click affordance (cursor + pointer-events) and overrides
      // the URL row's blue back to #000 so the text reads as plain
      // text.
      capturedTitleLink.removeAttribute('href');
      capturedUrlLink.removeAttribute('href');
    }
    copyUrlBtn.disabled = !response.url;

    if (response.screenshotError) {
      screenshotBox.checked = false;
      screenshotBox.disabled = true;
      copyScreenshotBtn.disabled = true;
      downloadScreenshotBtn.disabled = true;
      // Image-level Copy / Save-as in the drawing palette write the
      // *same* PNG as the per-row buttons, so they're meaningless
      // without a successful capture either.
      copyImageBtn.disabled = true;
      downloadImageBtn.disabled = true;
      screenshotRow.classList.add('has-error');
      screenshotErrorIcon.title = `Unable to capture screenshot: ${response.screenshotError}`;
      // Latched flag read by `updateImageSizeBadge` so resize-driven
      // render() calls (which can run before loadData paints the rest
      // of the badges) don't briefly show an "PNG · 0 B" pill from a
      // bogus empty data URL.
      screenshotErrored = true;
    }
    updateImageSizeBadge();

    // Apply per-artifact error states first so the HTML size badge
    // below reflects the right value (hidden rather than a misleading
    // "0 B" pill when the scrape failed).
    if (response.htmlError) {
      // HTML couldn't be scraped (restricted URL, blocked injection,
      // etc.). Disable + uncheck Save HTML, hide its Copy / Edit
      // buttons, and flag the row with a hoverable error icon so the
      // user understands why it's greyed out — while still letting
      // them use the rest of the capture flow. The reason itself
      // lives on the row's error-icon tooltip; the size pill is hidden
      // outright so the card row doesn't show a confusing "HTML · 0 B"
      // when no HTML was captured.
      htmlBox.checked = false;
      htmlBox.disabled = true;
      copyHtmlBtn.disabled = true;
      editHtmlBtn.disabled = true;
      downloadHtmlBtn.disabled = true;
      htmlRow.classList.add('has-error');
      htmlErrorIcon.title = `Unable to capture HTML contents: ${response.htmlError}`;
      htmlSizeBadge.hidden = true;
    } else if (response.htmlUnavailable) {
      // Image-context flow: HTML wasn't scraped because the user
      // right-clicked a specific image rather than the whole page.
      // Quiet-disable Save HTML — same disabled state as the error
      // path but no `has-error` styling and no error-icon tooltip
      // (there's nothing to explain; the absence is by design).
      htmlBox.checked = false;
      htmlBox.disabled = true;
      copyHtmlBtn.disabled = true;
      editHtmlBtn.disabled = true;
      downloadHtmlBtn.disabled = true;
      htmlSizeBadge.hidden = true;
    } else {
      captured.html = response.html;
      // True UTF-8 byte count of the captured HTML, not the JS string
      // length (which counts UTF-16 code units). Explicit `hidden =
      // false` is defensive — `loadData` only runs once today, but a
      // future re-load (e.g. retry-on-error) shouldn't inherit the
      // error branch's `hidden = true` state.
      htmlSizeBadge.hidden = false;
      htmlSizeBadge.textContent = `HTML · ${formatBytes(new Blob([captured.html]).size)}`;
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
      // Track which formats have non-empty content so we can pick
      // the initial radio in one pass below — the SW-provided
      // default wins when it's saveable, otherwise we fall back to
      // the first non-empty format.
      const contentfulFormats: SelectionFormat[] = [];
      for (const format of SELECTION_FORMATS) {
        const body = response.selections[format];
        const r = selectionRows[format];
        captured[SELECTION_WIRE_KIND[format]] = body;
        if (body && body.trim().length > 0) {
          r.radio.disabled = false;
          r.copyBtn.disabled = false;
          r.editBtn.disabled = false;
          r.downloadBtn.disabled = false;
          contentfulFormats.push(format);
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
        // Pick the initial radio. Prefer the user's configured
        // capture-page format default; fall back to the first format
        // with content if the chosen one is empty for this capture
        // (e.g. image-only selection → no text/markdown body). The
        // chosen format also becomes the "sticky default" that the
        // master checkbox restores when unchecked + re-checked.
        const preferred = response.capturePageDefaults.withSelection.format;
        const initialFormat = contentfulFormats.includes(preferred)
          ? preferred
          : contentfulFormats[0]!;
        selectionRows[initialFormat].radio.checked = true;
        defaultSelectionFormat = initialFormat;
        // At least one format is saveable — enable the master and
        // reveal the format rows. The master's checked state, plus
        // the screenshot/HTML rows, come from the stored
        // `withSelection` defaults below (after the if/else block).
        selectionBox.disabled = false;
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
    // Apply the user's stored Save-checkbox defaults. We branch on
    // whether the page is in "with-selection" mode (master is
    // available + at least one format had content) vs.
    // "no-selection" mode. Each checkbox is set only when it isn't
    // already disabled (artifact-error rows stay unchecked).
    const useWithSelection = !selectionBox.disabled;
    const cdd = response.capturePageDefaults;
    const saveDefaults = useWithSelection ? cdd.withSelection : cdd.withoutSelection;
    if (!screenshotBox.disabled) screenshotBox.checked = saveDefaults.screenshot;
    if (!htmlBox.disabled) htmlBox.checked = saveDefaults.html;
    if (useWithSelection) {
      selectionBox.checked = cdd.withSelection.selection;
    }
    // Apply the user's chosen "default button" highlight and rebind
    // the Enter / triggerCapture routing in one shot.
    applyDefaultButtonHighlight(cdd.defaultButton);
    currentPromptEnter = cdd.promptEnter;

    // Initial Selection-size badge population. The radio's `change`
    // event doesn't fire when we set `.checked` programmatically
    // above, so wire up the first paint manually here. After this
    // point user-driven radio + master changes update the badge via
    // the listeners installed in `wireSelectionControls`.
    updateSelectionSizeBadge();

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
    // Focus must happen after `visibility: visible` — focus calls
    // are silently ignored on `visibility: hidden` elements, so an
    // earlier `.focus()` (e.g. at module-init time) wouldn't stick.
    promptInput.focus();
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

// Hold `.pressed` on `btn` for the lifetime of `fn`. The Copy paths
// run async (SW round-trip → download-complete → writeText) so a
// fast user can alt-tab and paste before the clipboard has the new
// value — getting the *previous* clipboard contents and assuming
// our copy failed. The visible depressed state across the whole
// operation makes "wait until the button pops back up" obvious and
// eliminates that race in practice. `finally` ensures the class is
// removed even if the SW or download throws.
async function withPressed(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  btn.classList.add('pressed');
  try {
    await fn();
  } finally {
    btn.classList.remove('pressed');
  }
}

// `navigator.clipboard.writeText` / `…write` reject with a
// `NotAllowedError` ("Document is not focused") when the page loses
// focus mid-flight — reproducible by clicking a Copy button that
// has to wait on a SW download and then alt-tabbing before it
// lands. Both copy entry points (text via `writeClipboardText` and
// image via `copyImageToClipboard`) feed their rejection through
// `formatClipboardError`, so the user-facing wording — including
// the "click back in and try again" recovery hint — stays in sync
// across all the Copy buttons. `subject` is the noun the message
// is talking about ("copy" for text/filename/URL, "copy image" for
// the drawing-palette image button).
function formatClipboardError(err: unknown, subject: 'copy' | 'copy image'): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return `Couldn't ${subject} — capture page lost focus before the ${subject} finished.`;
  }
  const detail = (err as Error)?.message ?? String(err);
  return `Failed to ${subject === 'copy' ? 'copy to clipboard' : 'copy image to clipboard'}: ${detail}`;
}

// Surface clipboard-write failures in the shared `#ask-status` slot
// rather than letting them bubble as uncaught promise rejections.
// See `formatClipboardError` for the wording rules.
//
// No `console.warn` here on purpose: the in-page status message is
// the user's source of truth, and warnings would also bubble to the
// `chrome://extensions` errors page.
async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    setStatusMessage(formatClipboardError(err, 'copy'), 'error');
  }
}

// Page-card Copy URL button — copies the captured URL string itself
// (not a filename or a download path), separate from the per-artifact
// Copy buttons which materialize a file and copy its absolute path.
copyUrlBtn.addEventListener('click', () => {
  if (!capturedUrl) return;
  void withPressed(copyUrlBtn, () => writeClipboardText(capturedUrl));
});

copyScreenshotBtn.addEventListener('click', () => {
  void withPressed(copyScreenshotBtn, () => copyArtifactPath('screenshot'));
});
copyHtmlBtn.addEventListener('click', () => {
  void withPressed(copyHtmlBtn, () => copyArtifactPath('html'));
});
for (const format of SELECTION_FORMATS) {
  const btn = selectionRows[format].copyBtn;
  btn.addEventListener('click', () => {
    void withPressed(btn, () => copyArtifactPath(SELECTION_WIRE_KIND[format]));
  });
}

// ─── Download (Save as…) buttons ──────────────────────────────────
//
// Each row's download button opens a native save dialog seeded with a
// generic default filename (`screenshot.<png|jpg>`, `contents.html`,
// `selection.{html,txt,md}`) under the user's default download
// directory. The bytes written reflect the *current* edited state:
//   - Screenshot: the highlighted/cropped image via
//     `renderHighlightedImage` when there are bake-able edits, else
//     the original capture. Output format is sticky on the source
//     (JPG stays JPG; everything else writes PNG) — see `bakeMime`.
//   - HTML / selection: the `captured[kind]` mirror, which the Edit
//     dialogs keep in sync with the SW after each save.
// `chrome.downloads.download({ saveAs: true })` is callable directly
// from this extension page (no SW round-trip needed). It rejects with
// `USER_CANCELED` when the user dismisses the dialog — silenced.

downloadScreenshotBtn.addEventListener('click', () => {
  void downloadAs('screenshot');
});

// Image-level Copy / Save-as in the drawing palette. Both reuse the
// per-row screenshot logic — the Save-as is identical, and the Copy
// puts the same PNG bytes onto the clipboard as image data (vs. the
// per-row Copy, which copies the *filename* as text).
copyImageBtn.addEventListener('click', () => {
  void copyImageToClipboard();
});
downloadImageBtn.addEventListener('click', () => {
  void downloadAs('screenshot');
});

async function copyImageToClipboard(): Promise<void> {
  // Forcing PNG keeps this aligned with the `ClipboardItem` MIME
  // below: browsers only accept `image/png` in `ClipboardItem`
  // reliably, so even a JPG- or WEBP-source capture is re-encoded
  // to PNG for the clipboard.
  // - PNG source, no edits → short-circuits to `previewImg.src`.
  // - JPG / WEBP / GIF / … source → canvas re-encode to PNG runs
  //   even with no edits (otherwise the blob's MIME would mismatch
  //   the `'image/png'` `ClipboardItem` key below).
  // - Any source + edits → canvas re-encode to PNG runs.
  // The `fetch()` call is on the data URL (local base64 decode),
  // not a network request to the source page.
  const url = renderHighlightedImage('image/png');
  try {
    // Wrap the fetch in a Promise passed directly to ClipboardItem.
    // navigator.clipboard.write must be called synchronously within the
    // user gesture (before any await) to prevent the browser from
    // revoking clipboard access. The browser resolves the promise to
    // read the blob bytes.
    const blobPromise = fetch(url).then((r) => r.blob());
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
  } catch (err) {
    // Same `NotAllowedError` ("Document is not focused") path as
    // `writeClipboardText` — `navigator.clipboard.write` rejects the
    // same way when the page loses focus mid-flight. Reuse the
    // shared `formatClipboardError` builder so the user-facing
    // wording stays consistent across all three copy buttons. Same
    // reasoning as `writeClipboardText`: no `console.warn` so the
    // expected alt-tab `NotAllowedError` doesn't redirect into the
    // `chrome://extensions` errors page.
    setStatusMessage(formatClipboardError(err, 'copy image'), 'error');
  }
}
downloadHtmlBtn.addEventListener('click', () => {
  void downloadAs('html');
});
for (const format of SELECTION_FORMATS) {
  selectionRows[format].downloadBtn.addEventListener('click', () => {
    void downloadAs(SELECTION_WIRE_KIND[format]);
  });
}

const SELECTION_DOWNLOAD_MIME: Record<SelectionFormat, string> = {
  html: 'text/html',
  text: 'text/plain',
  markdown: 'text/markdown',
};
const SELECTION_DOWNLOAD_EXT: Record<SelectionFormat, string> = {
  html: 'html',
  text: 'txt',
  markdown: 'md',
};

async function downloadAs(
  kind: 'screenshot' | EditableArtifactKind,
): Promise<void> {
  if (kind === 'screenshot') {
    // `renderHighlightedImage` short-circuits to the original
    // capture's data URL when no edits need baking and the source
    // already matches `bakeMime` — see its docstring.
    const url = renderHighlightedImage();
    // Screenshot is a data: URL — nothing to revoke. The other kinds
    // use blob URLs (built from the editable body) and route through
    // `downloadEditableAs`, which handles its own revocation.
    await runSaveAsDialog(url, `screenshot.${bakeExt()}`, null);
    return;
  }
  await downloadEditableAs(kind, captured[kind]);
}

/**
 * Save the given editable-kind body to a user-chosen path via the
 * native save dialog. The body parameter is split out so the
 * in-dialog download button can hand the *current editor source*
 * (uncommitted), while the per-row Save-as button hands
 * `captured[kind]` (the SW-committed mirror).
 */
async function downloadEditableAs(
  kind: EditableArtifactKind,
  body: string,
): Promise<void> {
  let mime: string;
  let filename: string;
  if (kind === 'html') {
    mime = 'text/html';
    filename = 'contents.html';
  } else {
    // One of the three selection kinds. Reverse-map the editable kind
    // back to a SelectionFormat so we can pick the matching MIME and
    // extension. The selection-radio rows already enforce that the
    // body is non-empty before enabling this button.
    const format = (Object.keys(SELECTION_WIRE_KIND) as SelectionFormat[])
      .find((f) => SELECTION_WIRE_KIND[f] === kind)!;
    mime = SELECTION_DOWNLOAD_MIME[format];
    filename = `selection.${SELECTION_DOWNLOAD_EXT[format]}`;
  }
  const withNewline = body.endsWith('\n') ? body : `${body}\n`;
  const blobUrl = URL.createObjectURL(
    new Blob([withNewline], { type: `${mime};charset=utf-8` }),
  );
  await runSaveAsDialog(blobUrl, filename, blobUrl);
}

/**
 * Open the native save dialog seeded with `defaultName`, downloading
 * `url`. When `blobUrlToRevoke` is set we revoke it after a delay
 * rather than synchronously: `chrome.downloads.download` resolves on
 * the download having *started*, not finished — for large bodies the
 * browser may still be reading the blob when the await returns.
 * Revoking it then would risk truncating the saved file. 30 s is
 * comfortably longer than any plausible read for a save-as payload
 * and the page typically closes long before then anyway.
 */
const BLOB_REVOKE_DELAY_MS = 30_000;
async function runSaveAsDialog(
  url: string,
  defaultName: string,
  blobUrlToRevoke: string | null,
): Promise<void> {
  try {
    await chrome.downloads.download({ url, filename: defaultName, saveAs: true });
  } catch (err) {
    // USER_CANCELED is the expected outcome when the user dismisses
    // the save dialog — log other errors so unexpected failures are
    // visible in the SW devtools without crashing the page.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/USER_CANCELED/i.test(msg)) {
      console.warn('[SeeWhatISee] save-as failed:', err);
    }
  } finally {
    if (blobUrlToRevoke) {
      const u = blobUrlToRevoke;
      setTimeout(() => URL.revokeObjectURL(u), BLOB_REVOKE_DELAY_MS);
    }
  }
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
// Inlined rather than `import type`'d for the same reason
// `SelectionFormat` is duplicated above: keeps the page's payload
// contract independent of the SW module. New editable kinds must
// be added to all three sites.
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
  /** Modal heading + editor aria-label. Short, user-visible. */
  title: string;
  /** The pencil button inside the Capture-page row for this kind. */
  openBtn: HTMLButtonElement;
  /** If set, the dialog exposes the Edit / Preview toggle and
   * renders a preview using the named renderer:
   *   - `'html'`     — parse editor source as HTML (DOMParser) and
   *                    drop it into a sandboxed iframe.
   *   - `'markdown'` — parse as markdown via `marked`, then reuse
   *                    the same iframe + sanitizer pipeline on the
   *                    resulting HTML. Raw HTML inside the markdown
   *                    flows through the same script / meta-refresh
   *                    stripping as the HTML preview.
   * Omitted for plain-text kinds that have nothing meaningful to
   * render. */
  preview?: 'html' | 'markdown';
  /** Optional post-save hook — e.g. refresh the HTML-size readout. */
  onSaved?: (value: string) => void;
}

const EDIT_KINDS: EditKindSpec[] = [
  {
    kind: 'html',
    domSlug: 'html',
    title: 'Page contents HTML',
    openBtn: editHtmlBtn,
    preview: 'html',
    onSaved: (v) => {
      // Only reachable when the original HTML scrape succeeded —
      // `loadData` disables `editHtmlBtn` whenever `htmlError` is set,
      // so the badge here is always populated and visible.
      htmlSizeBadge.textContent = `HTML · ${formatBytes(new Blob([v]).size)}`;
    },
  },
  {
    kind: 'selectionHtml',
    domSlug: 'selection-html',
    title: 'Selection HTML',
    openBtn: selectionRows.html.editBtn,
    preview: 'html',
    // Each selection edit-save updates the live `captured.selection*`
    // body before this hook runs, so `updateSelectionSizeBadge` reads
    // the post-edit byte count when the active format matches the
    // edited kind. Editing a non-active format leaves the badge
    // unchanged until the user clicks that format's radio.
    onSaved: () => updateSelectionSizeBadge(),
  },
  {
    kind: 'selectionText',
    domSlug: 'selection-text',
    title: 'Edit selection text',
    openBtn: selectionRows.text.editBtn,
    onSaved: () => updateSelectionSizeBadge(),
  },
  {
    kind: 'selectionMarkdown',
    domSlug: 'selection-markdown',
    title: 'Selection markdown',
    openBtn: selectionRows.markdown.editBtn,
    preview: 'markdown',
    onSaved: () => updateSelectionSizeBadge(),
  },
];

// Populated by `bindEditDialog` once the DOM is cloned from the
// template; insertion order matches `EDIT_KINDS` so
// `anyEditDialogOpen()` and future iteration see the same order.
const editDialogs: HTMLDialogElement[] = [];

interface EditDialogParts {
  dialog: HTMLDialogElement;
  /**
   * The CodeJar-wrapped contenteditable <div> that replaces what used
   * to be a <textarea>. The DOM id is still `edit-${slug}-textarea`
   * for backward compatibility with e2e selectors, and the `.value`-
   * style access is mediated via `getCode` / `setCode` below so
   * callers don't touch CodeJar's internals directly.
   */
  editor: HTMLDivElement;
  /** Current source as a plain string. Reads from CodeJar so any
   *  in-flight IME composition / pending input is included. */
  getCode(): string;
  /** Replace the editor's contents. Re-runs the highlighter so the
   *  tokens reflect the new source. */
  setCode(code: string): void;
  saveBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  errorEl: HTMLParagraphElement;
  modeToggle: HTMLDivElement;
  editModeBtn: HTMLButtonElement;
  previewModeBtn: HTMLButtonElement;
  previewIframe: HTMLIFrameElement;
  /**
   * In-dialog "Download this file" button (right of the
   * Edit / Preview toggle). Saves whatever is currently in the
   * editor — including un-committed changes — via the same
   * `chrome.downloads.download({ saveAs: true })` path the per-row
   * Save-as buttons use.
   */
  dialogDownloadBtn: HTMLButtonElement;
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
function createEditDialog(
  domSlug: string,
  title: string,
  kind: EditableArtifactKind,
): EditDialogParts {
  const tpl = document.getElementById('edit-dialog-template') as HTMLTemplateElement;
  const frag = tpl.content.cloneNode(true) as DocumentFragment;
  const dialog = frag.querySelector('.edit-dialog') as HTMLDialogElement;
  const titleEl = dialog.querySelector('.edit-dialog-title') as HTMLHeadingElement;
  const editor = dialog.querySelector('.edit-dialog-textarea') as HTMLDivElement;
  const errorEl = dialog.querySelector('.edit-dialog-error') as HTMLParagraphElement;
  const saveBtn = dialog.querySelector('.edit-dialog-save') as HTMLButtonElement;
  const cancelBtn = dialog.querySelector('.edit-dialog-cancel') as HTMLButtonElement;
  const modeToggle = dialog.querySelector('.edit-dialog-mode-toggle') as HTMLDivElement;
  const editModeBtn = dialog.querySelector('.edit-dialog-mode-edit') as HTMLButtonElement;
  const previewModeBtn = dialog.querySelector('.edit-dialog-mode-preview') as HTMLButtonElement;
  const previewIframe = dialog.querySelector('.edit-dialog-preview') as HTMLIFrameElement;
  const dialogDownloadBtn = dialog.querySelector('.edit-dialog-download') as HTMLButtonElement;

  dialog.id = `edit-${domSlug}-dialog`;
  titleEl.id = `edit-${domSlug}-title`;
  titleEl.textContent = title;
  dialog.setAttribute('aria-labelledby', titleEl.id);
  editor.id = `edit-${domSlug}-textarea`;
  editor.setAttribute('aria-label', title);
  // `hljs` class lets the highlight.js theme stylesheet paint the
  // editor's background + default text color. Must be on the root
  // element CodeJar writes into.
  editor.classList.add('hljs');
  errorEl.id = `edit-${domSlug}-error`;
  saveBtn.id = `edit-${domSlug}-save`;
  cancelBtn.id = `edit-${domSlug}-cancel`;
  editModeBtn.id = `edit-${domSlug}-mode-edit`;
  previewModeBtn.id = `edit-${domSlug}-mode-preview`;
  previewIframe.id = `edit-${domSlug}-preview`;
  dialogDownloadBtn.id = `edit-${domSlug}-download`;

  document.body.appendChild(dialog);

  // Wrap the editor with CodeJar. `spellcheck: false` mirrors the
  // old textarea attribute; `tab: '\t'` matches textarea behavior
  // when the user hits Tab (CodeJar swallows it so focus doesn't
  // move out of the editor). `addClosing: false` suppresses
  // CodeJar's auto-pair-quotes/brackets default — the old textarea
  // had no such behavior and auto-pairing inside HTML attributes
  // ("foo=|bar" typing `"` would insert `""`) is an unwelcome UX
  // delta.
  // Rich-text paste: HTML editors should land the actual `text/html`
  // source the user copied (not the visible-text projection a
  // plaintext-only contenteditable would otherwise insert), and the
  // markdown editor should land the `htmlToMarkdown` projection. The
  // selection-text editor keeps the default plain-text paste — no
  // listener attached, so CodeJar's own paste handler (below) just
  // inserts the `text/plain` clipboard value. See the
  // `attachHtmlAwarePaste` block above for the Ctrl+V vs Ctrl+Shift+V
  // routing.
  //
  // *Order matters*: we attach this listener BEFORE wrapping with
  // CodeJar. CodeJar's own paste handler short-circuits when
  // `event.defaultPrevented` is already true, so attaching first
  // means our handler runs first, calls `preventDefault`, and
  // CodeJar's bails — otherwise CodeJar would insert the plain-text
  // version *before* ours runs and we'd end up with both copies in
  // the editor.
  if (kind === 'html' || kind === 'selectionHtml') {
    attachHtmlAwarePaste(editor, 'asHtmlSource');
  } else if (kind === 'selectionMarkdown') {
    attachHtmlAwarePaste(editor, 'asMarkdown');
  }

  const jar = CodeJar(editor, makeHighlighter(hljsLanguageFor(kind)), {
    tab: '\t',
    spellcheck: false,
    addClosing: false,
  });

  return {
    dialog, editor,
    getCode: () => jar.toString(),
    setCode: (code) => jar.updateCode(code),
    saveBtn, cancelBtn, errorEl,
    modeToggle, editModeBtn, previewModeBtn, previewIframe,
    dialogDownloadBtn,
  };
}

/**
 * Build the HTML document for previewing a captured HTML body in a
 * sandboxed iframe. Parses the HTML via DOMParser (`text/html` mode
 * is extremely forgiving — malformed input still yields a document),
 * strips any existing `<base>` (would shadow ours), and injects a
 * fresh one with the captured page's URL + `target="_blank"` so
 * relative links resolve and clicks open in a new tab instead of
 * replacing the preview iframe. Scripts survive parsing but won't
 * execute because the iframe's sandbox denies `allow-scripts`.
 * Returned string is loaded via a `blob:` URL (not `srcdoc`) because
 * srcdoc has a browser attribute-size limit that silently truncates
 * large captures to blank.
 */
function buildPreviewHtml(htmlBody: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(htmlBody, 'text/html');
  // Defense-in-depth: sandbox already denies `allow-scripts`, so
  // inline <script> can't run — but stripping makes the previewed
  // source match what renders and removes the execution vector
  // entirely. Also drop `<meta http-equiv="refresh">`: without JS
  // it's the one remaining way for captured HTML to hijack the
  // preview (auto-navigate the iframe to an attacker URL).
  doc.querySelectorAll('script').forEach((s) => s.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
    if ((m.getAttribute('http-equiv') ?? '').toLowerCase() === 'refresh') {
      m.remove();
    }
  });
  doc.querySelectorAll('base').forEach((b) => b.remove());
  const base = doc.createElement('base');
  if (baseUrl) base.setAttribute('href', baseUrl);
  base.setAttribute('target', '_blank');
  // First child of <head> so it wins over anything later in the
  // document (e.g. a rogue <base> buried in the body).
  doc.head.insertBefore(base, doc.head.firstChild);
  // Force UTF-8 so non-ASCII captures (em dashes, curly quotes,
  // emoji, CJK) don't render as mojibake. Chrome falls back to
  // Windows-1252 on blob: documents lacking an explicit charset,
  // turning e.g. "—" (UTF-8 E2 80 94) into "â€”". Inject a
  // <meta charset> at the very top of <head> (before <base> so
  // the charset is locked in before any URL parsing).
  const existingCharsets = doc.head.querySelectorAll(
    'meta[charset], meta[http-equiv="Content-Type" i]',
  );
  existingCharsets.forEach((m) => m.remove());
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.insertBefore(meta, doc.head.firstChild);
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

// `marked` is loaded by `marked.umd.js` before this script and
// exposed as a page-scoped global. Declared (not imported) because
// the vendor bundle is a classic-script UMD that attaches to
// `window.marked` — there's no module entry point we could pull
// from npm cleanly without re-bundling. Loose typing because we
// only call `.parse` and don't want to install `@types/marked`
// (whose version we'd then have to keep pinned to the bundled
// runtime). marked 18's default `async: false` makes `.parse`
// return a string synchronously; if a future marked flips that
// default we must pass `{ async: false }` explicitly — calling
// `marked.parse()` without awaiting would otherwise return a
// Promise<string> and `buildPreviewHtml` would see "[object Promise]"
// in the preview.
declare const marked: { parse: (src: string) => string };

// `hljs` and `CodeJar` are loaded before this script (`highlight.min.js`
// and `codejar.js` respectively) and exposed as page-scoped globals.
// Declared (not imported) for the same reason as `marked`: both
// arrive as classic-script bundles attached to window — hljs as a
// CDN-flavored UMD, CodeJar as build.mjs's classic-script wrap of
// the upstream ESM. Loose typing because we only touch a tiny
// surface (hljs.highlight + the CodeJar factory / its three
// return members).
declare const hljs: {
  highlight(code: string, opts: { language: string; ignoreIllegals?: boolean }): {
    value: string;
  };
};
declare const CodeJar: (
  editor: HTMLElement,
  highlight: (editor: HTMLElement) => void,
  opt?: Record<string, unknown>,
) => {
  updateCode(code: string): void;
  toString(): string;
  destroy(): void;
};

/**
 * Map a dialog kind onto the highlight.js language name we pass to
 * `hljs.highlight`. HTML kinds use `xml` (hljs models HTML as XML),
 * Markdown uses `markdown`, and anything else falls back to
 * `plaintext` so the highlighter still runs (CodeJar requires a
 * callback) without colorizing anything.
 */
function hljsLanguageFor(kind: EditableArtifactKind): string {
  if (kind === 'html' || kind === 'selectionHtml') return 'xml';
  if (kind === 'selectionMarkdown') return 'markdown';
  return 'plaintext';
}

/**
 * Build the highlight callback CodeJar calls on every input. The
 * editor element's `textContent` is the current source; we rewrite
 * its innerHTML to the tokenized output from hljs so the
 * `<span class="hljs-*">` spans pick up styles from
 * `highlight-theme.css`. `ignoreIllegals: true` avoids hljs throwing
 * on partial / malformed input mid-typing; we always want a best-
 * effort colorization.
 */
function makeHighlighter(language: string): (editor: HTMLElement) => void {
  return (editor: HTMLElement) => {
    const code = editor.textContent ?? '';
    editor.innerHTML = hljs.highlight(code, {
      language,
      ignoreIllegals: true,
    }).value;
  };
}

/**
 * Render markdown source to an HTML string via `marked`. `marked`
 * does NOT sanitize — raw HTML inside the markdown flows through
 * untouched — so every caller must pipe the result through
 * `buildPreviewHtml`, which strips `<script>` / `<meta refresh>`
 * before the iframe load, and the iframe sandbox denies
 * `allow-scripts` as defense in depth.
 */
function renderMarkdown(md: string): string {
  return marked.parse(md);
}

function bindEditDialog(spec: EditKindSpec): void {
  const parts = createEditDialog(spec.domSlug, spec.title, spec.kind);
  editDialogs.push(parts.dialog);

  if (spec.preview) {
    parts.modeToggle.hidden = false;
    parts.editModeBtn.addEventListener('click', () => setMode('edit'));
    parts.previewModeBtn.addEventListener('click', () => setMode('preview'));
  }

  spec.openBtn.addEventListener('click', () => {
    parts.setCode(captured[spec.kind]);
    clearError();
    // Always open in Edit mode so the default action is direct editing.
    if (spec.preview) setMode('edit');
    parts.dialog.showModal();
    // Defer focus so showModal's own autofocus doesn't overwrite us.
    requestAnimationFrame(() => {
      parts.editor.focus();
      // Place the caret at the start — bodies are often long and
      // the user is most likely to want to search / scroll from the
      // top rather than land at the end. `setSelectionRange` doesn't
      // exist on contenteditable; collapse a Range to the first
      // offset in the editor instead, then scroll the element to the
      // top (collapsing alone won't re-scroll it).
      const range = document.createRange();
      range.selectNodeContents(parts.editor);
      range.collapse(true);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      parts.editor.scrollTop = 0;
    });
  });

  /**
   * Switch the dialog between Edit (editor visible) and Preview
   * (sandboxed iframe visible, rendering the current editor
   * source). Preview is best-effort rendering — browsers are
   * extremely tolerant of malformed HTML, and the sandbox + no
   * same-origin + no allow-scripts keeps any rendered content from
   * touching the parent page. `<base href>` is injected so relative
   * URLs resolve against the captured page; `<base target="_blank">`
   * plus `allow-popups` in the sandbox list opens link clicks as a
   * normal new tab instead of replacing the preview iframe.
   */
  // Blob URL currently bound to `previewIframe.src`. We revoke it
  // whenever we replace it (mode switch, dialog close) to release
  // the (potentially multi-MB) HTML body from memory.
  let previewBlobUrl: string | null = null;

  function setMode(mode: 'edit' | 'preview'): void {
    const isPreview = mode === 'preview';
    parts.editModeBtn.classList.toggle('selected', !isPreview);
    parts.previewModeBtn.classList.toggle('selected', isPreview);
    parts.editModeBtn.setAttribute('aria-pressed', String(!isPreview));
    parts.previewModeBtn.setAttribute('aria-pressed', String(isPreview));
    // Editor stays in the DOM in both modes so it (a) keeps its
    // user-resized height defining the slot and (b) can't reflow
    // the dialog when hidden. `visibility: hidden` hides it visually
    // but preserves layout; the iframe is positioned absolutely on
    // top via CSS.
    parts.editor.style.visibility = isPreview ? 'hidden' : '';
    parts.previewIframe.hidden = !isPreview;
    if (isPreview) {
      // Use a blob: URL rather than `srcdoc`. srcdoc is an HTML
      // attribute and hits a browser-dependent size limit that
      // silently drops large captured HTML, leaving the preview
      // blank. blob: URLs have no such limit and still load under
      // the iframe's sandbox (unique opaque origin).
      revokePreviewBlob();
      // Markdown kinds render via marked first; HTML kinds pass the
      // editor source verbatim into buildPreviewHtml. Either way,
      // the final string flows through the same sanitizer (strips
      // <script>, strips <meta http-equiv=refresh>, injects
      // <meta charset=utf-8> and <base target=_blank>).
      let htmlBody = parts.getCode();
      if (spec.preview === 'markdown') {
        htmlBody = renderMarkdown(htmlBody);
      }
      const html = buildPreviewHtml(htmlBody, capturedUrl);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      previewBlobUrl = URL.createObjectURL(blob);
      parts.previewIframe.src = previewBlobUrl;
    } else {
      revokePreviewBlob();
      parts.previewIframe.removeAttribute('src');
    }
  }

  function revokePreviewBlob(): void {
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      previewBlobUrl = null;
    }
  }

  // Release the blob when the dialog closes (via Save, Cancel, or
  // Escape) so we don't leak the captured HTML to memory until the
  // user reopens the dialog.
  parts.dialog.addEventListener('close', () => {
    revokePreviewBlob();
    parts.previewIframe.removeAttribute('src');
  });

  parts.cancelBtn.addEventListener('click', () => {
    parts.dialog.close();
  });

  parts.saveBtn.addEventListener('click', () => {
    void save();
  });

  parts.dialogDownloadBtn.addEventListener('click', () => {
    // Use the editor's current source — including any un-Saved edits
    // — so the user can export an experiment without first committing
    // it back to the SW.
    void downloadEditableAs(spec.kind, parts.getCode());
  });

  async function save(): Promise<void> {
    const newValue = parts.getCode();
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
  kind: 'screenshot' | EditableArtifactKind,
): Promise<void> {
  // Skip the bake + override when the SW will cache-hit. The cache
  // is keyed by `editVersion`, so if we already shipped this version
  // (and therefore the SW already has the matching file on disk),
  // there's no point baking a fresh image just for the SW to drop.
  const ev = getEditVersion();
  const needsBake =
    kind === 'screenshot' &&
    hasBakeableEdits() &&
    ev !== lastSentScreenshotEditVersion;
  const screenshotOverride = needsBake ? renderHighlightedImage() : undefined;
  const response = (await chrome.runtime.sendMessage({
    action: 'ensureDownloaded',
    kind,
    editVersion: ev,
    screenshotOverride,
  })) as { path?: string; error?: string } | undefined;
  if (!response || response.error || !response.path) {
    const detail = response?.error ?? 'no response from background';
    console.warn('[SeeWhatISee] copy filename failed:', detail);
    setStatusMessage(`Couldn't copy filename: ${detail}`, 'error');
    return;
  }
  if (kind === 'screenshot') lastSentScreenshotEditVersion = ev;
  await writeClipboardText(response.path);
}

captureBtn.addEventListener('click', (e) => {
  // Disable the button so double-clicks can't re-submit. We always
  // wait for the SW response now: the SW reports save errors back
  // through the message channel rather than the toolbar tooltip
  // (the page has a status slot right next to the buttons that
  // produced the error), so the page-side handler has to be there
  // to receive it. The SW closes this tab itself on a successful
  // close-after-save; on a failure it leaves the tab open so the
  // user can read the error and recover from the same preview.
  captureBtn.disabled = true;
  // Modifier semantics — same on both Capture and Ask buttons:
  //   - shift-click: do the action, keep the page open.
  //   - ctrl-click:  do the action, close the page after.
  //   - plain click: each button's default (Capture closes, Ask
  //     stays open), kept for muscle memory.
  // shift wins when both are held — leans toward the safer "don't
  // disappear the preview" outcome on ambiguous chords.
  const closeAfter = closeAfterFromModifiers(e, true);

  try {
    // Only bake edits into a fresh image when both apply: there's
    // something to bake, and the user is actually saving the image.
    // If the screenshot isn't being saved, the override would be
    // wasted bytes on the message channel. "Edits" here covers red
    // rects/lines, redactions, and the active crop — any of them
    // changes the pixels that end up on disk.
    const hasEdits = hasBakeableEdits();
    const bakeIn = hasEdits && screenshotBox.checked;
    const screenshotOverride = bakeIn ? renderHighlightedImage() : undefined;
    // Per-kind flags only matter when we're actually saving the
    // screenshot — they describe what's baked into the image, so
    // there's nothing for the SW to flag on a record that doesn't
    // include the image. `bakeIn` already folds both conditions in.
    const flags = bakeIn
      ? editFlags()
      : { hasHighlights: false, hasRedactions: false, isCropped: false };

    setStatusMessage('Saving…', 'info');
    void (async () => {
      let response: { ok?: boolean; error?: string } | undefined;
      try {
        response = (await chrome.runtime.sendMessage({
          action: 'saveDetails',
          screenshot: screenshotBox.checked,
          html: htmlBox.checked,
          selectionFormat: selectedSelectionFormat(),
          prompt: promptInput.value.trim(),
          highlights: flags.hasHighlights,
          hasRedactions: flags.hasRedactions,
          isCropped: flags.isCropped,
          editVersion: getEditVersion(),
          screenshotOverride,
          closeAfter,
        })) as { ok?: boolean; error?: string } | undefined;
      } catch (err) {
        // Channel-disconnect on a closeAfter=true save is normal
        // (the SW closes the tab and the response can race the
        // teardown). Surface the error only when we expected to
        // stay open — otherwise it's the expected "tab gone"
        // signal and the page is on its way out anyway.
        if (!closeAfter) {
          setStatusMessage(
            `Capture failed: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
          captureBtn.disabled = false;
        }
        return;
      }
      if (response?.ok) {
        // closeAfter=true → SW will close us in a moment. Showing
        // "Saved." briefly is fine; the message disappears with
        // the tab. closeAfter=false leaves the user reading it.
        setStatusMessage('Saved.', 'ok');
        if (!closeAfter) captureBtn.disabled = false;
      } else {
        setStatusMessage(response?.error ?? 'Capture failed.', 'error');
        captureBtn.disabled = false;
      }
    })();
  } catch (err) {
    // Synchronous failure (e.g. renderHighlightedImage / toDataURL
    // throwing). Re-enable so the user can retry, surface the
    // failure in the page status slot rather than the toolbar.
    console.warn('[SeeWhatISee] capture submit failed:', err);
    setStatusMessage(
      `Capture failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
    captureBtn.disabled = false;
  }
});

// Let the background script trigger the Capture button remotely
// (e.g. when the user clicks the toolbar icon while this page is
// already open).
chrome.runtime.onMessage.addListener((msg: { action: string }) => {
  // The message name predates the Capture/Ask default-button toggle
  // — keep the wire name but route through the helper so the SW's
  // hand-off respects the user's chosen default.
  if (msg.action === 'triggerCapture') {
    clickDefaultPageButton();
  }
});

// Initialise the submodules in dependency order:
//   drawing → zoom (zoom's applyZoom invokes drawing's render +
//   drawViewportEdges) → ask (independent).
// Drawing's `render()` callbacks (updateImageSizeBadge,
// composeImageBadgeText) are hoisted function declarations and
// available from this point regardless of source-order.
initDrawing({
  previewImg,
  imageBox,
  overlay,
  edgesSvg,
  shrinkBtn,
  undoBtn,
  clearBtn,
  toolButtons,
  updateImageSizeBadge,
  composeImageBadgeText,
});

initZoom({
  previewImg,
  imageBox,
  highlightControls,
  zoomBtn,
  render,
  drawViewportEdges,
  visibleImageRect,
  imgRect,
  isPolylineActive,
  endPolylineChain,
  anyEditDialogOpen,
  isStaleMode: () => staleMode,
  autoGrowPrompt,
});

initAsk({
  screenshotBox,
  htmlBox,
  promptInput,
  capturedTitleLink,
  captured,
  getCapturedUrl: () => capturedUrl,
  selectedSelectionFormat,
  setStatusMessage,
  renderHighlightedImage,
  bakeMime,
  bakeExt,
  closeAfterFromModifiers,
  applyDefaultButtonHighlight,
  setPromptEnter: (v) => { currentPromptEnter = v; },
  selectionWireKind: SELECTION_WIRE_KIND,
});

// Initial sizing: autoGrowPrompt sizes the textarea and then
// internally calls fitImage → applyZoom. That first applyZoom runs
// before the image has loaded (`naturalWidth`/`naturalHeight` are 0),
// which is harmless — `previewImg.addEventListener('load', applyZoom)`
// re-runs once the screenshot data URL has been decoded. We do this
// initial pass anyway so the page isn't flashing an unsized preview
// between layout and image-load.
autoGrowPrompt();
void loadData();

// Test hook: lets the drawing e2e spec inspect the edit stack and
// the effective crop without resorting to pixel-sampling tricks or
// fixture-content probes. Harmless in production: nothing reads
// `window.__seeState` at runtime, and it only surfaces values that
// we already ship back to the SW via `saveDetails` / the bake.
//
// Drawing-side state goes through `getTestHooks()` (single bundle
// from `drawing.ts`); zoom-side hooks (setZoom / displayScale / etc.)
// stay inline because the zoom module doesn't carry test-only state
// of its own.
{
  const hooks = getTestHooks();
  (window as unknown as { __seeState?: unknown }).__seeState = {
    effectiveCrop: () => {
      const c = activeCrop();
      return c ? { x: c.x, y: c.y, w: c.w, h: c.h } : null;
    },
    flags: () => editFlags(),
    editKinds: hooks.getEditKinds,
    // Zoom + sizing hooks for the zoom e2e: drives the dropdown
    // programmatically and reads back the derived ratio used for
    // stroke-width math. `applyZoom` is also exposed so a
    // DPR-stubbing test can re-trigger sizing after overriding
    // `window.devicePixelRatio` without going through `setZoom`
    // (saves the menu-check refresh + label rewrite, which would
    // be confusing telemetry on a same-mode "re-apply").
    setZoom: (m: ZoomMode) => setZoom(m),
    applyZoom: () => applyZoom(),
    displayScale: () => currentDisplayScale(),
    targetCssSize: () => targetCssSize(),
    // Bounds of the most-recent edit matching `kind` (used by the
    // Shrink e2e to assert that a click really did mutate geometry —
    // not just that the editKinds list is unchanged).
    lastRectBounds: hooks.getLastRectBounds,
    // Polyline-mode probe (used by the polyline e2e to assert that
    // the chain is alive between segments). Returns the active kind
    // ('line' / 'arrow') or null when polyline mode is off.
    polylineKind: hooks.getPolylineKind,
    // Chain-start anchor of the active polyline chain, in image-rect-
    // local CSS pixels (or null when no chain is active). Used by the
    // loop-close e2e to assert that a near-start click snaps to this
    // point. Doubles as a "chain is alive" boolean for the loop-stays-
    // alive-after-close test.
    polylineChainStart: hooks.getPolylineChainStart,
    // How the active chain was entered: 'ctrl' (Ctrl-promoted) or
    // 'tool' (Polyline / Poly-arrow tool button). Null when no chain
    // is active. Used by e2e tests to verify the Ctrl-release exit
    // semantics fire only for Ctrl-promoted chains.
    polylineEntry: hooks.getPolylineEntry,
    // Endpoints of the most-recent line / arrow edit (used by the
    // arrow-key-during-Line-draw test to assert that the in-flight
    // endpoint follows keyboard nudges).
    lastLineBounds: hooks.getLastLineBounds,
    // All line / arrow segments of the requested kind, in commit
    // order. Used by the polyline e2e to verify that successive
    // segments chain endpoint-to-endpoint while Ctrl is held.
    allLineBounds: hooks.getAllLineBounds,
    // Test-only setter that overwrites the most recent rect-shaped
    // edit's geometry. Used by the "Shrink never grows" regression
    // test to construct a precise partial-advance starting state
    // (e.g. tight on three edges, loose on one) that's hard to
    // reach via mouse drags alone. No production caller exists.
    setLastRectBounds: hooks.setLastRectBounds,
  };
}
