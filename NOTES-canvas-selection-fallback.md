# Deferred change — canvas-editor selection fallback (copy-event interception)

This is a working note attached to a stash, not a design doc. It captures
what the change does, why it was attempted, what worked, what the review
flagged, and what would need to happen before this is safe to land.

To revisit: pop the stash and re-read this file alongside the diff.

## What the change does

- Adds a 5th branch to `scrapePageStateInPage`: when
  `window.getSelection()` yields nothing usable, register a bubble-phase
  `copy` listener on `document`, call `document.execCommand("copy")`,
  read `event.clipboardData` (`text/plain` + `text/html`),
  `preventDefault()` to avoid clobbering the system clipboard.
- Switches both call sites (`scrapeSelection` and `captureBothToMemory`)
  to inject with `allFrames: true`. Picks the selection from whichever
  frame finds one. Skips HTML serialization in non-top frames via a
  `window === window.top` guard.
- Adds new diag fields: `copyTried`, `copyExecuted`, `copyHtmlLen`,
  `copyTextLen`, `isTopFrame`.
- Two new tests in `scrape-page-state.spec.ts` covering the
  page-handler-writes-clipboardData path and the no-listener path.
- Architecture and file-index doc updates.

## Why it was attempted

- User asked: can we capture text selections in Google Docs? Docs renders
  document text into `<canvas>` tiles and keeps selection state in
  internal JS — `getSelection()` returns `rangeCount === 0` even when
  text is visibly selected.
- Generic, no-permissions approach: any editor that hooks `copy` (which
  is essentially every keyboard-copyable editor on the web) writes its
  selection into `event.clipboardData`. We can read that without
  `clipboardRead`/`clipboardWrite` because `clipboardData` is the event
  payload, not the system clipboard.

## What worked

- Round 1 (top-frame only) returned empty `clipboardData` in Docs:
  `activeTag: "IFRAME"` — Docs' copy handler is registered in the
  hidden `docs-texteventtarget-iframe`, not the top document.
- Round 2 (`allFrames: true`) succeeded. User confirmed Google Docs
  selection capture works and produces the expected
  `selection-<timestamp>.md` file.
- All 125 existing tests still pass.

## Review findings

Full review in `tmp/code-review-1777264540.md` (gitignored — not
travelling with the stash). Highlights below.

### HIGH — every toolbar click now fires synthetic `copy` events on every page

- `scrapeSelection` is called by `activeTabHasSelection` (the
  click-probe in `default-action.ts`) on every toolbar click — to
  decide between the with-/without-selection click defaults.
- This change makes every probe trigger `execCommand("copy")` in every
  same-origin frame, even when the user has nothing selected and never
  intended a selection capture.
- Pages with `copy` listeners (Tynt/33Across paywall trackers on news
  sites — Medium, NYT, Wired; "subscribe to keep copying" gates;
  generic analytics beacons) will fire on every click.
- `preventDefault()` only suppresses the system clipboard write — it
  does not stop the page's listener from running, undo XHRs, or revert
  state mutations.

### HIGH — `allFrames: true` injects into every iframe

- Includes ad iframes (DoubleClick, Taboola), tracker iframes (FB
  pixel, GA frames), embedded widgets (Disqus, Twitter, YouTube). On
  heavy news sites that's 30–80 frames per click, each running the
  worker including the copy fallback.

### Suggested gate to make it landable

- Top frame: only run the fallback when `activeTag === 'IFRAME'`
  (focus is delegated to a child — strong canvas-editor signal).
- Non-top frame: only run the fallback when `document.hasFocus()` (we
  are the focused frame).
- Catches Google Docs (top has IFRAME-as-active; texteventtarget-iframe
  has focus). Spares 99% of pages — no fallback runs on a normal
  selection-less click.
- Edge case: canvas editors that focus the canvas directly (Excalidraw,
  some standalone draw.io) would lose support under this gate. Could
  extend to `activeTag === 'CANVAS'` if needed, but only if we have a
  concrete editor that wants it.

### Other findings to address

- **MEDIUM — listener-target fragility.** Pages that hook `copy` on
  `window` (bubble) fire *after* our `document` listener, so we read
  empty data. Robust fix: attach to both `window` and `document`.
- **MEDIUM — pages that overwrite `clipboardData`** with promotional
  text ("Read more at <url>") would be captured verbatim. New class of
  silent incorrect-capture. Worth a doc-comment caveat.
- **MEDIUM — async clipboard handlers** (`navigator.clipboard.write`
  inside the copy listener) bypass `clipboardData` entirely. If Docs
  migrates to that path this fallback breaks silently.
- **LOW — log spam.** The new `interesting` gate is
  `copyTried || rangeCount > 0`; `copyTried` is always true when the
  fallback runs, so the SW console now logs on every empty click. The
  old gate (`rangeCount > 0`) was intentional. Tighten to e.g.
  `copyTextLen > 0 || copyHtmlLen > 0 || copyExecuted === false` — only
  log when the fallback either found something or failed notably.
- **LOW — `JSON.stringify` in `console.log`** loses DevTools'
  interactive object expansion. Restore the two-arg form.
- **LOW — diag-field doc comment** doesn't list the new fields
  (`copyTried` / `copyExecuted` / `copyHtmlLen` / `copyTextLen` /
  `isTopFrame`). Update.
- **LOW — multi-frame picker is duplicated** between `scrapeSelection`
  and `captureBothToMemory`. Extract a small helper so the two paths
  can't drift.
- **LOW — no integration test for the `allFrames: true` plumbing.**
  The new tests only exercise `scrapePageStateInPage` directly via
  `page.evaluate`, not the SW's all-frames merge.

## Minimum to revive this change

1. Add the active-element gate (top frame: `activeTag === 'IFRAME'`;
   non-top frame: `document.hasFocus()`). This is the blocker.
2. Tighten the `interesting` log gate so we don't spam on benign
   clicks.
3. Restore object-form `console.log` (drop `JSON.stringify`).
4. Update the diag-field list in the `scrapePageStateInPage` doc
   comment.
5. Re-test in Google Docs and on a few sites known to hook `copy`
   (e.g. Medium, NYT) to confirm the gate eliminates the side effect.

Polish (not blocking):

- Attach the copy listener to both `document` and `window` for
  robustness against window-bound page handlers.
- Extract a `pickSelectionFrame(results)` helper used by both call
  sites.
- Add an end-to-end test for `scrapeSelection` with a same-origin
  iframe whose copy handler writes data, asserting we pick it up.
