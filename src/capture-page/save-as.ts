// Per-row "Save as…" buttons + the drawing-palette Copy-image-to-
// clipboard button.
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
//
// `chrome.downloads.download({ saveAs: true })` is callable directly
// from this extension page (no SW round-trip needed). It rejects with
// `USER_CANCELED` when the user dismisses the dialog — silenced.

// Inlined for the same reason as in the other capture-page submodules.
type SelectionFormat = 'html' | 'text' | 'markdown';
type EditableArtifactKind =
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

const SELECTION_FORMATS: readonly SelectionFormat[] = ['html', 'text', 'markdown'];

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

export interface SaveAsContext {
  // Buttons.
  downloadScreenshotBtn: HTMLButtonElement;
  downloadHtmlBtn: HTMLButtonElement;
  copyImageBtn: HTMLButtonElement;
  downloadImageBtn: HTMLButtonElement;
  selectionRows: Record<SelectionFormat, { downloadBtn: HTMLButtonElement }>;

  // Live mirror of the SW's captured bodies. Read on save-as for
  // HTML / selection kinds (the body is split out as a parameter for
  // `downloadEditableAs` so the edit-dialog's in-dialog Download
  // button can pass un-Saved editor source).
  captured: Record<EditableArtifactKind, string>;
  selectionWireKind: Record<SelectionFormat, EditableArtifactKind>;

  // Bake helpers from drawing.ts.
  renderHighlightedImage(forceMime?: 'image/png' | 'image/jpeg'): string;
  bakeExt(): 'png' | 'jpg';

  // Page-wide status slot + shared clipboard-error formatter.
  setStatusMessage(text: string, kind: 'ok' | 'error' | 'info'): void;
  formatClipboardError(err: unknown, subject: 'copy' | 'copy image'): string;
}

let ctx: SaveAsContext;

export function initSaveAs(context: SaveAsContext): void {
  ctx = context;

  context.downloadScreenshotBtn.addEventListener('click', () => {
    void downloadAs('screenshot');
  });

  // Image-level Copy / Save-as in the drawing palette. Both reuse the
  // per-row screenshot logic — the Save-as is identical, and the Copy
  // puts the same PNG bytes onto the clipboard as image data (vs. the
  // per-row Copy, which copies the *filename* as text).
  context.copyImageBtn.addEventListener('click', () => {
    void copyImageToClipboard();
  });
  context.downloadImageBtn.addEventListener('click', () => {
    void downloadAs('screenshot');
  });

  context.downloadHtmlBtn.addEventListener('click', () => {
    void downloadAs('html');
  });
  for (const format of SELECTION_FORMATS) {
    context.selectionRows[format].downloadBtn.addEventListener('click', () => {
      void downloadAs(context.selectionWireKind[format]);
    });
  }
}

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
  const url = ctx.renderHighlightedImage('image/png');
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
    ctx.setStatusMessage(ctx.formatClipboardError(err, 'copy image'), 'error');
  }
}

async function downloadAs(
  kind: 'screenshot' | EditableArtifactKind,
): Promise<void> {
  if (kind === 'screenshot') {
    // `renderHighlightedImage` short-circuits to the original
    // capture's data URL when no edits need baking and the source
    // already matches `bakeMime` — see its docstring.
    const url = ctx.renderHighlightedImage();
    // Screenshot is a data: URL — nothing to revoke. The other kinds
    // use blob URLs (built from the editable body) and route through
    // `downloadEditableAs`, which handles its own revocation.
    await runSaveAsDialog(url, `screenshot.${ctx.bakeExt()}`, null);
    return;
  }
  await downloadEditableAs(kind, ctx.captured[kind]);
}

/**
 * Save the given editable-kind body to a user-chosen path via the
 * native save dialog. The body parameter is split out so the
 * in-dialog download button can hand the *current editor source*
 * (uncommitted), while the per-row Save-as button hands
 * `captured[kind]` (the SW-committed mirror).
 *
 * Exported for `capture-page/edit-dialog.ts` so the in-dialog
 * Download button shares this implementation.
 */
export async function downloadEditableAs(
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
    const format = (Object.keys(ctx.selectionWireKind) as SelectionFormat[])
      .find((f) => ctx.selectionWireKind[f] === kind)!;
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
