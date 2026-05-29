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
import { anyEditDialogOpen, initEditDialogs } from './capture-page/edit-dialog.js';
import { handleUploadFlow } from './capture-page/upload.js';
import {
  composeImageBadgeText,
  formatBytes,
  initPills,
  setScreenshotErrored,
  updateImageSizeBadge,
  updateSelectionSizeBadge,
} from './capture-page/pills.js';
import { downloadEditableAs, initSaveAs } from './capture-page/save-as.js';
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
  rescaleAfterImageResize,
  getDrawingSnapshot,
  restoreDrawingSnapshot,
  type Tool,
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
  /**
   * Restored UI state from a previous Capture-page session (saved by
   * the Restore last capture flow). Absent on a normal capture-page
   * open. When present, `loadData()` applies these on top of the
   * defaults — same checkboxes, same prompt text, same drawing
   * edits + undo stack, same selected tool. Zoom is deliberately
   * not carried; restore reverts to the page-init default (Fit).
   * Every field is optional so a partial push (e.g. close raced the
   * page's very first push) still restores what it can.
   */
  restoreUiState?: {
    prompt?: string;
    saveCheckboxes?: {
      screenshot: boolean;
      html: boolean;
      selection: boolean;
      format: SelectionFormat | null;
    };
    edits?: unknown[];
    editHistory?: unknown[];
    nextEditId?: number;
    editVersion?: number;
    selectedTool?: string;
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

/**
 * Render an SW-supplied capture-failure message into `el`, italicizing
 * the "Save" in the capture-directly hint's quoted "'Save' actions"
 * phrase — the quotes are dropped and the bare word becomes
 * `<em>Save</em>`. (The quotes are the plain-text emphasis used in the
 * native row tooltip, which can't render italics; rich text gets the
 * real thing here.) The `?error=` param is arbitrary text, so we build
 * the node tree from split segments + `<em>` rather than assigning
 * `innerHTML` — no markup is ever interpreted. The lookahead pins the
 * match to the hint phrase so a stray "Save" elsewhere in an error
 * string isn't touched.
 */
function renderCaptureFailedMessage(el: HTMLElement, message: string): void {
  el.textContent = '';
  // The delimiter `'Save'` (quotes included) is consumed by the split,
  // so the quotes drop out; the captured bare word lands at odd indices.
  const segments = message.split(/'(Save)'(?= actions\b)/);
  segments.forEach((seg, i) => {
    if (i % 2 === 1) {
      const em = document.createElement('em');
      em.textContent = seg;
      el.appendChild(em);
    } else if (seg) {
      el.appendChild(document.createTextNode(seg));
    }
  });
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

// ─── Image / HTML / Selection size pills ─────────────────────────
//
// The pill refreshers and `formatBytes` live in
// `capture-page/pills.ts`. `initPills(ctx)` is wired with the
// other submodule inits at the bottom of this file; the per-pill
// refreshers are imported above.
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
        await handleUploadFlow({
          onSessionReady: async () => {
            staleMode = false;
            await loadData();
          },
        });
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
        if (failMsg) renderCaptureFailedMessage(failMsg, errorParam);
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
      setScreenshotErrored(true);
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

    // Restore-last-capture: if the SW forwarded a UI snapshot from
    // a previous Capture-page session, overlay it on top of the
    // defaults we just applied. The defaults are the *baseline*
    // (so a checkbox the user toggled off in the previous session
    // overrides the default-on stored preference); the snapshot wins
    // wherever both speak. Pulled into `applyRestoredUiState` so
    // the per-field branches don't clutter `loadData`.
    if (response.restoreUiState) {
      applyRestoredUiState(response.restoreUiState);
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

// ─── Save as… ────────────────────────────────────────────────────
//
// Per-row Save-as buttons + the drawing-palette Copy-image and
// Save-image buttons live in `capture-page/save-as.ts`.
// `downloadEditableAs` is exported there so the in-dialog Download
// button in `edit-dialog.ts` shares the same path. `initSaveAs(ctx)`
// is wired with the other submodule inits at the bottom of this file.

// ─── Edit dialogs ─────────────────────────────────────────────────
//
// Catalog-driven Edit dialogs live in `capture-page/edit-dialog.ts`.
// `anyEditDialogOpen()` is re-exposed for the page-wide Alt-shortcut
// handler above; `initEditDialogs(ctx)` is wired with the other
// submodule inits at the bottom of this file.

// Kept in sync with the canonical declaration in
// `src/capture/types.ts` and the `EDITABLE_ARTIFACTS` dispatch table
// in `src/background.ts`. Inlined rather than `import type`'d for the
// same reason `SelectionFormat` is duplicated above: keeps the page's
// payload contract independent of the SW module. New editable kinds
// must be added to all three sites.
type EditableArtifactKind =
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

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
      // Flush any pending debounced last-capture push and wait for
      // the SW to merge it in. This is what guarantees the close-
      // path promote sees the freshest prompt / drawing state — a
      // bare fire-and-forget push would otherwise race the
      // saveDetails handler's promote step.
      await pushUiStateNow();
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
//   pills (no deps) → drawing (its render() ctx receives the pill
//   refreshers) → zoom (zoom's applyZoom invokes drawing's render +
//   drawViewportEdges) → ask + edit-dialog (independent).
initPills({
  imageSizeBadge,
  htmlSizeBadge,
  selectionSizeBadge,
  capturedPills,
  previewImg,
  selectionRows,
  captured,
  getDefaultSelectionFormat: () => defaultSelectionFormat,
  selectionWireKind: SELECTION_WIRE_KIND,
  getEditVersion,
  renderHighlightedImage,
  activeCrop,
  pctRectToPixels,
  getBoxDrag,
  getDragStart,
  getDragCurrent,
  getSelectedTool,
  imgRect,
});

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
  // Restorable state-changed: route through the debounced push so a
  // rapid undo / polyline burst still collapses to a single SW
  // write. Tool-button clicks aren't routed through this callback
  // (they don't bump `editVersion`); the `pagehide` flush picks up
  // a tool-only change on close.
  onEditCommit: pushUiStateDebounced,
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
  rescaleAfterImageResize,
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
  flushLastCapturePush: pushUiStateNow,
});

initSaveAs({
  downloadScreenshotBtn,
  downloadHtmlBtn,
  copyImageBtn,
  downloadImageBtn,
  selectionRows,
  captured,
  selectionWireKind: SELECTION_WIRE_KIND,
  renderHighlightedImage,
  bakeExt,
  setStatusMessage,
  formatClipboardError,
});

initEditDialogs({
  openBtns: {
    html: editHtmlBtn,
    selectionHtml: selectionRows.html.editBtn,
    selectionText: selectionRows.text.editBtn,
    selectionMarkdown: selectionRows.markdown.editBtn,
  },
  captured,
  getCapturedUrl: () => capturedUrl,
  htmlSizeBadge,
  updateSelectionSizeBadge,
  formatBytes,
  downloadEditableAs,
});

// ─── Last-capture push ────────────────────────────────────────────
//
// Best-effort: any time the user touches a piece of restorable state
// (prompt, save checkboxes / format radio, drawing edits, selected
// tool), push the current snapshot to the SW. The SW
// stores it on the per-tab Capture-page session, and the next close
// path (Capture button, Ask ctrl-click, manual tab close) promotes
// it to the `lastCapture` session-storage slot. The
// Restore last capture menu entry then rehydrates from that slot.
//
// Pushes are debounced (~350ms) so a rapid keystroke / drag burst
// only generates one SW write; a synchronous flush on `pagehide`
// covers the final close gap. `pushingDisabled` guards the
// debounce + pagehide handlers against firing during the restore
// phase (otherwise applying a restored snapshot would bounce the
// same values right back to the SW and clobber any in-flight
// state).

const PUSH_DEBOUNCE_MS = 350;
let pushDebounceTimer: number | null = null;
let pushingDisabled = false;

function captureUiStateSnapshot(): {
  prompt: string;
  saveCheckboxes: {
    screenshot: boolean;
    html: boolean;
    selection: boolean;
    format: SelectionFormat | null;
  };
  edits: unknown[];
  editHistory: unknown[];
  nextEditId: number;
  editVersion: number;
  selectedTool: string;
} {
  const drawing = getDrawingSnapshot();
  return {
    prompt: promptInput.value,
    saveCheckboxes: {
      screenshot: screenshotBox.checked,
      html: htmlBox.checked,
      selection: selectionBox.checked,
      format: selectedSelectionFormat(),
    },
    edits: drawing.edits,
    editHistory: drawing.editHistory,
    nextEditId: drawing.nextEditId,
    editVersion: drawing.editVersion,
    selectedTool: drawing.selectedTool,
  };
}

async function pushUiStateNow(): Promise<void> {
  if (pushingDisabled) return;
  // The SW's `pushUiState` handler responds once it has persisted
  // the merged state. Awaiting that response is what lets the
  // Capture / Ask pre-send flush guarantee the close-time promote
  // sees the freshest state — without the await, the two SW
  // handlers race. A SW-down / tab-closing rejection is benign;
  // swallowed so callers don't have to.
  try {
    await chrome.runtime.sendMessage({
      action: 'pushUiState',
      ui: captureUiStateSnapshot(),
    });
  } catch {
    // page closing / SW down — best-effort
  }
}

function pushUiStateDebounced(): void {
  if (pushingDisabled) return;
  if (pushDebounceTimer !== null) window.clearTimeout(pushDebounceTimer);
  pushDebounceTimer = window.setTimeout(() => {
    pushDebounceTimer = null;
    void pushUiStateNow();
  }, PUSH_DEBOUNCE_MS);
}

// Wire push triggers:
//   - Prompt typing: debounced so a multi-keystroke burst collapses
//     to one push.
//   - Save-checkbox / format-radio toggles: immediate — they're
//     discrete user gestures, no benefit to coalescing.
//   - Drawing edits, undo / clear / shrink, edge-handle resize, tool
//     button click: routed through the drawing module's
//     `onEditCommit` callback (see initDrawing wiring below). Debounced
//     because rapid undo presses or a long polyline chain could
//     otherwise flood the SW.
//   - Page hide: synchronous flush so the final close picks up any
//     state still inside the debounce window.
promptInput.addEventListener('input', pushUiStateDebounced);
screenshotBox.addEventListener('change', () => { void pushUiStateNow(); });
htmlBox.addEventListener('change', () => { void pushUiStateNow(); });
selectionBox.addEventListener('change', () => { void pushUiStateNow(); });
for (const format of SELECTION_FORMATS) {
  selectionRows[format].radio.addEventListener('change', () => { void pushUiStateNow(); });
}
// `pagehide` fires on tab close, navigation, and reload alike.
// The push is fire-and-forget here — the SW may or may not finish
// processing before the tab vanishes. `tabs.onRemoved` promotes
// from whatever session state did land, as a safety net.
window.addEventListener('pagehide', () => { void pushUiStateNow(); });

/**
 * Apply a previously-pushed UI snapshot to the live page. Wires
 * the prompt, save-checkbox + format-radio state, and the drawing
 * edit stack + undo history + selected tool. Zoom is deliberately
 * not restored — see the inline comment in the body. Guards
 * `pushingDisabled` so the per-checkbox / radio listeners above
 * don't fire pushes that would bounce the same values right back
 * to the SW while we're still painting.
 *
 * Best-effort field-by-field: each branch checks for presence so
 * an older / partial push (closed before the page sent everything)
 * restores whatever it can without throwing.
 */
function applyRestoredUiState(
  state: NonNullable<DetailsData['restoreUiState']>,
): void {
  // Suppress pushes while we paint, and drop any pending debounce
  // so a previously-scheduled push (impossible today since restore
  // runs inside loadData's first paint, but cheap belt-and-suspenders)
  // can't fire between the body of this function and `finally`.
  pushingDisabled = true;
  if (pushDebounceTimer !== null) {
    window.clearTimeout(pushDebounceTimer);
    pushDebounceTimer = null;
  }
  try {
    if (typeof state.prompt === 'string') {
      promptInput.value = state.prompt;
      autoGrowPrompt();
    }
    if (state.saveCheckboxes) {
      const cb = state.saveCheckboxes;
      if (!screenshotBox.disabled) screenshotBox.checked = cb.screenshot;
      if (!htmlBox.disabled) htmlBox.checked = cb.html;
      if (!selectionBox.disabled) {
        selectionBox.checked = cb.selection;
        // Apply format radio when the master is on and the saved
        // format is still saveable on this capture. Two skip
        // branches both land on the default-set radio above (lines
        // 906-911) being the user's effective format:
        //   - `cb.selection && cb.format` but `row.radio.disabled`
        //     — the saved format isn't available on this restored
        //     body (e.g. text format was empty so its row is off).
        //   - `cb.selection && !cb.format` — master was on but no
        //     format pinned (shouldn't happen today; defensive).
        // The `!cb.selection` branch clears every radio to match
        // a master-off close.
        if (cb.selection && cb.format) {
          const row = selectionRows[cb.format];
          if (!row.radio.disabled) {
            for (const f of SELECTION_FORMATS) {
              selectionRows[f].radio.checked = f === cb.format;
            }
            defaultSelectionFormat = cb.format;
          }
        } else if (!cb.selection) {
          for (const f of SELECTION_FORMATS) {
            selectionRows[f].radio.checked = false;
          }
        }
      }
    }
    // The page always pushes a full drawing snapshot, so we just
    // forward the fields verbatim — `restoreDrawingSnapshot` skips
    // each absent one. The `as never` casts trust the SW-stored
    // shape (structured-clone preserves it across the
    // `chrome.storage.session` round-trip); a hand-crafted
    // malformed value would land garbage on the edit stack, but
    // there's no path that produces one today.
    restoreDrawingSnapshot({
      edits: state.edits as never,
      editHistory: state.editHistory as never,
      nextEditId: state.nextEditId,
      editVersion: state.editVersion,
      selectedTool: state.selectedTool as Tool | undefined,
    });
    // Zoom mode is deliberately not restored — viewport size and
    // scroll position aren't snapshotted either, so reapplying a
    // saved zoom against a possibly-different window would land at
    // an arbitrary sizing. Fit (the page-init default) is the only
    // value that's guaranteed sensible regardless of context.

    // Refresh the Selection-size badge after restoring the checkbox /
    // radio state; programmatic `.checked` assignments don't fire
    // `change`.
    updateSelectionSizeBadge();
  } finally {
    pushingDisabled = false;
  }
}

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
