# Ask on web

The "Ask AI" button on the Capture page sends the currently-staged
artifacts (screenshot, HTML snapshot, optional selection, prompt) to
an AI web UI in another tab. v1 supports Claude only; the
provider-adapter layout makes Gemini / ChatGPT additive.

## Goals

- One click from the Capture page to a Claude tab with everything
  attached.
- Reuse the same Save-checkbox state the Capture button reads — no
  second "what to include" UI.
- Upload HTML and selection as **file attachments**, not as inline
  prompt text. Cleaner prompt history, handles large pages.
- Auto-submit when the user typed a prompt; leave the input alone
  when they didn't.
- Pick destination (new tab vs. existing tab) every time.

## UI on the Capture page

### Button stack

- `#capture` and `#ask-btn` sit one above the other in a
  `.button-stack` grid that's sized to `max-content` of the wider
  child, with `width: 100%` on each button — so the two buttons
  share a width regardless of label length.
- Ask button label is `<u>A</u>sk <span id="ask-target-label">…</span>`.
  The trailing span is updated by `refreshAskTargetLabel()` from the
  enabled providers — "Ask Claude" today, "Ask AI" with multiple
  enabled providers.
- Tooltips: Capture is "Save to disk (Read with /see-what-i-see
  skills)". Ask is "Send to `<provider>` on web", recomputed
  alongside the label.

### Hotkeys

- `Alt+C` — Capture.
- `Alt+A` — open the Ask menu (toggle).
- Both no-op when their button is `disabled` (in-flight save / Ask).
- The underlines on `C` / `A` mirror the hotkeys.

### Ask menu

Anchored popup below the Ask button, rebuilt fresh on every open
from `chrome.tabs.query` per registered provider:

```
New window in
  Claude
  (Gemini  — coming soon, disabled)
  (ChatGPT — coming soon, disabled)
─────────────────────────────────────
Existing window in Claude
  "Helping with the Ask feature design…"
  "untitled"
─────────────────────────────────────
Existing window in Gemini       ← only when Gemini has open tabs
  …
```

- "Existing window in `<provider>`" sections render only for
  providers with at least one matching tab open.
- Each section is preceded by a horizontal separator
  (`.ask-menu-separator`).
- One click on a menu item both picks the destination and sends.
- ESC and outside-click dismiss the menu.

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
| `src/background/ask/index.ts` | Orchestration: `listAskProviders`, `sendToAi`, `installAskMessageHandler`. Resolves target tab, focuses it, runs the injected runtime. |
| `src/background/ask/providers.ts` | Provider registry types + `ASK_PROVIDERS` array. |
| `src/background/ask/claude.ts` | Claude adapter — provider data only (label, URLs, ranked selectors). |
| `src/ask-inject.ts` | Provider-agnostic runtime that runs in the AI tab's MAIN world. |
| `src/capture.html` + `src/capture-page.ts` | Ask button, menu, status line, payload assembly. |

### Provider registry

```ts
type AskProvider = {
  id: 'claude';                 // future: | 'gemini' | 'chatgpt'
  label: string;
  urlPatterns: string[];        // chrome.tabs.query
  excludeUrlPatterns?: string[];// glob excludes filtered post-query
  newTabUrl: string;            // opened for "New window in <X>"
  enabled: boolean;             // false = "coming soon" in the menu
  selectors: AskInjectSelectors;
};
```

`excludeUrlPatterns`:

- Removes tabs whose URL matches any pattern, even when
  `urlPatterns` already matched them.
- Used for pages on the provider's domain that aren't valid chat
  targets — settings, projects index, login.
- Syntax is a simpler `*`-glob (case-insensitive) — see the jsdoc
  on `AskProvider.excludeUrlPatterns` for the full grammar and
  pitfalls.
- Applied post-query in JS (via `matchesAny()` in `index.ts`)
  because `chrome.tabs.query` doesn't accept negative patterns.

`AskInjectSelectors` has four ranked lists: `fileInput`,
`textInput`, `submitButton`, `attachmentPreview` (vestigial, kept
for future preview-confirmation work). The injected runtime walks
each list in order and uses the first match.

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
  click #ask-btn ─────────────────────────────────────┐
    sendMessage({ action: 'askListProviders' }) ──▶   │
      background/ask/index.ts → listAskProviders()    │
        chrome.tabs.query(provider.urlPatterns)       │
    rebuild popup menu                                │
                                                      │
  user picks a destination ◀────────────────────────  ┘
    sendMessage({ action: 'askAi', destination, payload }) ──▶
      background/ask/index.ts → sendToAi()
        ├── resolve tab (existing or new — wait 'complete' up to 15s)
        ├── focus tab + window
        ├── executeScript({ files: ['ask-inject.js'], world: 'MAIN' })
        └── executeScript({ func: invokeRuntime, args: [selectors, payload] })
              window.__seeWhatISeeAsk(selectors, payload) — see below
    show #ask-status: "Sent." or error
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

## Out of scope (v1)

- Gemini and ChatGPT adapters — architecture supports them; defer
  until Claude is solid.
- Pinning a default destination so plain Ask sends without showing
  the menu.
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
