# Ask on web

The "Ask AI" button on the Capture page sends the currently-staged
artifacts (screenshot, HTML snapshot, optional selection, prompt) to
an AI web UI in another tab. Ships with Claude (including Claude Code,
which can only take image uploads), Gemini, ChatGPT, and Google
Search (image-only, new-tab-only); the provider-adapter layout makes
additional providers additive.

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
- Trailing destination glyph (`#ask-btn-icon`) sits after the
  provider label and mirrors the resolved default's *kind* — pin
  glyph (`#pin-icon`) for an existing pinned tab, new-window glyph
  (`#new-window-icon`) for a new-tab destination. Same source
  symbols the menu's leading indicator slot uses, so the on-button
  hint and the in-menu hint stay visually consistent.
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
- **Pin clearing** — closed tabs, statically-disabled providers, and
  off-host navigations clear the pin lazily on the next `resolveAsk`.
  When the *user* disables the pinned provider on the Options page,
  the pin is cleared **eagerly** by `clearPinIfProviderDisabled` in
  `src/background.ts`, listening on `chrome.storage.onChanged` for
  the `askProviderSettings` key — so the toolbar Pin/Unpin entry
  doesn't keep saying "Unpin" for a pin that won't be honored.
- **Fallback** — the user's configured **default provider** (Options
  page → Ask AI providers), opened in a new tab. Used when there's no
  pin or the pin is dead. The default lives in `askProviderSettings`
  in `chrome.storage.local`; the SW's `normalizeAskProviderSettings`
  guarantees it always points at a user-enabled provider, or is null
  when every provider is disabled. Null fallback means plain-Ask
  resolves to "no destination" and the Capture-page button is
  disabled with the "No Ask providers enabled" tooltip — see
  [Provider settings](#provider-settings) below.

`sendToAi` writes the pin on every successful send, including
new-tab opens (so the freshly-created tab gets reused next time).
`resolveAsk` reads it for the menu / button label /
plain-Ask path.

### Toolbar pin entry

The action context menu (right-click on the toolbar icon) carries
a `Pin tab as Ask target` entry that lets the user pin/unpin the
**current tab** directly, without opening the Capture page. Driven
by `refreshPinAskTargetMenu` and `togglePinAskTarget` in
`src/background.ts` / `src/background/context-menu.ts`:

- **Eligibility** — enabled when either:
  - The active tab is the current `askPin` (regardless of URL), so
    the user can always Unpin from the tab the pin points at — even
    after navigating it to a wrong page.
  - The active tab matches an enabled provider's `urlPatterns`
    (Chrome match-pattern grammar) and isn't on its
    `excludeUrlPatterns` list, so it's a valid pin target.

  Otherwise the entry greys out.
- **Title** — flips between `Pin tab as Ask target` and
  `Unpin tab as Ask target` based on whether the active tab is
  the current `askPin`. The "Unpin" wording stays even when the
  pinned tab has navigated to a wrong page.
- **Refresh timing** — Chrome doesn't expose an `onShown` hook for
  the action context menu, so we keep the entry's state ahead of
  the user with listeners on `tabs.onActivated`, `tabs.onUpdated`
  (status `'complete'` or URL change), `windows.onFocusChanged`,
  and `storage.onChanged` for the `askPin` key.
- **Toggle** — clicking calls `togglePinAskTarget(tab)`. We
  re-resolve the provider at click time rather than trusting the
  cached title, so a stale entry can't pin an already-excluded
  page or refuse to clear a now-excluded pin.

### Provider settings

The Options page surfaces an **Ask button settings** section with
one row per registered provider, two columns of controls:

- **Enabled** — checkbox; user-disabled providers don't appear in
  the Ask menu, can't be pinned via the toolbar entry, and aren't
  used as the fallback default. If the active pin happens to be on
  a now-disabled provider, `resolveAsk` clears it lazily.
- **Default** — radio button; picks which enabled provider plain-Ask
  opens when there's no pin (or the pin is dead). When the user
  disables the current default, the page rotates the radio to the
  next enabled provider in label order (ChatGPT → Claude → Gemini,
  wrapping). When all providers are disabled, every radio is greyed;
  re-enabling any one of them re-elects it as the default.

Storage:

- Key: `askProviderSettings` in `chrome.storage.local`.
- Shape: `{ enabled: { claude, gemini, chatgpt, google }, default | null }`.
- Factory defaults: all enabled, default = Claude.
- `normalizeAskProviderSettings` is applied on every read AND write
  so a partial / never-saved object lands on the factory defaults
  and a default that points at a disabled provider gets shifted.

The Capture page also listens for `chrome.storage.onChanged` on this
key so changes made on the Options page (e.g. disabling every
provider) flip the Ask button's disabled state and tooltip live —
no page reload needed.

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
| `src/background/ask/google.ts` | Google Search adapter — `newTabOnly`, image-only, types into a `<textarea>` instead of a contenteditable; submit posts the search form to `/search`. |
| `src/ask-inject.ts` | Provider-agnostic runtime that runs in the AI tab's MAIN world. |
| `src/ask-widget.ts` | In-page status / recovery widget that runs in the AI tab's ISOLATED world (see "Status widget" below). |
| `src/background/ask/widget-store.ts` | `chrome.storage.session` wrapper for the widget — one record per destination tabId. |
| `src/capture.html` + `src/capture-page.ts` | Ask button, menu, status line, payload assembly. |

### Provider registry

```ts
type AskProvider = {
  id: 'claude' | 'gemini' | 'chatgpt' | 'google';
  label: string;
  urlPatterns: string[];        // chrome.tabs.query
  excludeUrlPatterns?: string[];// glob excludes filtered post-query
  newTabUrl: string;            // opened for "New window in <X>"
  enabled: boolean;             // false = "coming soon" in the menu
  acceptedAttachmentKinds?: ('image' | 'text')[]; // provider-wide; omit = all
  urlVariants?: AskUrlVariant[];                  // per-URL overrides
  newTabOnly?: boolean;                           // skip pinning + existing-tab listing
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
- `sendToAi` re-validates the destination tab's URL at send time
  (closed / off-provider / excluded) before any inject attempt, so a
  tab that closes or navigates between menu open and item click
  surfaces a clear status-line error instead of a late-stage
  "Could not find file-upload input" from `ask-inject.ts`.
- Syntax is a simpler `*`-glob (case-insensitive) — see the jsdoc
  on `AskProvider.excludeUrlPatterns` for the full grammar and
  pitfalls.
- Applied post-query in JS (via `matchesAny()` in `index.ts`)
  because `chrome.tabs.query` doesn't accept negative patterns.

`AskInjectSelectors` has four ranked lists: `fileInput`,
`textInput`, `submitButton`, and the optional `attachmentPreview`
(see below). The injected runtime walks each list in order and uses
the first match. There's also an optional `preFileInputClicks` list
for providers (Gemini today) whose file input only appears after a
click chain — see below.

### `attachmentPreview` (chip-count verification)

Opt-in per provider. When set, `attachFiles` in `src/ask-inject.ts`:

- Counts matching chips BEFORE dispatching the `change` event
  (`baselinePreviews`) — using a delta, not an absolute total,
  tolerates leftover chips from a previous Ask call in the same tab
  and ignores false-positive matches in unrelated page chrome.
- After the existing settle, polls up to `PREVIEW_CONFIRM_TIMEOUT_MS`
  (8 s by default; tunable from the page via
  `__seeWhatISeeAskTuning.previewConfirmTimeoutMs` for tests) for the
  count to reach `baseline + files.length`.
- If the deadline elapses with fewer chips, refuses with
  `"Only K of N attachments were accepted by the destination."`
  (or `"No attachments were accepted by the destination."` when
  `K === 0`) — surfaced on the Capture page status line BEFORE
  typing or submit.

Why this matters:

- The destination can accept the file-input `change` dispatch but
  still server-reject the upload.
- Most visible on ChatGPT when logged out: image uploads succeed,
  everything else gets a "File type must be one of …" toast.
- Without the chip-count gate we'd silently report Sent.

Selector list rules:

- Counts sum across all selectors, so list overlapping selectors only
  if each match is a distinct DOM node — duplicates (e.g. a wrapper +
  its child Remove button) double-count and mask partial-reject
  scenarios. Prefer a single canonical wrapper per file.
- Selectors should target the chip ELEMENT (one match per file), not
  a parent container (always 1) or descendants (over-count).
- Providers without `attachmentPreview` skip verification — the
  runtime falls back to its previous "settle and continue" behavior,
  so adding the field is non-breaking.

Drift fallback:

- When `last === 0 && baseline === 0` (no selector ever matched)
  the runtime surfaces `"Could not verify attachment delivery.
  Check the conversation manually; the upload may have succeeded."`
- This is the soft path: the user isn't told their upload was
  rejected when the real problem is our stale selectors.
- Heuristic is intentionally asymmetric — drift on a tab that
  already had leftover chips falls into the regular partial-reject
  branch instead. Fresh tabs are the dominant case.

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

### `acceptedAttachmentKinds` and `urlVariants` (Claude Code)

Some composers reject attachments their file input would otherwise
take via `DataTransfer`:

- Claude on `/code` (Claude Code) is the v1 case — same host as
  full-featured Claude, but the agentic-coding composer accepts
  images only and silently drops HTML / selection.
- Without filtering, the SW would inject everything, the AI tab would
  discard most of it, and the Capture page would still report
  "Sent." — none of which the user can act on.

Two cooperating fields live on `AskProvider`:

- `acceptedAttachmentKinds?: ('image' | 'text')[]` — provider-wide
  default. Omit (or leave undefined) to mean "no restriction." Today
  no provider sets this at the top level; everyone uses URL variants
  instead.
- `urlVariants?: AskUrlVariant[]` — per-URL overrides. Each entry has
  `pattern` (a `*`-glob, same grammar as `excludeUrlPatterns`) and
  `acceptedAttachmentKinds`. The first variant whose pattern matches
  the destination URL wins.

`resolveAcceptedKinds(provider, url)` — exported from
`src/background/ask/index.ts` — walks the variant list and falls back
to the provider-level default. Used in three places:

- `listAskProviders` populates per-tab `acceptedAttachmentKinds` on
  each `AskTabSummary`. The Capture page leans on the existing tab
  title to disambiguate sub-products — Claude Code's title is
  literally "Claude Code", so no extra suffix is rendered.
- `resolveAsk` sets `destinationAcceptedAttachmentKinds` on the
  resolved default destination so the Capture page can pre-validate
  the user's checkbox state before round-tripping to the SW.
- `sendToAi` resolves kinds at send time and refuses (with
  `ok: false`) if any attachment's kind isn't accepted at the
  destination, returning the offending filenames in `AskResult.skipped`.
  We deliberately don't silently filter — the user should always see
  "the payload I checked is what got sent." Reaching this branch
  implies a stale page-side cache; normal flow catches it upstream
  in the pre-send guard.

Pre-send guard on the Capture page:

- `checkDestinationAcceptsCheckedBoxes` runs before every send (plain
  Ask click and per-menu-row pick).
- If the user has checked Save rows whose kind isn't in the
  destination's accepted list, the status line names the destination
  via the variant `label` and lists the offending Save rows
  (`"Claude Code only accepts image attachments; uncheck Save HTML
  and Save selection."`), and the send is aborted.
- The SW's matching refusal at send time is the safety net for stale
  page state (toolbar Pin/Unpin or tab-navigation races where the
  cached accepted-kinds doesn't match what the destination actually
  accepts now). Its error message has the same shape, with
  `Skipped: …` appended naming the dropped filenames.

We deliberately don't offer a "New window in Claude Code" entry —
Claude Code requires repo-selection setup before any prompt makes
sense, so opening a fresh tab from Ask would dump the user on a
screen that can't accept the payload yet. The Ask menu only surfaces
`/code` tabs that already exist (the user pinned or set up).

`ask-inject.ts` is unchanged by all of this — filtering happens in
the SW so the runtime stays selector-driven and provider-agnostic.

### `newTabOnly` (Google Search)

Some destinations aren't a chat surface to reuse — Google Search
submits via a form GET that navigates the tab to `/search?q=…`,
clobbering any prior state. For these, set `newTabOnly: true` on the
provider and three things change:

- The Ask menu hides the "Existing window in <X>" section for it
  (`listAskProviders` skips the `chrome.tabs.query`).
- The toolbar Pin/Unpin entry stays disabled when the active tab is
  on this provider (`findProviderForTab` skips it).
- A successful send doesn't write `askPin` (`sendToAi` skips the
  pin-write step), so the next plain Ask still resolves to whatever
  the user's configured default points at — including a fresh tab on
  this provider, if it *is* the default.

The provider can still be the user's chosen default; plain Ask just
opens a new tab on it every time.

Google additionally pairs this with `acceptedAttachmentKinds: ['image']`
because the `+`-button file input is image-only — HTML and selection
attachments get the same Capture-page pre-send refusal Claude Code
uses.

### Adding a new provider

1. Create `src/background/ask/<provider>.ts`, export an
   `AskProvider` with selectors specific to that site.
2. Append it to `ASK_PROVIDERS` in `providers.ts`.
3. Add the id to `PROVIDER_IDS`, `DEFAULT_ROTATION`, and
   `DEFAULT_ASK_PROVIDER_SETTINGS.enabled` in `settings.ts`.
4. Set `enabled: true` once the file-input + prompt + submit path
   has been validated end-to-end on the live site.
5. For non-chat destinations (form-submit-and-navigate), set
   `newTabOnly: true` and pair with `acceptedAttachmentKinds` if the
   composer is type-restricted.

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
          │     installs the postMessage bridge listener (see below)
          ├── executeScript({ files: ['ask-widget.js'], world: 'ISOLATED' })
          │     widget walks each item via the bridge — see ask-widget.md
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
Installs a postMessage bridge listener on `window` and exposes the
ops the ISOLATED-world widget calls one at a time:

- `attachFile { attachment, selectors }` — build a `File` from the
  attachment's data (base64 decode for data URLs, `TextEncoder` for
  text), set `input.files` on the resolved file input, dispatch
  `change` + `input`, then settle 1500 ms and (if the provider opted
  in via `selectors.attachmentPreview`) confirm the chip count rose
  by one.
- `typePrompt { text, selectors }` — focus the contenteditable and
  insert the text segment-by-segment.
  - Split on `\n` and insert each segment with `execCommand('insertText')`.
  - Insert a paragraph break (`execCommand('insertParagraph')`)
    between segments — preserves blank lines and does *not* trigger
    an Enter `keydown`, so Claude's submit keymap stays out of it.
  - Both calls fall back to a synthesized `InputEvent` if
    `execCommand` returns `false`.
- `clickSubmit { selectors }` — poll `selectors.submitButton` for an
  enabled button (interval 150 ms, deadline 30 s) and click it. The
  submit-enable state is the authoritative "uploads finished" signal.

Each op resolves to `null` on success or rejects with an Error; the
bridge serializes that as `{ok: true, result}` / `{ok: false, error}`
back to the widget. See [`ask-widget.md`](ask-widget.md) for the
bridge protocol and the per-op timeouts the widget enforces.

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

## Status widget (`ask-widget.ts`)

A small panel injected into the destination AI tab during every
Ask. Renders per-step progress, exposes per-item Copy + Retry,
and gives the user a clipboard-based recovery surface even after
the Capture page closes.

The widget is the **active orchestrator** of the inject — the SW
resolves the destination tab, writes the initial record, and then
hands off; the widget walks each item via a `window.postMessage`
bridge into MAIN-world helpers in `ask-inject.ts`.

Full design — UI, theming, storage record shape, cross-world
bridge protocol, retry / cancel-and-replace semantics — lives in
[`ask-widget.md`](ask-widget.md).

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
(claude.ai, gemini.google.com, chatgpt.com, google.com). Used to
confirm prod selectors still match the live DOM and the prod
timings still work. Not part of `npm test`.

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
