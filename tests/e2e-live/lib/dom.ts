// Small page-side DOM helpers shared by the live specs' `resetPage`
// hooks. Each is written to be passed straight to `page.evaluate`,
// so they must stay self-contained — no imports, no closure captures.

/** Empty a contenteditable composer (ProseMirror & friends).
 *
 *  Scopes the selection to the composer with a `Range` rather than
 *  reaching for `execCommand('selectAll')`. That matters for speed,
 *  not just tidiness: `selectAll` after `focus()` still selects the
 *  whole document on claude.ai and takes ~10 s to round-trip, once
 *  per test. The range-scoped version is effectively instant.
 *
 *  `execCommand('delete')` (rather than clearing `innerHTML`) is
 *  deliberate — it routes through the editor's own input handling,
 *  so the editor's model stays in sync with the DOM, and it mirrors
 *  the runtime's `typePrompt` path.
 */
export function clearContentEditable(selector: string): void {
  const composer = document.querySelector<HTMLElement>(selector);
  if (!composer) return;
  composer.focus();
  const range = document.createRange();
  range.selectNodeContents(composer);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('delete');
}
