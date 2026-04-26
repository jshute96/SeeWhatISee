// Unit tests for `src/markdown.ts` — HTML → markdown + HTML → text
// conversion used by the selection capture paths.
//
// Runs under Node's built-in `node:test` runner (Node 20+), reading
// the compiled module out of `dist/`. The `pretest:unit` script in
// package.json builds `dist/` first, so invoking `npm run test:unit`
// is enough; running `node --test` directly on these files also
// works once `dist/` exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  htmlToMarkdown as _htmlToMarkdown,
  htmlToText,
  looksLikeMarkdownSource,
  selectionMarkdownBody,
} from '../../dist/markdown.js';

// Small helper: normalize trailing whitespace so we can write the
// expected strings without worrying about the converter's canonical
// single-newline terminator.
function norm(s) {
  return s.replace(/\s+$/, '');
}

// Wrapper around `htmlToMarkdown` that also asserts the round-trip
// invariant: the converter's output should itself be detected as
// markdown source (i.e. `looksLikeMarkdownSource('', output) ===
// true`). This double-binds the converter and the detector — drift
// in either direction breaks the test.
//
// Calling shapes:
//   htmlToMarkdown(html)
//   htmlToMarkdown(html, baseUrl)
//   htmlToMarkdown(html, opts)                 // no baseUrl
//   htmlToMarkdown(html, baseUrl, opts)
//
// `opts` may carry `expectLooksLikeMarkdown: false` for inputs where
// the output is genuinely plain text or single-line and isn't
// expected to trip the detector (entity-decode tests, a tiny
// `<h1>Title</h1>` snippet, etc.). Default is `true`.
function htmlToMarkdown(html, baseUrlOrOpts, maybeOpts) {
  let baseUrl;
  let opts;
  if (typeof baseUrlOrOpts === 'string' || baseUrlOrOpts === undefined) {
    baseUrl = baseUrlOrOpts;
    opts = maybeOpts;
  } else {
    baseUrl = undefined;
    opts = baseUrlOrOpts;
  }
  const md = _htmlToMarkdown(html, baseUrl);
  const expect = (opts && 'expectLooksLikeMarkdown' in opts)
    ? opts.expectLooksLikeMarkdown
    : true;
  const actual = looksLikeMarkdownSource('', md);
  if (actual !== expect) {
    assert.fail(
      `looksLikeMarkdownSource round-trip mismatch:\n` +
      `  input    = ${JSON.stringify(html)}\n` +
      `  baseUrl  = ${JSON.stringify(baseUrl)}\n` +
      `  output   = ${JSON.stringify(md)}\n` +
      `  expected = ${expect}\n` +
      `  actual   = ${actual}\n` +
      `  hint: pass { expectLooksLikeMarkdown: false } if the output is plain / single-line.`,
    );
  }
  return md;
}

// `PLAIN` opts a single `htmlToMarkdown` call out of the round-trip
// assertion. Use it for outputs that genuinely have no markdown
// signal \u2014 `hello world`, `a\n\nb`, `~~gone~~` (the detector
// doesn't recognise strikethrough), an empty string \u2014 so the
// wrapper doesn't expect detection where none is possible.
const PLAIN = { expectLooksLikeMarkdown: false };

test('plain text passes through', () => {
  assert.equal(norm(htmlToMarkdown('hello world', PLAIN)), 'hello world');
  assert.equal(norm(htmlToText('hello world')), 'hello world');
});

test('decodes common HTML entities', () => {
  assert.equal(
    norm(htmlToMarkdown('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;', PLAIN)),
    `a & b < c > d "e" 'f'`,
  );
  assert.equal(norm(htmlToMarkdown('&#x2014;', PLAIN)), '\u2014');
});

test('headings become hashes', () => {
  assert.equal(norm(htmlToMarkdown('<h1>Title</h1>')), '# Title');
  assert.equal(norm(htmlToMarkdown('<h3>Nested</h3>')), '### Nested');
  assert.equal(norm(htmlToMarkdown('<h6>Deep</h6>')), '###### Deep');
});

test('paragraphs separated by blank lines', () => {
  const out = norm(htmlToMarkdown('<p>One</p><p>Two</p>', PLAIN));
  assert.equal(out, 'One\n\nTwo');
});

test('bold / italic / strikethrough', () => {
  assert.equal(norm(htmlToMarkdown('<b>bold</b>')), '**bold**');
  assert.equal(norm(htmlToMarkdown('<strong>also</strong>')), '**also**');
  assert.equal(norm(htmlToMarkdown('<i>it</i>')), '*it*');
  assert.equal(norm(htmlToMarkdown('<em>em</em>')), '*em*');
  // Strikethrough output `~~gone~~` carries no detector signal — the
  // detector deliberately doesn't recognise `~~`, so opt out.
  assert.equal(norm(htmlToMarkdown('<del>gone</del>', PLAIN)), '~~gone~~');
});

test('literal asterisk next to <i> stays distinguishable', () => {
  // Wikipedia PIE-reconstruction pattern: `*<i>gʷṓws</i>`. Without
  // escaping, the `*` collides with the italic's opening `*` and
  // the output reads as `**gʷṓws*` — unterminated bold. Backslash-
  // escape keeps the literal asterisk a literal.
  assert.equal(
    norm(htmlToMarkdown('*<i>gʷṓws</i>')),
    '\\**gʷṓws*',
  );
});

test('inline code wraps in backticks', () => {
  assert.equal(norm(htmlToMarkdown('use <code>grep -rn</code> here')),
    'use `grep -rn` here');
});

test('inline code containing backticks widens the fence', () => {
  assert.equal(
    norm(htmlToMarkdown('<code>a`b</code>')),
    '`` a`b ``',
  );
});

test('br becomes hard line break', () => {
  assert.equal(norm(htmlToMarkdown('line one<br>line two', PLAIN)),
    'line one  \nline two');
});

test('hr becomes a thematic break', () => {
  assert.equal(norm(htmlToMarkdown('<p>a</p><hr><p>b</p>', PLAIN)),
    'a\n\n---\n\nb');
});

test('unordered list', () => {
  const out = norm(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>'));
  assert.equal(out, '- one\n- two');
});

test('ordered list', () => {
  const out = norm(htmlToMarkdown('<ol><li>one</li><li>two</li></ol>'));
  assert.equal(out, '1. one\n2. two');
});

test('ordered list with start attribute', () => {
  const out = norm(htmlToMarkdown('<ol start="5"><li>a</li><li>b</li></ol>'));
  assert.equal(out, '5. a\n6. b');
});

test('whitespace text nodes between block siblings do not bleed as indent', () => {
  // Pretty-printed HTML with newlines between block siblings would
  // otherwise emit " ### Heading" (leading space pushing the `#`s
  // off the start of the line and breaking the heading).
  const out = norm(htmlToMarkdown(
    '<h3>A</h3>\n<p>body</p>\n<h3>B</h3>',
  ));
  assert.equal(out, '### A\n\nbody\n\n### B');
});

test('empty headings are dropped', () => {
  const out = norm(htmlToMarkdown('<h3>A</h3><h3></h3><h3>B</h3>'));
  assert.equal(out, '### A\n\n### B');
});

test('sibling block divs inside a <li> become loose list-item continuation paragraphs', () => {
  // Real-world case: a React-rendered task list where each task is
  // a separate `<div>` inside a single `<li>`. Want each task on its
  // own line (as a continuation paragraph), not all run together.
  const out = norm(htmlToMarkdown(
    '<ul><li>' +
      '<div>task one</div>' +
      '<div>task two</div>' +
      '<div>task three</div>' +
    '</li></ul>',
  ));
  assert.equal(out, '- task one\n\n  task two\n\n  task three');
});

test('leading whitespace inside a block container is trimmed', () => {
  // `<div> I have searched <a>existing issues</a></div>` — the
  // literal leading space in the text node would otherwise show up
  // as `   text` on the emitted line.
  const out = norm(htmlToMarkdown(
    '<div> hello <a href="https://x">world</a></div>',
  ));
  assert.equal(out, 'hello [world](https://x)');
});

test('whitespace text nodes between <li> are ignored', () => {
  // Pretty-printed HTML with newlines + indentation between list
  // items would otherwise emit " 1. one\n 2. two", which reads as
  // an indented pre-block rather than a numbered list.
  const out = norm(htmlToMarkdown(
    '<ol>\n  <li>/config</li>\n  <li>change a setting</li>\n  <li>exit config</li>\n</ol>',
  ));
  assert.equal(out, '1. /config\n2. change a setting\n3. exit config');
});

test('nested lists indent', () => {
  const out = norm(htmlToMarkdown(
    '<ul><li>a<ul><li>a.1</li><li>a.2</li></ul></li><li>b</li></ul>',
  ));
  assert.equal(out, '- a\n  - a.1\n  - a.2\n- b');
});

test('links and images', () => {
  assert.equal(
    norm(htmlToMarkdown('<a href="https://x.example">hi</a>')),
    '[hi](https://x.example)',
  );
  assert.equal(
    norm(htmlToMarkdown('<img src="pic.png" alt="photo">')),
    '![photo](pic.png)',
  );
  assert.equal(
    norm(htmlToMarkdown('<img src="pic.png">')),
    '![](pic.png)',
  );
});

test('empty-text anchors are dropped', () => {
  // No text = decorative chrome (permalink icons, font-icon
  // buttons, skip-to-content links). Dropping is friendlier than
  // emitting an autolink the reader didn't ask for. Output is `''`,
  // which the detector returns false on.
  assert.equal(norm(htmlToMarkdown('<a href="https://x.example"></a>', PLAIN)), '');
  assert.equal(norm(htmlToMarkdown('<a href="#usage"></a>', PLAIN)), '');
});

test('github-style heading permalink anchor is dropped', () => {
  // Real-world GitHub source — a visible heading followed by an
  // invisible `<a href="#usage"><svg>...</svg></a>` permalink
  // icon. The anchor should disappear, not emit `<#usage>` or a
  // stray `[](#usage)`.
  const html =
    '<div><h2>Usage</h2>' +
    '<a id="user-content-usage" class="anchor" href="#usage">' +
    '<svg class="octicon"><path d=""></path></svg>' +
    '</a></div>' +
    '<h3>Chrome extension</h3>';
  assert.equal(norm(htmlToMarkdown(html)), '## Usage\n\n### Chrome extension');
});

test('blockquote', () => {
  const out = norm(htmlToMarkdown('<blockquote><p>Hello</p><p>There</p></blockquote>'));
  assert.equal(out, '> Hello\n>\n> There');
});

test('fenced code block with language hint', () => {
  const out = norm(htmlToMarkdown(
    '<pre><code class="language-js">const x = 1;\nconsole.log(x);</code></pre>',
  ));
  assert.equal(out, '```js\nconst x = 1;\nconsole.log(x);\n```');
});

test('fenced code block without language hint', () => {
  const out = norm(htmlToMarkdown('<pre>plain text\nnext line</pre>'));
  assert.equal(out, '```\nplain text\nnext line\n```');
});

test('fenced code inside <li> breaks onto its own line', () => {
  // Real-world case: a GitHub-rendered install step whose `<li>`
  // contains "Clone…:" followed by `<div class="highlight"><pre>…`.
  // Without the block-boundary insertion the output glues the
  // opening fence onto the text line (`Clone…:\`\`\``), which
  // doesn't render as a code block.
  const out = norm(htmlToMarkdown(
    '<ol><li>Clone this repo:<pre>git clone foo\ncd foo</pre></li></ol>',
  ));
  assert.equal(
    out,
    '1. Clone this repo:\n\n  ```\n  git clone foo\n  cd foo\n  ```',
  );
});

test('language hint on github-style highlight wrapper propagates to <pre>', () => {
  // GitHub ships rendered code blocks as `<div class="highlight
  // highlight-source-<lang>"><pre>…</pre></div>`. The language
  // name lives on the wrapper, not on `<pre>` / `<code>` — our
  // ctx-hint plumbing lets the inner `<pre>` pick it up.
  const out = norm(htmlToMarkdown(
    '<div class="highlight highlight-source-bash"><pre>npm install</pre></div>',
  ));
  assert.equal(out, '```bash\nnpm install\n```');
});

test('language hint on <pre class="language-X"> is honored', () => {
  const out = norm(htmlToMarkdown('<pre class="language-ts">let x: number;</pre>'));
  assert.equal(out, '```ts\nlet x: number;\n```');
});

test('simple table', () => {
  const out = norm(htmlToMarkdown(
    '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
    '<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>',
  ));
  assert.equal(
    out,
    '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
  );
});

test('stray <tr> fragments render as a pipe table with blank header', () => {
  // Selection started / ended mid-table — the clone has `<tr>`s but
  // no `<table>`. We synthesize an empty header so no data row gets
  // demoted to a heading, and emit a valid GFM pipe table.
  const out = norm(htmlToMarkdown(
    '<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr>',
  ));
  assert.equal(
    out,
    '|  |  |\n| --- | --- |\n| a | b |\n| c | d |',
  );
});

test('stray <tr> fragments with mixed cell counts pad to widest row', () => {
  // First row shorter — treat as the tail of a mid-row selection,
  // left-pad its cells into the rightmost columns. Later rows keep
  // trailing-pad (head of a cut row).
  const out = norm(htmlToMarkdown(
    '<tr><td>a</td></tr><tr><td>x</td><td>y</td><td>z</td></tr>',
  ));
  assert.equal(
    out,
    '|  |  |  |\n| --- | --- | --- |\n|  |  | a |\n| x | y | z |',
  );
});

test('stray <tr> fragments: last row short keeps trailing pad', () => {
  // Head of a mid-row-ending selection: cells are the leftmost
  // columns; trailing pad is correct.
  const out = norm(htmlToMarkdown(
    '<tr><td>a</td><td>b</td><td>c</td></tr><tr><td>x</td></tr>',
  ));
  assert.equal(
    out,
    '|  |  |  |\n| --- | --- | --- |\n| a | b | c |\n| x |  |  |',
  );
});

test('table with unaligned row widths pads trailing empty cells', () => {
  const out = norm(htmlToMarkdown(
    '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>',
  ));
  assert.equal(
    out,
    '| A | B |\n| --- | --- |\n| 1 |  |',
  );
});

test('drops elements with the hidden attribute', () => {
  // Pages frequently stash never-shown chrome (snackbar templates,
  // skeleton placeholders) behind the HTML5 `hidden` attribute. The
  // user doesn't see them on screen, so neither should the markdown.
  assert.equal(
    norm(htmlToMarkdown('<p>before</p><div hidden>secret</div><p>after</p>', PLAIN)),
    'before\n\nafter',
  );
  assert.equal(
    norm(htmlToText('<p>before</p><div hidden>secret</div><p>after</p>')),
    'before\nafter',
  );
});

test('drops elements with inline display:none', () => {
  // Real-world case: Google's `<g-snackbar style="display:none">…</g-snackbar>`
  // — visible in the HTML source but invisible to the user. We don't
  // run a layout engine, but inline `display:none` is the cheap signal
  // that catches the most common patterns.
  assert.equal(
    norm(htmlToMarkdown(
      '<p>before</p><div style="display:none">secret</div><p>after</p>',
      PLAIN,
    )),
    'before\n\nafter',
  );
  assert.equal(
    norm(htmlToMarkdown(
      '<p>a</p><span style="color:red; display: none !important">x</span><p>b</p>',
      PLAIN,
    )),
    'a\n\nb',
  );
  // Browsers accept `!important` with no space; real-world inline styles
  // do show up in this form.
  assert.equal(
    norm(htmlToMarkdown(
      '<p>a</p><span style="display:none!important">x</span><p>b</p>',
      PLAIN,
    )),
    'a\n\nb',
  );
});

test('display:none subtree drops its visible-looking children too', () => {
  // Locks the contract that hiding propagates: a hidden parent erases
  // everything underneath it, not just its own immediate text.
  const out = norm(htmlToMarkdown(
    '<p>before</p>' +
    '<div hidden><p>inner para</p><span>inner span</span></div>' +
    '<p>after</p>',
    PLAIN,
  ));
  assert.equal(out, 'before\n\nafter');
});

test('inline display:none nested inside a parent is also dropped', () => {
  const out = norm(htmlToMarkdown(
    '<p>visible <span style="display:none">hidden</span> tail</p>',
    PLAIN,
  ));
  assert.equal(out, 'visible tail');
});

test('display:none false-positive guard: substring inside a value does not hide', () => {
  // The check walks declaration-by-declaration, so a substring like
  // `display:none.png` inside a `background` URL doesn't trip it.
  const out = norm(htmlToMarkdown(
    '<p style="background: url(\'display:none.png\')">visible</p>',
    PLAIN,
  ));
  assert.equal(out, 'visible');
});

test('non-display style declarations are not hidden', () => {
  const out = norm(htmlToMarkdown(
    '<p style="visibility: hidden">still rendered</p>',
    PLAIN,
  ));
  // visibility:hidden takes layout space and we intentionally don't
  // try to chase it — the converter only recognizes `display:none`
  // and the `hidden` attribute.
  assert.equal(out, 'still rendered');
});

test('hidden table rows are skipped from the rendered table', () => {
  const out = norm(htmlToMarkdown(
    '<table>' +
    '<tr><th>A</th><th>B</th></tr>' +
    '<tr hidden><td>x</td><td>y</td></tr>' +
    '<tr><td>1</td><td>2</td></tr>' +
    '</table>',
  ));
  assert.equal(out, '| A | B |\n| --- | --- |\n| 1 | 2 |');
});

test('hidden cells inside a visible row are dropped', () => {
  const out = norm(htmlToMarkdown(
    '<table>' +
    '<tr><th>A</th><th>B</th></tr>' +
    '<tr><td>1</td><td hidden>secret</td><td>3</td></tr>' +
    '</table>',
  ));
  // Width comes from the (now 2-cell) row count; the hidden cell is
  // erased rather than blanked, so the surviving cells slide left.
  assert.equal(out, '| A | B |\n| --- | --- |\n| 1 | 3 |');
});

test('hidden stray <tr> rows are dropped from a synthesized table', () => {
  const out = norm(htmlToMarkdown(
    '<tr><td>a</td><td>b</td></tr>' +
    '<tr style="display:none"><td>x</td><td>y</td></tr>' +
    '<tr><td>c</td><td>d</td></tr>',
  ));
  assert.equal(
    out,
    '|  |  |\n| --- | --- |\n| a | b |\n| c | d |',
  );
});

test('drops script and style contents', () => {
  const out = norm(htmlToMarkdown(
    '<p>before</p><script>alert(1)</script><style>.x{}</style><p>after</p>',
    PLAIN,
  ));
  assert.equal(out, 'before\n\nafter');
});

test('div / span unwrap to their text', () => {
  const out = norm(htmlToMarkdown(
    '<div><span>outer </span><span><b>bold</b></span></div>',
  ));
  assert.equal(out, 'outer **bold**');
});

test('ignores comments', () => {
  const out = norm(htmlToMarkdown('hello<!-- hidden -->world', PLAIN));
  assert.equal(out, 'helloworld');
});

test('ignores comments between block siblings', () => {
  assert.equal(
    norm(htmlToMarkdown('<p>a</p><!-- gap --><p>b</p>', PLAIN)),
    'a\n\nb',
  );
});

test('ignores comments between <li> elements', () => {
  // A non-`<li>` child of `<ul>` would otherwise trip the list
  // emitter. The parser skips the comment entirely so the ul sees
  // only its two `<li>` children.
  assert.equal(
    norm(htmlToMarkdown('<ul><li>a</li><!-- between --><li>b</li></ul>')),
    '- a\n- b',
  );
});

test('ignores comments that wrap <li>-looking content', () => {
  assert.equal(
    norm(htmlToMarkdown('<ul><li>only<!-- <li>fake</li> --></li></ul>')),
    '- only',
  );
});

test('unclosed comment eats the rest of the input', () => {
  // Defensive: a truncated selection ending mid-comment shouldn't
  // surface as raw `<!--` in the output.
  assert.equal(norm(htmlToMarkdown('<p>a</p><!-- never closed', PLAIN)), 'a');
});

test('collapses whitespace in inline runs', () => {
  const out = norm(htmlToMarkdown('<p>  extra    space\n\nbetween\t  words  </p>', PLAIN));
  assert.equal(out, 'extra space between words');
});

test('preformatted preserves whitespace', () => {
  const out = norm(htmlToMarkdown(
    '<pre>line 1\n  indented\nline 3</pre>',
  ));
  assert.equal(out, '```\nline 1\n  indented\nline 3\n```');
});

test('tolerates mismatched close tag', () => {
  const out = norm(htmlToMarkdown('<p>open without</p></div>', PLAIN));
  assert.equal(out, 'open without');
});

test('tolerates unclosed tag', () => {
  const out = norm(htmlToMarkdown('<p>never closed', PLAIN));
  assert.equal(out, 'never closed');
});

test('tolerates unclosed attribute quote without eating the rest', () => {
  // Regression: the tag scanner used to run the quote-match to EOF
  // and then abort, silently dropping everything after the bad
  // tag. The converter promises best-effort on malformed input; at
  // minimum the content after the broken tag must survive.
  const out = norm(htmlToMarkdown('<a href="unclosed>text</a><p>more</p>'));
  assert.match(out, /more/);
});

test('<a> wrapping a heading unwraps instead of emitting ## inside label', () => {
  // A GitHub theme pattern: `<a href="#perma"><h2>Section</h2></a>`.
  // Emitting the children as a link label would produce the literal
  // text `[## Section](#perma)` — the `##` renders as text, not a
  // heading. Drop the anchor and emit the block content.
  const out = norm(htmlToMarkdown('<a href="/x"><h2>Section</h2></a>'));
  assert.equal(out, '## Section');
});

test('<li> containing only a nested list emits an empty outer marker', () => {
  // Without this special case the outer `<li>` prepends its `- `
  // to the nested list's already-emitted `- a`, giving an ambiguous
  // `- - a` double-marker line.
  const out = norm(htmlToMarkdown('<ul><li><ul><li>a</li></ul></li></ul>'));
  assert.equal(out, '-\n  - a');
});

test('attribute value with embedded greater-than is parsed safely', () => {
  const out = norm(htmlToMarkdown('<a href="https://x?q=a>b">go</a>'));
  assert.equal(out, '[go](https://x?q=a>b)');
});

// ─── Relative URL resolution ──────────────────────────────────────

test('relative link resolves against base URL', () => {
  const out = norm(htmlToMarkdown(
    '<a href="next.html">go</a>',
    'https://example.com/docs/index.html',
  ));
  assert.equal(out, '[go](https://example.com/docs/next.html)');
});

test('root-absolute link resolves against base origin', () => {
  const out = norm(htmlToMarkdown(
    '<a href="/about">about</a>',
    'https://example.com/docs/index.html',
  ));
  assert.equal(out, '[about](https://example.com/about)');
});

test('protocol-relative link picks up base protocol', () => {
  const out = norm(htmlToMarkdown(
    '<a href="//cdn.example.com/x">x</a>',
    'https://example.com/',
  ));
  assert.equal(out, '[x](https://cdn.example.com/x)');
});

test('absolute link is left alone', () => {
  const out = norm(htmlToMarkdown(
    '<a href="https://other.example/y">y</a>',
    'https://example.com/',
  ));
  assert.equal(out, '[y](https://other.example/y)');
});

test('fragment-only link stays as anchor', () => {
  const out = norm(htmlToMarkdown(
    '<a href="#section-2">jump</a>',
    'https://example.com/docs/',
  ));
  assert.equal(out, '[jump](#section-2)');
});

test('query-only link resolves against base path', () => {
  const out = norm(htmlToMarkdown(
    '<a href="?tab=2">t</a>',
    'https://example.com/docs/page.html',
  ));
  assert.equal(out, '[t](https://example.com/docs/page.html?tab=2)');
});

test('relative image src resolves against base URL', () => {
  const out = norm(htmlToMarkdown(
    '<img src="img/pic.png" alt="p">',
    'https://example.com/docs/index.html',
  ));
  assert.equal(out, '![p](https://example.com/docs/img/pic.png)');
});

test('no base URL → relative hrefs pass through unchanged', () => {
  const out = norm(htmlToMarkdown('<a href="foo.html">f</a>'));
  assert.equal(out, '[f](foo.html)');
});

test('malformed base URL leaves hrefs unchanged', () => {
  // `new URL('x', 'not a url')` throws; the converter should swallow
  // and emit the raw ref rather than propagating the error.
  const out = norm(htmlToMarkdown('<a href="x">x</a>', 'not a url'));
  assert.equal(out, '[x](x)');
});


// ─── htmlToText ────────────────────────────────────────────────────

test('text extractor returns just the text', () => {
  assert.equal(
    norm(htmlToText('<h1>Title</h1><p>Hello <b>world</b>.</p>')),
    'Title\nHello world.',
  );
});

test('text extractor separates block elements with newlines', () => {
  assert.equal(
    norm(htmlToText('<p>One</p><p>Two</p><p>Three</p>')),
    'One\nTwo\nThree',
  );
});

test('text extractor drops script / style content', () => {
  assert.equal(
    norm(htmlToText('<p>a</p><script>x()</script><p>b</p>')),
    'a\nb',
  );
});

test('text extractor keeps image alt', () => {
  assert.equal(
    norm(htmlToText('See <img src="x.png" alt="the chart"> below')),
    'See the chart below',
  );
});

test('empty input returns empty output', () => {
  assert.equal(htmlToMarkdown('', PLAIN), '');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToMarkdown('   ', PLAIN), '');
  assert.equal(htmlToText('   '), '');
});

// ─── looksLikeMarkdownSource ──────────────────────────────────────
//
// Heuristic detector for "the user selected something that's already
// markdown source" — see `looksLikeMarkdownSource` in src/markdown.ts
// for the rule. The cases below cover the GitHub-blob and CodeMirror
// editor patterns that motivated the helper, plus the negative cases
// it has to reject.

test('detects GitHub-style markdown source: span-only HTML, headings + bullets in text', () => {
  // `?plain=1` blob view of a `.md` file. Each visible line is a row
  // of `<span>`s for syntax highlight; no semantic block tags.
  const html =
    '<span>#</span><span> Heading</span><span>\n</span>' +
    '<span>-</span><span> first bullet</span><span>\n</span>' +
    '<span>-</span><span> second bullet</span>';
  const text = '# Heading\n- first bullet\n- second bullet';
  assert.equal(looksLikeMarkdownSource(html, text), true);
});

test('detects text-heavy markdown with sparse inline markers', () => {
  // Two wrapped paragraphs of prose with only a `**bold**`, a `code`,
  // and a `[link](url)` — any one of those inline markers alone is
  // enough to trip the detector once signal #1 has cleared.
  const html = '<span>(several spans of prose)</span>';
  const text =
    'This paragraph mentions a **key term** in passing and runs to the\n' +
    'end of the line as wrapped prose, nothing fancy.\n' +
    '\n' +
    'A second paragraph drops a `snippet` and a [link](https://example.com)\n' +
    'across more wrapped text, again no special structure to it.';
  assert.equal(looksLikeMarkdownSource(html, text), true);
});

test('detects multi-line bullet selection', () => {
  // The bullet line-leading marker is the signal; the continuation
  // indent on line 2 is intentionally NOT counted as a separate
  // signal (see comment in `looksLikeMarkdownSource` — would
  // false-positive on Python / JS source bodies).
  const html = '<span>- top item</span><span>\n  more text on the next line</span>';
  const text = '- top item\n  more text on the next line';
  assert.equal(looksLikeMarkdownSource(html, text), true);
});

test('CM6/GitHub-blob path: empty HTML, multi-line markdown text', () => {
  // After commit e105761, CodeMirror-style selections come back with
  // `html === ''` but `text` populated. Empty HTML trivially satisfies
  // signal #1; the text carries the markdown signals.
  const html = '';
  const text =
    '## A subsection\n' +
    '\n' +
    'Some prose with a `code` span and a [link](https://x.test).\n' +
    '\n' +
    '- bullet one\n' +
    '- bullet two';
  assert.equal(looksLikeMarkdownSource(html, text), true);
});

test('CM6/GitHub-blob path: empty HTML with plain prose text → false', () => {
  // Same selection shape, but the underlying file is just text — no
  // markdown markers anywhere. Detector correctly declines so we don't
  // pretend a `.txt` paste is markdown.
  const html = '';
  const text =
    'just some prose without any special markup whatsoever\n' +
    'wrapped across two lines for good measure';
  assert.equal(looksLikeMarkdownSource(html, text), false);
});

test('rendered prose paragraph mentioning "# hi" → false', () => {
  // The literal `# hi` appears inside a `<p>`, so signal #1 fails
  // (the HTML carries a block tag the converter can use).
  const html = '<p>I was thinking about # hi as a heading marker</p>';
  const text = 'I was thinking about # hi as a heading marker';
  assert.equal(looksLikeMarkdownSource(html, text), false);
});

test('real list selection with <ul><li> → false', () => {
  // The converter handles this case fine via its `<ul>`/`<li>`
  // emitters; we want it to take that path, not short-circuit.
  const html = '<ul><li>one</li><li>two</li></ul>';
  const text = 'one\ntwo';
  assert.equal(looksLikeMarkdownSource(html, text), false);
});

test('plain-text multi-line selection with no markdown markers → false', () => {
  const html = '<span>line one</span><span>\n</span><span>line two</span>';
  const text = 'line one\nline two';
  assert.equal(looksLikeMarkdownSource(html, text), false);
});

test('single-line selection starting with "# " → true', () => {
  // A one-line selection that looks like a markdown heading in
  // editor-style HTML is detected. Selections can be short — a
  // single line with one markdown signal is enough.
  const html = '<span># Heading on one line</span>';
  const text = '# Heading on one line';
  assert.equal(looksLikeMarkdownSource(html, text), true);
});

test('single-line selection with one inline backtick → true', () => {
  // The motivating case: a selection like `Click \`Submit\` to
  // continue` from an editor view should be preserved verbatim
  // rather than re-converted via htmlToMarkdown.
  const html = '<span>Click `Submit` to continue</span>';
  const text = 'Click `Submit` to continue';
  assert.equal(looksLikeMarkdownSource(html, text), true);
});

test('pipe-table line counts as a markdown signal', () => {
  // A line bracketed by `|` at both ends is a strong markdown table
  // shape. Code rarely has lines that start AND end with `|` —
  // boolean OR / shell pipes sit mid-line.
  const html = '<span>| A | B |</span>';
  const text = '| A | B |';
  assert.equal(looksLikeMarkdownSource(html, text), true);
});

test('mid-line pipe (boolean OR / shell pipe) is not a table signal', () => {
  // `if (a | b) {` does NOT start or end with `|`, so the
  // pipe-table regex correctly skips it.
  const html = '<span>if (a | b) {</span>';
  const text = 'if (a | b) {';
  assert.equal(looksLikeMarkdownSource(html, text), false);
});

test('empty / whitespace text returns false', () => {
  assert.equal(looksLikeMarkdownSource('', ''), false);
  assert.equal(looksLikeMarkdownSource('', '   \n  '), false);
  assert.equal(looksLikeMarkdownSource('<span></span>', ''), false);
});

test('false-positive guard: Python source viewed in editor is not detected', () => {
  // A user reading Python source in a CodeMirror-style editor view
  // selects a multi-line method body. The selection has indented
  // lines (`    self.x = x`) and contains `__init__` / `__name__`
  // dunders, both of which earlier iterations of this heuristic
  // counted as signals. Now: indent isn't a signal at all, and the
  // underscore-flavoured emphasis forms are dropped from the inline
  // regex. Result: zero markdown signals → not detected, even though
  // signal #1 (no block tags) clears.
  const html =
    '<span>def __init__(self, x):</span><span>\n    self.x = x</span><span>\n' +
    'if __name__ == "__main__":</span>';
  const text =
    'def __init__(self, x):\n' +
    '    self.x = x\n' +
    'if __name__ == "__main__":';
  assert.equal(looksLikeMarkdownSource(html, text), false);
});

test('false-positive guard: digit-only 2D index access not a ref-style link', () => {
  // `arr[i][1]` shape would match a naive `[…][…]` pattern. Real
  // markdown reference links rarely use a pure-numeric id without
  // any letters — a digit-only or whitespace-only second bracket
  // is filtered out. NOTE: alphabetic 2D index access (`arr[i][j]`,
  // `cells[r][c]`) DOES still match the inline-ref-link regex; see
  // `looksLikeMarkdownSource` for why that's acceptable in practice
  // (short-circuit output equals htmlToMarkdown output for code).
  const html = '<span>arr[i][1]</span><span>\n</span><span>cells[0][1]</span>';
  const text = 'arr[i][1]\ncells[0][1]';
  assert.equal(looksLikeMarkdownSource(html, text), false);
});

test('positive: real reference-style link still matches', () => {
  // Sanity check that the tightened `inlineRefLink` regex still
  // matches the actual `[label][id]` form when the id is a real
  // word, alongside one other signal (line-leading bullet) to clear
  // the threshold.
  const html = '<span>- See [the docs][docs] for more</span><span>\nmore prose</span>';
  const text = '- See [the docs][docs] for more\nmore prose';
  assert.equal(looksLikeMarkdownSource(html, text), true);
});

// ─── selectionMarkdownBody ────────────────────────────────────────

test('selectionMarkdownBody passes markdown source through verbatim', () => {
  const html = '<span># H</span><span>\n- a\n- b</span>';
  const text = '# H\n- a\n- b';
  // Trailing whitespace (if any) is normalised to a single `\n`,
  // matching `htmlToMarkdown`'s post-condition; the rest of the text
  // is preserved as-is.
  assert.equal(selectionMarkdownBody(html, text), '# H\n- a\n- b\n');
});

test('selectionMarkdownBody runs htmlToMarkdown when HTML has block tags', () => {
  const html = '<h1>Title</h1><p>Body</p>';
  const text = 'Title\nBody';
  assert.equal(
    selectionMarkdownBody(html, text),
    htmlToMarkdown(html),
  );
});

test('selectionMarkdownBody resolves relative URLs on the htmlToMarkdown path', () => {
  const html = '<p><a href="next.html">go</a></p>';
  const text = 'go';
  assert.equal(
    norm(selectionMarkdownBody(html, text, 'https://example.com/docs/index.html')),
    '[go](https://example.com/docs/next.html)',
  );
});

test('selectionMarkdownBody: empty HTML + markdown text → text verbatim', () => {
  // CM6/GitHub-blob path: previously this would have returned
  // `htmlToMarkdown('')` → `''`, losing the user's selection entirely.
  const html = '';
  const text = '## H\n\nbody with `code`';
  assert.equal(selectionMarkdownBody(html, text), '## H\n\nbody with `code`\n');
});

test('selectionMarkdownBody short-circuit path resolves relative inline links', () => {
  // The motivating bug: selecting `![icon](src/icons/icon-16.png)`
  // from GitHub's source view of a `.md` file used to leave the
  // ref relative — broken once the `.md` file was opened anywhere
  // outside the original page. Now `selectionMarkdownBody`
  // resolves it on the verbatim-text path too.
  const html = '<span>The toolbar icon ![icon](src/icons/icon-16.png) does foo.</span>';
  const text = 'The toolbar icon ![icon](src/icons/icon-16.png) does foo.';
  assert.equal(
    selectionMarkdownBody(
      html,
      text,
      'https://github.com/jshute96/SeeWhatISee/blob/main/README.md',
    ),
    'The toolbar icon ![icon](https://github.com/jshute96/SeeWhatISee/blob/main/src/icons/icon-16.png) does foo.\n',
  );
});

test('selectionMarkdownBody short-circuit path resolves relative inline-link URLs', () => {
  const html = '<span>See [the docs](docs/architecture.md) for more `info`.</span>';
  const text = 'See [the docs](docs/architecture.md) for more `info`.';
  assert.equal(
    selectionMarkdownBody(
      html,
      text,
      'https://github.com/jshute96/SeeWhatISee/blob/main/README.md',
    ),
    'See [the docs](https://github.com/jshute96/SeeWhatISee/blob/main/docs/architecture.md) for more `info`.\n',
  );
});

test('selectionMarkdownBody short-circuit path resolves reference-link definitions', () => {
  // Reference-style definitions (`[id]: url`) that often appear at
  // the bottom of a markdown file should also pick up the base URL.
  const html =
    '<span># Title</span><span>\n</span>' +
    '<span>See [docs][d].</span><span>\n\n[d]: docs/x.md</span>';
  const text = '# Title\n\nSee [docs][d].\n\n[d]: docs/x.md';
  assert.equal(
    selectionMarkdownBody(
      html,
      text,
      'https://example.com/repo/blob/main/README.md',
    ),
    '# Title\n\nSee [docs][d].\n\n[d]: https://example.com/repo/blob/main/docs/x.md\n',
  );
});

test('selectionMarkdownBody short-circuit path leaves fragment-only refs alone', () => {
  const html = '<span>Jump to [§ Usage](#usage) for details.</span>';
  const text = 'Jump to [§ Usage](#usage) for details.';
  assert.equal(
    selectionMarkdownBody(html, text, 'https://example.com/x.md'),
    'Jump to [§ Usage](#usage) for details.\n',
  );
});

test('selectionMarkdownBody short-circuit path skips links inside fenced code blocks', () => {
  // Markdown source often DOCUMENTS markdown — a fenced code block
  // that shows `[label](rel)` is a literal example, not a live ref.
  // Rewriting it would change what the documentation says.
  const html =
    '<span># Examples</span><span>\n</span>' +
    '<span>```</span><span>\n</span>' +
    '<span>Use [link](relative.html) like this</span><span>\n</span>' +
    '<span>```</span><span>\n</span>' +
    '<span>And outside: [real](real.html)</span>';
  const text =
    '# Examples\n```\nUse [link](relative.html) like this\n```\nAnd outside: [real](real.html)';
  assert.equal(
    selectionMarkdownBody(html, text, 'https://example.com/docs/'),
    '# Examples\n```\nUse [link](relative.html) like this\n```\nAnd outside: [real](https://example.com/docs/real.html)\n',
  );
});

test('selectionMarkdownBody short-circuit path skips indented code blocks', () => {
  const html =
    '<span># Examples</span><span>\n\n</span>' +
    '<span>    Inside: [code](rel.html)</span><span>\n\n</span>' +
    '<span>Outside: [live](live.html)</span>';
  const text =
    '# Examples\n\n    Inside: [code](rel.html)\n\nOutside: [live](live.html)';
  assert.equal(
    selectionMarkdownBody(html, text, 'https://example.com/docs/'),
    '# Examples\n\n    Inside: [code](rel.html)\n\nOutside: [live](https://example.com/docs/live.html)\n',
  );
});

test('selectionMarkdownBody short-circuit path with no baseUrl leaves links alone', () => {
  const html = '<span>See ![icon](rel.png) and [docs](rel.md).</span>';
  const text = 'See ![icon](rel.png) and [docs](rel.md).';
  assert.equal(
    selectionMarkdownBody(html, text),
    'See ![icon](rel.png) and [docs](rel.md).\n',
  );
});

test('selectionMarkdownBody short-circuit path leaves absolute URLs alone', () => {
  const html = '<span>See [docs](https://other.example/x.md).</span>';
  const text = 'See [docs](https://other.example/x.md).';
  assert.equal(
    selectionMarkdownBody(html, text, 'https://example.com/'),
    'See [docs](https://other.example/x.md).\n',
  );
});

test('selectionMarkdownBody short-circuit path resolves multiple inline links on one line', () => {
  // Sanity check that the `/g` flag is doing its job — both link
  // URLs should be rewritten, not just the first.
  const html = '<span>See [a](rel-a.md) and [b](rel-b.md) for details.</span>';
  const text = 'See [a](rel-a.md) and [b](rel-b.md) for details.';
  assert.equal(
    selectionMarkdownBody(html, text, 'https://example.com/docs/'),
    'See [a](https://example.com/docs/rel-a.md) and [b](https://example.com/docs/rel-b.md) for details.\n',
  );
});

test('selectionMarkdownBody short-circuit path preserves all three CommonMark title forms', () => {
  // Inline-link title can be `"…"`, `'…'`, or `(…)` per the spec.
  // The URL is resolved while the title text is preserved verbatim.
  const html =
    '<span>- [a](rel-a "double")</span><span>\n' +
    '- [b](rel-b \'single\')</span><span>\n' +
    '- [c](rel-c (paren))</span>';
  const text =
    '- [a](rel-a "double")\n' +
    '- [b](rel-b \'single\')\n' +
    '- [c](rel-c (paren))';
  assert.equal(
    selectionMarkdownBody(html, text, 'https://example.com/docs/'),
    '- [a](https://example.com/docs/rel-a "double")\n' +
    '- [b](https://example.com/docs/rel-b \'single\')\n' +
    '- [c](https://example.com/docs/rel-c (paren))\n',
  );
});

test('selectionMarkdownBody short-circuit path handles tilde-fenced code blocks', () => {
  // `~~~` is the alternate fence character. The skip should treat
  // it the same as ```` ``` ````.
  const html =
    '<span># Examples</span><span>\n</span>' +
    '<span>~~~</span><span>\n</span>' +
    '<span>Use [link](relative.html) like this</span><span>\n</span>' +
    '<span>~~~</span><span>\n</span>' +
    '<span>And outside: [real](real.html)</span>';
  const text =
    '# Examples\n~~~\nUse [link](relative.html) like this\n~~~\nAnd outside: [real](real.html)';
  assert.equal(
    selectionMarkdownBody(html, text, 'https://example.com/docs/'),
    '# Examples\n~~~\nUse [link](relative.html) like this\n~~~\nAnd outside: [real](https://example.com/docs/real.html)\n',
  );
});

test('selectionMarkdownBody short-circuit path: balanced-paren URL is a known limitation', () => {
  // Locks in the documented limitation: a URL like
  // `Foo_(bar).md` truncates at the inner `)`. If we ever fix this,
  // this test will fail and prompt updating the JSDoc disclaimer.
  const html = '<span>See [Foo](Foo_(bar).md) below.</span>';
  const text = 'See [Foo](Foo_(bar).md) below.';
  // The regex captures `Foo_(bar` as the URL, leaves the trailing
  // `).md)` as literal text after the resolved link.
  const out = selectionMarkdownBody(html, text, 'https://example.com/docs/');
  assert.match(
    out,
    /\[Foo\]\(https:\/\/example\.com\/docs\/Foo_\(bar\)/,
  );
});

test('selectionMarkdownBody short-circuit path: relative / root-absolute / absolute side-by-side', () => {
  // One assertion exercising all three href shapes that
  // `resolveUrl` distinguishes — relative resolves against the
  // base path, `/root` resolves against the base origin, and
  // `https://…` is left alone.
  const html =
    '<span>- [relative](docs/x.md)</span><span>\n' +
    '- [root-absolute](/about)</span><span>\n' +
    '- [absolute](https://other.example/y)</span>';
  const text =
    '- [relative](docs/x.md)\n' +
    '- [root-absolute](/about)\n' +
    '- [absolute](https://other.example/y)';
  assert.equal(
    selectionMarkdownBody(
      html,
      text,
      'https://example.com/repo/blob/main/README.md',
    ),
    '- [relative](https://example.com/repo/blob/main/docs/x.md)\n' +
    '- [root-absolute](https://example.com/about)\n' +
    '- [absolute](https://other.example/y)\n',
  );
});

// ─── Round-trip invariant — curated cases ────────────────────────
//
// The `htmlToMarkdown` wrapper at the top of this file already
// asserts `looksLikeMarkdownSource('', output) === true` on every
// call (unless the test passed `PLAIN`). The cases below are an
// explicit curated set of HTML shapes that exercise structurally
// distinct markdown outputs, kept as documentation of *what* the
// round-trip covers — every entry here implicitly asserts the
// invariant by virtue of calling the wrapper without `PLAIN`.

test('round-trip: htmlToMarkdown output is detected as markdown source', () => {
  const cases = [
    // Headings only — exercises the line-leading `# ` signal alone,
    // no inline markers to lean on.
    '<h1>Title</h1><h2>Subtitle</h2>',
    // Headings + paragraphs.
    '<h1>Title</h1><h2>Subtitle</h2><p>Some body text here.</p>',
    // List + link.
    '<ul><li>first <a href="https://x.test">item</a></li><li>second item</li></ul>',
    // Ordered list — exercises the `\d+. ` line-leading signal.
    '<ol><li>step one</li><li>step two</li><li>step three</li></ol>',
    // Inline emphasis + code.
    '<p>This has <b>bold</b> and <code>code</code> inline.</p>' +
    '<p>And a second paragraph for line count.</p>',
    // Blockquote.
    '<blockquote><p>Quoted text spans</p><p>two paragraphs.</p></blockquote>',
    // Fenced code block.
    '<pre><code class="language-js">const x = 1;\nconsole.log(x);</code></pre>',
    // Pipe table — the `pipeTableLine` detector signal catches both
    // the data rows and the `| --- | --- |` separator.
    '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
    '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    // Mixed.
    '<h2>Mixed</h2><ul><li>one</li><li>two</li></ul><p>Tail with <em>italics</em>.</p>',
  ];
  // Each call asserts the round-trip via the wrapper's default
  // `expectLooksLikeMarkdown: true`; no extra assertion needed here.
  for (const html of cases) htmlToMarkdown(html);
});

test('round-trip exception: plain-text-only HTML stays plain (not detected)', () => {
  // Documented exception. The converter passes plain prose through
  // unchanged; the detector correctly returns false because there
  // are no markdown signals to find. Pass `PLAIN` so the wrapper
  // asserts the negative case rather than the default positive.
  const html = '<p>just some words across</p><p>two paragraphs</p>';
  htmlToMarkdown(html, PLAIN);
});
