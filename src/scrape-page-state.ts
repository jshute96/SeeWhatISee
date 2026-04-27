// Page-context worker for the HTML + selection scrape, extracted to
// its own module so it has zero imports and zero references to
// service-worker-only APIs (chrome.*). Two consumers:
//
//   - `capture.ts` injects it into the active tab via
//     `chrome.scripting.executeScript({ func, args })`. The function's
//     source is `Function.toString()`'d and re-parsed in the page
//     world, so the only DOM/browser globals it can rely on are the
//     ones present in any web page.
//
//   - The unit/E2E test (`tests/e2e/scrape-page-state.spec.ts`) imports
//     it directly and calls it via `page.evaluate(scrapePageStateInPage,
//     ...)` against a fixture page where the test has set up specific
//     selection scenarios (no selection, real selection, CodeMirror-
//     style fake, empty range, includeHtml flag). Going through
//     `page.evaluate` rather than the SW lets the test fully control
//     `window.getSelection()` — `executeScript` runs in an isolated
//     world so a main-world monkey-patch wouldn't be visible to it.
//
// The "self-containment" constraint is non-obvious and load-bearing.
// `chrome.scripting.executeScript({ func, args })` ships `func` to a
// different JavaScript realm (the target tab's isolated world). To
// cross that boundary the API calls `func.toString()` to grab just
// the function's *source text*, IPCs the string + the structured-
// cloned `args`, and re-parses the source in the target frame's
// extension context (roughly `(<source>).apply(null, <args>)`). The
// page's extension runtime — built into Chrome, not user code — does
// the eval; we just write the function.
//
// What does *not* survive that round-trip:
//   - Closure variables. A SW-side `const X = 7; func: () => X` lands
//     in the page as `() => X` with no `X` in scope → ReferenceError.
//   - Module imports. The page world has no module graph; an
//     `import { foo } from './bar'` referenced inside the function
//     resolves to nothing.
//   - Sibling helpers. A `function helper() { … }` defined elsewhere
//     in this file isn't reachable.
//
// So every helper, type, and constant the function uses must live
// inside the function body. The return value also has to be
// structured-cloneable (no DOM Nodes, no functions) — that's why we
// pre-extract `innerHTML`, `toString()`, and the diag fields into
// plain values before returning. Putting the function in its own
// file with zero imports makes the constraint visible: any future
// `import` line at the top of this file is an immediate signal that
// the change won't work.

export type PageScrapeResult = {
  html: string;
  selection: { html: string; text: string } | null;
  diag: Record<string, unknown>;
};

/**
 * Page-context worker for the selection scrape. See module header for
 * the call sites and the self-containment constraint.
 *
 * **Branches, in order:**
 *
 *  1. *Diagnostics, always.* `rangeCount`, `selType`, `selStrLen`
 *     describe the selection itself; `activeTag` / `activeId` /
 *     `activeHasShadow` describe the focused element (often where the
 *     failure mode lives — CodeMirror 6 parks focus on a hidden
 *     `<textarea id="read-only-cursor-text-area">`; some editors
 *     render inside a Shadow DOM root). The SW logs `diag` when the
 *     scrape comes back empty so future failures are diagnosable from
 *     the SW console alone, without instrumenting the page.
 *
 *  2. *No selection at all* (`!sel || rangeCount === 0`). Return
 *     `selection: null`. The diagnostic will say `rangeCount: 0` —
 *     usually means the user didn't select anything, or focus moved
 *     off the page and Chrome collapsed the selection before we ran.
 *
 *  3. *Selection exists, normal case.* Clone every range's contents
 *     into a detached container; `container.innerHTML` is our
 *     "byte-identical to what the page serialized" HTML body, and
 *     `Selection.toString()` is the visible text (better than walking
 *     the cloned tree because it respects line breaks across block
 *     elements, skips `display: none`, etc.). Both populated → return
 *     both.
 *
 *  4. *Selection exists, `cloneContents()` returns empty but
 *     `toString()` has text.* This is the CodeMirror 6 fallback —
 *     CM6 (and similar virtualized / measure-DOM editors, e.g.
 *     GitHub's blob viewer at `?plain=1`) creates Ranges whose
 *     endpoints sit inside layout nodes that don't enclose real text
 *     in the DOM tree, so the platform's "compute rendered text"
 *     algorithm (`toString`) finds the visible characters but the
 *     "give me the DOM between these boundaries" algorithm
 *     (`cloneContents`) finds nothing. We accept the selection as
 *     text-only: HTML body is `''` (the Capture page greys out the
 *     HTML / markdown rows for this capture) and the text body has
 *     the user's selection — which is the format that matters for
 *     source code anyway.
 *
 *  5. *Selection exists but both bodies are empty* (e.g. a Range
 *     positioned in an entirely invisible region). Return
 *     `selection: null`; the master Save-selection row shows
 *     "Selection has no saveable content".
 *
 * **Why include HTML here at all?** The bundled call from
 * `captureBothToMemory` needs both the page HTML and the selection in
 * one round-trip — two separate `executeScript` calls would double
 * the IPC cost and widen the window during which the tab could be
 * torn down between reads. The `includeHtml` flag lets the
 * selection-only caller (`scrapeSelection`, used by the More-menu
 * format shortcuts and the with-selection click probe) skip the
 * `outerHTML` serialization, which is the expensive part on a big
 * page.
 */
export function scrapePageStateInPage(includeHtml: boolean): PageScrapeResult {
  const sel = window.getSelection();
  const active = document.activeElement as Element | null;
  // Cache `toString()` once — it's called twice otherwise (for the
  // diag field and again as the selection text body), and on a multi-
  // megabyte selection that's a duplicate scan of the rendered text.
  const selStr = sel ? sel.toString() : '';
  const diag: Record<string, unknown> = {
    rangeCount: sel?.rangeCount ?? 0,
    selType: sel?.type ?? 'none',
    selStrLen: selStr.length,
    activeTag: active?.tagName ?? null,
    activeId: active?.id || null,
    activeHasShadow: !!(
      active && (active as Element & { shadowRoot?: ShadowRoot }).shadowRoot
    ),
  };
  const pageHtml = includeHtml ? document.documentElement.outerHTML : '';
  let selection: { html: string; text: string } | null = null;
  if (sel && sel.rangeCount > 0) {
    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    const html = container.innerHTML;
    diag.clonedHtmlLen = html.length;
    const anchor = sel.anchorNode as Node | null;
    const anchorEl =
      anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    diag.anchorTag = anchorEl?.tagName ?? null;
    diag.anchorClass = anchorEl?.className || null;
    if (html.length > 0 || selStr.length > 0) {
      selection = { html, text: selStr };
    }
  }
  return { html: pageHtml, selection, diag };
}
