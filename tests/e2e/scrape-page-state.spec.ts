// Direct coverage for `scrapePageStateInPage` — the page-context
// worker that powers both `scrapeSelection` and the bundled
// HTML+selection round-trip in `captureBothToMemory`.
//
// We test the function via `page.evaluate(scrapePageStateInPage, ...)`
// rather than driving it through the SW's `executeScript` because:
//
//   - `executeScript` runs in an isolated world; a main-world
//     monkey-patch on `window.getSelection` (needed for the CodeMirror
//     fake) wouldn't be visible to it.
//   - Going through the SW means setting up the toolbar-click flow
//     for every variant. Calling the function directly keeps each
//     scenario to ~10 lines and a single assertion cluster.
//
// What's covered:
//   1. No selection → returns `selection: null`, diag has `rangeCount: 0`.
//   2. Real text selection → returns both `html` and `text`.
//   3. CodeMirror-style fake (cloneContents empty, toString non-empty)
//      → returns text-only fallback (`html === ''`, `text` populated).
//      This is the regression test for the GitHub blob-viewer bug.
//   4. Empty range (cloneContents empty, toString empty) → null.
//   5. `includeHtml: true` returns the page HTML; `false` returns ''.

import { test, expect } from '../fixtures/extension';
import { scrapePageStateInPage } from '../../src/scrape-page-state';

test.describe('scrapePageStateInPage', () => {
  test('no selection on page → selection: null, diag has rangeCount 0', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/purple.html`);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    const result = await page.evaluate(scrapePageStateInPage, false);
    expect(result.selection).toBeNull();
    expect(result.diag.rangeCount).toBe(0);
    expect(result.html).toBe('');
    await page.close();
  });

  test('real text selection → returns html and text', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/purple.html`);
    await page.evaluate(() => {
      const span = document.createElement('span');
      span.id = 'sel-seed';
      span.textContent = 'hello selection world';
      document.body.appendChild(span);
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const result = await page.evaluate(scrapePageStateInPage, false);
    expect(result.selection).not.toBeNull();
    expect(result.selection!.text).toBe('hello selection world');
    expect(result.selection!.html).toBe('hello selection world');
    expect(result.diag.rangeCount).toBe(1);
    expect(result.diag.clonedHtmlLen).toBeGreaterThan(0);
    await page.close();
  });

  test('CodeMirror-style selection (cloneContents empty, toString non-empty) → text-only fallback', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/purple.html`);
    // Reproduce GitHub's CM6 blob-viewer failure mode: a Selection
    // that returns visible text from `toString()` but whose Range's
    // `cloneContents()` returns an empty fragment. CM6 produces this
    // because its visible text lives on layout/measure DOM nodes
    // whose Range boundaries don't enclose real text in the tree.
    // Easiest synthetic version: monkey-patch `window.getSelection`
    // to return a fake whose `getRangeAt(0).cloneContents()` always
    // returns an empty fragment, while `toString()` returns 1.5KB of
    // "selected" source code (matching the real failure we observed).
    await page.evaluate(() => {
      const FAKE_TEXT = 'function hello(name) {\n  return `Hi, ${name}`;\n}\n'.repeat(30);
      // Place focus on a real hidden textarea so `activeTag` /
      // `activeId` in the diag match what we saw on github.com (CM6
      // parks focus on `<textarea id="read-only-cursor-text-area">`).
      const ta = document.createElement('textarea');
      ta.id = 'read-only-cursor-text-area';
      ta.style.position = 'absolute';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      const fakeRange = {
        cloneContents: () => document.createDocumentFragment(),
      };
      const fakeSel = {
        rangeCount: 1,
        type: 'Range',
        anchorNode: document.body,
        toString: () => FAKE_TEXT,
        getRangeAt: () => fakeRange,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).getSelection = () => fakeSel;
    });

    const result = await page.evaluate(scrapePageStateInPage, false);
    expect(result.selection).not.toBeNull();
    expect(result.selection!.text).toContain('function hello(name)');
    expect(result.selection!.text.length).toBeGreaterThan(1000);
    // The CM6 bug signature: HTML body is empty but text is not.
    expect(result.selection!.html).toBe('');
    // Diag echoes the conditions we synthesized — useful when this
    // assertion fails because future refactors might change which
    // diag fields are emitted.
    expect(result.diag.rangeCount).toBe(1);
    expect(result.diag.clonedHtmlLen).toBe(0);
    expect(result.diag.selStrLen).toBe(result.selection!.text.length);
    expect(result.diag.activeTag).toBe('TEXTAREA');
    expect(result.diag.activeId).toBe('read-only-cursor-text-area');
    await page.close();
  });

  test('empty range (cloneContents empty, toString empty) → selection null', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/purple.html`);
    await page.evaluate(() => {
      const fakeRange = {
        cloneContents: () => document.createDocumentFragment(),
      };
      const fakeSel = {
        rangeCount: 1,
        type: 'Caret',
        anchorNode: document.body,
        toString: () => '',
        getRangeAt: () => fakeRange,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).getSelection = () => fakeSel;
    });

    const result = await page.evaluate(scrapePageStateInPage, false);
    expect(result.selection).toBeNull();
    expect(result.diag.rangeCount).toBe(1);
    expect(result.diag.clonedHtmlLen).toBe(0);
    expect(result.diag.selStrLen).toBe(0);
    await page.close();
  });

  test('includeHtml flag controls whether page HTML is serialized', async ({
    extensionContext,
    fixtureServer,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/purple.html`);

    const withHtml = await page.evaluate(scrapePageStateInPage, true);
    expect(withHtml.html).toContain('<title>purple</title>');

    const withoutHtml = await page.evaluate(scrapePageStateInPage, false);
    expect(withoutHtml.html).toBe('');
    await page.close();
  });
});
