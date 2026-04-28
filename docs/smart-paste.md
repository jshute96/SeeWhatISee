# Smart paste

Rich-text paste handling on the Capture page (`capture.html`). When
the user pastes HTML-bearing content into the prompt textarea or one
of the edit dialogs, we route it to the right format for the target
surface — instead of unconditionally inserting `text/plain` (the
default for textareas and plaintext-only contenteditables).

Implementation: `attachHtmlAwarePaste(el, mode)` in
`src/capture-page.ts`. Tests: `tests/e2e/capture-paste.spec.ts`.

## Surfaces and modes

| Surface                       | Mode             | Behavior on `text/html` |
|-------------------------------|------------------|-------------------------|
| Prompt textarea               | `'asMarkdown'`   | Convert to markdown via `htmlToMarkdown`. |
| Selection-markdown editor     | `'asMarkdown'`   | Same. |
| Page-HTML editor              | `'asHtmlSource'` | Insert HTML source after `cleanCopiedHtml`. |
| Selection-HTML editor         | `'asHtmlSource'` | Same. |
| Selection-text editor         | (no listener)    | CodeJar's built-in paste inserts `text/plain` — correct for a plaintext editor. |

## User-facing behavior

- **Ctrl+V** (regular paste): rich-text source from a browser or app
  lands as markdown / HTML source / plain text per the table above.
- **Ctrl+Shift+V** ("paste as plain text"): always pastes verbatim
  `text/plain`. Chrome strips formatting *before* firing the paste
  event, so `clipboardData` carries only `text/plain` and our
  listener falls through to the default paste path.
- **Editor-to-editor round trip**: copy from one of our CodeJar
  editors and paste back — the source survives exactly. See
  [source-view short-circuit](#source-view-short-circuit-shouldpasteastext).

There's no modifier flag on `ClipboardEvent` itself; `text/html`
presence is the only signal Chrome surfaces. That's enough.

## `cleanCopiedHtml`

Normalizes clipboard payloads to match what `scrape-page-state.ts`
produces from a real selection (which never goes near the clipboard):

- Extracts the fragment between `<!--StartFragment-->` /
  `<!--EndFragment-->` if present (browsers wrap rendered-HTML
  copies with these markers).
- Strips every browser-added inline `style="…"` attribute. Chrome
  inlines computed styles for every element during the copy
  serialization, so a paste otherwise carries `font-family`,
  `box-sizing`, `-webkit-text-stroke-width`, etc. on every node.
- Unwraps bare `<span>` elements. Browsers synthesize them around
  whitespace runs to keep the gaps visible in paste targets that
  collapse whitespace.
- Normalizes `\u00A0` → regular space. Browsers sprinkle nbsp into
  clipboard `text/html` for the same reason. In our editors those
  nbsps pin line wrapping at every gap.
- Preserves source-authored attributes (`class`, `href`, `id`,
  `dir`) untouched.

Tradeoff: a real `&nbsp;` from the source page is *also* normalized
to a regular space — we can't tell the two apart in `clipboardData`.
The escape hatch is Ctrl+Shift+V.

## Source-view short-circuit (`shouldPasteAsText`)

Before either conversion path runs, decide whether `text/plain` is
already source in the editor's target format. When the user copies
out of a CodeJar editor (or any hljs/Prism-styled code block on the
web), the `text/html` payload is just a tree of styled spans — a
visual rendering of the source the user already had as plain text.

### Signals (in priority order — first match wins)

1. **Highlighter token classes** in `text/html` — `hljs`, `token`,
   `language-`, `cm-`, `mtk`. Strongest signal: when these appear
   we *know* the html is a styled rendering (highlight.js, Prism,
   CodeMirror, Monaco, Shiki, …) and `text/plain` is the source.
   Cheapest regex; checked first.
2. **Mode-specific content match** on `text/plain`:
   - `'asMarkdown'`: `looksLikeMarkdownSource(html, text)` — html
     has no markdown-output block tags AND text has any markdown
     signal (heading, bullet, fence, emphasis, link). Catches
     unstyled markdown source from any origin (GitHub `?plain=1`,
     plain-textarea exports, etc.).
   - `'asHtmlSource'`: tag-shaped pattern in text — `</tag>`,
     `<tag>` / `<tag/>`, `<tag attr=…>`, `<!DOCTYPE…>`, or
     `<!--…-->`. Bare-boolean-attr shapes (`<b and c>`) are
     deliberately rejected — they're indistinguishable from math
     prose like `if a<b and c>d`.

### Tradeoff

- The broader highlighter classes (`token`, `language-`, `cm-`) can
  false-positive on pages that use them for non-syntax purposes —
  UI tokens, multilingual paragraphs with `class="language-fr"`,
  utility classes prefixed `cm-`.
- When that fires the user gets the visible text instead of
  structured markdown.
- Graceful failure mode, since `text/plain` is still what they
  *saw*. Ctrl+Shift+V is the escape hatch.

### Why it matters

Without the short-circuit, the html-side path would mangle the
round trip:

- HTML editor: every `<` / `>` in the styled spans gets
  entity-escaped, and the editor receives the literal styled
  spans as visible source instead of the user's original markup.
- Markdown editor: `htmlToMarkdown` flattens spans to text but
  backslash-escapes every literal `*`, so `**bold**` source
  round-trips as `\*\*bold\*\*` and stops being bold.

When any signal fires, paste `text/plain` verbatim. Otherwise:

- `'asMarkdown'`: run `htmlToMarkdown(cleanCopiedHtml(html))`.
- `'asHtmlSource'`: insert `cleanCopiedHtml(html)` as source.

## `insertAtCaret`

Inserts text at the current caret in either a textarea or a
contenteditable, replacing any active selection.

- **Textareas**: `setRangeText(text, start, end, 'end')` plus a
  synthetic `input` event so listeners that watch `input` (e.g. the
  prompt's autosize) re-run.
- **Contenteditables**: insert a `document.createTextNode(text)`
  via the Range API at the current selection, then dispatch a
  synthetic `keyup` so CodeJar's debounced highlighter re-runs.

### Why a text node, not `execCommand('insertText')`

`insertText` converts each `\n` in the payload to a `<br>` element.
CodeJar reads source via `editor.textContent`, which skips `<br>`
element nodes — blank lines would silently collapse on the next
highlight pass.

A direct text-node insertion keeps `\n` as a literal text-node
character. `white-space: pre-wrap` on the editor renders it as a
real newline and `textContent` reads it back unchanged. No HTML
escaping needed (we're inserting a text node, not parsing HTML);
no deprecated `execCommand` either.

CodeJar's `keyup` listener is the path that triggers re-highlight
(it runs `debounceHighlight` when `prev !== toString()`). Firing
a synthetic `keyup` after the insertion routes through the same
pipeline a real keystroke would.

## Listener ordering vs CodeJar

The paste listener is attached *before* `CodeJar(editor, …)` wraps
the editor. CodeJar's own paste handler short-circuits on
`event.defaultPrevented`, so:

1. Our listener runs first, calls `preventDefault`, and inserts.
2. CodeJar's listener runs, sees `defaultPrevented`, bails.

Reverse the order and CodeJar would insert `text/plain` *before*
ours runs — the editor would end up with both copies.

## Build-time wiring

`htmlToMarkdown` and `looksLikeMarkdownSource` live in
`src/markdown.ts`, an ES module also imported by `capture.ts`,
`scrape-page-state.ts`, and the SW. `capture-page.ts` imports the
two symbols directly:

```ts
import { htmlToMarkdown, looksLikeMarkdownSource } from './markdown.js';
```

For that import to work, `capture.html` loads the controller as a
module:

```html
<script type="module" src="capture-page.js"></script>
```

- The vendor classic-script tags (`marked.umd.js`,
  `highlight.min.js`, `codejar.js`) stay where they were — module
  code reads window globals fine, so they're still consumed via
  `declare const`.
- They load before the module so the globals are in place when the
  module executes. Module scripts are deferred — they run after
  the parser finishes, by which time the classic scripts have
  already attached.
