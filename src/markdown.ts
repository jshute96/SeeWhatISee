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
//   - `htmlToMarkdown(html)` — entry point. Never throws on
//     malformed input; it treats bad markup as best-effort text.
//   - `htmlToText(html)`    — text-only fallback. Used on platforms
//     where the scrape can't produce a reliable `selection.toString()`
//     (and as a test-friendly companion to the markdown converter).

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
      while (j < n) {
        const c = html[j]!;
        if (c === '"' || c === "'") {
          const q = c;
          j++;
          while (j < n && html[j] !== q) j++;
          j++; // consume closing quote
          continue;
        }
        if (c === '>') break;
        j++;
      }
      if (j >= n) { i = n; break; }
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
          run.push(n);
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
      if (child.tag === 'tr') {
        const cells = child.children.filter(
          (c): c is ElementNode => c.type === 'element' && (c.tag === 'td' || c.tag === 'th'),
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
