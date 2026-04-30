# Ask on web

The "Ask AI" button on the Capture page sends the currently-staged
artifacts (screenshot, HTML snapshot, optional selection, prompt) to
an AI web UI in another tab. Ships with Claude, Gemini, and ChatGPT;
the provider-adapter layout makes additional providers additive.

## Goals

- One click from the Capture page to a Claude tab with everything
  attached.
- Reuse the same Save-checkbox state the Capture button reads — no
  second "what to include" UI.
- Upload HTML and selection as **file attachments**, not as inline
  prompt text. Cleaner prompt history, handles large pages.
- Auto-submit when the user typed a prompt; leave the input alone
  when they didn't.
- Remember the last destination so repeat-Asks reuse the same
  conversation tab. The drop-down caret remains available for
  picking a different target.

## UI on the Capture page

### Button stack

- `#capture` and the Ask split widget (`.ask-split`) sit one above
  the other in a `.button-stack` grid that's sized to `max-content`
  of the wider child. The Capture button has `width: 100%`; the
  Ask split is a flex row that fills its grid cell and divides the
  space between its two halves.
- Ask split is two buttons sharing a single visual chrome:
  - `#ask-btn` — the main "Ask `<provider>`" label. Click sends
    straight to the resolved default destination (no menu).
  - `#ask-caret` — chevron-only square button on the right edge.
    Click opens the menu so the user can pick a different target.
- The trailing label `#ask-target-label` and the main button's
  tooltip are updated by `refreshAskTargetLabel()` to match
  whichever provider the resolved default points at — "Ask Claude"
  while the pin lives on a Claude tab, "Ask ChatGPT" once the user
  picks a ChatGPT tab from the menu, and so on.
- Tooltip phrasing reflects the destination kind: "Send to existing
  Claude window" when a pinned tab is alive, "Send to new Claude
  window" when the fallback is in play.

### Hotkeys

- `Alt+C` — Capture.
- `Alt+A` — open the Ask menu (caret click). Mirrors the keyboard
  path the menu had before pinning landed, so the user always has a
  chance to pick a different target.
- Both no-op when their button is `disabled` (in-flight save / Ask).
- The underlines on `C` / `A` mirror the hotkeys.

### Ask menu

Anchored popup below the Ask button, rebuilt fresh on every open
from `chrome.tabs.query` per registered provider:

```
New window in
  Claude
  Gemini
  ChatGPT
─────────────────────────────────────
Existing window in Claude
  "Helping with the Ask feature design…"
  "untitled"
─────────────────────────────────────
Existing window in Gemini       ← only when Gemini has open tabs
  …
─────────────────────────────────────
Existing window in ChatGPT      ← only when ChatGPT has open tabs
  …
```

- "Existing window in `<provider>`" sections render only for
  providers with at least one matching tab open.
- Each section is preceded by a horizontal separator
  (`.ask-menu-separator`).
- One click on a menu item both picks the destination and sends.
- Each item has a leading 16px indicator slot (always reserved).
  The item that matches the **resolved default** carries
  `is-default` and shows a green pushpin glyph (`#pin-icon`) —
  that's the one plain `#ask-btn` will hit. Reserving the slot on
  every item keeps labels vertically aligned across the menu.
- A still-alive pinned tab whose URL is now on a wrong page
  (excluded) gets `is-stale` and a grey crossed-out pin
  (`#pin-off-icon`) on the same slot. Both the stale row and the
  new fallback's `is-default` row are visible at once, so the user
  can see "pin used to point here" alongside "this is what plain
  Ask will hit instead." Mutually exclusive with `is-default`.
- Tabs on the provider's host but on an excluded URL (settings,
  library, recents, etc.) appear in the listing too, rendered
  disabled with an italic `(Wrong page)` suffix. See
  `excludeUrlPatterns` below.
- ESC and outside-click dismiss the menu.

### Pinning (the resolved default)

Plan-Ask (clicking `#ask-btn` without opening the menu) targets
whichever destination the SW currently considers the default:

- **Pin shape** — `{ provider, tabId }` written to
  `chrome.storage.session` under `askPin`. Session storage means the
  pin clears on browser restart, which is appropriate since `tabId`
  is only meaningful inside a single Chrome session.
- **Pin reuse rules** — kept only when the tab still exists, the
  pinned provider is still enabled, and the tab's URL still matches
  one of that provider's `urlPatterns` (so a navigated-away tab
  doesn't get hijacked).
- **Stale pin** — pinned tab is alive on the provider's host but
  on an *excluded* URL (settings, library, recents):
  - Pin is **kept** rather than cleared, so a navigation back
    restores it.
  - `resolveAsk` reports it as `staleTabPin` so the menu can render
    the grey crossed-pin row described above.
  - Plain-Ask in this state hits the fallback, and the new tab's
    id overwrites the stale pin via `sendToAi`'s `writePin` —
    a stale pin can't linger forever, just past the user's next
    decision.
- **Pin clearing** — closed tabs, disabled providers, and off-host
  navigations clear the pin lazily on the next `resolveAsk`.
- **Fallback** — first enabled provider's "newTab" entry, used when
  there's no pin or the pin is dead. "First" is registry order in
  `ASK_PROVIDERS` (Claude → Gemini → ChatGPT today), so adding a
  provider above an existing one in the array would change which
  provider plain-Ask picks for first-time users.

`sendToAi` writes the pin on every successful send, including
new-tab opens (so the freshly-created tab gets reused next time).
`resolveAsk` reads it for the menu / button label /
plain-Ask path.

### Status line

`#ask-status` sits directly below the buttons + "Prompt:" label,
inside the same flex column (`.left-stack`). Displays:

- "Sending…" while the round-trip is in flight.
- "Sent." on success.
- The error message on failure.

Layout intent (full rationale in the `.controls` CSS comment in
`src/capture.html`):

- The textarea is a sibling of `.left-stack`, not a child — its
  height is independent so a tall prompt does not push the status
  away from the buttons.
- A long error wraps inside the buttons + label width instead of
  widening the column or squashing the textarea. The width pinning
  uses `width: 0; min-width: 100%` on `#ask-status` so its content
  doesn't contribute to the column's intrinsic size.

## Architecture

### Files

| File | Purpose |
|------|---------|
| `src/background/ask/index.ts` | Orchestration: `listAskProviders`, `resolveAsk`, `sendToAi`, `installAskMessageHandler`. Resolves target tab (with stale-pin detection), focuses it, runs the injected runtime, and pins the destination on success. |
| `src/background/ask/providers.ts` | Provider registry types + `ASK_PROVIDERS` array. |
| `src/background/ask/claude.ts` | Claude adapter — provider data only (label, URLs, ranked selectors). |
| `src/background/ask/gemini.ts` | Gemini adapter — same shape as Claude's, plus a `preFileInputClicks` chain to surface Gemini's dynamic file input. |
| `src/background/ask/chatgpt.ts` | ChatGPT adapter — provider data only; `#upload-files` is in the initial DOM so no `preFileInputClicks` is needed, and the composer is ProseMirror so the typing path matches Claude's. |
| `src/ask-inject.ts` | Provider-agnostic runtime that runs in the AI tab's MAIN world. |
| `src/capture.html` + `src/capture-page.ts` | Ask button, menu, status line, payload assembly. |

### Provider registry

```ts
type AskProvider = {
  id: 'claude' | 'gemini' | 'chatgpt';
  label: string;
  urlPatterns: string[];        // chrome.tabs.query
  excludeUrlPatterns?: string[];// glob excludes filtered post-query
  newTabUrl: string;            // opened for "New window in <X>"
  enabled: boolean;             // false = "coming soon" in the menu
  selectors: AskInjectSelectors;
};
```

`excludeUrlPatterns`:

- Marks tabs whose URL matches any pattern as `excluded` in the
  menu listing — they still appear under "Existing window in X"
  but are rendered disabled with a "(Wrong page)" italic
  suffix and aren't selectable.
- Used for pages on the provider's domain that aren't valid chat
  targets — settings, projects index, login, recents.
- Excluded tabs are also rejected by `resolveAsk`
  so plain Ask can never resolve to one.
- Syntax is a simpler `*`-glob (case-insensitive) — see the jsdoc
  on `AskProvider.excludeUrlPatterns` for the full grammar and
  pitfalls.
- Applied post-query in JS (via `matchesAny()` in `index.ts`)
  because `chrome.tabs.query` doesn't accept negative patterns.

`AskInjectSelectors` has four ranked lists: `fileInput`,
`textInput`, `submitButton`, `attachmentPreview` (vestigial, kept
for future preview-confirmation work). The injected runtime walks
each list in order and uses the first match. There's also an
optional `preFileInputClicks` list for providers (Gemini today)
whose file input only appears after a click chain — see below.

### `preFileInputClicks` (Gemini)

Some providers don't expose a file `<input>` in the initial DOM:

- The user has to open an "Add files" menu first, then pick "Upload
  files", and only that menu action creates the input.
- For these providers the adapter declares `preFileInputClicks` — a
  list of button selectors the runtime clicks in order before
  searching for the file input.

For the duration of the click chain the runtime patches
`HTMLInputElement.prototype.click` to a no-op for `type="file"` inputs:

- Without the patch, a menu-item click handler would call `.click()`
  on the freshly-created input and pop the OS file picker —
  defeating programmatic upload.
- The patch is installed and restored inside the same try/finally so
  it can't leak even if a click selector throws.
- Once the click chain finishes, the runtime polls for the input via
  `waitForRankedLast` and picks the **last** match in document order
  — handles the second-call case where a stale input from the
  previous attach may still be in the DOM.

Claude's adapter omits `preFileInputClicks`; the runtime takes the
fast path (a single `findRanked` call against `fileInput`) and the
override never installs.

### Adding a new provider

1. Create `src/background/ask/<provider>.ts`, export an
   `AskProvider` with selectors specific to that site.
2. Append it to `ASK_PROVIDERS` in `providers.ts`.
3. Set `enabled: true` once the file-input + prompt + submit path
   has been validated end-to-end on the live site.

`ask-inject.ts` does not change — it's selector-driven.

## Send flow

```
Capture page (capture-page.ts)
  click #ask-caret ───────────────────────────────────┐
    sendMessage({ action: 'askListProviders' }) ──▶   │
      background/ask/index.ts                         │
        listAskProviders() + resolveAsk()
          chrome.tabs.query(provider.urlPatterns)     │
          read 'askPin' from chrome.storage.session   │
    rebuild popup menu (pin on the default item)      │
                                                      │
  user picks a destination ◀────────────────────────  ┘
    sendMessage({ action: 'askAi', destination, payload }) ──▶ ▼
                                                                │
  click #ask-btn ─────────────────────────────────────────────► │
    sendMessage({ action: 'askAiDefault', payload }) ──▶        │
      background/ask/index.ts                                   │
        resolveAsk()                             │
        sendToAi() ◀───────────────────────────────────────────┘
          ├── resolve tab (existing or new — wait 'complete' up to 15s)
          ├── focus tab + window
          ├── executeScript({ files: ['ask-inject.js'], world: 'MAIN' })
          ├── executeScript({ func: invokeRuntime, args: [selectors, payload] })
          │     window.__seeWhatISeeAsk(selectors, payload) — see below
          └── on success: write 'askPin' = { provider, tabId }
    show #ask-status: "Sent." or error
    refresh #ask-target-label (the pin may have moved)
```

### Payload

The Capture page assembles the payload from existing checkbox state:

| Field | Source |
|-------|--------|
| `attachments[]` (image/png) | `previewImg.src`, baked via `renderHighlightedPng()` if there are edits, when `screenshotBox.checked` |
| `attachments[]` (text/html, `contents.html`) | `captured.html`, when `htmlBox.checked` |
| `attachments[]` (text/markdown\|plain\|html, `selection.{md,txt,html}`) | `captured[wireKind]` for the selected format, when selection master is checked |
| `promptText` | `promptInput.value.trim()` |
| `autoSubmit` | `promptText.length > 0` |

### Injected runtime (`ask-inject.ts`)

Self-contained IIFE, no `import` / `export`, runs in MAIN world.
Exposes `window.__seeWhatISeeAsk(selectors, payload)`.

Steps:

1. **Build files** from each `attachment.data` — base64 decode for
   data URLs, `TextEncoder` for text. Failure here is caught before
   any DOM mutation.
2. **Attach files** in a single change event on the file input.
   `DataTransfer.items.add(file)` for each, set `input.files = dt.files`,
   dispatch `change` and `input`.
3. **Settle** for 1500 ms — gives Claude's React state time to
   ingest the upload before we type into the composer.
4. **Type prompt** into the contenteditable.
   - Split on `\n` and insert each segment with `execCommand('insertText')`.
   - Insert a paragraph break (`execCommand('insertParagraph')`)
     between segments — this preserves blank lines as their own
     paragraphs and crucially does *not* trigger an Enter `keydown`,
     so Claude's submit keymap stays out of it.
   - Both calls fall back to a synthesized `InputEvent` if
     `execCommand` returns `false`.
5. **Auto-submit** when `autoSubmit && promptText.trim().length > 0`:
   poll `selectors.submitButton` for an enabled button (interval
   150 ms, deadline 30 s) and click. The submit-enable state is the
   authoritative "uploads finished" signal.
6. Return `{ ok: true }` or `{ ok: false, error }`.

### Why MAIN world

- The composer (Claude's ProseMirror) listens for `beforeinput` /
  `input` events on its own DOM. Isolated-world events fire into a
  separate JS realm and the page never sees them.
- Same for the file input's `change` event — React-attached
  listeners only fire from the page's realm.

### Why dynamic injection (no `content_scripts`)

- `host_permissions: ["<all_urls>"]` + `scripting` permission
  already cover `claude.ai/*` (and future providers). No new
  manifest permissions.
- The extension runs zero code on AI sites until the user clicks
  Ask. Smaller surface area, no impact on regular browsing.

## Why ProseMirror matters

Claude's prompt input is a [ProseMirror](https://prosemirror.net)
editor (the `tiptap ProseMirror` class on the contenteditable).
Implications:

- Setting `.textContent` / `.innerHTML` does nothing — ProseMirror
  re-renders from its own document model on the next pass.
- Insertion has to go through the input pipeline. `execCommand('insertText')`
  emits an `InputEvent` with `inputType: 'insertText'`, which
  ProseMirror translates into a model edit.
- A literal `\n` passed to `insertText` can be interpreted as Enter
  — hence the line-by-line splitting + `insertParagraph` between
  segments.
- `execCommand('insertParagraph')` emits `inputType: 'insertParagraph'`,
  which produces a real `<p>` break in the model. It does *not* fire
  an Enter `keydown`, so Claude's submit keymap is bypassed.

## Diagnosing problems

The injected runtime logs every step to the **AI tab's** DevTools
console under the `[SeeWhatISee Ask]` prefix:

- `run: invoked` with `{ attachments, promptLength, autoSubmit, url }`.
- `<role>: matched <selector>` for `fileInput` / `textInput` /
  `submitButton` — surfaces selector drift the moment claude.ai
  changes a DOM hook.
- `<role>: no selector matched [...]` (warning) — direct pointer
  to which list needs updating.
- `attachFiles: N file(s) [names]` → `dispatched change+input` →
  `settling for 1500ms`.
- `typePrompt: focused input, starting insertion {length, lines}` →
  `insertion complete`.
- `clickSubmit: waiting for submit button to enable` →
  `clicking after Xms (N polls)`.
- `run: completed successfully` or `run: failed <message>`.

The Capture page side surfaces failures via `#ask-status`. The
Capture page is still open after a failure, so the user can
Copy/Save any artifact manually as a recovery path.

## Live e2e tests (manual)

There's a separate manual suite at `tests/e2e-live/` that runs
the injection library against the **real** provider pages
(claude.ai, gemini.google.com, chatgpt.com). Used to confirm prod
selectors still match the live DOM and the prod timings still
work. Not part of `npm test`.

Setup, running, design principles, and how to add a new
provider all live in [`ask-live-tests.md`](ask-live-tests.md).

## Out of scope (v1)

- Options-page controls (preferred provider, attachment subset,
  auto-submit toggle).
- Optional structured-prompt mode (URL footer, inline selection
  quote). For now the prompt is the user's text verbatim, with
  everything else as file attachments.
- Region-cropping before Ask.
- Remote selector config.
- DOM-based attachment-preview confirmation (`attachmentPreview`
  selectors are vestigial in `AskInjectSelectors`; the
  submit-enable poll already gates "uploads finished" for the
  auto-submit path).
