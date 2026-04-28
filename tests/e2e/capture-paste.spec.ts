// E2E coverage for rich-text paste handling on the Capture page —
// the `attachHtmlAwarePaste` listener wired onto the prompt textarea
// and the contenteditable edit dialogs (page-HTML, selection-HTML,
// selection-markdown). The selection-text dialog deliberately has no
// listener; CodeJar's own paste handler inserts `text/plain` for it.
//
// What's covered:
//   - Conversion paths: html → markdown for the markdown editors,
//     html → cleaned source for the html editors.
//   - Source-view short-circuit (`shouldPasteAsText`): hljs / Prism /
//     content-based detection that pastes `text/plain` verbatim when
//     it's already source in the target format.
//   - cleanCopiedHtml normalization: StartFragment marker stripping,
//     inline-style stripping, bare-span unwrapping, `\u00A0` → space.
//   - Real round-trips: copy from a CodeJar editor (with hljs
//     highlighting) and paste back, asserting the source survives
//     exactly. Computes the clipboard payload via Range.cloneContents
//     + innerHTML — the same path Chrome's copy implementation runs —
//     because headless Chromium under Playwright won't populate
//     `clipboardData` on a synthesized copy event.
//   - Edge cases: math-style angle brackets in prose, missing
//     StartFragment markers, blank-line preservation through CodeJar
//     re-highlight.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import {
  openDetailsFlow,
  seedSelection,
  setEditorCode,
} from './details-helpers';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Each test in this file issues one capture via openDetailsFlow;
// without a small cushion the suite occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

/**
 * Simulate a Ctrl+V paste into a CodeJar-managed contenteditable
 * editor by:
 *   1. Focusing the editor and collapsing the caret to the end so
 *      the pasted text appends rather than replacing existing
 *      content (or landing at an unpredictable selection).
 *   2. Constructing a real `DataTransfer` populated with the
 *      caller's `text/html` (and matching `text/plain` fallback so
 *      we resemble Chrome's actual clipboard payloads).
 *   3. Dispatching a `ClipboardEvent('paste', …)` so the page's
 *      paste listener runs against real clipboardData.
 *
 * Returns the editor's `textContent` (which equals CodeJar's source
 * view — hljs token spans are stripped) plus whether the listener
 * called `preventDefault()`. Tests use the latter to assert that
 * the no-op `selection-text` dialog kept the default paste path.
 */
async function pasteIntoEditor(
  page: Page,
  editorId: string,
  payload: { html: string; text: string },
): Promise<{ content: string; prevented: boolean }> {
  return await page.evaluate(({ id, html, text }) => {
    const editor = document.getElementById(id)!;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(ev);
    return {
      content: editor.textContent ?? '',
      prevented: ev.defaultPrevented,
    };
  }, { id: editorId, html: payload.html, text: payload.text });
}

/**
 * Real round-trip: select all text inside a CodeJar/hljs-highlighted
 * editor, build the *exact* clipboard payload Chrome would write
 * for that selection (text/html = serialized DOM of the cloned
 * range, text/plain = `Selection.toString()`), then dispatch a
 * synthetic paste with that payload back into the editor. Asserts
 * the source survives the trip exactly.
 *
 * We compute the payload ourselves rather than firing a real
 * `copy` event: in headless Chromium under Playwright, the
 * `clipboardData` on a synthesized copy comes back empty even
 * when the event fires (no OS-level user gesture, no clipboard
 * write). The DOM serialization we use here is what Chrome's
 * own copy implementation runs to produce the html payload —
 * cloneContents + innerHTML — so the test exercises the *real*
 * hljs span tree the editor draws. Replacing the highlighter (or
 * its class names) changes that span tree and the round-trip will
 * either fall out of the syntax-highlight short-circuit (round-
 * trip mismatch) or fail the `class="hljs…"` sanity check.
 */
async function copyAndPasteRoundTrip(
  page: Page,
  editorId: string,
): Promise<{ pasted: string; clipboardHtml: string; clipboardText: string }> {
  return await page.evaluate(({ id }) => {
    const editor = document.getElementById(id)!;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    // Build the html payload Chrome's copy path would produce: clone
    // the selected range into a detached <div> and read its innerHTML.
    // The plain-text payload is Selection.toString() — same as what
    // the OS clipboard's `text/plain` slot gets.
    const wrap = document.createElement('div');
    wrap.appendChild(range.cloneContents());
    const clipboardHtml = wrap.innerHTML;
    const clipboardText = sel.toString();

    // Wipe the editor and place caret at end before pasting back.
    editor.textContent = '';
    editor.focus();
    const r2 = document.createRange();
    r2.selectNodeContents(editor);
    r2.collapse(false);
    const s2 = window.getSelection()!;
    s2.removeAllRanges();
    s2.addRange(r2);

    // Same code path a real Ctrl+V triggers.
    const dt = new DataTransfer();
    dt.setData('text/html', clipboardHtml);
    dt.setData('text/plain', clipboardText);
    editor.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
    return {
      pasted: editor.textContent ?? '',
      clipboardHtml,
      clipboardText,
    };
  }, { id: editorId });
}

test('details: edit-html paste inserts raw HTML source (StartFragment stripped)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await capturePage.locator('#edit-html').click();
  // Clear the prefilled capture HTML so we can assert on just the
  // pasted content without dragging in the fixture page's body.
  await setEditorCode(capturePage.locator('#edit-html-textarea'), '');
  // Chrome's clipboard wrappers (`<meta charset>` + StartFragment /
  // EndFragment markers) should be stripped; the user gets the
  // actual markup they copied.
  const result = await pasteIntoEditor(capturePage, 'edit-html-textarea', {
    html:
      '<meta charset="utf-8"><!--StartFragment-->' +
      '<p>pasted <b>html</b></p>' +
      '<!--EndFragment-->',
    text: 'pasted html',
  });
  expect(result.prevented).toBe(true);
  expect(result.content).toBe('<p>pasted <b>html</b></p>');

  await openerPage.close();
});

test('details: edit-selection-markdown paste converts HTML to markdown', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  await capturePage.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(
    capturePage.locator('#edit-selection-markdown-textarea'), '',
  );
  const result = await pasteIntoEditor(
    capturePage,
    'edit-selection-markdown-textarea',
    {
      html: '<p>Hello <b>world</b></p>',
      text: 'Hello world',
    },
  );
  expect(result.prevented).toBe(true);
  expect(result.content).toBe('Hello **world**');

  await openerPage.close();
});

test('details: edit-selection-markdown paste preserves blank lines through CodeJar re-highlight', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  // htmlToMarkdown converts `<h1>` + `<p>` into a heading followed
  // by a blank line and a paragraph; the blank line round-trips
  // through CodeJar's textContent-based re-highlight only if the
  // insert path stores `\n` as text-node whitespace (Range.insertNode
  // of a text node), not as `<br>` elements that an
  // execCommand('insertText') path would synthesize — the latter
  // quietly collapses the blank line on the next highlight pass.
  await capturePage.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(
    capturePage.locator('#edit-selection-markdown-textarea'), '',
  );
  const result = await pasteIntoEditor(
    capturePage,
    'edit-selection-markdown-textarea',
    {
      html: '<h1>Title</h1><p>Body paragraph.</p>',
      text: 'TitleBody paragraph.',
    },
  );
  expect(result.prevented).toBe(true);
  expect(result.content).toBe('# Title\n\nBody paragraph.');

  await openerPage.close();
});

test('details: real markdown-editor copy/paste round-trip preserves source exactly', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  // Source containing the markdown tokens hljs is most likely to
  // wrap with `<span class="hljs-…">` — emphasis, code, headings,
  // links — so the captured `text/html` actually exercises the
  // syntax-highlight short-circuit branch.
  const SOURCE = [
    '# Heading',
    '',
    '**bold** and *em* with `inline code`.',
    '',
    'A [link](https://example.test/) and a list:',
    '',
    '- item one',
    '- item two',
  ].join('\n');
  await capturePage.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(
    capturePage.locator('#edit-selection-markdown-textarea'), SOURCE,
  );
  // setEditorCode writes textContent and dispatches `keyup`; CodeJar
  // schedules its highlight pass 30ms later via debounce, so wait
  // for hljs to actually inject token spans before we sample what
  // the clipboard would carry.
  await capturePage.waitForFunction(
    () =>
      /class=["']hljs-/.test(
        document.getElementById('edit-selection-markdown-textarea')!.innerHTML,
      ),
    null,
    { timeout: 1000 },
  );

  const result = await copyAndPasteRoundTrip(
    capturePage,
    'edit-selection-markdown-textarea',
  );
  // The captured html must actually carry the hljs marker classes;
  // otherwise the test would silently degenerate into a plain-text
  // round-trip that doesn't exercise the syntax-highlight branch.
  expect(result.clipboardHtml).toMatch(/class=["']hljs/);
  expect(result.pasted).toBe(SOURCE);

  await openerPage.close();
});

test('details: real html-editor copy/paste round-trip preserves source exactly', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // HTML source with the tokens hljs's xml mode highlights:
  // tag names, attribute names, attribute string values. The
  // captured `text/html` is the rendered span tree of all that
  // highlighting; without the syntax-highlight short-circuit the
  // paste-as-html-source path would entity-escape every `<` and
  // land the literal styled spans.
  const SOURCE = [
    '<section id="intro" class="hero">',
    '  <h1>Welcome</h1>',
    '  <p>Body with <a href="https://example.test/">link</a>.</p>',
    '</section>',
  ].join('\n');
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), SOURCE);
  // Same debounce as the markdown case — wait for hljs's xml-mode
  // pass to inject token spans.
  await capturePage.waitForFunction(
    () =>
      /class=["']hljs-/.test(
        document.getElementById('edit-html-textarea')!.innerHTML,
      ),
    null,
    { timeout: 1000 },
  );

  const result = await copyAndPasteRoundTrip(
    capturePage,
    'edit-html-textarea',
  );
  expect(result.clipboardHtml).toMatch(/class=["']hljs/);
  expect(result.pasted).toBe(SOURCE);

  await openerPage.close();
});

test('details: pasting hljs-highlighted source into the markdown editor uses text/plain (no escaping)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  // Round-trip case: user selects + copies markdown source from
  // the editor, where it's displayed as a tree of `class="hljs-…"`
  // spans, then pastes back. The clipboard's text/plain holds the
  // real source (`**bold**`), text/html holds the styled spans.
  // Without the syntax-highlight detector, htmlToMarkdown would
  // unwrap the spans and escape the literal asterisks
  // (`\*\*bold\*\*`); the detector short-circuits and pastes
  // text/plain directly so the source round-trips exactly.
  await capturePage.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(
    capturePage.locator('#edit-selection-markdown-textarea'), '',
  );
  const result = await pasteIntoEditor(
    capturePage,
    'edit-selection-markdown-textarea',
    {
      html:
        '<span class="hljs-strong">**bold**</span> ' +
        '<span class="hljs-emphasis">*em*</span>',
      text: '**bold** *em*',
    },
  );
  expect(result.prevented).toBe(true);
  expect(result.content).toBe('**bold** *em*');

  await openerPage.close();
});

test('details: pasting hljs-highlighted source into the html editor uses text/plain (no entity escaping)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), '');
  // Same round-trip but for the HTML editor: the clipboard's
  // text/html is the hljs render of the source, and treating it as
  // raw HTML to insert would entity-escape every `<` / `>` and
  // land the literal styled spans. text/plain is the original
  // source.
  const result = await pasteIntoEditor(capturePage, 'edit-html-textarea', {
    html:
      '<span class="hljs-tag">&lt;<span class="hljs-name">h1</span>&gt;</span>' +
      'Title' +
      '<span class="hljs-tag">&lt;/<span class="hljs-name">h1</span>&gt;</span>',
    text: '<h1>Title</h1>',
  });
  expect(result.prevented).toBe(true);
  expect(result.content).toBe('<h1>Title</h1>');

  await openerPage.close();
});

test('details: pasting prism-highlighted markdown source uses text/plain (no hljs class needed)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  // Prism.js / MDX / many other syntax highlighters use `class="token …"`
  // (and a `language-…` wrapper). The detector should recognize this
  // as "html is just a styled rendering of text/plain markdown source"
  // even though no `hljs` classes appear.
  await capturePage.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(
    capturePage.locator('#edit-selection-markdown-textarea'), '',
  );
  const result = await pasteIntoEditor(
    capturePage,
    'edit-selection-markdown-textarea',
    {
      html:
        '<pre class="language-md"><code class="language-md">' +
        '<span class="token title important"># Title</span>\n' +
        '<span class="token bold">**bold**</span>' +
        '</code></pre>',
      text: '# Title\n**bold**',
    },
  );
  expect(result.prevented).toBe(true);
  expect(result.content).toBe('# Title\n**bold**');

  await openerPage.close();
});

test('details: pasting nbsp-laced clipboard html lands as regular spaces (line wrap not constrained)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Browsers wrap visible whitespace in non-breaking spaces when
  // serializing rendered HTML to the clipboard, so paste targets
  // that collapse whitespace still see the gaps. cleanCopiedHtml
  // normalizes them back to regular `\u0020` so the editor's
  // line-wrapping isn't pinned at every gap.
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), '');
  const result = await pasteIntoEditor(capturePage, 'edit-html-textarea', {
    // Both `&nbsp;` entity form and the literal `\u00A0` character
    // appear in real clipboard payloads — mix both.
    html: '<p>one&nbsp;two\u00A0three four</p>',
    text: 'one two three four',
  });
  expect(result.prevented).toBe(true);
  // No `\u00A0` survives: either as the literal char or the entity
  // form (which would have been escaped to `&amp;nbsp;` and inserted
  // as visible source text — equally wrong).
  expect(result.content).not.toContain('\u00A0');
  expect(result.content).not.toContain('&nbsp;');
  expect(result.content).not.toContain('&amp;nbsp;');
  expect(result.content).toBe('<p>one two three four</p>');

  await openerPage.close();
});

test('details: edit-html paste with prose containing math-style angle brackets is not mistaken for HTML source', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // The asHtmlSource short-circuit must distinguish *html source*
  // (`<p>foo</p>`, `<a href="x">`) from *prose with bare angle
  // brackets* (`if a<b then c>0`). Prose lands as cleaned html
  // (a single text run with no tag structure), not the verbatim
  // text/plain — otherwise the user gets bare prose where they
  // pasted html-rendering content.
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), '');
  const result = await pasteIntoEditor(capturePage, 'edit-html-textarea', {
    // text/plain has angle brackets but no real tag shape.
    text: 'if a<b and c>d then return',
    // text/html is a real `<p>` wrapping the prose — the
    // structural representation of the same text.
    html: '<p>if a&lt;b and c&gt;d then return</p>',
  });
  expect(result.prevented).toBe(true);
  // Cleaned html source — *not* the raw `text/plain` — lands in
  // the editor.
  expect(result.content).toBe('<p>if a&lt;b and c&gt;d then return</p>');

  await openerPage.close();
});

test('details: edit-html paste of bare html fragment without StartFragment markers still works', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Some browsers / apps don't emit `<!--StartFragment-->` markers
  // around the clipboard `text/html` payload. cleanCopiedHtml's
  // else-branch must still produce reasonable output when the
  // markers are absent.
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), '');
  const result = await pasteIntoEditor(capturePage, 'edit-html-textarea', {
    html: '<p>raw <b>html</b> with no markers</p>',
    // Use prose without tag shape so we exercise the html-side
    // path (and not the source-view short-circuit).
    text: 'raw html with no markers',
  });
  expect(result.prevented).toBe(true);
  expect(result.content).toBe('<p>raw <b>html</b> with no markers</p>');

  await openerPage.close();
});

test('details: edit-selection-text paste falls through to plain-text insertion', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  // The selection-text dialog deliberately *doesn't* attach the
  // html-aware paste listener — its editor is plaintext-only, and a
  // user pasting into it wants the visible-text version, not the
  // HTML source or a markdown projection. CodeJar's own paste
  // handler still runs and inserts the `text/plain` clipboard
  // value, which is exactly what we want here.
  await capturePage.locator('#edit-selection-text-btn').click();
  await setEditorCode(
    capturePage.locator('#edit-selection-text-textarea'), '',
  );
  const result = await pasteIntoEditor(
    capturePage,
    'edit-selection-text-textarea',
    {
      html: '<p>Hello <b>world</b></p>',
      text: 'Hello world',
    },
  );
  expect(result.content).toBe('Hello world');

  await openerPage.close();
});
