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

import { htmlToMarkdown, looksLikeMarkdownSource } from './markdown.js';
import { excludedSuffix } from './url-helpers.js';
import type { AskProviderId } from './background/ask/providers.js';

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
const htmlSizeBadge = document.getElementById('html-size-badge') as HTMLSpanElement;
const selectionSizeBadge = document.getElementById('selection-size-badge') as HTMLSpanElement;
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
    return;
  }
  const body = captured[SELECTION_WIRE_KIND[format]];
  selectionSizeBadge.hidden = false;
  selectionSizeBadge.textContent = `Selection · ${formatBytes(new Blob([body]).size)}`;
}
// `getElementById` returns `HTMLElement | null`. SVG elements are
// `SVGElement`, which sits on a sibling branch of the DOM type
// hierarchy — TypeScript won't let us cast directly across the
// branches without a `unknown` bridge.
const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;
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

// ─── Rich-text paste handling ────────────────────────────────────
//
// `attachHtmlAwarePaste` wires a paste listener that inspects
// `clipboardData` and chooses an insertion based on the `mode`:
//
//   - `'asMarkdown'`   — run `text/html` through `htmlToMarkdown`
//                        and insert the markdown projection. Used by
//                        the prompt textarea and the
//                        Selection-markdown edit dialog so a paste
//                        from a rendered web page lands as nicely-
//                        formatted markdown rather than the
//                        browser's flat `text/plain` fallback.
//   - `'asHtmlSource'` — insert the `text/html` clipboard string
//                        verbatim (after stripping Chrome's
//                        StartFragment / EndFragment wrappers and
//                        any leading `<meta>` cruft). Used by the
//                        Page-HTML and Selection-HTML edit dialogs
//                        so the user gets the actual source of what
//                        they copied, not its visible-text shadow.
//
// "Paste as plain text" (Ctrl+Shift+V from the OS / browser context
// menu) is handled implicitly: Chrome strips formatting *before*
// firing the paste event, so `clipboardData` only carries
// `text/plain` and we fall through to the default paste path. There
// is no modifier flag on the ClipboardEvent itself — `text/html`
// presence is the only signal Chrome surfaces — but it's enough to
// route the two paste modes onto the two outputs the user wants.
type HtmlPasteMode = 'asMarkdown' | 'asHtmlSource';

/**
 * Normalize a `text/html` clipboard payload into the kind of markup
 * the selection-capture path produces: the user's original tags,
 * without the browser's render-time cruft.
 *
 * Browsers serialize rendered HTML to the clipboard with extras the
 * source page didn't have:
 *   - `<!--StartFragment-->` … `<!--EndFragment-->` wrappers around
 *     the actual fragment, plus a leading `<meta charset=…>` and
 *     `<html><body>` shell. We extract just the fragment.
 *   - Inline `style="…"` attributes on every styled element,
 *     populated from the page's *computed* styles. We strip them so
 *     the paste matches `scrape-page-state.ts`'s outerHTML reading
 *     (which never sees computed styles).
 *   - Bare `<span>` wrappers with no attributes that browsers
 *     synthesize around whitespace runs and similar transient
 *     boundaries during the copy serialization. We unwrap them.
 *
 * We deliberately preserve `class`, `href`, `dir`, `id`, and other
 * source-authored attributes. Only the additions browsers introduce
 * during the copy are removed. `htmlToMarkdown` already ignores
 * styles and bare spans, so the `'asMarkdown'` path doesn't strictly
 * need the second-pass cleanup — but running it uniformly means both
 * paste modes see the same input and behave consistently.
 */
function cleanCopiedHtml(html: string): string {
  const startMarker = '<!--StartFragment-->';
  const endMarker = '<!--EndFragment-->';
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  let body = (start !== -1 && end !== -1 && end > start)
    ? html.slice(start + startMarker.length, end)
    : html;
  body = body.trim();
  if (!body) return '';

  // Parse in `text/html` mode (forgiving of malformed input). The
  // resulting Document is detached, so embedded `<script>` won't run
  // and `<img>` won't fetch — though the markup paths we care about
  // here are inert anyway.
  const doc = new DOMParser().parseFromString(body, 'text/html');
  doc.body.querySelectorAll('[style]').forEach((el) => el.removeAttribute('style'));
  // Unwrap bare `<span>`s — `replaceWith(...childNodes)` splices the
  // children into the parent in the span's place and drops the span.
  doc.body.querySelectorAll('span').forEach((span) => {
    if (span.attributes.length === 0) {
      span.replaceWith(...Array.from(span.childNodes));
    }
  });
  // Normalize non-breaking spaces (`\u00A0`) back to regular spaces.
  // Browsers sprinkle nbsp into clipboard `text/html` to preserve
  // visible whitespace runs in paste targets that would otherwise
  // collapse them — Word, Gmail, etc. In our editors those nbsps
  // become non-breaking and constrain line wrapping at every gap
  // the source happened to render with extra space. We almost never
  // want that intent preserved across a copy; regular spaces flow
  // and wrap as expected. innerHTML serialization re-encodes
  // `\u00A0` → `&nbsp;`, so this also keeps the entity out of the
  // asHtmlSource paste path.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue && n.nodeValue.indexOf('\u00A0') !== -1) {
      n.nodeValue = n.nodeValue.replace(/\u00A0/g, ' ');
    }
  }
  return doc.body.innerHTML.trim();
}

/**
 * Insert `text` at the current caret in either a textarea or a
 * contenteditable element, replacing any active selection.
 *
 * Textareas: `setRangeText` (silent — no events fire on their own)
 * plus a synthetic `input` so listeners that watch `input` (e.g.
 * the prompt's autosize) re-run.
 *
 * Contenteditables: insert a single text node directly via the
 * Range API, then dispatch `keyup` so CodeJar's debounced
 * highlighter re-runs. The text-node path keeps `\n` as literal
 * text-node whitespace (`white-space: pre-wrap` renders newlines,
 * `textContent` reads them back unchanged) — `execCommand
 * ('insertText', …)` would convert each `\n` to a `<br>` element,
 * which CodeJar's `textContent`-based source view would silently
 * skip and the next highlight pass would collapse blank lines.
 */
function insertAtCaret(el: HTMLTextAreaElement | HTMLElement, text: string): void {
  if (el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const node = document.createTextNode(text);
  if (range && el.contains(range.commonAncestorContainer)) {
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel!.removeAllRanges();
    sel!.addRange(range);
  } else {
    el.appendChild(node);
  }
  // CodeJar's highlight pipeline runs on `keyup`; firing one tells
  // it to re-tokenize. `prev` (CodeJar's pre-keystroke snapshot) is
  // captured on keydown — without one, it remains stale and the
  // `prev !== toString()` guard inside CodeJar's keyup handler
  // fires, triggering `debounceHighlight`. The `restore(save())`
  // pair around the highlight preserves our caret position.
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

/**
 * Heuristic: is `text/plain` already source in the format the
 * editor wants, with `text/html` just a rendered view of it?
 *
 * Two signals, in order of confidence (first match wins):
 *
 *   1. **Syntax-highlighter token classes** in `text/html` —
 *      `hljs`, `token`, `language-`, `cm-`, `mtk`. When these
 *      appear we *know* the html is just a styled rendering: the
 *      DOM is a tree of decorative spans (highlight.js, Prism,
 *      CodeMirror, Monaco, Shiki, …) and `text/plain` is the
 *      source the user was viewing. Strongest signal — checked
 *      first, cheapest regex.
 *
 *   2. **Mode-specific content match** on `text/plain`:
 *      - `'asMarkdown'`: `looksLikeMarkdownSource` (the same
 *        detector `selectionMarkdownBody` uses) — html has no
 *        markdown-output block tags AND text has any markdown
 *        signal (heading, bullet, fence, emphasis, link).
 *      - `'asHtmlSource'`: tag-shaped pattern in text — `</tag>`,
 *        `<tag>` / `<tag/>`, `<tag attr=…>`, `<!DOCTYPE…>`, or
 *        `<!--…-->`. Bare-boolean-attr shapes (`<b and c>`) are
 *        deliberately rejected — they're indistinguishable from
 *        math prose like `if a<b and c>d`.
 *
 * Tradeoff on signal #1: the broader class names (`token`,
 * `language-`, `cm-`) can false-positive on pages that use them
 * for non-syntax purposes (UI tokens, multilingual paragraphs
 * with `class="language-fr"`, utility classes prefixed `cm-`).
 * The cost when that fires: pasting visible text instead of
 * structured markdown — a graceful failure mode, since
 * `text/plain` is still what the user *saw*. Ctrl+Shift+V is the
 * escape hatch.
 */
function shouldPasteAsText(
  html: string,
  text: string,
  mode: HtmlPasteMode,
): boolean {
  if (!text) return false;
  // 1. Highlighter classes — strongest signal. Token-class prefixes:
  //    hljs       → highlight.js
  //    token      → Prism.js
  //    language-  → Prism + many other code-block outputs
  //    cm-        → CodeMirror token classes
  //    mtk        → Monaco token classes (`mtk1`, `mtk2`, …)
  if (/\bclass=["'](?:hljs|token|language-|cm-|mtk)/.test(html)) return true;
  // 2. Mode-specific content fallback.
  if (mode === 'asMarkdown') {
    return looksLikeMarkdownSource(html, text);
  }
  // 'asHtmlSource' — tag-shaped patterns in text/plain.
  return (
    /<\/[a-zA-Z][a-zA-Z0-9]*\s*>/.test(text) ||
    /<[a-zA-Z][a-zA-Z0-9]*\s*\/?>/.test(text) ||
    /<[a-zA-Z][a-zA-Z0-9]*\s+[a-zA-Z][a-zA-Z0-9-]*=/.test(text) ||
    /<!(?:DOCTYPE\s|--)/.test(text)
  );
}

function attachHtmlAwarePaste(
  el: HTMLTextAreaElement | HTMLElement,
  mode: HtmlPasteMode,
): void {
  el.addEventListener('paste', (e) => {
    const cd = (e as ClipboardEvent).clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    if (!html) return;
    const text = cd.getData('text/plain');
    // Source-view round-trip: when text/plain is already source in
    // the editor's target format, insert it verbatim. The html-side
    // paths would otherwise escape stray `*`/`<`/`>` characters
    // ("**bold**" → "\*\*bold\*\*", "<h1>" → entity-escaped spans).
    if (shouldPasteAsText(html, text, mode)) {
      e.preventDefault();
      insertAtCaret(el, text);
      return;
    }
    const cleaned = cleanCopiedHtml(html);
    if (!cleaned) return;
    const toInsert = mode === 'asMarkdown'
      ? htmlToMarkdown(cleaned).trim()
      : cleaned;
    if (!toInsert) return;
    e.preventDefault();
    insertAtCaret(el, toInsert);
  });
}

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
    if (askBtn.disabled) return;
    e.preventDefault();
    askBtn.click();
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

// ─── Highlight overlay ────────────────────────────────────────────
//
// Drawing is *modal*: one of the tool buttons (Box / Line / Arrow /
// Crop / Redact) is selected at a time, and a left-button drag on the
// overlay produces an edit of that kind:
//
//   - Box     — red stroked rectangle (highlights a region).
//   - Line    — red diagonal line.
//   - Arrow   — red line with a barbed arrowhead at the click-release
//     end; barbs scale with segment length up to a fixed cap.
//   - Crop    — drag paints the live cropped preview (dim frame
//     outside the drag bounds, dashed border, corner grips), so the
//     user sees what the cropped result will look like. Commits as
//     a crop region on mouseup; the saved PNG is shrunk to the
//     crop. Multiple crops stack; the most-recent active one wins.
//   - Redact  — drag paints a filled black rectangle live, matching
//     the committed appearance — opaque black box that hides
//     whatever was underneath in the saved PNG.
//
// There's no right-click drawing. There's no in-place conversion
// between kinds: every drag commits one new edit of the active
// tool's kind, and Undo simply removes the last edit (Clear wipes
// the stack). Coordinates are percentages of the image so edits
// survive resizes and prompt growth.
//
// Crop-edge handles work alongside the tool palette: the four edges
// and four corners of the *effective* crop region (the active crop
// if one exists, else the full image) are draggable. With no active
// crop, dragging an image edge inward creates a crop from scratch;
// with one, dragging the crop edges resizes it. The HANDLE_PX hit
// band wins over the selected tool, so a Box drag that starts in
// the band starts a crop-handle drag instead of a Box draw.

type Point = { x: number; y: number };
type RectKind = 'rect' | 'redact' | 'crop';
type LineKind = 'line' | 'arrow';
type Tool = RectKind | LineKind;
interface RectEdit {
  id: number;
  kind: RectKind;
  x: number; y: number; w: number; h: number;
}
interface LineEdit {
  id: number;
  kind: LineKind;
  x1: number; y1: number; x2: number; y2: number;
}
type Edit = RectEdit | LineEdit;

// History is an append-only log of edit additions — Undo pops the
// most recent and removes the matching edit. The only op is "add",
// so the entry is just the edit's id.
type HistoryOp = { id: number };

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

// ─── Crop-drag state ──────────────────────────────────────────────
//
// Each of the four edges and four corners of the image (or the
// active crop, when one exists) is a draggable handle. The user can
// drag inward to create a crop from scratch or to resize an existing
// one. Every completed drag commits a new 'crop' edit on the stack,
// so it participates in Undo / Clear and resizes nest naturally
// without mutating prior stack entries.
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
// grab the handles on the next drag). 1.5% picks up ~9 px on a
// 600 px preview — enough room to click on without being a wasted
// constraint.
const MIN_CROP_PCT = 1.5;

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

// Arrowhead barbs scale with the segment length so a tiny arrow keeps
// a proportional head, but cap so a very long arrow doesn't grow a
// disproportionately large head. ARROW_HEAD_RATIO is the barb length
// as a fraction of the segment length; ARROW_HEAD_MAX_PX caps it.
// ARROW_HEAD_ANGLE is the angle each barb makes against the reverse
// line direction.
const ARROW_HEAD_RATIO = 0.25;
const ARROW_HEAD_MAX_PX = 18;
const ARROW_HEAD_ANGLE = (28 * Math.PI) / 180;

// Compute the two barb endpoints for an arrowhead at (x2,y2) on the
// segment from (x1,y1)→(x2,y2). Returned in the same coordinate
// system as the inputs. `maxHeadPx` caps the barb length in those
// same units — overlay calls leave it at the default (CSS-pixel
// cap); the bake-in path passes a scaled cap so the natural-pixel
// arrowhead matches the displayed proportion.
function arrowBarbs(
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
// nothing — appends `<line>` shapes to `overlay`.
function appendArrow(
  x1: number, y1: number, x2: number, y2: number,
): void {
  overlay.appendChild(makeLine(x1, y1, x2, y2));
  const b = arrowBarbs(x1, y1, x2, y2);
  if (!b) return;
  overlay.appendChild(makeLine(b.ax, b.ay, x2, y2));
  overlay.appendChild(makeLine(b.bx, b.by, x2, y2));
}

function render(): void {
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  const r = imgRect();
  const w = r.width;
  const h = r.height;

  for (const e of edits) {
    if (e.kind === 'line' || e.kind === 'arrow') {
      const ax1 = (e.x1 / 100) * w;
      const ay1 = (e.y1 / 100) * h;
      const ax2 = (e.x2 / 100) * w;
      const ay2 = (e.y2 / 100) * h;
      if (e.kind === 'arrow') {
        appendArrow(ax1, ay1, ax2, ay2);
      } else {
        overlay.appendChild(makeLine(ax1, ay1, ax2, ay2));
      }
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

  // Render the crop as the drag preview if a crop drag is in
  // progress (either a Crop-tool *creation* drag or a handle
  // *resize* drag), else the committed active crop, else nothing.
  // All three states share the same visual (dim surround + dashed
  // border + corner grips), so the user sees the final cropped
  // result live while dragging — including a Crop-tool create
  // drag, where the dim frame appears under the bounds the user
  // is currently dragging.
  let cropPreview:
    | { x: number; y: number; w: number; h: number }
    | undefined;
  if (selectedTool === 'crop' && dragStart && dragCurrent) {
    const r = imgRect();
    cropPreview = {
      x: (Math.min(dragStart.x, dragCurrent.x) / r.width) * 100,
      y: (Math.min(dragStart.y, dragCurrent.y) / r.height) * 100,
      w: (Math.abs(dragCurrent.x - dragStart.x) / r.width) * 100,
      h: (Math.abs(dragCurrent.y - dragStart.y) / r.height) * 100,
    };
  } else if (cropDrag) {
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
  }

  // Small square grips at the four corners of the effective crop
  // region (the cropPreview if a drag is in flight, the active crop
  // if one exists, else the image's own corners). Drawn even with
  // no crop so the image hints that its edges are draggable —
  // without them the edge hit band is invisible. White fill with a
  // 1px dark outline so they read on both light and dark
  // backgrounds. Grips render centered on the corner and may extend
  // past the image edge — `#overlay` is `overflow: visible` so the
  // square is fully drawn even at a boundary corner.
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
      overlay.appendChild(g);
    }
  }

  if (dragStart && dragCurrent) {
    if (selectedTool === 'line') {
      overlay.appendChild(makeLine(
        dragStart.x, dragStart.y, dragCurrent.x, dragCurrent.y,
      ));
    } else if (selectedTool === 'arrow') {
      appendArrow(
        dragStart.x, dragStart.y, dragCurrent.x, dragCurrent.y,
      );
    } else if (selectedTool === 'rect' || selectedTool === 'redact') {
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
        overlay.appendChild(makeStrokedRect(x, y, dw, dh, 'red'));
      } else {
        overlay.appendChild(makeFilledRect(x, y, dw, dh, 'black'));
      }
    }
  }

  const hasEditHistory = editHistory.length > 0;
  undoBtn.disabled = !hasEditHistory;
  clearBtn.disabled = !hasEditHistory;
}

overlay.addEventListener('mousedown', (e) => {
  const me = e as MouseEvent;
  // Left button only — there's no right-click drawing in the new
  // tool model. The browser will surface the right-button context
  // menu untouched.
  if (me.button !== 0) return;
  // A drag is already in flight. Ignore so the state machine can't
  // end up with both `cropDrag` and `dragStart` non-null at the
  // same time.
  if (cropDrag !== null || dragStart !== null) return;
  const p = localCoords(me);
  // Crop-handle drag wins over the selected tool. Hit-test runs
  // against the *effective* crop region — the active crop if one
  // exists, else the full image — so dragging an image edge inward
  // creates a crop from scratch. A drag elsewhere in the overlay
  // commits an edit of the selected tool's kind (below).
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
  me.preventDefault();
  dragStart = p;
  dragCurrent = dragStart;
  // Reset any idle-hover resize cursor — we're committing to a
  // tool-driven draw from this spot, and the resize cursor would
  // mislead the user if they started right on a handle.
  overlay.style.cursor = 'crosshair';
  render();
});

// Idle-hover cursor feedback. The hit-test matches the mousedown
// path's, so the user gets a resize cursor before committing — on
// the active crop's edges if one exists, or the image edges (for
// "drag here to start cropping") if none.
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
      editHistory.push({ id });
      editVersion++;
    }
    cropDrag = null;
    overlay.style.cursor = 'crosshair';
    render();
    return;
  }

  if (dragStart === null) return;
  // Left button only matches the mousedown gate.
  if (e.button !== 0) return;
  const end = localCoords(e);
  const r = imgRect();
  const dx = end.x - dragStart.x;
  const dy = end.y - dragStart.y;
  const moved = Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX;
  // Real movement required — a bare click shouldn't push a
  // degenerate zero-size shape.
  let pending: Edit | null = null;
  if (moved) {
    const id = nextEditId;
    if (selectedTool === 'line' || selectedTool === 'arrow') {
      pending = {
        id,
        kind: selectedTool,
        x1: (dragStart.x / r.width) * 100,
        y1: (dragStart.y / r.height) * 100,
        x2: (end.x / r.width) * 100,
        y2: (end.y / r.height) * 100,
      };
    } else {
      const x = Math.min(dragStart.x, end.x);
      const y = Math.min(dragStart.y, end.y);
      const wPct = (Math.abs(dx) / r.width) * 100;
      const hPct = (Math.abs(dy) / r.height) * 100;
      // Crop needs each side ≥ MIN_CROP_PCT so the resulting crop's
      // edge handles stay grabbable. The handle-resize path enforces
      // this between opposing edges; the create path has to enforce
      // it at commit time too — a diagonal CLICK_THRESHOLD_PX drag
      // would otherwise commit a sub-1% crop that can't be re-grabbed.
      const tooSmall = selectedTool === 'crop' && (wPct < MIN_CROP_PCT || hPct < MIN_CROP_PCT);
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
  dragStart = null;
  dragCurrent = null;
  render();
});

undoBtn.addEventListener('click', () => {
  const last = editHistory.pop();
  if (!last) return;
  const idx = edits.findIndex((e) => e.id === last.id);
  if (idx >= 0) edits.splice(idx, 1);
  editVersion++;
  render();
});

clearBtn.addEventListener('click', () => {
  edits.length = 0;
  editHistory.length = 0;
  editVersion++;
  render();
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

// Tool selection. Each `.tool-btn` carries `data-tool` matching one
// of `Tool`'s string values. Clicking a button updates `selectedTool`
// and toggles the `.selected` / `aria-pressed` state across the
// whole group so exactly one is pushed-down at a time.
function setSelectedTool(tool: Tool): void {
  selectedTool = tool;
  for (const btn of toolButtons) {
    const isMine = btn.dataset.tool === tool;
    btn.classList.toggle('selected', isMine);
    btn.setAttribute('aria-pressed', isMine ? 'true' : 'false');
  }
}
for (const btn of toolButtons) {
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
      // the click affordance (cursor + pointer-events), overrides the
      // URL row's blue back to #222 so the text reads as plain text,
      // and hides the trailing external-link glyph since there's
      // nowhere to navigate.
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
    }

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

// Page-card Copy URL button — copies the captured URL string itself
// (not a filename or a download path), separate from the per-artifact
// Copy buttons which materialize a file and copy its absolute path.
copyUrlBtn.addEventListener('click', () => {
  if (!capturedUrl) return;
  void navigator.clipboard.writeText(capturedUrl);
});

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

// ─── Download (Save as…) buttons ──────────────────────────────────
//
// Each row's download button opens a native save dialog seeded with a
// generic default filename (`screenshot.png`, `contents.html`,
// `selection.{html,txt,md}`) under the user's default download
// directory. The bytes written reflect the *current* edited state:
//   - Screenshot: the highlighted/cropped PNG via `renderHighlightedPng`
//     when there are bake-able edits, else the original capture.
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
  // `renderHighlightedPng` short-circuits to the original
  // `previewImg.src` data URL when no edits need baking, so the
  // bytes here are always either the original captureVisibleTab
  // output or a freshly-baked render — never a re-fetch from the
  // source page. The `fetch()` call is on the data URL (local
  // base64 decode), not a network request.
  const url = renderHighlightedPng();
  try {
    const blob = await (await fetch(url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch (err) {
    console.warn('[SeeWhatISee] copy image to clipboard failed:', err);
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
    // `renderHighlightedPng` short-circuits to the original capture's
    // data URL when no edits need baking — see its docstring.
    const url = renderHighlightedPng();
    // Screenshot is a data: URL — nothing to revoke. The other kinds
    // use blob URLs (built from the editable body) and route through
    // `downloadEditableAs`, which handles its own revocation.
    await runSaveAsDialog(url, 'screenshot.png', null);
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
//
// Short-circuits to `previewImg.src` (the original captureVisibleTab
// data URL) when there are no bake-able edits — same pixels, but
// avoids the 30–100ms canvas re-encode AND preserves byte identity
// with the original capture. Callers can therefore always invoke
// this without first guarding on `hasBakeableEdits()`.
function renderHighlightedPng(): string {
  if (!hasBakeableEdits()) return previewImg.src;
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
    if (e.kind === 'line' || e.kind === 'arrow') {
      const x1 = (e.x1 / 100) * natW - sx;
      const y1 = (e.y1 / 100) * natH - sy;
      const x2 = (e.x2 / 100) * natW - sx;
      const y2 = (e.y2 / 100) * natH - sy;
      ctx.strokeStyle = 'red';
      ctx.lineWidth = strokePx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      if (e.kind === 'arrow') {
        const b = arrowBarbs(x1, y1, x2, y2, ARROW_HEAD_MAX_PX * scale);
        if (b) {
          ctx.moveTo(b.ax, b.ay);
          ctx.lineTo(x2, y2);
          ctx.lineTo(b.bx, b.by);
        }
      }
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
// independently. Each tool-kind flips its own flag: Box-tool boxes,
// Line-tool lines, and Arrow-tool arrows all count as `hasHighlights`;
// redactions and crops are separate kinds and flip `hasRedactions` /
// `isCropped`.
//
// `isCropped` uses `activeCrop()` (not "any crop edit in the stack")
// so a crop that's been dragged back out to the full image reports
// as *not cropped* — the saved PNG matches the original, so the
// flag would mislead downstream consumers.
function editFlags(): { hasHighlights: boolean; hasRedactions: boolean; isCropped: boolean } {
  let hasHighlights = false;
  let hasRedactions = false;
  for (const e of edits) {
    if (e.kind === 'rect' || e.kind === 'line' || e.kind === 'arrow') hasHighlights = true;
    else if (e.kind === 'redact') hasRedactions = true;
  }
  return { hasHighlights, hasRedactions, isCropped: activeCrop() !== undefined };
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
          editVersion,
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
    // Synchronous failure (e.g. renderHighlightedPng / toDataURL
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

// ─── Ask flow ─────────────────────────────────────────────────────
//
// Horizontal Ask button row (`.button-row`, wraps to multiple
// lines on a narrow viewport). Three button kinds, in source
// order after `#capture`:
//   - `#ask-btn`   ("Ask <provider>") resolves the default
//                    destination via the SW (pinned tab if alive,
//                    else preferred-new-tab provider, else the
//                    user's Options-page default) and sends to
//                    it. Carries Alt+A. Sits inside `.ask-split`
//                    paired with #ask-menu-btn — they share a
//                    visual chrome (split button).
//   - `#ask-menu-btn` chevron-only sliver attached to #ask-btn.
//                    Opens the destination-picker menu. Picking
//                    a row updates the default (pin / preferred
//                    new-tab provider) and refreshes the labels —
//                    does NOT send.
//   - `.ask-provider-btn` favicon-only squares appended into
//                    `.button-row` by `refreshAskTargetLabel`,
//                    one per enabled provider. Each click sends
//                    straight to a new tab on that provider —
//                    quick override that doesn't first walk
//                    through the menu's "set default"
//                    intermediate. Identified by the bundled
//                    brand logo (`AskProvider.iconFilename` →
//                    `chrome.runtime.getURL('icons/<file>')`).
//
// Every button kind honours the shift/ctrl modifier semantics:
// shift-click keeps the page open, ctrl-click closes it on success
// (Ask-side close leaves focus on the destination provider tab).
//
// The payload is built from the Capture-page state the Capture
// button reads. The SW handles tab focus + script injection, and
// pins the chosen destination on every successful send so the next
// plain-Ask reuses the same tab.

interface AskTabSummary {
  tabId: number;
  title: string;
  url: string;
  /** Tab is on the provider's host but on a non-chat page (settings,
   *  library, recents, etc.) — rendered disabled with a "(Wrong
   *  page)" suffix. */
  excluded?: boolean;
  /** URL-aware accepted-kinds list. `undefined` = no restriction. */
  acceptedAttachmentKinds?: ('image' | 'text')[];
  /** Display name used in pre-send error text (variant label or the
   *  provider's own label). Always set by the SW. */
  destinationDisplayName: string;
}
interface AskProviderListing {
  id: AskProviderId;
  label: string;
  enabled: boolean;
  /** Bundled logo filename under the extension's `icons/` dir
   *  (e.g. `claude.svg`). The page resolves it via
   *  `chrome.runtime.getURL` and uses the result as the `<img>`
   *  src on the per-provider Ask button — those buttons carry
   *  no text label, so the bundled logo is what identifies
   *  each one visually. */
  iconFilename: string;
  existingTabs: AskTabSummary[];
  newTabAcceptedAttachmentKinds?: ('image' | 'text')[];
}
type AskDestination =
  | { kind: 'newTab'; provider: AskProviderId }
  | { kind: 'existingTab'; provider: AskProviderId; tabId: number };

const askBtn = document.getElementById('ask-btn') as HTMLButtonElement;
const askMenuBtn = document.getElementById('ask-menu-btn') as HTMLButtonElement;
const askMenu = document.getElementById('ask-menu') as HTMLDivElement;
const askMenuList = askMenu.querySelector('ul') as HTMLUListElement;
const askTargetLabel = document.getElementById('ask-target-label') as HTMLSpanElement;
const askBtnIconUse = document.querySelector(
  '#ask-btn-icon use',
) as SVGUseElement;
// Per-provider Ask buttons are appended directly into `.button-row`
// (not a wrapper div) so they're real flex children of the row —
// `display: contents` wrappers can perturb the row's `gap` math
// and visually unbalance the spacing between buttons.
const askButtonRow = document.querySelector('.button-row') as HTMLDivElement;

// Swap the trailing glyph on #ask-btn between the pin (existing
// pinned tab) and new-window glyphs so the user sees at a glance
// which path plain-Ask is about to take. Falls back to the
// new-window glyph when no destination has resolved yet — that's
// what plain-Ask will do once a provider is enabled.
function setAskBtnIcon(kind: 'pin' | 'new-window'): void {
  const symbolId = kind === 'pin' ? '#pin-icon' : '#new-window-icon';
  askBtnIconUse.setAttribute('href', symbolId);
}

/**
 * Read the providers + the resolved default destination from the
 * SW. The default is what plain-Ask will target right now (pinned
 * tab if alive, else the first enabled provider's new tab). One
 * round-trip serves both menu rendering and label refreshes; the
 * menu open path keeps the providers and the simpler refreshes
 * just look at `defaultDestination`.
 */
interface AskStatePin {
  provider: AskProviderId;
  tabId: number;
}
async function fetchAskState(): Promise<{
  providers: AskProviderListing[];
  defaultDestination: AskDestination | null;
  /** Pin landed on a tab that's still alive on the provider's host
   *  but on a wrong (excluded) page. The menu greys-out the check
   *  on that row alongside the regular green check on whatever
   *  `defaultDestination` resolved to instead. */
  staleTabPin: AskStatePin | null;
  /** Effective accepted attachment kinds at the resolved default
   *  destination, or `undefined` for "no restriction." Used by plain
   *  Ask's pre-send check. */
  defaultAcceptedKinds: ('image' | 'text')[] | undefined;
  /** Display name (variant label or provider label) of the resolved
   *  default destination — used in the pre-send refusal message. */
  defaultDestinationDisplayName: string | undefined;
}> {
  try {
    const response = (await chrome.runtime.sendMessage({
      action: 'askListProviders',
    })) as
      | {
          providers: AskProviderListing[];
          defaultDestination: AskDestination | null;
          staleTabPin?: AskStatePin;
          defaultAcceptedAttachmentKinds?: ('image' | 'text')[];
          defaultDestinationDisplayName?: string;
        }
      | undefined;
    return {
      providers: response?.providers ?? [],
      defaultDestination: response?.defaultDestination ?? null,
      staleTabPin: response?.staleTabPin ?? null,
      defaultAcceptedKinds: response?.defaultAcceptedAttachmentKinds,
      defaultDestinationDisplayName: response?.defaultDestinationDisplayName,
    };
  } catch {
    return {
      providers: [],
      defaultDestination: null,
      staleTabPin: null,
      defaultAcceptedKinds: undefined,
      defaultDestinationDisplayName: undefined,
    };
  }
}

/**
 * Cached accepted-kinds list + display name for the default
 * destination. Populated by `refreshAskTargetLabel` and consulted by
 * `runAskDefault` so we can pre-validate the user's checkbox state
 * before round-tripping to the SW. `undefined` kinds means "no
 * restriction" (the common case); the only restricted destination
 * today is Claude on `/code`.
 */
let currentDefaultAcceptedKinds: ('image' | 'text')[] | undefined;
let currentDefaultDisplayName: string | undefined;

// Sync the "Ask <provider>" button label + tooltip to the resolved
// default destination. Called at page load and after every Ask
// (since pin-on-success can swap the active provider). Failures
// here are silent — the static HTML default ("Ask Claude") is a
// safe fallback.
async function refreshAskTargetLabel(): Promise<void> {
  const {
    providers,
    defaultDestination,
    defaultAcceptedKinds,
    defaultDestinationDisplayName,
  } = await fetchAskState();
  currentDefaultAcceptedKinds = defaultAcceptedKinds;
  currentDefaultDisplayName = defaultDestinationDisplayName;
  // `listAskProviders` already filters out user-disabled providers,
  // so an empty (or all-statically-disabled) listing means the user
  // has nothing to Ask. Block every Ask row (menu opener, default,
  // per-provider) until they re-enable a provider on the Options
  // page. Drop the per-provider buttons too — they're built fresh
  // from the enabled-provider list right after.
  const enabled = providers.filter((p) => p.enabled);
  const noProvidersTooltip = 'No Ask providers enabled; Update in Options';
  renderAskProviderButtons(enabled);
  if (enabled.length === 0) {
    askBtn.disabled = true;
    askMenuBtn.disabled = true;
    askBtn.title = noProvidersTooltip;
    askMenuBtn.title = noProvidersTooltip;
    askTargetLabel.textContent = 'AI';
    setAskBtnIcon('new-window');
    return;
  }
  // At least one provider is available — re-enable the rows (a
  // previous "all disabled" render may have disabled them) and pick
  // a label/tooltip from the resolved default.
  askBtn.disabled = false;
  askMenuBtn.disabled = false;
  askMenuBtn.title = 'Choose Ask target tab';
  if (defaultDestination) {
    const provider = providers.find((p) => p.id === defaultDestination.provider);
    if (provider) {
      askTargetLabel.textContent = provider.label;
      const verb = defaultDestination.kind === 'existingTab'
        ? 'Send to existing'
        : 'Send to new';
      askBtn.title = `${verb} ${provider.label} window`;
      setAskBtnIcon(defaultDestination.kind === 'existingTab' ? 'pin' : 'new-window');
      return;
    }
  }
  // No default available — fall back to a generic label. Plain-Ask
  // will open a new window in this state, so the new-window glyph
  // matches what's about to happen.
  setAskBtnIcon('new-window');
  if (enabled.length === 1) {
    askTargetLabel.textContent = enabled[0].label;
    askBtn.title = `Send to ${enabled[0].label} on web`;
  } else {
    askTargetLabel.textContent = 'AI';
    askBtn.title = 'Send to an AI on web';
  }
}

/**
 * Rebuild the per-provider Ask button rows under the default Ask
 * button — one "Ask <Label>" button per enabled provider, each
 * sending straight to a new tab on that provider. Modifier keys
 * follow the same shift/ctrl rules as the default Ask row.
 *
 * Re-rendered on every `refreshAskTargetLabel` so the row set
 * tracks the live `askProviderSettings` (Options-page enable
 * toggles, cross-tab storage events). For an empty list the
 * container is left empty and CSS collapses it to zero height.
 *
 * Rebuild during an in-flight Ask is safe: the click handler
 * captures `dest` / `acceptedKinds` / `provider.label` from the
 * closure of the *outgoing* button, so a click that lands on the
 * about-to-be-replaced button still fires `runAskFor` correctly,
 * and `runAskFor` immediately disables every button via
 * `setAskProviderButtonsDisabled` on entry. Subsequent
 * `replaceChildren` removes the now-detached old button without
 * affecting the in-flight async call.
 */
function renderAskProviderButtons(enabled: AskProviderListing[]): void {
  // Wipe the previous render's per-provider buttons (identified by
  // class) without disturbing the static `#capture` / `.ask-split`
  // children. Then append the fresh set into `.button-row` so each
  // new button is a direct flex child of the row.
  askButtonRow
    .querySelectorAll('.ask-provider-btn')
    .forEach((el) => el.remove());
  for (const provider of enabled) {
    const dest: AskDestination = { kind: 'newTab', provider: provider.id };
    const btn = document.createElement('button');
    btn.type = 'button';
    // Compact square button — no text label, just the destination
    // site's favicon. Visual identification of each provider via
    // the favicon people already recognise from the address bar
    // beats spelling out "Ask Claude / Ask Gemini / …" alongside
    // the existing default-Ask row that already says it.
    btn.className = 'btn ask-provider-btn';
    btn.title = `Ask ${provider.label} in new tab`;
    btn.setAttribute('aria-label', `Ask ${provider.label} in new tab`);
    const favicon = document.createElement('img');
    // Bundled logo from `src/icons/` (built into `dist/icons/`
    // by `scripts/build.mjs`). We download these once at
    // build-time rather than fetching `${origin}/favicon.ico`
    // because some providers' favicons require auth, redirect,
    // or 404 from a fresh extension context.
    favicon.src = chrome.runtime.getURL(`icons/${provider.iconFilename}`);
    favicon.alt = '';
    // Width/height attributes match the rendered size set by the
    // `.ask-provider-btn img` CSS rule, so layout is stable even
    // before the stylesheet has applied (e.g. on the very first
    // paint of a fresh tab). Update both together if either drifts.
    favicon.width = 20;
    favicon.height = 20;
    btn.appendChild(favicon);
    btn.addEventListener('click', (e) => {
      void runAskFor(
        dest,
        provider.newTabAcceptedAttachmentKinds,
        provider.label,
        closeAfterFromModifiers(e, false),
      );
    });
    askButtonRow.appendChild(btn);
  }
}
void refreshAskTargetLabel();

// Re-render parts of the page on external state changes from other
// tabs / the SW:
//
// - `local.askProviderSettings` — flipped from the Options page in
//   another tab. Refreshes the Ask label + disabled state.
// - `session.askPin` — the toolbar context-menu Set/Unset entry
//   writes here (without going through `runAskWithMessage`), so
//   without this listener the cached `currentDefaultAcceptedKinds`
//   would go stale and the page-side pre-send guard would miss the
//   newly-restricted destination (e.g. a freshly-pinned `/code`
//   tab). Post-Ask refreshes are still handled inline by
//   `runAskWithMessage`.
// - `local.capturePageDefaults` — flipped from the Options page in
//   another tab. Live-applies `defaultButton` (highlight ring +
//   Enter / triggerCapture routing) and `promptEnter`. The
//   Save-checkbox state in the same blob is intentionally NOT
//   re-applied — those are seeded once on first paint; clobbering
//   the user's in-progress checkbox edits mid-session would be
//   jarring. `defaultButton` and `promptEnter` have no equivalent
//   in-page edit surface, so live-updating them has no conflict.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['askProviderSettings']) {
    void refreshAskTargetLabel();
    return;
  }
  if (area === 'session' && changes['askPin']) {
    void refreshAskTargetLabel();
    return;
  }
  if (area === 'session' && changes['askPreferredNewTabProvider']) {
    // A menu pick in another Capture-page tab (or this one's last
    // pick once the SW finishes writing) just shifted which
    // provider the fallback resolves to. Refresh so the button
    // label and trailing icon match the new resolution.
    void refreshAskTargetLabel();
    return;
  }
  if (area === 'local' && changes['capturePageDefaults']) {
    const next = changes['capturePageDefaults'].newValue as
      | { defaultButton?: 'capture' | 'ask'; promptEnter?: 'send' | 'newline' }
      | undefined;
    if (next?.defaultButton === 'capture' || next?.defaultButton === 'ask') {
      applyDefaultButtonHighlight(next.defaultButton);
    }
    if (next?.promptEnter === 'send' || next?.promptEnter === 'newline') {
      currentPromptEnter = next.promptEnter;
    }
  }
});

// Tracks the deferred-listener-attach `setTimeout` (see openAskMenu).
// closeAskMenu() clears it so a close that happens *before* the timer
// fires doesn't leak listener attaches against an already-hidden menu.
let askListenerAttachTimer: ReturnType<typeof setTimeout> | null = null;

function closeAskMenu(): void {
  askMenu.hidden = true;
  askMenuBtn.setAttribute('aria-expanded', 'false');
  if (askListenerAttachTimer !== null) {
    clearTimeout(askListenerAttachTimer);
    askListenerAttachTimer = null;
  }
  document.removeEventListener('click', onDocumentClickWhileAskOpen, true);
  document.removeEventListener('keydown', onKeydownWhileAskOpen, true);
}

function onDocumentClickWhileAskOpen(e: MouseEvent): void {
  // Outside-click dismiss. Clicks inside the menu still bubble through
  // to their item-handler (registered on each <li>) — closeAskMenu()
  // there happens *after* the click handler runs. The main Ask
  // button is *not* an outside-click here either: clicking it is a
  // direct send (which closes the menu via the explicit handler).
  const target = e.target as Node | null;
  if (
    askMenu.contains(target) ||
    askMenuBtn.contains(target) ||
    askBtn.contains(target)
  ) return;
  closeAskMenu();
}

function onKeydownWhileAskOpen(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAskMenu();
    askMenuBtn.focus();
  }
}

/**
 * Render a `<li>` for one menu pick. The first column is a fixed-
 * width check slot — `is-default` toggles whether the check glyph
 * is visible. Putting the slot on every item (rather than only on
 * the default one) keeps labels vertically aligned across the menu.
 */
function renderAskMenuItem(opts: {
  label: string;
  /** Italic text appended after the label — used to annotate why a
   *  disabled item is disabled (e.g. "(Wrong page)"). */
  suffix?: string;
  title?: string;
  /** Indicator-slot glyph for the active states (`isDefault` /
   *  `isStale`). `'pin'` (default) for an existing pinned-tab row;
   *  `'new-window'` for the "New window in <provider>" row. The
   *  stale variant is always pin-off, regardless of this hint. */
  glyph?: 'pin' | 'new-window';
  isDefault: boolean;
  /** Marks a row whose tab used to be the pin but has since
   *  navigated to a wrong page. Renders the `pin-off` glyph in
   *  grey, so the user sees where the pin *was* alongside where
   *  Ask is going *now*. Mutually exclusive with `isDefault` in
   *  practice (a stale pin can't also be the resolved default). */
  isStale?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'ask-menu-item';
  if (opts.isDefault) li.classList.add('is-default');
  if (opts.isStale) li.classList.add('is-stale');
  li.setAttribute('role', 'menuitem');
  if (opts.title) li.title = opts.title;
  const check = document.createElement('span');
  check.className = 'ask-menu-check';
  check.setAttribute('aria-hidden', 'true');
  // Glyph picked by row kind: existing-tab "default" rows show a
  // pin (the tab is pinned); "stale" rows show a crossed-out pin;
  // new-window default rows show a new-window glyph instead, since
  // those rows are an action ("open a new window") rather than a
  // pinned target. `glyph` defaults to `'pin'` so call sites that
  // don't care (the check is hidden via CSS unless is-default or
  // is-stale anyway) can omit it.
  const symbolId = opts.isStale
    ? 'pin-off-icon'
    : `${opts.glyph ?? 'pin'}-icon`;
  check.innerHTML = `<svg><use href="#${symbolId}"></use></svg>`;
  const labelEl = document.createElement('span');
  labelEl.className = 'ask-menu-label';
  labelEl.textContent = opts.label;
  li.append(check, labelEl);
  if (opts.suffix) {
    const suffixEl = document.createElement('span');
    suffixEl.className = 'ask-menu-suffix';
    suffixEl.textContent = ` ${opts.suffix}`;
    li.appendChild(suffixEl);
  }
  if (opts.disabled) {
    li.setAttribute('aria-disabled', 'true');
  } else {
    li.tabIndex = 0;
    if (opts.onClick) li.addEventListener('click', opts.onClick);
  }
  return li;
}

function isSameDestination(
  a: AskDestination | null,
  b: AskDestination,
): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.provider !== b.provider) return false;
  if (a.kind === 'existingTab' && b.kind === 'existingTab') {
    return a.tabId === b.tabId;
  }
  return true;
}

async function openAskMenu(): Promise<void> {
  if (!askMenu.hidden) {
    closeAskMenu();
    return;
  }
  askMenuList.replaceChildren();
  const loading = document.createElement('li');
  loading.className = 'ask-menu-heading';
  loading.textContent = 'Loading…';
  askMenuList.appendChild(loading);
  askMenu.hidden = false;
  askMenuBtn.setAttribute('aria-expanded', 'true');
  // Defer listener attach so the click that opened the menu doesn't
  // immediately close it on the same event-loop tick. Track the timer
  // and check `askMenu.hidden` at fire time so a close-before-fire
  // (Escape, programmatic toggle, etc.) doesn't leave dangling
  // listeners — closeAskMenu() also clears the pending timer.
  askListenerAttachTimer = setTimeout(() => {
    askListenerAttachTimer = null;
    if (askMenu.hidden) return;
    document.addEventListener('click', onDocumentClickWhileAskOpen, true);
    document.addEventListener('keydown', onKeydownWhileAskOpen, true);
  }, 0);

  const { providers, defaultDestination, staleTabPin } = await fetchAskState();
  // Bail if the user already closed the menu while we were waiting.
  if (askMenu.hidden) return;

  askMenuList.replaceChildren();
  if (providers.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'ask-menu-heading';
    empty.textContent = 'No providers configured';
    askMenuList.appendChild(empty);
    return;
  }

  // Section 1: "New window in <provider>" — one entry per registered
  // provider, including disabled ones (rendered as "coming soon").
  const newHeading = document.createElement('li');
  newHeading.className = 'ask-menu-heading';
  newHeading.textContent = 'New window in';
  askMenuList.appendChild(newHeading);
  for (const provider of providers) {
    const dest: AskDestination = { kind: 'newTab', provider: provider.id };
    askMenuList.appendChild(
      renderAskMenuItem({
        label: provider.enabled
          ? provider.label
          : `${provider.label} (coming soon)`,
        glyph: 'new-window',
        isDefault: provider.enabled
          ? isSameDestination(defaultDestination, dest)
          : false,
        disabled: !provider.enabled,
        onClick: provider.enabled
          ? () => {
              closeAskMenu();
              void setAskDefaultDestination(dest);
            }
          : undefined,
      }),
    );
  }

  // Section 2..N: "Existing window in <provider>" — only rendered for
  // providers with at least one matching tab open. Each section gets
  // a horizontal separator before its heading so the menu visually
  // segments into "new windows" vs. each "existing windows" group.
  for (const provider of providers) {
    if (!provider.enabled || provider.existingTabs.length === 0) continue;
    const sep = document.createElement('li');
    sep.className = 'ask-menu-separator';
    sep.setAttribute('role', 'separator');
    askMenuList.appendChild(sep);
    const heading = document.createElement('li');
    heading.className = 'ask-menu-heading';
    heading.textContent = `Existing window in ${provider.label}`;
    askMenuList.appendChild(heading);
    for (const tab of provider.existingTabs) {
      const dest: AskDestination = {
        kind: 'existingTab',
        provider: provider.id,
        tabId: tab.tabId,
      };
      askMenuList.appendChild(
        renderAskMenuItem({
          label: tab.title || tab.url || `Tab ${tab.tabId}`,
          // Excluded tabs (settings, library, recents, etc.) live on
          // the provider's host but aren't a valid Ask target. Show
          // them disabled so the user can see the tab is recognised
          // — just not pickable — and explain why with the suffix.
          // For valid targets we leave the suffix off; the page
          // title already disambiguates sub-products like Claude
          // Code, which sets `<title>Claude Code</title>`.
          suffix: tab.excluded ? excludedSuffix(tab.url) : undefined,
          title: tab.url,
          isDefault: !tab.excluded
            && isSameDestination(defaultDestination, dest),
          // Pin used to point here but the tab navigated to a wrong
          // page. Both checks (greyed-here, fresh-on-the-fallback)
          // appear together so the user can see what just happened.
          isStale: staleTabPin?.provider === provider.id
            && staleTabPin.tabId === tab.tabId,
          disabled: tab.excluded,
          onClick: tab.excluded
            ? undefined
            : () => {
                closeAskMenu();
                void setAskDefaultDestination(dest);
              },
        }),
      );
    }
  }
}

askMenuBtn.addEventListener('click', () => {
  void openAskMenu();
});

askBtn.addEventListener('click', (e) => {
  // Close the menu if it happens to be open (e.g. user opened via
  // the caret then changed their mind and hit the main button).
  if (!askMenu.hidden) closeAskMenu();
  // Modifier semantics mirror the Capture button:
  //   - shift-click → keep the page open after the Ask (also the
  //     default — Ask doesn't close on plain click since the user
  //     usually wants to glance at the destination tab and return).
  //   - ctrl-click  → close the Capture page once the SW reports
  //     a successful send. Useful when the user is done with this
  //     capture and the tab is just clutter.
  void runAskDefault(closeAfterFromModifiers(e, false));
});

/**
 * Apply a menu pick as the new Ask default and refresh the button
 * label to match. Doesn't send — the menu is a default-picker, not
 * a sender. The next click on `#ask-btn` (or Alt+A) does the send
 * against this newly-set default.
 *
 * Disables both Ask buttons for the duration of the SW round-trip
 * so a fast follow-up click on `#ask-btn` can't fire an
 * `askAiDefault` message that arrives at the SW before the
 * `askSetDefault` write lands — the page-side disable forces the
 * second click to wait for the first to settle.
 * `refreshAskTargetLabel` re-enables the buttons in the finally
 * block based on the now-resolved state.
 *
 * Failures are surfaced in the ask-status line; the button label
 * still gets a refresh attempt either way so a partial write
 * (pin set, label fetch failed) doesn't lie about the resolved
 * default.
 */
async function setAskDefaultDestination(destination: AskDestination): Promise<void> {
  askBtn.disabled = true;
  askMenuBtn.disabled = true;
  setAskProviderButtonsDisabled(true);
  try {
    const response = (await chrome.runtime.sendMessage({
      action: 'askSetDefault',
      destination,
    })) as { ok?: boolean; error?: string } | undefined;
    if (!response?.ok) {
      setStatusMessage(response?.error ?? 'Failed to set default.', 'error');
    } else {
      // Clear any lingering error from a previous Ask so the new
      // default-set isn't visually shouted at by stale red text.
      setStatusMessage('', 'info');
    }
  } catch (err) {
    setStatusMessage(
      `Failed to set default: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  } finally {
    await refreshAskTargetLabel();
  }
}

interface AskAttachment {
  data: string;
  kind: 'image' | 'text';
  mimeType: string;
  filename: string;
}

const SELECTION_FILE_META: Record<
  SelectionFormat,
  { filename: string; mimeType: string }
> = {
  html: { filename: 'selection.html', mimeType: 'text/html' },
  text: { filename: 'selection.txt', mimeType: 'text/plain' },
  markdown: { filename: 'selection.md', mimeType: 'text/markdown' },
};

function buildAskAttachments(): AskAttachment[] {
  const out: AskAttachment[] = [];
  if (screenshotBox.checked && !screenshotBox.disabled) {
    // Bake current edits into the PNG when there are any — Ask uses
    // the same on-screen state the user is looking at, mirroring the
    // Capture button's bake-on-save policy. `renderHighlightedPng`
    // short-circuits to the original capture's data URL when no
    // edits need baking.
    const data = renderHighlightedPng();
    out.push({
      data,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'screenshot.png',
    });
  }
  if (htmlBox.checked && !htmlBox.disabled && captured.html) {
    out.push({
      data: captured.html,
      kind: 'text',
      mimeType: 'text/html',
      // `contents.html` matches the Save-to-disk filename prefix
      // (`contents-<timestamp>.html`) so the HTML attachment in
      // the AI tab and the saved-on-disk file share a name.
      filename: 'contents.html',
    });
  }
  const fmt = selectedSelectionFormat();
  if (fmt) {
    const body = captured[SELECTION_WIRE_KIND[fmt]];
    if (body && body.trim().length > 0) {
      const meta = SELECTION_FILE_META[fmt];
      out.push({
        data: body,
        kind: 'text',
        mimeType: meta.mimeType,
        filename: meta.filename,
      });
    }
  }
  return out;
}

/**
 * Build the Ask payload from current Capture-page state. Returns
 * `null` (with a status message already shown) when the user has
 * neither a prompt nor any checked Save row to send — guards against
 * silently focusing the AI tab and doing nothing. The caller skips
 * the SW round-trip in that case.
 */
function buildAskPayload(): {
  attachments: AskAttachment[];
  promptText: string;
  autoSubmit: boolean;
  sourceUrl: string;
  sourceTitle: string;
} | null {
  const promptText = promptInput.value.trim();
  const attachments = buildAskAttachments();
  if (attachments.length === 0 && promptText.length === 0) {
    setStatusMessage(
      'Nothing to send — check at least one box or type a prompt.',
      'error',
    );
    return null;
  }
  return {
    attachments,
    promptText,
    // Empty prompt → user wants to set up the conversation and keep
    // typing on the AI side. Non-empty → fire it off.
    autoSubmit: promptText.length > 0,
    // Source-page metadata for the in-page widget's Page section.
    // The widget needs both URL and title to mirror the Capture-page
    // card; the widget falls back gracefully if either is empty.
    sourceUrl: capturedUrl,
    sourceTitle: capturedTitleLink.textContent ?? capturedUrl,
  };
}

/**
 * Send the assembled payload via the SW and reflect the outcome
 * in the Ask status line. Disables both halves of the split button
 * while in flight so a double-press can't queue a second send. On
 * success, refresh the button label since the SW may have just
 * pinned a different destination.
 */
async function runAskWithMessage(
  message: ({
    action: 'askAiDefault';
  } | {
    action: 'askAi';
    destination: AskDestination;
  }) & {
    payload: NonNullable<ReturnType<typeof buildAskPayload>>;
  },
  closeAfter: boolean,
): Promise<void> {
  askBtn.disabled = true;
  askMenuBtn.disabled = true;
  setAskProviderButtonsDisabled(true);
  setStatusMessage('Sending…', 'info');
  try {
    const response = (await chrome.runtime.sendMessage(message)) as
      | { ok: boolean; error?: string; skipped?: string[] }
      | undefined;
    if (!response) {
      setStatusMessage('No response from background.', 'error');
      return;
    }
    if (!response.ok) {
      // The SW refuses payloads with attachments the destination
      // doesn't accept and reports them in `skipped` — append them
      // to the error so the user sees which files were the problem.
      // Normal flow catches this upstream in the page-side guard;
      // this path fires only when the page's cached accepted-kinds
      // was stale (toolbar Set/Unset or tab-navigation race).
      const skippedSuffix =
        response.skipped && response.skipped.length > 0
          ? ` Skipped: ${response.skipped.join(', ')}.`
          : '';
      setStatusMessage((response.error ?? 'Ask failed.') + skippedSuffix, 'error');
      return;
    }
    setStatusMessage('Sent.', 'ok');
    // Refresh after success: a successful Ask may have updated the
    // pin (sendToAi pins the destination on success), so the label
    // needs to reflect that.
    void refreshAskTargetLabel();
    // ctrl-click → close the Capture page now that the Ask landed.
    // Skipped on failure (the user keeps the page open as a
    // recovery surface — Copy/Download buttons are still here).
    if (closeAfter) {
      void chrome.runtime.sendMessage({ action: 'closeCapturePage' });
    }
  } catch (err) {
    setStatusMessage(
      `Ask failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  } finally {
    askBtn.disabled = false;
    askMenuBtn.disabled = false;
    setAskProviderButtonsDisabled(false);
    // Re-resolve the disabled state from the latest provider settings
    // so a mid-Ask Options-page change (e.g. user disabled every
    // provider while we were waiting on the SW) doesn't leave the
    // buttons re-enabled. The `chrome.storage.onChanged` listener
    // would also catch this on the next tick, but doing it here
    // closes the brief "buttons clickable but no providers" window.
    // refreshAskTargetLabel also re-renders the per-provider rows.
    void refreshAskTargetLabel();
  }
}

/** Toggle the disabled state of every per-provider button as a
 *  group. Used to gate the dynamic Ask <Provider> rows during an
 *  in-flight send / setDefault round-trip — same protection the
 *  static `#ask-btn` / `#ask-menu-btn` get. */
function setAskProviderButtonsDisabled(disabled: boolean): void {
  askButtonRow.querySelectorAll('.ask-provider-btn').forEach((btn) => {
    (btn as HTMLButtonElement).disabled = disabled;
  });
}

async function runAskDefault(closeAfter: boolean): Promise<void> {
  if (
    !checkDestinationAcceptsCheckedBoxes(
      currentDefaultAcceptedKinds,
      currentDefaultDisplayName,
    )
  ) return;
  const payload = buildAskPayload();
  if (!payload) return;
  await runAskWithMessage({ action: 'askAiDefault', payload }, closeAfter);
}

/**
 * Send the staged payload to a specific destination. Used by the
 * per-provider Ask buttons (each one targets a new tab on a
 * specific provider) and any future caller that needs to override
 * the resolved default for a single send. Honours the same modifier
 * semantics as `runAskDefault` via the `closeAfter` parameter.
 */
async function runAskFor(
  destination: AskDestination,
  acceptedKinds: ('image' | 'text')[] | undefined,
  displayName: string | undefined,
  closeAfter: boolean,
): Promise<void> {
  if (!checkDestinationAcceptsCheckedBoxes(acceptedKinds, displayName)) return;
  const payload = buildAskPayload();
  if (!payload) return;
  await runAskWithMessage({ action: 'askAi', destination, payload }, closeAfter);
}

/**
 * Pre-send guard: refuse to send when the destination's composer
 * doesn't accept one of the kinds the user has checked. Today this
 * only fires for Claude on `/code` (image-only), but the check is
 * generic — any future image-only or text-only sub-page will benefit.
 *
 * On a mismatch we display an error naming the destination by its
 * variant label (e.g. "Claude Code") and the specific Save rows the
 * user needs to uncheck, and return false so the caller bails. The
 * SW runs the same check at send time and refuses outright (with
 * `Skipped: …` in the error) if anything slips through — covers
 * stale-cache races (toolbar Set/Unset or tab navigation between
 * cache load and click). `displayName` falls back to a generic
 * "Destination" if the SW didn't provide one (defensive — in
 * practice the listing always fills it in alongside any non-null
 * `acceptedKinds`).
 */
function checkDestinationAcceptsCheckedBoxes(
  acceptedKinds: ('image' | 'text')[] | undefined,
  displayName: string | undefined,
): boolean {
  if (!acceptedKinds || acceptedKinds.length === 0) return true;
  const allow = new Set(acceptedKinds);
  const offending: string[] = [];
  if (
    htmlBox.checked
    && !htmlBox.disabled
    && captured.html
    && !allow.has('text')
  ) {
    offending.push('Save HTML');
  }
  // Mirror buildAskAttachments's `body.trim().length > 0` gate — if
  // the selection radio is checked but the captured body is empty,
  // no attachment would be sent, so don't flag it as offending.
  const fmt = selectedSelectionFormat();
  if (fmt && !allow.has('text')) {
    const body = captured[SELECTION_WIRE_KIND[fmt]];
    if (body && body.trim().length > 0) offending.push('Save selection');
  }
  if (
    screenshotBox.checked
    && !screenshotBox.disabled
    && !allow.has('image')
  ) {
    offending.push('Save screenshot');
  }
  if (offending.length === 0) return true;
  const list = offending.length === 1
    ? offending[0]
    : `${offending.slice(0, -1).join(', ')} and ${offending[offending.length - 1]}`;
  const kindList = formatAcceptedKinds(acceptedKinds);
  const name = displayName ?? 'Destination';
  setStatusMessage(
    `${name} only accepts ${kindList} attachments; uncheck ${list}.`,
    'error',
  );
  return false;
}

/** Friendly join of accepted-kind tokens for the pre-send error
 *  ("image" / "image and text" / "image, text, and …"). Mirrors the
 *  SW's `formatKindList` so the page-side and SW-side wording match. */
function formatAcceptedKinds(kinds: ('image' | 'text')[]): string {
  if (kinds.length === 1) return kinds[0];
  if (kinds.length === 2) return `${kinds[0]} and ${kinds[1]}`;
  return `${kinds.slice(0, -1).join(', ')}, and ${kinds[kinds.length - 1]}`;
}

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
