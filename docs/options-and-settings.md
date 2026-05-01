# Options and settings

The Options page (`options.html`) is the only UI for editing these.
The SW reads them on every toolbar dispatch and tooltip rebuild;
`capture.html` reads `capturePageDefaults` on first paint.

## Stored settings

All keys live in `chrome.storage.local`.

### Toolbar action defaults

| Key | Pool | Fresh-install default |
|------|------|------------------------|
| `defaultClickWithSelection` | `WITH_SELECTION_CHOICES` (`capture`, `save-defaults`, `save-selection-{html,text,markdown}`, `ignore-selection`) | `capture` |
| `defaultClickWithoutSelection` | every `CAPTURE_ACTIONS` entry except `save-selection-*` | `capture` |
| `defaultDblWithSelection` | same as click-with-sel | `save-defaults` |
| `defaultDblWithoutSelection` | same as click-without-sel | `save-defaults` |

- The "with-selection" pools include `ignore-selection`, a sentinel
  that means "skip the selection probe and fall through to the
  matching without-selection default".
- The "without-selection" pools exclude `save-selection-*`
  shortcuts because they would just error on every click without a
  selection. The setters reject those ids.
- Getters apply legacy-id migration so users keep their saved
  defaults across the action-id rename:
  - `capture-with-details` → `capture`
  - `capture-screenshot` → `save-screenshot`
  - `capture-page-contents` → `save-page-contents`
  - `capture-url` → `save-url`
  - `capture-both` → `save-all`
  - `save-both` → `save-all` (intermediate id from earlier rename)
  - `capture-selection-{html,text,markdown}` →
    `save-selection-{html,text,markdown}`
  - `capture-now` → `save-screenshot` (older legacy id, predates
    `capture-screenshot`)

  Delay suffixes survive the rewrite (`capture-screenshot-2s` →
  `save-screenshot-2s`). The without-selection getter additionally
  rejects stale `save-selection-*` values left in storage from
  older builds (they would just error on every click without a
  selection).

### Capture-page settings

```ts
interface CaptureDetailsDefaults {
  withoutSelection: { screenshot: boolean; html: boolean };
  withSelection:    { screenshot: boolean; html: boolean;
                      selection: boolean;
                      format: 'html' | 'text' | 'markdown' };
  defaultButton:    'capture' | 'ask';
  promptEnter:      'send' | 'newline';
}
```

- Storage key: `capturePageDefaults`.
- Implementation: `src/background/capture-page-defaults.ts`.
- Fresh-install defaults:
  - `withoutSelection`: screenshot only.
  - `withSelection`: selection only, as markdown.
  - `defaultButton`: `capture` (the Capture page's main button).
  - `promptEnter`: `send` (Enter on the Prompt fires the default).
- `defaultButton` drives three things on the Capture page:
  - which of the two main buttons (Capture or the Ask split widget)
    gets the highlight ring.
  - which one fires when the user presses Enter on the Prompt.
  - which one fires when the toolbar icon is clicked while the
    Capture page is already open (the SW's `triggerCapture`
    hand-off).
- `promptEnter` only steers the un-modified Enter key in the Prompt
  textarea. Shift+Enter always inserts a newline; Ctrl+Enter always
  fires the default button.
- Degraded-state fallback: if `defaultButton='ask'` but the Ask
  split is disabled (no provider enabled, mid-Ask round-trip),
  Enter / `triggerCapture` falls through to `#capture` rather than
  silently dropping the user's keystroke.
- **Live updates.** The Capture page's `chrome.storage.onChanged`
  listener picks up `defaultButton` / `promptEnter` changes the
  moment the Options page Saves — no reload needed. The
  Save-checkbox defaults are seed-only (re-applying them mid-session
  would clobber the user's in-progress checkbox edits).
- The setter re-normalizes on write so a partial / dirty input from
  the Options page can't put a malformed object into storage.

### Ask provider settings

```ts
interface AskProviderSettings {
  enabled: { claude: boolean; gemini: boolean; chatgpt: boolean };
  default: 'claude' | 'gemini' | 'chatgpt' | null;
}
```

- Storage key: `askProviderSettings`.
- Implementation: `src/background/ask/settings.ts`.
- Fresh-install defaults: all enabled, default Claude.
- Read on every Ask resolution (`resolveAsk`, `listAskProviders`,
  `findProviderForTab`, `sendToAi`) so disabling a provider takes
  effect immediately without any reload.
- Two invariants are enforced on every read AND write by
  `normalizeAskProviderSettings`:
  1. `enabled` always has a boolean for every registered provider id.
  2. `default` is either null or the id of an enabled provider — if
     the stored value points at a disabled provider, normalize
     auto-shifts it to the next enabled provider in label-order
     (ChatGPT → Claude → Gemini, wrapping); if no provider is
     enabled, default becomes null.
- Pin lifecycle: a `chrome.storage.onChanged` listener in
  `src/background.ts` clears `askPin` when the pinned provider
  becomes user-disabled (`clearPinIfProviderDisabled`), then refreshes
  the toolbar Pin/Unpin entry. `resolveAsk` also clears stale pins
  lazily on the next resolve.

## Toolbar dispatch (`handleActionClick`)

Reads all four stored ids up front, then picks a path:

- **Viewing the Capture page.** If the active tab is a `capture.html`
  page with stashed session data, the click sends it a
  `triggerCapture` message — same effect as clicking the page's
  Capture button. The Click/Dbl defaults are not consulted.
- **First click.** Start the 250 ms double-click timer; on expiry,
  run `dispatchAction(clickWithout, clickWith)`.
- **Second click within window.** Clear the timer and run
  `dispatchAction(dblWithout, dblWith)` instead.

`dispatchAction(without, with)` probes for a selection on the active
tab. If one is present and the `with` id isn't `ignore-selection`, it
runs the `with` action; otherwise it runs the `without` action. The
probe runs lazily inside the timer / on the second click so the
selection state always reflects the tab at *dispatch* time, not at
click time. Probe failures (restricted URL, closed tab) fall through
to `false` so the click still runs the without-selection action.

## Toolbar tooltip

Built by `getDefaultActionTooltip`. Layout:

```
SeeWhatISee
[blank]
[ERROR: <msg>]                              (only when an error is pending)
[blank]
Click: <click-no-sel.tooltipFragment>
Double-click: <dbl-no-sel.tooltipFragment>
With selection click: <click-with-sel.tooltipFragment>          (if not ignore-selection)
With selection double-click: <dbl-with-sel.tooltipFragment>     (if not ignore-selection)
[blank]
```

- `_execute_action` hotkey, when bound, is folded into the `Click:`
  label as `Click, <key>:` rather than adding another line.
- The two `With selection …` lines drop independently when their
  stored choice is `ignore-selection` (its `tooltipFragment` is
  `null`) — that branch then behaves identically with or without a
  selection, so the line would just be noise.
- The trailing blank entry separates the action block from whatever
  Chrome appends below (the "Wants access to this site" permission
  line, for example).

## Capture-page first-paint pre-checks

`capture-page.ts`'s `loadData` reads `capturePageDefaults` (via
`getDetailsData`) and applies the matching branch on first paint:

- **With a selection** on the page (master row enabled because at
  least one format had non-empty content) → apply the `withSelection`
  branch. `screenshot` / `html` / `selection` checkboxes take the
  stored values; the format radio lands on `withSelection.format`.
- **Without a selection** → apply the `withoutSelection` branch
  (`screenshot` / `html` only). The Save-selection master stays
  disabled.
- **Fallback on empty format.** If the stored format has no content
  for this capture (e.g. image-only selection → empty markdown /
  text), the page falls back to the first non-empty format.
- **Disabled rows are left untouched.** A stored `screenshot=true`
  doesn't override a row that `screenshotError` has greyed out.

## Keyboard commands

Meta-commands — run whatever the user has stored as a default rather
than naming a specific action:

- `_execute_action` — Chrome's reserved name; fires
  `chrome.action.onClicked` and so triggers the same
  `handleActionClick` path a toolbar click would (subject to the
  250 ms double-click window).
- `01-secondary-action` — calls `runDblDefault()` directly, no timer
  involved. Selection-aware via the same `dispatchAction` helper, so
  a pressed Secondary hotkey always fires the same dispatch a Dbl
  click would.

The remaining manifest commands (`05-capture`, `11-save-defaults`,
`12-save-screenshot`, etc.) name specific actions and route through
`findCaptureAction` —
see `architecture.md` → "Keyboard commands" for that side.

## Options page (`options.html`)

Reachable via the toolbar action's right-click → Options, the
**Options** button in the Capture page header (calls
`chrome.runtime.openOptionsPage`), or `chrome://extensions/?options=…`.
Manifest entry `options_ui` with `open_in_tab: true` opens it in a
full tab.

### Layout

Sections are rendered top-to-bottom in this order:

- **Ask button AI providers** (`<h1>`) — table over registered Ask
  providers in alphabetical-by-label order (ChatGPT, Claude, Gemini).
  Columns: Provider, Enabled (checkbox), Default (radio).
  - Toggling a checkbox immediately greys / re-enables that row's
    Default radio. If the toggled checkbox was the current default
    and was just unchecked, the page rotates the default to the
    next enabled provider in row order (wrapping). If no provider
    was the default and the user just enabled one, that row
    becomes the new default.
  - A page-local helper (`pickNextEnabledAskDefault` in
    `src/options.ts`) mirrors the SW's
    `pickNextEnabledDefault` so the radio always reflects what the
    SW will accept on save.
- ***Capture* page *Prompt* box settings** (`<h1>`) — two
  side-by-side `<h2>` blocks (no fieldset border) inside a
  `.side-by-side` flex wrapper:
  - *Enter behavior in Prompt* table — columns `Enter key` /
    `Action`. Three rows:
    - `Enter` → Submit prompt / Add newline radios (the `promptEnter`
      setting; defaults to *Submit prompt*).
    - `Shift+Enter` → fixed `Add newline`.
    - `Ctrl+Enter` → fixed `Submit prompt`.
  - *Default submit button* table — columns `Button` / `Description`.
    The Button cell renders each option as a `.btn-mock` span styled
    to look like the actual Capture-page button (1px dark border,
    light background, 4px radius). Two rows of radios for the
    `defaultButton` setting:
    - *Capture* — *Save to files*.
    - *Ask <provider>* — *Send to provider web page*. The provider
      label is appended live from the Ask-providers table above
      (e.g. *Ask Claude*) so it always mirrors the Capture page's
      `#ask-target-label`. Falls back to *Ask AI* when no provider
      is enabled (matches the Capture page's `AI` fallback).
- **Default items to save on *Capture* page and in *Save default
  items*** (`<h1>`) — two side-by-side fieldsets that mirror
  `capture.html`.
  - *Without selection*: Save screenshot, Save HTML.
  - *With selection*: Save screenshot, Save HTML, Save selection
    master + nested format radios (`as HTML / as text / as markdown`).
  - Unlike the Capture page, the Save-selection master and the
    format radios are independent — the format radios persist the
    *default* `as`-mode for whenever Save selection is on, so they
    stay enabled even when Save selection is off.
- **Toolbar icon click and context menu** (`<h1>`) — wrapper
  heading; the actual settings are in the `<h2>` sub-sections below.
  - **Keyboard hotkeys for icon click** (`<h2>`) — two-row table:
    - `Default action` (same as click on toolbar icon) → shows the
      `_execute_action` shortcut.
    - `Secondary action` (same as double-click) → shows the
      `secondary-action` shortcut.
    - Read-only — Chrome has no API to bind hotkeys. An inline
      "Chrome extension settings page" button opens
      `chrome://extensions/shortcuts`.
  - **Default action with no text selection** (`<h2>`) and
    **Default action with text selected** (`<h2>`) — wrapped in a
    `.side-by-side` flex container so they sit beside each other when
    the viewport has room and stack on narrow viewports. Columns:
    Click radio, Double-click radio, Action, Hotkey. Per-row hotkey
    cells composed by `composeRowHotkey` (see "Hotkey-cell display"
    below). The without-selection table is bucketed by delay value
    under section-row labels (`Capture immediately`, `Capture after
    N second delay`); the delay groups are collapsible (see
    "Collapsible delay groups" below). The with-selection table
    covers `WITH_SELECTION_CHOICES`
    (`capture`, `save-defaults`, `save-selection-{html,text,markdown}`)
    plus the `ignore-selection` sentinel.

### Hotkey-cell display

Each per-row hotkey cell can show up to three stacked lines, one per
applicable hotkey:

1. The Default-action hotkey (`_execute_action`) when this row is
   the currently-picked Click action.
2. The Secondary-action hotkey when this row is the currently-picked
   Double-click action.
3. The action's own bound keyboard shortcut, if any.

"Currently-picked" is the live DOM radio state, so the cell updates
the moment the user clicks a Click / Double-click radio — no Save
round-trip required. Implemented by `composeRowHotkey` (joins
applicable shortcuts with `\n`) and `recomputeHotkeyCells`
(re-paints every row in both action tables); the hotkey-cell CSS
uses `white-space: pre-line` and `line-height: 1.5` so the joined
string renders as readable separate lines.

### Collapsible delay groups

Each `Capture after N second delay` section row in the no-selection
table is collapsible, with a triangle caret toggle next to the label
(rotated 90° via CSS when `aria-expanded="true"`).

- Initial state per group is **auto-expanded** if any row in the
  group is the saved Click / Double-click default OR has a bound
  keyboard shortcut. Otherwise it auto-collapses so rarely-used
  delayed actions don't dominate the page.
- The user's manual toggle (clicking the caret) is recorded in a
  module-level `userDelayGroupState` map so a subsequent re-render
  (Save / Undo / Defaults / radio-driven `refreshHotkeys`) preserves
  the user's choice instead of snapping the section back to its
  auto-computed state. Cleared on full page reload.
- "Capture immediately" is a plain section row, not collapsible.

### Footer buttons

Three buttons in a row, plus a status message. All three are
disabled while a save is in flight — a stray Undo or Defaults click
mid-save would otherwise be silently overwritten by the post-save
re-render, and a second Save click would race two concurrent
round-trips.

- **Save** — persists the four click/dbl ids, the
  `capturePageDefaults` object, and the `askProviderSettings` object.
  - Status: "Settings saved." (or "Save failed: …" on error).
- **Undo changes** — re-renders the form from the most recently
  saved state (the `latest` cache, refreshed after every Save).
  - Discards unsaved edits without round-tripping the SW.
  - Status: "Restored saved settings."
- **Defaults** — re-renders the form with `OptionsData.factoryDefaults`.
  - Sourced from `DEFAULT_*_ID` constants in `default-action.ts`,
    `DEFAULT_CAPTURE_DETAILS_DEFAULTS` in `capture-page-defaults.ts`,
    and `DEFAULT_ASK_PROVIDER_SETTINGS` in `ask/settings.ts`.
  - Does **not** save; the user must hit Save to persist.
  - Status: "Default options applied above but not saved."

### Status messages

`setStatus(text, opts)` renders into the `#status` span; the next
call replaces whatever's there.

- Default mode auto-clears after 5 seconds — used for the three
  per-button confirmations and the `setOptions` error path.
- `sticky: true` skips the auto-clear timer for messages we don't
  want to vanish on their own. Used for in-flight `Saving…` (so a
  slow round-trip doesn't leave the UI looking idle) and for the
  initial-load failure (terminal state with nothing else to render).
- Sticky messages still get replaced by the next `setStatus` call —
  e.g. `Saving…` → `Settings saved.` after the SW responds.

### Wire

Messages handled in `background/options.ts`:

- `getOptionsData` — returns the action catalog, the stored click/dbl
  ids, the current `capturePageDefaults`, the registered Ask
  providers + their stored `askProviderSettings`, the bound hotkey
  map, and a `factoryDefaults` block consumed by the Defaults button.
- `setOptions` — accepts new ids for any of the click/dbl slots plus
  a `capturePageDefaults` object and an `askProviderSettings` object.
  Each setter is wrapped independently so a stale value in one slot
  doesn't block the others. The action setters call
  `refreshMenusAndTooltip`, resyncing the context-menu labels and the
  toolbar tooltip.

### Hotkey refresh

Chrome fires no event when the user edits a shortcut at
`chrome://extensions/shortcuts`. The page resyncs the hotkey column
on `window` focus / blur and on every radio click — three coarse
signals that catch most "user just came back from the editor" cases
without needing an event.
