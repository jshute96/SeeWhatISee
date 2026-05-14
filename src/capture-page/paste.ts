// Rich-text paste handling for the Capture page.
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

import { htmlToMarkdown, looksLikeMarkdownSource } from '../markdown.js';

export type HtmlPasteMode = 'asMarkdown' | 'asHtmlSource';

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
  // Normalize non-breaking spaces (` `) back to regular spaces.
  // Browsers sprinkle nbsp into clipboard `text/html` to preserve
  // visible whitespace runs in paste targets that would otherwise
  // collapse them — Word, Gmail, etc. In our editors those nbsps
  // become non-breaking and constrain line wrapping at every gap
  // the source happened to render with extra space. We almost never
  // want that intent preserved across a copy; regular spaces flow
  // and wrap as expected. innerHTML serialization re-encodes
  // ` ` → `&nbsp;`, so this also keeps the entity out of the
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

export function attachHtmlAwarePaste(
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
