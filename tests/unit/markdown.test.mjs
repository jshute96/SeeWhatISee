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

import { htmlToMarkdown, htmlToText } from '../../dist/markdown.js';

// Small helper: normalize trailing whitespace so we can write the
// expected strings without worrying about the converter's canonical
// single-newline terminator.
function norm(s) {
  return s.replace(/\s+$/, '');
}

test('plain text passes through', () => {
  assert.equal(norm(htmlToMarkdown('hello world')), 'hello world');
  assert.equal(norm(htmlToText('hello world')), 'hello world');
});

test('decodes common HTML entities', () => {
  assert.equal(
    norm(htmlToMarkdown('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;')),
    `a & b < c > d "e" 'f'`,
  );
  assert.equal(norm(htmlToMarkdown('&#x2014;')), '\u2014');
});

test('headings become hashes', () => {
  assert.equal(norm(htmlToMarkdown('<h1>Title</h1>')), '# Title');
  assert.equal(norm(htmlToMarkdown('<h3>Nested</h3>')), '### Nested');
  assert.equal(norm(htmlToMarkdown('<h6>Deep</h6>')), '###### Deep');
});

test('paragraphs separated by blank lines', () => {
  const out = norm(htmlToMarkdown('<p>One</p><p>Two</p>'));
  assert.equal(out, 'One\n\nTwo');
});

test('bold / italic / strikethrough', () => {
  assert.equal(norm(htmlToMarkdown('<b>bold</b>')), '**bold**');
  assert.equal(norm(htmlToMarkdown('<strong>also</strong>')), '**also**');
  assert.equal(norm(htmlToMarkdown('<i>it</i>')), '*it*');
  assert.equal(norm(htmlToMarkdown('<em>em</em>')), '*em*');
  assert.equal(norm(htmlToMarkdown('<del>gone</del>')), '~~gone~~');
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
  assert.equal(norm(htmlToMarkdown('line one<br>line two')),
    'line one  \nline two');
});

test('hr becomes a thematic break', () => {
  assert.equal(norm(htmlToMarkdown('<p>a</p><hr><p>b</p>')),
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
  // emitting an autolink the reader didn't ask for.
  assert.equal(norm(htmlToMarkdown('<a href="https://x.example"></a>')), '');
  assert.equal(norm(htmlToMarkdown('<a href="#usage"></a>')), '');
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

test('table with unaligned row widths pads trailing empty cells', () => {
  const out = norm(htmlToMarkdown(
    '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>',
  ));
  assert.equal(
    out,
    '| A | B |\n| --- | --- |\n| 1 |  |',
  );
});

test('drops script and style contents', () => {
  const out = norm(htmlToMarkdown(
    '<p>before</p><script>alert(1)</script><style>.x{}</style><p>after</p>',
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
  const out = norm(htmlToMarkdown('hello<!-- hidden -->world'));
  assert.equal(out, 'helloworld');
});

test('ignores comments between block siblings', () => {
  assert.equal(
    norm(htmlToMarkdown('<p>a</p><!-- gap --><p>b</p>')),
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
  assert.equal(norm(htmlToMarkdown('<p>a</p><!-- never closed')), 'a');
});

test('collapses whitespace in inline runs', () => {
  const out = norm(htmlToMarkdown('<p>  extra    space\n\nbetween\t  words  </p>'));
  assert.equal(out, 'extra space between words');
});

test('preformatted preserves whitespace', () => {
  const out = norm(htmlToMarkdown(
    '<pre>line 1\n  indented\nline 3</pre>',
  ));
  assert.equal(out, '```\nline 1\n  indented\nline 3\n```');
});

test('tolerates mismatched close tag', () => {
  const out = norm(htmlToMarkdown('<p>open without</p></div>'));
  assert.equal(out, 'open without');
});

test('tolerates unclosed tag', () => {
  const out = norm(htmlToMarkdown('<p>never closed'));
  assert.equal(out, 'never closed');
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
  assert.equal(htmlToMarkdown(''), '');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToMarkdown('   '), '');
  assert.equal(htmlToText('   '), '');
});
