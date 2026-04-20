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

test('link with no text becomes autolink', () => {
  assert.equal(
    norm(htmlToMarkdown('<a href="https://x.example"></a>')),
    '<https://x.example>',
  );
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
