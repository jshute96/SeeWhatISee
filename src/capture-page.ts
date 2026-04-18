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
const captureBtn = document.getElementById('capture') as HTMLButtonElement;
const promptInput = document.getElementById('prompt-text') as HTMLTextAreaElement;
const previewImg = document.getElementById('preview') as HTMLImageElement;
const capturedUrlInput = document.getElementById('captured-url') as HTMLInputElement;
const htmlSizeEl = document.getElementById('html-size') as HTMLSpanElement;
const copyScreenshotBtn = document.getElementById('copy-screenshot-name') as HTMLButtonElement;
const copyHtmlBtn = document.getElementById('copy-html-name') as HTMLButtonElement;
// `getElementById` returns `HTMLElement | null`. SVG elements are
// `SVGElement`, which sits on a sibling branch of the DOM type
// hierarchy — TypeScript won't let us cast directly across the
// branches without a `unknown` bridge.
const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;
const undoBtn = document.getElementById('undo') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;

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
// Left-click-drag draws red rectangles and right-click-drag draws
// red lines. Edits live in a stack so Undo pops the most recent and
// Clear empties it. Coordinates are stored as percentages of the
// image so they survive resizes (window resize, prompt growth,
// image swap).

type Edit =
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number };

interface Point { x: number; y: number; }

const SVG_NS = 'http://www.w3.org/2000/svg';
// Movement under this many CSS pixels counts as a stray click, not
// a drag — discarded so a single click never produces a degenerate
// zero-size rectangle or a zero-length line.
const CLICK_THRESHOLD_PX = 4;

const edits: Edit[] = [];
let dragStart: Point | null = null;
let dragCurrent: Point | null = null;
let dragButton: number | null = null;

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

function makeRect(x: number, y: number, w: number, h: number): SVGRectElement {
  const el = document.createElementNS(SVG_NS, 'rect');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'red');
  el.setAttribute('stroke-width', '3');
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
    if (e.type === 'rect') {
      overlay.appendChild(makeRect(
        (e.x / 100) * w,
        (e.y / 100) * h,
        (e.w / 100) * w,
        (e.h / 100) * h,
      ));
    } else {
      overlay.appendChild(makeLine(
        (e.x1 / 100) * w,
        (e.y1 / 100) * h,
        (e.x2 / 100) * w,
        (e.y2 / 100) * h,
      ));
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
      overlay.appendChild(makeRect(x, y, dw, dh));
    }
  }
  undoBtn.disabled = edits.length === 0;
  clearBtn.disabled = edits.length === 0;
}

overlay.addEventListener('mousedown', (e) => {
  const me = e as MouseEvent;
  if (me.button !== 0 && me.button !== 2) return;
  me.preventDefault();
  dragStart = localCoords(me);
  dragCurrent = dragStart;
  dragButton = me.button;
  render();
});

// Suppress the browser context menu so right-click-drag is available
// for drawing lines.
overlay.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('mousemove', (e) => {
  if (dragStart === null) return;
  dragCurrent = localCoords(e);
  render();
});

window.addEventListener('mouseup', (e) => {
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
    if (dragButton === 2) {
      edits.push({
        type: 'line',
        x1: (dragStart.x / r.width) * 100,
        y1: (dragStart.y / r.height) * 100,
        x2: (end.x / r.width) * 100,
        y2: (end.y / r.height) * 100,
      });
    } else {
      const x = Math.min(dragStart.x, end.x);
      const y = Math.min(dragStart.y, end.y);
      edits.push({
        type: 'rect',
        x: (x / r.width) * 100,
        y: (y / r.height) * 100,
        w: (Math.abs(dx) / r.width) * 100,
        h: (Math.abs(dy) / r.height) * 100,
      });
    }
    editVersion++;
  }
  dragStart = null;
  dragCurrent = null;
  dragButton = null;
  render();
});

undoBtn.addEventListener('click', () => {
  edits.pop();
  editVersion++;
  render();
});

clearBtn.addEventListener('click', () => {
  edits.length = 0;
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
  const response: DetailsData | undefined = await chrome.runtime.sendMessage({
    action: 'getDetailsData',
  });
  if (!response) return;
  previewImg.src = response.screenshotDataUrl;
  capturedUrlInput.value = response.url;
  // True UTF-8 byte count of the captured HTML, not the JS string
  // length (which counts UTF-16 code units).
  htmlSizeEl.textContent = formatBytes(new Blob([response.html]).size);
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

// Last `editVersion` we sent the SW with a screenshot override. If
// the user hasn't drawn / undone since, we skip the (potentially
// multi-MB) PNG bake + message-channel copy on the next click — the
// SW will hit its cache anyway and ignore any override we'd send.
// Reset to -1 so the very first Copy with edits forces a bake.
let lastSentScreenshotEditVersion = -1;

async function copyArtifactPath(kind: 'screenshot' | 'html'): Promise<void> {
  // Skip the bake + override when the SW will cache-hit. The cache
  // is keyed by `editVersion`, so if we already shipped this version
  // (and therefore the SW already has the matching file on disk),
  // there's no point baking a fresh PNG just for the SW to drop.
  const needsBake =
    kind === 'screenshot' &&
    edits.length > 0 &&
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

// Render the preview image with all current highlight edits baked
// into the PNG bytes, at the screenshot's natural resolution. Used
// when the user saves a screenshot that has highlights — we want the
// saved file to show the markup, not just the underlying screenshot.
//
// Stroke widths in the SVG overlay are CSS pixels at display size;
// we scale them up by the display→natural ratio so they look the
// same in the saved PNG as they did during editing (otherwise a 3px
// stroke on a 4×-downscaled preview would render as a hairline in
// the saved file).
function renderHighlightedPng(): string {
  const w = previewImg.naturalWidth;
  const h = previewImg.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for highlight rendering');
  ctx.drawImage(previewImg, 0, 0, w, h);

  const displayW = previewImg.clientWidth || w;
  const displayH = previewImg.clientHeight || h;
  // The image always preserves its aspect ratio (max-width and the
  // JS-managed max-height both scale uniformly), so w/displayW and
  // h/displayH should be equal in theory. Averaging is just cheap
  // insurance against sub-pixel rounding drift between the two —
  // not handling for non-uniform scale.
  const scale = (w / displayW + h / displayH) / 2;

  ctx.strokeStyle = 'red';
  ctx.lineWidth = 3 * scale;
  ctx.lineCap = 'round';

  for (const e of edits) {
    if (e.type === 'rect') {
      ctx.strokeRect(
        (e.x / 100) * w,
        (e.y / 100) * h,
        (e.w / 100) * w,
        (e.h / 100) * h,
      );
    } else {
      ctx.beginPath();
      ctx.moveTo((e.x1 / 100) * w, (e.y1 / 100) * h);
      ctx.lineTo((e.x2 / 100) * w, (e.y2 / 100) * h);
      ctx.stroke();
    }
  }

  return canvas.toDataURL('image/png');
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
    // Only bake highlights into a fresh PNG when both apply: there's
    // something to bake, and the user is actually saving the image.
    // If the screenshot isn't being saved, the override would be
    // wasted bytes on the message channel.
    const hasHighlights = edits.length > 0;
    const bakeIn = hasHighlights && screenshotBox.checked;
    const screenshotOverride = bakeIn ? renderHighlightedPng() : undefined;

    void chrome.runtime.sendMessage({
      action: 'saveDetails',
      screenshot: screenshotBox.checked,
      html: htmlBox.checked,
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
