// Lightweight HTML → Markdown converter used by `captureSelection`
// and the details flow so a selected fragment can be saved as
// CommonMark-ish markdown instead of raw HTML.
//
// Scope / tradeoffs:
//   - Designed for *selection fragments* (user-highlighted runs of
//     page content), not whole pages. Scripts, styles, iframes, and
//     other "not really content" nodes are dropped.
//   - Pure function over a string so the tests can run without a DOM
//     (no `DOMParser`, no `jsdom`). The tokenizer and tree builder
//     here are intentionally minimal — they target the subset of
//     HTML that actually appears inside copied page fragments.
//   - Handled elements: headings (h1–h6), paragraphs, line breaks,
//     hr, bold/italic/underline/strike, inline code, fenced code
//     blocks (pre / pre>code), blockquote, ordered + unordered lists
//     (nested), links, images, simple tables.
//   - Everything else unwraps to its text content so nothing user-
//     visible silently disappears.
//
// Exports:
//   - `htmlToMarkdown(html, baseUrl?)` — entry point. Never throws on
//     malformed input; it treats bad markup as best-effort text.
//   - `htmlToText(html)`    — text-only fallback. Used on platforms
//     where the scrape can't produce a reliable `selection.toString()`
//     (and as a test-friendly companion to the markdown converter).
//   - `looksLikeMarkdownSource(html, text)` — heuristic detector for
//     "this selection is itself markdown source" (e.g. a `.md` file
//     viewed in GitHub `?plain=1` or a CodeMirror editor). Used by
//     `selectionMarkdownBody` to decide whether to short-circuit.
//   - `selectionMarkdownBody(html, text, baseUrl?)` — picks between
//     verbatim text (when the detector fires) and the
//     `htmlToMarkdown` conversion path. The single entry point used
//     by `src/capture.ts` for building the `markdown` selection body.

/**
 * Void / self-closing HTML elements that never carry children. The
 * parser emits them as leaf nodes regardless of whether the source
 * HTML used the XHTML-style `<br/>` or the HTML-style `<br>`.
 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Elements whose content should be dropped entirely from the
 * conversion output. Keeping their children would leak raw CSS / JS
 * text into the markdown, which is never what the user wants when
 * they grab a page selection.
 */
const SKIP_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed',
]);

/**
 * Tags that introduce a block boundary. Used by the text extractor
 * to decide where to insert a newline when flattening the tree —
 * inline tags (`<span>`, `<b>`, …) don't break, block tags do.
 */
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog',
  'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
interface TextNode {
  type: 'text';
  value: string;
}
type Node = ElementNode | TextNode;

/**
 * Detect inline-style hidden elements that the user wouldn't see on
 * the page. We don't run a layout / CSS engine, so this only catches
 * the cheap signals: the HTML5 `hidden` attribute and an inline
 * `style="display: none"` declaration. CSS-class-driven hiding (e.g.
 * a `.sr-only` rule in a stylesheet) still leaks through — there's no
 * fix for that without a real DOM.
 *
 * Motivation: pages stash invisible chrome inside the live HTML
 * (toast templates, snackbar messages, screen-reader-only flyouts).
 * The text snapshot sidesteps these because `Selection.toString()`
 * already respects layout, but the markdown / text converters parse
 * raw HTML and would otherwise emit the hidden text alongside the
 * visible content.
 */
function isHiddenElement(node: ElementNode): boolean {
  if ('hidden' in node.attrs) return true;
  const style = node.attrs['style'];
  if (!style) return false;
  // Walk the inline declarations rather than substring-matching, so
  // `background: url('display:none.png')` and friends don't trigger
  // a false positive. We only care about a literal `display: none`
  // (with optional `!important`) at declaration scope.
  for (const decl of style.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx < 0) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    if (prop !== 'display') continue;
    const val = decl.slice(colonIdx + 1).trim().toLowerCase();
    // Accept anything starting with `none` followed by a non-identifier
    // char (or end-of-string). Catches `none`, `none !important`,
    // `none!important` (no space — legal CSS, real in the wild), and
    // `none/* comment */`. Avoids matching e.g. a hypothetical
    // `none-foo` keyword.
    if (/^none($|[^a-z0-9_-])/.test(val)) return true;
  }
  return false;
}

// ─── HTML entity decoding ─────────────────────────────────────────
//
// Only the few named entities a browser-serialized fragment reliably
// produces. Numeric entities (`&#39;`, `&#x27;`) are decoded
// generically below.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

// ─── Tokenizer + tree builder ─────────────────────────────────────

/**
 * Parse an HTML fragment into a small tree of `ElementNode` /
 * `TextNode` nodes. The tokenizer is character-driven, not regex-
 * based, so it handles attribute values that contain `>` and avoids
 * catastrophic backtracking on pathological inputs.
 *
 * The parser tolerates mismatched / unclosed tags: close tags that
 * don't match the top of the stack pop until a match is found (or
 * drop the stray close), which matches how browsers forgive typical
 * mid-page copy artifacts.
 */
function parseHtml(html: string): Node[] {
  const root: ElementNode = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  let i = 0;
  const n = html.length;

  const top = (): ElementNode => stack[stack.length - 1]!;

  const pushText = (s: string): void => {
    if (!s) return;
    top().children.push({ type: 'text', value: decodeEntities(s) });
  };

  while (i < n) {
    const ch = html[i]!;
    if (ch === '<') {
      // Comment: <!-- ... --> — skip whole block.
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      // Doctype / CDATA / processing-instruction: skip to the next `>`.
      if (html[i + 1] === '!' || html[i + 1] === '?') {
        const end = html.indexOf('>', i);
        i = end < 0 ? n : end + 1;
        continue;
      }
      // Close tag.
      if (html[i + 1] === '/') {
        const end = html.indexOf('>', i);
        if (end < 0) { i = n; break; }
        const tag = html.slice(i + 2, end).trim().toLowerCase();
        i = end + 1;
        // Pop stack until we find a matching open or hit the root.
        for (let j = stack.length - 1; j > 0; j--) {
          if (stack[j]!.tag === tag) {
            stack.length = j;
            break;
          }
        }
        continue;
      }
      // Open tag. Find the end of the tag proper while respecting
      // attribute quotes, since e.g. `<a title="1 > 2">` embeds a `>`.
      let j = i + 1;
      let quoteFailed = false;
      while (j < n) {
        const c = html[j]!;
        if (c === '"' || c === "'") {
          const q = c;
          j++;
          while (j < n && html[j] !== q) j++;
          if (j >= n) { quoteFailed = true; break; }
          j++; // consume closing quote
          continue;
        }
        if (c === '>') break;
        j++;
      }
      if (quoteFailed || j >= n) {
        // Malformed tag: unclosed attribute quote, or no `>` anywhere
        // before EOF. Try one last recovery — if there's a `>`
        // somewhere after the tag start, pretend the tag ends there
        // (sacrifices attribute fidelity for the one bad tag but
        // keeps the rest of the input parseable). Otherwise emit
        // the `<` as literal text and advance one char so we don't
        // drop everything that follows.
        const recover = html.indexOf('>', i + 1);
        if (recover < 0) {
          pushText('<');
          i = i + 1;
          continue;
        }
        j = recover;
      }
      const inner = html.slice(i + 1, j);
      i = j + 1;

      // Strip optional self-closing slash.
      const selfClosing = inner.endsWith('/');
      const head = selfClosing ? inner.slice(0, -1) : inner;
      // Tag name ends at first whitespace.
      const match = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(head);
      if (!match) continue;
      const tag = match[1]!.toLowerCase();
      const attrs = parseAttrs(head.slice(tag.length));

      if (SKIP_ELEMENTS.has(tag)) {
        // Swallow everything up to the matching close tag.
        const closer = `</${tag}`;
        const end = html.toLowerCase().indexOf(closer, i);
        if (end < 0) { i = n; break; }
        const afterClose = html.indexOf('>', end);
        i = afterClose < 0 ? n : afterClose + 1;
        continue;
      }

      const node: ElementNode = { type: 'element', tag, attrs, children: [] };
      top().children.push(node);
      if (!selfClosing && !VOID_ELEMENTS.has(tag)) {
        stack.push(node);
      }
      continue;
    }
    // Plain text until the next `<`.
    const next = html.indexOf('<', i);
    const chunk = next < 0 ? html.slice(i) : html.slice(i, next);
    pushText(chunk);
    i = next < 0 ? n : next;
  }

  return root.children;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i]!)) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && !/[\s=]/.test(s[i]!)) i++;
    const name = s.slice(nameStart, i).toLowerCase();
    if (!name) break;
    while (i < n && /\s/.test(s[i]!)) i++;
    if (s[i] !== '=') {
      out[name] = '';
      continue;
    }
    i++; // consume '='
    while (i < n && /\s/.test(s[i]!)) i++;
    const q = s[i];
    if (q === '"' || q === "'") {
      i++;
      const vStart = i;
      while (i < n && s[i] !== q) i++;
      out[name] = decodeEntities(s.slice(vStart, i));
      if (i < n) i++; // consume closing quote
    } else {
      const vStart = i;
      while (i < n && !/\s/.test(s[i]!)) i++;
      out[name] = decodeEntities(s.slice(vStart, i));
    }
  }
  return out;
}

// ─── Markdown emission ────────────────────────────────────────────

interface EmitContext {
  /**
   * Stack of ancestor list containers, outermost first. Each entry
   * tracks whether the list is ordered (`type: 'ol'`) and, for ordered
   * lists, the next item number to emit. Nested list indentation
   * derives from this stack's length.
   */
  listStack: Array<{ type: 'ul' | 'ol'; index: number }>;
  /** True inside `<pre>` — text nodes preserve whitespace and
   *  newlines rather than being collapsed. */
  preformatted: boolean;
  /** True inside `<a>` — suppress nested link emission so we don't
   *  produce `[foo[bar](u2)](u1)` for weird nested markup. */
  insideLink: boolean;
  /**
   * Language hint inherited from a containing element for the next
   * `<pre>` emission. Set by GitHub-style `<div class="highlight
   * highlight-source-<lang>">` wrappers, where the language name
   * lives on the outer `<div>` rather than on `<pre>` / `<code>`.
   * Used only as a fallback when `<pre>` / `<code>` don't carry
   * their own `language-*` class. `undefined` means no hint.
   */
  preHintedLanguage: string | undefined;
  /**
   * Page URL the fragment was scraped from, used to resolve relative
   * `<a href>` and `<img src>` values so they keep working when the
   * markdown file is read on its own. `undefined` disables resolution
   * (relative hrefs pass through unchanged). Fragment-only hrefs
   * (`#foo`) are *always* left alone regardless — they point inside
   * the saved page, not the source page.
   */
  baseUrl: string | undefined;
}

function newContext(baseUrl?: string): EmitContext {
  return {
    listStack: [],
    preformatted: false,
    insideLink: false,
    preHintedLanguage: undefined,
    baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : undefined,
  };
}

/**
 * Resolve an HTML `href` / `src` against the page URL so relative
 * references (`foo.html`, `/x/y`, `?q=1`) become absolute and keep
 * working when the markdown file is read on its own. Fragment-only
 * refs (`#section`) stay as-is — they point inside whatever file
 * the markdown ends up in, which is the right behavior for anchor
 * links captured alongside the selection.
 *
 * Returns the original value unchanged on:
 *   - empty strings,
 *   - fragment-only refs,
 *   - missing `baseUrl` (no resolution requested),
 *   - malformed URLs (`new URL` throws).
 */
function resolveUrl(ref: string, baseUrl: string | undefined): string {
  if (!ref) return ref;
  if (ref.startsWith('#')) return ref;
  if (!baseUrl) return ref;
  try {
    return new URL(ref, baseUrl).href;
  } catch {
    return ref;
  }
}

/**
 * Convert an HTML fragment to CommonMark-ish markdown. Never throws
 * on malformed input; unhandled elements unwrap to their text.
 *
 * When `baseUrl` is supplied, relative `<a href>` and `<img src>`
 * values are resolved against it so the saved markdown's links and
 * images keep working outside the original page. Anchor-only
 * references (`#foo`) pass through unchanged.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  const nodes = parseHtml(html);
  const out = emitNodes(nodes, newContext(baseUrl)).trim();
  // Collapse runs of >2 blank lines down to the canonical "one blank
  // line between blocks" so block elements separated by phantom
  // inline wrappers still produce clean output.
  return out.replace(/\n{3,}/g, '\n\n') + (out.length > 0 ? '\n' : '');
}

/**
 * Block-level tags that `htmlToMarkdown` keys off of when synthesising
 * markdown structure. If a selection's cloned HTML contains *none* of
 * these, the converter has nothing to turn into headings / paragraphs /
 * lists / code blocks and will collapse the whole fragment onto one
 * line — which is the failure mode `looksLikeMarkdownSource` is built
 * to short-circuit.
 */
const MARKDOWN_BLOCK_SOURCE_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'hr',
]);

/**
 * Heuristic: was the user's selection *already* markdown source (e.g.
 * highlighted from GitHub's `?plain=1` blob view, a CodeMirror editor
 * showing a `.md` file, or a fenced code block on a docs site)?
 *
 * Two signals must both hold:
 *
 *  1. **The HTML carries no semantic block structure** — none of
 *     `MARKDOWN_BLOCK_SOURCE_TAGS` appears anywhere in the parse
 *     tree. Editor / source views build their visible lines out of
 *     `<span>` runs or `<div>`-per-line. `<div>` is intentionally
 *     kept out of the block-source set: a div-per-line editor still
 *     mangles under `htmlToMarkdown` (each line becomes its own
 *     paragraph with double-newline spacing, original indentation
 *     lost), so we *want* the short-circuit to fire on those.
 *     Empty HTML trivially satisfies this — the CodeMirror-style
 *     path where `cloneContents()` returns nothing but
 *     `Selection.toString()` has the visible text.
 *
 *  2. **The text shows ≥ 1 markdown signal**, where a signal is
 *     any of:
 *       * a line-leading markdown token (heading `# `, bullet
 *         `- `/`* `/`+ `, numbered `\d+. `, blockquote `> `, fence
 *         ```` ``` ````) at the start of a line, possibly preceded by
 *         up to 3 spaces (CommonMark caps structural indent at 3),
 *       * a pipe-table line that starts and ends with `|` (catches
 *         both data rows like `| A | B |` and the `| --- | --- |`
 *         separator),
 *       * or an inline marker anywhere in the text (backtick code,
 *         `**bold**`, single-`*` italic with non-word neighbours,
 *         `[link](url)`, `![img](url)`, reference-style
 *         `[…][word-id]`). The underscore-flavoured emphasis forms
 *         (`__bold__`, `_italic_`) are intentionally omitted because
 *         Python identifiers like `__init__` and `_name` are valid
 *         CommonMark emphasis by the spec, indistinguishable by
 *         regex. Reference-style links require at least one
 *         non-digit char in the id to skip 2D index access shapes
 *         like `arr[i][1]`.
 *
 * Threshold is intentionally low: signal #1 already does most of the
 * discrimination work — rendered pages almost always carry *some*
 * block tag in any non-trivial selection — so once we're in the
 * "no block tags at all" branch a single inline marker (or a single
 * line-leading `#`/`-`/etc.) is enough to prefer the verbatim text.
 * Selections can be short — one sentence with an inline `code` span
 * or a `[link](url)` should still be recognised.
 *
 * Returning `true` means the caller should pass the text through
 * unchanged as the markdown body instead of running it through the
 * HTML→markdown converter (which would lose all of the source's line
 * structure).
 */
export function looksLikeMarkdownSource(html: string, text: string): boolean {
  // Empty / whitespace-only text can't carry any signal we'd recover.
  // (Whitespace HTML with empty text falls out here too.)
  if (!text.trim()) return false;

  // Signal #1 — abort if any markdown-output block tag is present.
  // We walk the parse tree rather than substring-matching so
  // `<p title="foo">` style attributes can't false-positive and
  // commented-out `<p>` markup is correctly ignored. Empty HTML is
  // an empty node list and trivially has none.
  if (containsAnyTag(parseHtml(html), MARKDOWN_BLOCK_SOURCE_TAGS)) return false;

  // Signal #2 — count markdown signals in the text.
  const lines = text.split('\n');

  // Line-leading markdown tokens. The leading-whitespace allowance is
  // bounded (`{0,3}` spaces or one tab) so a deeply-indented prose
  // line doesn't claim to be a heading; CommonMark itself caps
  // structural indent at 3 spaces. We intentionally do NOT treat a
  // deeply-indented line (≥ 4 spaces) as its own signal: it's the
  // shape that Python / JS / YAML source bodies have, and the
  // single-signal threshold below would false-positive on any
  // multi-line code selection viewed in an editor. Real bullet
  // continuations come paired with their `- ` opener line, which
  // trips this regex on its own.
  const lineLeading = /^( {0,3}|\t)(#{1,6} |[-*+] |\d+\. |> |```)/;
  // Pipe-table line: starts and ends with `|` (after optional
  // whitespace). Strong signal — code rarely has lines bracketed by
  // `|` at both ends (in-line `|` for booleans / shell pipes sits
  // mid-line, not at line edges). Catches both data rows and the
  // `| --- | --- |` separator that would otherwise produce no
  // markdown signal at all (the detector doesn't have a "table"
  // concept beyond this line shape).
  const pipeTableLine = /^\s*\|.*\|\s*$/;
  // Inline markers anywhere in the text.
  const inlineLink = /\[[^\]\n]+\]\([^)\n]+\)/;
  // Reference-style link: `[label][id]`. Require the second bracket
  // to contain at least one non-digit, non-whitespace char (or be
  // empty for the shortcut form `[label][]`) so digit-only 2D index
  // accesses like `arr[i][1]` / `cells[0][1]` don't false-positive.
  // **Limitation**: alphabetic 2D index accesses (`arr[i][j]`,
  // `cells[r][c]`) DO still match. We accept that — short-circuiting
  // such a code-source selection to verbatim text produces output
  // identical to what `htmlToMarkdown` would emit (no HTML tags to
  // convert), so the misclassification is benign. We can't
  // distinguish `[abc]` as a ref id from `[abc]` as a JS access
  // without semantic context.
  const inlineRefLink = /\[[^\]\n]+\]\[(?:[^\]\n]*[^\]\n\d\s][^\]\n]*|)\]/;
  const inlineImg = /!\[[^\]\n]*\]\([^)\n]+\)/;
  const inlineCode = /`[^`\n]+`/;
  // Emphasis: only the asterisk forms. The underscore forms
  // (`__bold__`, `_italic_`) are intentionally omitted because
  // Python identifiers (`__init__`, `__name__`) are *literally*
  // valid CommonMark emphasis by the spec — space-or-punct on both
  // sides, no intraword constraint at the outer boundary — so no
  // regex can distinguish them from the real markdown form. The
  // user is plausibly viewing Python source in the same editor-style
  // HTML this heuristic is built for, so we drop the form rather
  // than risk false-positives. Real markdown almost always uses
  // `**` / `*` anyway, and our own `htmlToMarkdown` only ever emits
  // those (so the round-trip property stays intact).
  const inlineBold = /\*\*\S(?:[^*\n]*\S)?\*\*/;
  // Single-`*` italic: opens and closes on a non-space char with
  // non-word boundaries on both sides, so prose mentioning a single
  // `*` (or `arr * factor`) doesn't trip.
  const inlineItalic = /(?:^|[^*\w])\*\S[^*\n]*\S\*(?:[^*\w]|$)/;

  for (const line of lines) {
    if (lineLeading.test(line) || pipeTableLine.test(line)) return true;
  }
  for (const re of [inlineLink, inlineRefLink, inlineImg, inlineCode, inlineBold, inlineItalic]) {
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Walk a parsed-HTML node tree and return `true` if any element node
 * has a tag in `tags`. Used by `looksLikeMarkdownSource` to detect
 * whether the selection's HTML carries any of the block tags
 * `htmlToMarkdown` would actually convert from.
 */
function containsAnyTag(nodes: Node[], tags: Set<string>): boolean {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    if (tags.has(node.tag)) return true;
    if (containsAnyTag(node.children, tags)) return true;
  }
  return false;
}

/**
 * Build the markdown body for a selection. When the cloned HTML lacks
 * structural block tags but the text reads as markdown source, return
 * the text verbatim (with a single trailing newline) so the source's
 * line structure isn't lost; otherwise run the HTML through
 * `htmlToMarkdown` with the supplied `baseUrl` so relative links
 * resolve.
 *
 * Shared between the per-format selection scrape (`scrapeSelection`)
 * and the in-memory bundled capture (`captureBothToMemory`) in
 * `src/capture.ts` so both paths agree on the detection rule.
 */
export function selectionMarkdownBody(html: string, text: string, baseUrl?: string): string {
  if (looksLikeMarkdownSource(html, text)) {
    const trimmed = text.replace(/\s+$/, '');
    return trimmed.length > 0 ? trimmed + '\n' : '';
  }
  return htmlToMarkdown(html, baseUrl);
}

/**
 * Extract plain text from an HTML fragment. Block elements introduce
 * newlines; inline elements flow together. Used as the default text
 * format for captures on paths where the page-side `selection.toString()`
 * isn't available (or as the test-friendly companion to `htmlToMarkdown`).
 */
export function htmlToText(html: string): string {
  const nodes = parseHtml(html);
  const raw = emitText(nodes).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return raw.trim() + (raw.trim().length > 0 ? '\n' : '');
}

function emitText(nodes: Node[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
      continue;
    }
    if (isHiddenElement(node)) continue;
    const tag = node.tag;
    if (tag === 'br') {
      out += '\n';
      continue;
    }
    if (tag === 'hr') {
      out += '\n';
      continue;
    }
    if (tag === 'img') {
      const alt = node.attrs.alt;
      if (alt) out += alt;
      continue;
    }
    const isBlock = BLOCK_ELEMENTS.has(tag);
    if (isBlock && out.length > 0 && !out.endsWith('\n')) out += '\n';
    out += emitText(node.children);
    if (isBlock && !out.endsWith('\n')) out += '\n';
  }
  return out;
}

function emitNodes(nodes: Node[], ctx: EmitContext): string {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    // Skip elements the page itself keeps invisible (`hidden` attr or
    // inline `display: none`). The rest of the emitter doesn't need to
    // know — dropping the node here means its children, block-boundary
    // padding, and tr-run merging all just see it as absent.
    if (node.type === 'element' && isHiddenElement(node)) continue;
    // Drop whitespace-only text nodes that sit between block-level
    // siblings in pretty-printed HTML. If we kept them they'd leak
    // through as a stray " " right after the previous block's
    // trailing "\n", which then reads as a one-space indent on the
    // next block's first line (e.g. `\n - bullet` instead of
    // `\n- bullet`). Preformatted content keeps every character.
    if (
      node.type === 'text' &&
      !ctx.preformatted &&
      node.value.trim().length === 0 &&
      (out.length === 0 || out.endsWith('\n'))
    ) {
      continue;
    }
    // Stray `<tr>` fragment (no surrounding `<table>`). Happens
    // when a selection starts or ends mid-table and clones only
    // some rows. Collect consecutive `<tr>` siblings into a
    // pseudo-`<table>` with a blank header row so no data row
    // gets demoted to a heading, then let `emitTable` render it
    // as a GFM pipe table — much more readable than flattening
    // every cell onto one line.
    if (node.type === 'element' && node.tag === 'tr') {
      const run: ElementNode[] = [];
      while (i < nodes.length) {
        const n = nodes[i]!;
        if (n.type === 'element' && n.tag === 'tr') {
          if (!isHiddenElement(n)) run.push(n);
          i++;
        } else if (n.type === 'text' && n.value.trim().length === 0) {
          i++;
        } else {
          break;
        }
      }
      i--; // for-loop will re-increment
      out += emitStrayTrRun(run, ctx);
      continue;
    }
    // Ensure a block-level child doesn't get glued to preceding
    // inline text. Without this, `<li>Clone this:<pre>…</pre></li>`
    // produces `Clone this:\`\`\`…` — the `<pre>`'s fenced output
    // starts with "```" with no leading newline, concatenates onto
    // the "Clone this:" text, and the opening fence lands on the
    // same line as the list-item prose. We only prepend when the
    // running output ends mid-line (no trailing `\n`): if the
    // previous sibling already ended with a newline we leave list
    // tightness alone. List tags are excluded outright — they
    // manage their own boundary (nested `<ul>` prepends its own
    // `\n`, sibling `<li>`s chain tightly) and a forced blank
    // line would demote every nested list to "loose."
    if (
      node.type === 'element' &&
      BLOCK_ELEMENTS.has(node.tag) &&
      node.tag !== 'ul' && node.tag !== 'ol' && node.tag !== 'li'
    ) {
      if (out.length > 0 && !out.endsWith('\n')) {
        out += '\n\n';
      }
    }
    out += emitNode(node, ctx);
  }
  return out;
}

function emitInline(nodes: Node[], ctx: EmitContext): string {
  // Inline emission collapses runs of whitespace (newlines, tabs,
  // multiple spaces) into a single space — markdown treats inline
  // whitespace as insignificant and the raw newlines from pretty-
  // printed HTML would otherwise break paragraphs mid-sentence.
  const raw = emitNodes(nodes, ctx);
  return ctx.preformatted ? raw : raw.replace(/\s+/g, ' ');
}

function blockSep(out: string): string {
  // Ensure two trailing newlines so the next block is separated by a
  // blank line. Idempotent: doesn't over-count when called repeatedly.
  if (out.length === 0) return out;
  if (out.endsWith('\n\n')) return out;
  if (out.endsWith('\n')) return out + '\n';
  return out + '\n\n';
}

function emitNode(node: Node, ctx: EmitContext): string {
  if (node.type === 'text') {
    if (ctx.preformatted) return node.value;
    // Outside <pre>, collapse runs of whitespace; the surrounding
    // block emitter adds its own newlines. Also escape bare `*`
    // in text: a literal asterisk immediately adjacent to an
    // `<em>` / `<i>` emission (e.g. "*" + "*word*" from a
    // Wiki-style Proto-Indo-European reconstruction `*<i>gʷṓws</i>`)
    // otherwise collapses to `**word*` — bold-not-closed in most
    // renderers. Backslash-escape keeps the literal character
    // stable without leaking emphasis semantics.
    return node.value.replace(/\s+/g, ' ').replace(/\*/g, '\\*');
  }

  const tag = node.tag;
  switch (tag) {
    case 'h1': case 'h2': case 'h3':
    case 'h4': case 'h5': case 'h6': {
      const level = Number(tag[1]);
      const text = emitInline(node.children, ctx).trim();
      if (!text) return '';
      return blockSep(`${'#'.repeat(level)} ${text}`);
    }
    case 'p': {
      const text = emitInline(node.children, ctx).trim();
      if (!text) return '';
      return blockSep(text);
    }
    case 'br':
      return '  \n';
    case 'hr':
      return blockSep('---');
    case 'strong': case 'b':
      return wrapInline('**', node.children, ctx);
    case 'em': case 'i':
      return wrapInline('*', node.children, ctx);
    case 'u':
      return wrapInline('<u>', node.children, ctx, '</u>');
    case 's': case 'strike': case 'del':
      return wrapInline('~~', node.children, ctx);
    case 'code': {
      // Inside a `<pre>` the fenced-block emitter has already opened
      // ``` around us — just unwrap so we don't end up with nested
      // backticks. Bare inline `<code>` gets the usual span wrapping.
      if (ctx.preformatted) return emitNodes(node.children, ctx);
      const text = emitNodes(node.children, ctx);
      // If the text contains a backtick, escape by widening the fence.
      const hasBacktick = text.includes('`');
      const fence = hasBacktick ? '``' : '`';
      const pad = hasBacktick ? ' ' : '';
      return `${fence}${pad}${text}${pad}${fence}`;
    }
    case 'pre': {
      // Discover the language hint in priority order:
      //   1. `<pre class="language-X">` or `highlight-source-X`.
      //   2. `<code class="language-X">` as the sole meaningful
      //      child (the Markdown-generator convention).
      //   3. An ancestor hint supplied via ctx, e.g. GitHub's
      //      `<div class="highlight highlight-source-<lang>">`
      //      wrapper — the language name lives on the wrapper
      //      `<div>`, not on the `<pre>` or `<code>` itself.
      let lang = '';
      const preCls = node.attrs['class'] ?? '';
      const preMatch =
        /language-([\w+-]+)/.exec(preCls) ??
        /highlight-source-([\w+-]+)/.exec(preCls);
      if (preMatch) lang = preMatch[1]!;
      if (!lang) {
        const codeChild = node.children.find(
          (c): c is ElementNode => c.type === 'element' && c.tag === 'code',
        );
        if (codeChild) {
          const cls = codeChild.attrs['class'] ?? '';
          const m = /language-([\w+-]+)/.exec(cls);
          if (m) lang = m[1]!;
        }
      }
      if (!lang && ctx.preHintedLanguage) lang = ctx.preHintedLanguage;
      const inner = emitNodes(node.children, { ...ctx, preformatted: true });
      const body = inner.replace(/\n+$/, '');
      return blockSep(`\`\`\`${lang}\n${body}\n\`\`\``);
    }
    case 'blockquote': {
      const inner = emitNodes(node.children, ctx).trim();
      if (!inner) return '';
      const quoted = inner.split('\n').map((l) => (l.length ? `> ${l}` : '>')).join('\n');
      return blockSep(quoted);
    }
    case 'ul': case 'ol': {
      const kind: 'ul' | 'ol' = tag === 'ol' ? 'ol' : 'ul';
      const start = Number(node.attrs['start']);
      ctx.listStack.push({ type: kind, index: Number.isFinite(start) && start > 0 ? start : 1 });
      // Pretty-printed HTML (`<ol>\n  <li>…</li>\n  <li>…</li>\n</ol>`)
      // includes whitespace-only text nodes between the `<li>`
      // children. Emitting them would prepend stray spaces before
      // each list marker and the output would render as an indented
      // pseudo-code block rather than a list. Drop non-`<li>`
      // children here — nested `<ul>`/`<ol>` live inside a `<li>`
      // anyway.
      const items = node.children.filter(
        (c): c is ElementNode => c.type === 'element' && c.tag === 'li',
      );
      const body = emitNodes(items, ctx);
      ctx.listStack.pop();
      // Nested lists: lead with a newline so the parent `<li>`'s text
      // and the first nested marker don't end up on the same line.
      // Top-level lists get the usual block separator around them.
      return ctx.listStack.length === 0 ? blockSep(body.trimEnd()) : '\n' + body;
    }
    case 'li': {
      const frame = ctx.listStack[ctx.listStack.length - 1];
      const marker = frame?.type === 'ol' ? `${frame.index++}.` : '-';
      // If the only meaningful child is a nested list, render an
      // empty outer item with the nested list indented below.
      // Without this we'd flow through the normal path, emit the
      // nested list's `- a` on the same line as our `- ` marker,
      // and produce the ambiguous `- - a` double-marker.
      const meaningful = node.children.filter(
        (c) => !(c.type === 'text' && c.value.trim().length === 0),
      );
      if (
        meaningful.length === 1 &&
        meaningful[0]!.type === 'element' &&
        (meaningful[0]!.tag === 'ul' || meaningful[0]!.tag === 'ol')
      ) {
        const nested = emitNode(meaningful[0]!, ctx);
        // Nested list emits with a leading `\n` (see the `ul`/`ol`
        // case). Strip it, indent the body, re-attach after our
        // empty marker line.
        const lines = nested.replace(/^\n/, '').split('\n');
        const indented = lines.map((l) => (l.length ? '  ' + l : '')).join('\n');
        return `${marker}\n${indented}${indented.endsWith('\n') ? '' : '\n'}`;
      }
      const body = emitNodes(node.children, ctx).trim();
      if (!body) return `${marker}\n`;
      // The li renders at the current depth with no leading indent;
      // a surrounding <li> (if any) re-indents *all* our body lines
      // uniformly. Subsequent lines (nested lists, wrapped paragraphs)
      // get a 2-space hanging indent so they sit under the marker.
      const lines = body.split('\n');
      // `trimEnd` on the first line kills the stray space that
      // ends up between the parent-li text and a following
      // nested sublist (`<li>Foo: <ul>…</ul></li>` collapses the
      // whitespace before `<ul>` into a single trailing " ").
      const first = (lines.shift() ?? '').trimEnd();
      const rest = lines
        .map((l) => (l.length === 0 ? '' : '  ' + l))
        .join('\n');
      return `${marker} ${first}${rest ? '\n' + rest : ''}\n`;
    }
    case 'a': {
      const rawHref = node.attrs['href'] ?? '';
      const href = resolveUrl(rawHref, ctx.baseUrl);
      if (ctx.insideLink || !href) {
        return emitInline(node.children, ctx);
      }
      // `<a>` wrapping a block element (e.g. a GitHub theme's
      // anchor-wrapped heading: `<a href="#perma"><h2>Title</h2></a>`)
      // can't become `[## Title](url)` — the `##` would land inside
      // the link label and render as literal text, not a heading.
      // Unwrap: emit the block content at block level and drop the
      // link target. The author almost always means "this heading
      // *is* the permalink anchor," and losing the URL is cleaner
      // than mangling the structure.
      const hasBlockChild = node.children.some(
        (c): c is ElementNode => c.type === 'element' && BLOCK_ELEMENTS.has(c.tag),
      );
      if (hasBlockChild) {
        return emitNodes(node.children, ctx);
      }
      const text = emitInline(node.children, { ...ctx, insideLink: true }).trim();
      // Drop empty-text anchors outright. They're almost always
      // decorative chrome — GitHub's `#permalink` icons (`<a
      // href="#foo"><svg>...</svg></a>`), font-icon buttons, and
      // invisible skip-to-content links. A markdown autolink
      // (`<https://x>`) is not a useful fallback here: if the
      // author wanted the URL text visible they'd have written it
      // inside the anchor.
      if (!text) return '';
      return `[${text}](${href})`;
    }
    case 'img': {
      const src = resolveUrl(node.attrs['src'] ?? '', ctx.baseUrl);
      const alt = node.attrs['alt'] ?? '';
      if (!src) return alt;
      return `![${alt}](${src})`;
    }
    case 'table':
      return blockSep(emitTable(node, ctx));
    case 'thead': case 'tbody': case 'tfoot':
      return emitNodes(node.children, ctx);
    case 'tr': case 'td': case 'th':
      // Stray table fragments outside a <table>: just unwrap so the
      // text survives. The `<table>` path handles the real case.
      return emitInline(node.children, ctx);
    case 'div': case 'section': case 'article':
    case 'main': case 'header': case 'footer':
    case 'aside': case 'nav': case 'figure': case 'figcaption': {
      // Block-level containers: trim leading/trailing whitespace the
      // source HTML put inside them (pretty-print indent, stray
      // spaces at the start of the text) and separate from adjacent
      // siblings with a blank line. Sibling block divs then read as
      // separate paragraphs instead of running together on one line,
      // and inside a `<li>` each becomes a loose list-item
      // continuation paragraph.
      //
      // Also sniff the class attribute for a GitHub-style code-
      // block language hint (`<div class="highlight
      // highlight-source-bash">…<pre>…</pre>…</div>`) and push it
      // down via ctx so the inner `<pre>` can pick it up.
      let childCtx = ctx;
      const cls = node.attrs['class'] ?? '';
      const langMatch = /highlight-source-([\w+-]+)/.exec(cls);
      if (langMatch) {
        childCtx = { ...ctx, preHintedLanguage: langMatch[1] };
      }
      const body = emitNodes(node.children, childCtx).trim();
      return body ? blockSep(body) : '';
    }
    default:
      // Unknown / inline-ish tag: unwrap its children.
      return emitNodes(node.children, ctx);
  }
}

function wrapInline(
  open: string,
  children: Node[],
  ctx: EmitContext,
  close?: string,
): string {
  const text = emitInline(children, ctx);
  if (!text.trim()) return text;
  return `${open}${text}${close ?? open}`;
}

function emitStrayTrRun(trs: ElementNode[], ctx: EmitContext): string {
  // Synthesize a `<table>` wrapper so a selected run of rows that
  // lacks one still renders as a pipe table. Prepend an *empty*
  // header row so no data row gets visually promoted to a header
  // — for partial-table captures every row is body content.
  const countCells = (tr: ElementNode): number =>
    tr.children.filter(
      (c) => c.type === 'element' && (c.tag === 'td' || c.tag === 'th'),
    ).length;
  const cellCounts = trs.map(countCells);
  const maxCells = Math.max(0, ...cellCounts);
  if (maxCells === 0) return '';

  // If the first row has fewer cells than the widest row, treat it
  // as a selection that started mid-row: the cells it carries are
  // the RIGHTMOST columns of the full row, so pad the missing
  // slots onto the *left* side. Default `emitTable` padding is
  // trailing (right), which works for the last row (a selection
  // that ended mid-row → early columns only) but would mis-align
  // the first-row tail case.
  const adjusted = trs.slice();
  if (adjusted.length > 0 && cellCounts[0]! < maxCells) {
    const missing = maxCells - cellCounts[0]!;
    const blanks: ElementNode[] = [];
    for (let k = 0; k < missing; k++) {
      blanks.push({ type: 'element', tag: 'td', attrs: {}, children: [] });
    }
    adjusted[0] = { ...adjusted[0]!, children: [...blanks, ...adjusted[0]!.children] };
  }

  const blankHeaderCells: ElementNode[] = [];
  for (let k = 0; k < maxCells; k++) {
    blankHeaderCells.push({ type: 'element', tag: 'th', attrs: {}, children: [] });
  }
  const blankHeader: ElementNode = {
    type: 'element', tag: 'tr', attrs: {}, children: blankHeaderCells,
  };
  const syntheticTable: ElementNode = {
    type: 'element', tag: 'table', attrs: {}, children: [blankHeader, ...adjusted],
  };
  return blockSep(emitTable(syntheticTable, ctx));
}

function emitTable(node: ElementNode, ctx: EmitContext): string {
  // Flatten header + body rows; every table renders as a GFM-style
  // pipe table with a separator row under the first row.
  const rows: ElementNode[][] = [];
  const collectRows = (n: ElementNode): void => {
    for (const child of n.children) {
      if (child.type !== 'element') continue;
      if (isHiddenElement(child)) continue;
      if (child.tag === 'tr') {
        const cells = child.children.filter(
          (c): c is ElementNode =>
            c.type === 'element' &&
            (c.tag === 'td' || c.tag === 'th') &&
            !isHiddenElement(c),
        );
        rows.push(cells);
      } else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
        collectRows(child);
      }
    }
  };
  collectRows(node);

  if (rows.length === 0) return '';

  const cellText = (cell: ElementNode): string =>
    emitInline(cell.children, ctx).replace(/\|/g, '\\|').trim();
  const rendered = rows.map((r) => r.map(cellText));
  const cols = Math.max(...rendered.map((r) => r.length));
  const padded = rendered.map((r) => {
    const out = r.slice();
    while (out.length < cols) out.push('');
    return out;
  });

  const header = padded[0]!;
  const separator = new Array(cols).fill('---');
  const body = padded.slice(1);

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}
