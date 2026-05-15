// Catalog-driven Edit dialogs for the Capture page. Each editable
// artifact kind (page HTML, selection HTML / text / markdown) gets
// one dialog cloned from `#edit-dialog-template` in capture.html. A
// Save pushes the new body to the SW via `updateArtifact`, which
// invalidates the corresponding download cache so the next Copy /
// Capture writes the edited content.
//
// Adding a future kind is one entry in `EDIT_KINDS` below plus a
// pencil button in the markup. `initEditDialogs(ctx)` is the only
// entry point; `anyEditDialogOpen()` is exposed so the main file's
// page-wide Alt-shortcut handler can suspend its bindings while any
// dialog is up.

import { attachHtmlAwarePaste } from './paste.js';

// Kept in sync with the canonical declaration in `src/capture/types.ts`
// and the `EDITABLE_ARTIFACTS` dispatch table in `src/background.ts`.
// Inlined rather than `import type`'d for the same reason the main
// file inlines it: keeps the page's payload contract independent of
// the SW module. New editable kinds must be added to all sites.
type EditableArtifactKind =
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

/**
 * Everything the edit-dialog catalog needs from the rest of the
 * Capture page. Passed once at init time; internal helpers close
 * over the binding at module scope.
 */
export interface EditDialogContext {
  /** Pencil button in the Capture-page row for each kind. */
  openBtns: Record<EditableArtifactKind, HTMLButtonElement>;
  /** Live mirror of the SW's captured bodies. Reference is stable;
   *  contents mutate as the user saves edits. */
  captured: Record<EditableArtifactKind, string>;
  /** Captured page URL — used as `<base href>` in HTML previews so
   *  relative links resolve against the source page. */
  getCapturedUrl(): string;
  /** HTML-size pill on the page card. Refreshed by the 'html' kind's
   *  onSaved hook. */
  htmlSizeBadge: HTMLSpanElement;
  /** Selection-size pill refresher — called by every selection
   *  kind's onSaved hook. */
  updateSelectionSizeBadge(): void;
  /** Byte-count formatter shared with the page card. */
  formatBytes(n: number): string;
  /** In-dialog "Download this file" button writes the editor's
   *  current source (un-Saved). Shared with the per-row Save-as
   *  buttons in `save-as.ts` (which use the SW-committed mirror). */
  downloadEditableAs(kind: EditableArtifactKind, body: string): Promise<void>;
}

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

let ctx: EditDialogContext;

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
    parts.setCode(ctx.captured[spec.kind]);
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
      const html = buildPreviewHtml(htmlBody, ctx.getCapturedUrl());
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
    void ctx.downloadEditableAs(spec.kind, parts.getCode());
  });

  async function save(): Promise<void> {
    const newValue = parts.getCode();
    // No-op when unchanged: avoid an SW round-trip (and the cache
    // invalidation side-effect that would re-download on next Copy).
    if (newValue === ctx.captured[spec.kind]) {
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
      ctx.captured[spec.kind] = newValue;
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

export function initEditDialogs(context: EditDialogContext): void {
  ctx = context;
  const specs: EditKindSpec[] = [
    {
      kind: 'html',
      domSlug: 'html',
      title: 'Page contents HTML',
      openBtn: context.openBtns.html,
      preview: 'html',
      onSaved: (v) => {
        // Only reachable when the original HTML scrape succeeded —
        // `loadData` disables the Edit-HTML button whenever `htmlError`
        // is set, so the badge here is always populated and visible.
        context.htmlSizeBadge.textContent = `HTML · ${context.formatBytes(new Blob([v]).size)}`;
      },
    },
    {
      kind: 'selectionHtml',
      domSlug: 'selection-html',
      title: 'Selection HTML',
      openBtn: context.openBtns.selectionHtml,
      preview: 'html',
      // Each selection edit-save updates the live `captured.selection*`
      // body before this hook runs, so `updateSelectionSizeBadge` reads
      // the post-edit byte count when the active format matches the
      // edited kind. Editing a non-active format leaves the badge
      // unchanged until the user clicks that format's radio.
      onSaved: () => context.updateSelectionSizeBadge(),
    },
    {
      kind: 'selectionText',
      domSlug: 'selection-text',
      title: 'Edit selection text',
      openBtn: context.openBtns.selectionText,
      onSaved: () => context.updateSelectionSizeBadge(),
    },
    {
      kind: 'selectionMarkdown',
      domSlug: 'selection-markdown',
      title: 'Selection markdown',
      openBtn: context.openBtns.selectionMarkdown,
      preview: 'markdown',
      onSaved: () => context.updateSelectionSizeBadge(),
    },
  ];
  for (const spec of specs) bindEditDialog(spec);
}

export function anyEditDialogOpen(): boolean {
  return editDialogs.some((d) => d.open);
}
