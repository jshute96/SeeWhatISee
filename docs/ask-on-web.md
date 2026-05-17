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

- `.right-stack` (the column right of the Save checkboxes) holds
  three rows: the prompt textarea on top (label + textarea, with
  the textarea growing vertically as the user types), the
  horizontal action-button row in the middle, and the
  `#ask-status` line on the bottom.
- `.button-row` holds `#capture` followed by every Ask button,
  laid out as a flex row with `flex-wrap` so a narrow viewport
  stacks them across multiple lines instead of overflowing. The
  row is also the popup menu's `position: relative` anchor.
- Each Ask button uses the `.ask-row` class — content-sized flex
  with a label and a trailing icon, separated by a 6px gap.
- The Ask split: `.ask-split` wraps `#ask-btn` (the main "Ask
  `<provider>`" label) and `#ask-menu-btn` (a chevron-only sliver
  attached to its right edge that opens the destination-picker
  menu). They share a visual chrome — common border at the seam,
  outer radii at the start of the main button and the end of the
  caret. `.ask-split` is also the popup menu's `position:
  relative` anchor.
  - `#ask-btn` sends straight to the resolved default destination
    — pinned tab if alive, else a new tab in the preferred /
    Options-default provider. Carries `Alt+A`. Sits immediately
    after `#capture` so the user's most-likely Ask click is the
    second button on the row, with no preamble. The trailing
    `#ask-target-label` and the button's tooltip are updated by
    `refreshAskTargetLabel()` to match whichever provider the
    resolved default points at. Trailing icon (`#ask-btn-icon`,
    a `<span>` holding a single text codepoint) signals what
    plain-Ask is about to do:
    - `📌` (emoji-presentation pushpin, red via the system color-
      emoji font) → existing pinned tab.
    - `↗` (U+2197 text-presentation arrow, no VS-16) → new-tab
      destination. Tinted green via `color: #060` to match the
      green indicators in the Ask dropdown menu's leading slot.
      The colored emoji form (`↗️`) is avoided because it would
      be a fixed blue glyph that ignores `color`.
    - The toolbar context-menu uses ☐ / ☑ instead of 📌 because
      native menu rendering on Linux falls back to a thin
      monochrome glyph for 📌.
  - `#ask-menu-btn` opens the menu. Picking a row shifts the
    default (writes the pin or the preferred-new-tab provider)
    and refreshes the labels — does *not* send.
- After `.ask-split` come the per-provider Ask buttons. One
  `.ask-provider-btn` per enabled provider, appended directly
  into `.button-row` by `refreshAskTargetLabel()` — they're real
  flex children of the row so the row's `gap` spaces them evenly
  with the static buttons (a `display: contents` wrapper would
  perturb the gap math). Compact squares with no text label;
  identified by the bundled brand logo from `src/icons/`
  (`AskProvider.iconFilename` — `claude.svg`, `gemini.svg`,
  `chatgpt.ico`, `google.ico`), resolved on the page via
  `chrome.runtime.getURL('icons/' + iconFilename)`. Bundled
  rather than fetched at runtime because some providers' favicons
  require auth, redirect, or 404 from a fresh extension context.
  Each click sends straight to a *new tab* on that provider,
  bypassing the resolved default. `sendToAi` still pins on
  success, so a per-provider click shifts the default for the
  next plain-Ask.
- Capture and `#ask-btn` carry `color: #512da8; font-weight: 700;`
  (the same deep-purple as the page header's brand title) so the
  two primary actions read as more prominent than the neutral
  per-provider squares.
- Tooltip phrasing on `#ask-btn` reflects the destination kind:
  "Send to existing Claude window" when a pinned tab is alive,
  "Send to new Claude window" when the fallback is in play.
  Per-provider buttons say "Ask `<provider>` in new tab".
- `.is-default` highlight ring (the user's chosen default submit
  button, set on the Options page):
  - Capture uses `box-shadow: inset 0 0 0 2px` so the ring paints
    over its own background.
  - `.ask-split` uses an `::after` pseudo-element overlay
    (absolute, inset:0, 2px border, `pointer-events: none`).
    An inset shadow on the wrapper would be hidden behind the
    inner buttons' own backgrounds; the pseudo paints on top.
  - Both choices are inset / overlay rather than `outline` so the
    ring doesn't extend past the button edge into the
    `.button-row` gap and visibly shrink the spacing on either
    side of the highlighted item.

### Hotkeys

- `Alt+C` — Capture (clicks `#capture`).
- `Alt+A` — Ask (clicks `#ask-btn`); fires the send against the
  currently-resolved default destination. Use the "Ask…" row or
  one of the per-provider rows with the mouse to send against a
  different target.
- Both no-op when their button is `disabled` (in-flight save / Ask).
- The underlines on `C` / `A` mirror the hotkeys.

### Click modifiers (Capture and Ask)

`#capture`, `#ask-btn`, and every per-provider Ask row apply the
same modifier semantics:

- **Plain click** — each button's own default. Capture closes the
  page after the save; Ask leaves it open.
- **Shift-click** — keep the page open after the action. Useful
  when chaining a Capture into an Ask (or vice versa) without
  losing the staged preview.
- **Ctrl-click** — close the page after the action. Mirrors Capture's
  default for the Ask side, so a "send and dismiss" gesture works
  the same way regardless of which button you hit. The Ask close
  path leaves focus on the destination provider tab (not the
  original screenshot tab) — `sendToAi` already activated the
  provider and the answer is about to stream in there.

shift wins if both modifiers are held. Ask only requests the close
on a successful send — failures keep the page open as a recovery
surface (Copy / Download buttons are right there).

### Ask menu

Anchored popup below the Ask button, rebuilt fresh on every open
from `chrome.tabs.query` per registered provider:

```
New tab in
  Claude
  Gemini
  ChatGPT
─────────────────────────────────────
Existing tab in Claude
  "Helping with the Ask feature design…"
  "untitled"
─────────────────────────────────────
Existing tab in Gemini          ← only when Gemini has open tabs
  …
─────────────────────────────────────
Existing tab in ChatGPT         ← only when ChatGPT has open tabs
  …
```

- "Existing tab in `<provider>`" sections render only for
  providers with at least one matching tab open.
- When *no* provider has any matching tab, a single "Existing
  tabs" heading appears instead, with one disabled "No existing
  tabs" row underneath. Lets the menu always show both axes (new
  vs. existing) so the user can tell the section is empty rather
  than missing:
  ```
  New tab in
    Claude
    Gemini
    ChatGPT
  ─────────────────────────────────────
  Existing tabs
    No existing tabs                   ← disabled
  ```
- Each section is preceded by a horizontal separator
  (`.ask-menu-separator`).
- Picking a menu item updates the default (writes `askPin` for an
  existing-tab pick, writes `askPreferredNewTabProvider` for a
  "New tab in <X>" pick) and refreshes the button label / icon
  to match. Does *not* send — the user fires the Ask with a
  follow-up click on `#ask-btn` (or `Alt+A`). This split keeps
  "shift the default" and "fire the send" as two distinct gestures.
- Each item has a leading 16px indicator slot (always reserved).
  The item that matches the **resolved default** carries
  `is-default` and shows a 📌 emoji — that's the one plain
  `#ask-btn` will hit. Reserving the slot on every item keeps
  labels vertically aligned across the menu.
- A still-alive pinned tab whose URL is now on a wrong page
  (excluded) gets `is-stale` and a red ❗ on the same slot — flags
  "this row is what *was* the pin, but it's wandered onto a wrong
  page." Both the stale row and the new fallback's `is-default`
  row are visible at once, so the user can see "pin used to point
  here" alongside "this is what plain Ask will hit instead."
  Mutually exclusive with `is-default`.
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
    the red ❗ stale-pin row described above.
  - Plain-Ask in this state hits the fallback, and the new tab's
    id overwrites the stale pin via `sendToAi`'s `writePin` —
    a stale pin can't linger forever, just past the user's next
    decision.
- **Pin clearing** — closed tabs, statically-disabled providers, and
  off-host navigations clear the pin lazily on the next `resolveAsk`.
  When the *user* disables the pinned provider on the Options page,
  the pin is cleared **eagerly** by `clearPinIfProviderDisabled` in
  `src/background.ts`, listening on `chrome.storage.onChanged` for
  the `askProviderSettings` key — so the toolbar Set/Unset entry
  doesn't keep saying "Unset" for a pin that won't be honored.
- **Fallback priority** — when no live pin resolves, `resolveAsk`
  walks the remaining levels in order:
  - **`askPreferredNewTabProvider`** in `chrome.storage.session` —
    a session-scoped override written by the Ask menu's "New
    window in `<X>`" pick. Lets the menu act as a default-picker
    without overwriting the persistent option. Cleared on
    browser restart so the user's Options-page default reasserts
    itself for fresh sessions.
  - The user's configured **default provider** (Options page → Ask
    AI providers), opened in a new tab. Lives in
    `askProviderSettings` in `chrome.storage.local`; the SW's
    `normalizeAskProviderSettings` guarantees it always points at
    a user-enabled provider, or is null when every provider is
    disabled. Null fallback means plain-Ask resolves to "no
    destination" and the Capture-page button is disabled with
    the "No Ask providers enabled" tooltip — see
    [Provider settings](#provider-settings) below.
  - Either level is dropped lazily on the next `resolveAsk` if the
    provider has since been disabled.

`sendToAi` writes the pin on every successful send, including
new-tab opens (so the freshly-created tab gets reused next time).
`resolveAsk` reads it for the menu / button label /
plain-Ask path.

### Toolbar pin entry

The action context menu (right-click on the toolbar icon) carries
a `☐  Set this tab as Ask button target` entry that lets the user pin/unpin the
**current tab** directly, without opening the Capture page. Driven
by `refreshPinAskTargetMenu` and `togglePinAskTarget` in
`src/background.ts` / `src/background/context-menu.ts`:

- **Eligibility** — enabled when either:
  - The active tab is the current `askPin` (regardless of URL), so
    the user can always clear the pin from the tab it points at —
    even after navigating it to a wrong page.
  - The active tab matches an enabled provider's `urlPatterns`
    (Chrome match-pattern grammar) and isn't on its
    `excludeUrlPatterns` list, so it's a valid pin target.

  Otherwise the entry greys out.
- **Title** — flips between `☐  Set this tab as Ask button target`
  and `☑  Unset this tab as Ask button target` based on whether the
  active tab is the current `askPin`. The "Unset" wording stays
  even when the pinned tab has navigated to a wrong page. The
  ballot-box prefix doubles as a state indicator (unchecked when
  the tab isn't pinned, checked when it is) — `chrome.contextMenus`
  has no `iconUrl` API, so a leading glyph is the only option, and
  the text-default ballot boxes render consistently across native
  menu renderers (the colored 📌 emoji falls back to a thin grey
  glyph on Linux GTK).
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

`#ask-status` is the bottom row of the `.right-stack` column.
Displays:

- "Sending…" while the round-trip is in flight.
- "Sent." on success.
- The error message on failure.

Layout intent (full rationale in the `.controls` CSS comment in
`src/capture.html`):

- Stacked rows: prompt textarea, then the button row, then the
  status. The textarea grows vertically without pushing the
  status off-screen because its growth is bounded by `max-height`.
- A long error wraps inside the column width instead of widening
  the column or overflowing the page. `min-height: 1em` reserves
  space when empty so a future status message doesn't shift the
  layout below.

## Architecture

### Files

| File | Purpose |
|------|---------|
| `src/ask/index.ts` | Orchestration: `listAskProviders`, `resolveAsk`, `sendToAi`, `installAskMessageHandler`, `friendlyInjectError`. Resolves target tab (with stale-pin detection), runs the injected runtime, focuses the new tab early after a scriptability probe (closes it if the probe fails, otherwise leaves it open even on late inject failure and switches focus back to the Capture page), and pins the destination on success. |
| `src/ask/providers.ts` | Provider registry types + `ASK_PROVIDERS` array. |
| `src/ask/claude.ts` | Claude adapter — provider data only (label, URLs, ranked selectors). |
| `src/ask/gemini.ts` | Gemini adapter — same shape as Claude's, plus a `preFileInputClicks` chain to surface Gemini's dynamic file input. |
| `src/ask/chatgpt.ts` | ChatGPT adapter — provider data only; `#upload-files` is in the initial DOM so no `preFileInputClicks` is needed, the composer is ProseMirror so the typing path matches Claude's, and `maxAttachmentCount: 2` reflects the composer's per-turn cap. |
| `src/ask/google.ts` | Google Search adapter — `newTabOnly`, image-only, types into a `<textarea>` instead of a contenteditable; submit posts the search form to `/search`. |
| `src/ask-inject.ts` | Provider-agnostic runtime that runs in the AI tab's MAIN world. |
| `src/ask-widget.ts` | In-page status / recovery widget that runs in the AI tab's ISOLATED world (see "Status widget" below). |
| `src/ask/widget-store.ts` | `chrome.storage.session` wrapper for the widget — one record per destination tabId. |
| `src/capture.html` + `src/capture-page.ts` | Ask button, menu, status line, payload assembly. |

### Provider registry

```ts
type AskProvider = {
  id: 'claude' | 'gemini' | 'chatgpt' | 'google';
  label: string;
  urlPatterns: string[];        // chrome.tabs.query
  excludeUrlPatterns?: string[];// glob excludes filtered post-query
  newTabUrl: string;            // opened for "New tab in <X>"
  enabled: boolean;             // false = "coming soon" in the menu
  acceptedAttachmentKinds?: ('image' | 'text')[]; // provider-wide; omit = all
  urlVariants?: AskUrlVariant[];                  // per-URL overrides
  maxAttachmentCount?: number;                    // per-turn cap; omit = no cap
  newTabOnly?: boolean;                           // skip pinning + existing-tab listing
  selectors: AskInjectSelectors;
};
```

`excludeUrlPatterns`:

- Marks tabs whose URL matches any pattern as `excluded` in the
  menu listing — they still appear under "Existing tab in X"
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
`src/ask/index.ts` — walks the variant list and falls back
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
  page state (toolbar Set/Unset or tab-navigation races where the
  cached accepted-kinds doesn't match what the destination actually
  accepts now). Its error message has the same shape, with
  `Skipped: …` appended naming the dropped filenames.

We deliberately don't offer a "New tab in Claude Code" entry —
Claude Code requires repo-selection setup before any prompt makes
sense, so opening a fresh tab from Ask would dump the user on a
screen that can't accept the payload yet. The Ask menu only surfaces
`/code` tabs that already exist (the user pinned or set up).

`ask-inject.ts` is unchanged by all of this — filtering happens in
the SW so the runtime stays selector-driven and provider-agnostic.

### `maxAttachmentCount` (ChatGPT)

Some composers cap the number of attachments per turn even when
the kinds are all accepted:

- ChatGPT today rejects a third attachment outright — the upload
  chip never renders, and the runtime's preview-count check fails
  after the settle. The user sees "Sent" turn into a mid-walk
  failure with no actionable hint.
- `AskProvider.maxAttachmentCount?: number` declares the cap.
  ChatGPT sets it to 2; other providers leave it unset.

Plumbing mirrors `acceptedAttachmentKinds`:

- `resolveMaxAttachmentCount(provider, url)` returns the cap (or
  `null` for no cap). Provider-level today; the `url` argument is
  ignored. The signature leaves room for a per-URL cap to slot in
  later without touching call sites.
- `listAskProviders` and `resolveAsk` populate
  `newTabMaxAttachmentCount` / `maxAttachmentCount` /
  `destinationMaxAttachmentCount` so the Capture page caches the
  cap for each destination.
- `sendToAi` refuses with `ok: false` when
  `payload.attachments.length > maxAttachmentCount`. The error
  reads "ChatGPT accepts at most 2 attachments per turn; you have
  3. Uncheck a Save row."
- `checkDestinationAttachmentCount` on the Capture page runs the
  same check up front so the user sees the refusal without
  paying the SW round-trip.

Unlike the kinds path, we don't auto-drop attachments — there's no
rule for picking which one to keep. The user makes the call by
unchecking a Save row.

### `newTabOnly` (Google Search)

Some destinations aren't a chat surface to reuse — Google Search
submits via a form GET that navigates the tab to `/search?q=…`,
clobbering any prior state. For these, set `newTabOnly: true` on the
provider and three things change:

- The Ask menu hides the "Existing tab in <X>" section for it
  (`listAskProviders` skips the `chrome.tabs.query`).
- The toolbar Set/Unset entry stays disabled when the active tab is
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

1. Create `src/ask/<provider>.ts`, export an
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
  click #ask-menu-btn ("Ask…") ───────────────────────┐
    sendMessage({ action: 'askListProviders' }) ──▶   │
      ask/index.ts                         │
        listAskProviders() + resolveAsk()             │
          chrome.tabs.query(provider.urlPatterns)     │
          read 'askPin' + 'askPreferredNewTabProvider'│
    rebuild popup menu (pin on the default item)      │
                                                      │
  user picks a destination ◀────────────────────────  ┘
    sendMessage({ action: 'askSetDefault', destination }) ──▶
      ask/index.ts
        setAskDefault() — writes 'askPin' (existingTab) or
                          'askPreferredNewTabProvider' (newTab)
    refresh labels + per-provider rows (no send)

  click #ask-btn (or Alt+A) ─────────────────────────────────► ▼
    sendMessage({ action: 'askAiDefault', payload }) ──▶        │
                                                                │
  click "Ask <Provider>" (one of the per-provider rows) ─────► ▼
    sendMessage({ action: 'askAi', destination, payload }) ──▶  │
      ask/index.ts                                   │
        (askAiDefault: resolveAsk() picks destination)          │
        sendToAi() ◀───────────────────────────────────────────┘
          ├── newTab path: chrome.tabs.create({ active: false })
          │     ├── write placeholder widget record
          │     ├── scriptability probe (executeScript func: () => 1)
          │     │     ├── permanent block (ExtensionsSettings /
          │     │     │     "cannot be scripted") → close tab,
          │     │     │     return error to Capture page; user's
          │     │     │     focus never leaves Capture
          │     │     └── transient error → ignore (post-load retry)
          │     ├── focus new tab + window (early — user sees the
          │     │     placeholder widget while the page finishes loading)
          │     └── wait for 'complete' up to 15s
          │   existingTab path: tabId = destination.tabId (no open, no
          │     focus — stays on Capture until inject succeeds)
          ├── executeScript({ files: ['ask-inject.js'], world: 'MAIN' })
          │     installs the postMessage bridge listener (see below)
          ├── on inject success:
          │     ├── executeScript({ files: ['ask-widget.js'], world: 'ISOLATED' })
          │     │     widget walks each item via the bridge — see ask-widget.md
          │     ├── focus tab + window (existingTab only — newTab
          │     │     was already focused after the probe)
          │     └── write 'askPin' = { provider, tabId }
          └── on inject failure (post-probe — rare):
                ├── leave tab open (user may have started interacting)
                ├── patch widget record with friendlyInjectError()
                │     (policy blocks like "ExtensionsSettings" / "cannot
                │     be scripted" pass through verbatim; everything else
                │     becomes "Check if the tab is on a prompt screen.")
                └── focus the source Capture page so the error toast
                    is visible (no-op when the user closed it via
                    ctrl-click before the failure landed)
    show #ask-status: "Sent." or error
    refresh labels + per-provider rows (the pin may have moved)
    if ctrl-click: sendMessage({ action: 'closeCapturePage' })
```

### Payload

The Capture page assembles the payload from existing checkbox state:

| Field | Source |
|-------|--------|
| `attachments[]` (image/png\|jpeg) | `previewImg.src`, baked via `renderHighlightedImage()` if there are edits, when `screenshotBox.checked`. Mime + extension are sticky on the source (JPG stays JPG; everything else is PNG) |
| `attachments[]` (text/html, `contents.html`) | `captured.html`, when `htmlBox.checked` |
| `attachments[]` (text/markdown\|plain\|html, `selection.{md,txt,html}`) | `captured[wireKind]` for the selected format, when selection master is checked |
| `promptText` | `promptInput.value.trim()` |
| `autoSubmit` | `promptText.length > 0` |

### Injected runtime (`ask-inject.ts`)

Self-contained IIFE, no `import` / `export`, runs in MAIN world.
Installs a postMessage bridge listener on `window` and exposes the
ops the ISOLATED-world widget calls one at a time:

- `clearComposer { selectors }` — best-effort initial DOM clear of
  the composer plus a wide-scope `MutationObserver` that re-wipes
  any text that re-appears, until the user's first trusted
  `keydown` disengages it. See the
  [ChatGPT draft-injection workaround](#chatgpt-draft-injection-workaround)
  section below for the full rationale and why this is ChatGPT-only.
  - Dispatched once per run, only when the widget record has
    `clearComposerOnEntry: true`. The SW sets that flag iff both
    (a) destination is newTab AND (b) the provider opts in via
    `AskProvider.clearComposerOnEntry` — today, ChatGPT alone.
  - Initial clear is `execCommand('selectAll')` + `'delete'` with a
    Range + `deleteContentBackward` InputEvent fallback. Same
    edit-pipeline rationale as `typePrompt`.
  - Observer is attached to `document.documentElement` with
    `{ childList, subtree, characterData }`. Each callback
    re-resolves the composer via `selectors.textInput` and clears
    if non-empty — handles a composer that hasn't mounted yet AND
    a later composer remount.
  - `typePrompt` disconnects the observer at entry so our own
    `execCommand('insertText')` writes don't get clobbered.
    `attachFile` does NOT disconnect — its mutations on the file
    input and chip-container do fire the observer, but the
    callback's "is the composer's textContent empty?" early-return
    short-circuits since attach puts no text in the composer.
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

## ChatGPT draft-injection workaround

This section documents the `clearComposer` machinery introduced
for ChatGPT specifically. **It is a workaround for what looks like
a ChatGPT-side bug** — Claude, Gemini, and Google all start a
fresh tab with an empty composer and need none of this.

### The bug

- ChatGPT persists unsent composer text under
  `localStorage['oai/apps/conversationDrafts']`. On every fresh
  load of `chatgpt.com` (a different window, a reload, or a tab
  the extension just opened), the page reads that key, restores
  the draft into React state, and renders it into the composer.
- That re-render fires several seconds after the page is otherwise
  "ready," and on logged-in sessions appears to fire repeatedly
  during hydration. We can't anchor it to a single observable
  event.
- User-visible symptom: open chatgpt.com, type something, close
  the window without sending. Open Capture, run "Ask ChatGPT" with
  just an image. By the time the Ask flow completes, the old draft
  text has appeared in the new tab's composer.

### Why a workaround at all

We could not find a single-shot clear that wins this race
reliably. Approaches we tried and discarded:

- Clear `localStorage['oai/apps/conversationDrafts']` from the SW
  before opening the tab — too late; ChatGPT had already read it
  into React state.
- Clear it at the start of the SW's Ask flow — same problem; the
  read happens early in page init.
- A `document_start` content script with a URL-fragment marker
  wiping the key before page scripts run — works, but requires a
  manifest change, a per-tab URL marker, and `chrome://extensions`
  reloads to land. Too heavy for one provider's quirk.

The behavior that did stick was a `MutationObserver` that just
keeps wiping the composer for as long as ChatGPT keeps trying to
re-inject the draft.

### The mechanism

- `AskProvider.clearComposerOnEntry` — provider opt-in. Set to
  `true` on the ChatGPT adapter only.
- SW: on a `newTab` destination with that provider flag, writes
  `clearComposerOnEntry: true` on the widget record.
- Widget: dispatches a one-shot `clearComposer` bridge op before
  walking the items.
- Runtime (`ask-inject.ts`):
  1. Best-effort `execCommand('selectAll')` + `'delete'` on the
     composer (handles the case where the draft is already there
     when our op runs).
  2. Installs a wide-scope `MutationObserver` on
     `document.documentElement` with
     `{ childList, subtree, characterData }`. Each callback re-
     finds the composer via the provider's selectors and clears
     it if non-empty. Wide scope handles composer-not-yet-mounted
     AND any later composer remount that would orphan a narrow
     observer.
  3. Installs a `keydown` listener (capture phase) on `document`.
     First trusted (`isTrusted: true`) keystroke anywhere
     disengages both the observer and itself — the user typing is
     the "I've taken over" signal. Programmatic mutations
     (`execCommand`, ChatGPT's React re-renders) don't fire
     `keydown`, so they can't false-trigger the disengage.

### Constraints the design respects

- **Additive contract preserved:** the existingTab / pinned-reuse
  path skips `clearComposer` entirely. The documented "Ask twice
  before Send accumulates" behavior (live test
  `two prompt-only calls accumulate text`) is unaffected.
- **`typePrompt` plays nicely:** disconnects the observer at
  entry so our own `execCommand('insertText')` writes don't get
  wiped. `attachFile` does NOT disconnect — its mutations do fire
  the wide-scope observer, but the callback's empty-textContent
  early-return makes the firing harmless since attach puts no text
  in the composer.
- **SW ordering matters:** `executeScript MAIN` (installs the
  bridge listener) must run BEFORE `writeWidgetRecord('injecting')`
  so the placeholder widget's storage listener has a usable
  bridge by the time it posts the first `callMain` request.
  `window.postMessage` doesn't replay for late subscribers — get
  the order wrong and the first op times out silently. See the
  comment block in `sendToAi` around the `executeScript` call.

### If this stops working

Likely first signals:
- `tests/e2e-live/chatgpt.live.spec.ts` ("after a prior draft
  leaves the composer clean") fails. That's the regression spec
  for this whole story.
- User reports the draft showing up again. The page console will
  show whether `clearComposer:` logs ran and whether the observer
  caught text.

The biggest "this could break tomorrow" risk is ChatGPT changing
their selectors (the runtime's `findComposerSilent` returns null,
observer fires forever with no work to do — cheap but
ineffective). The selector smoke test in the live suite catches
that case.

Known disengage gaps: the "user is taking over" signal is the
first trusted `keydown`, which doesn't fire on right-click →
Paste, drag-and-drop, or some on-screen-keyboard input. If the
user does one of those into the composer before any keystroke,
the observer wipes it. Treat `"my paste keeps disappearing right
after an Ask"` as the symptom of this corner.

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
