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

### Capture-page Save defaults

```ts
interface CaptureDetailsDefaults {
  withoutSelection: { screenshot: boolean; html: boolean };
  withSelection:    { screenshot: boolean; html: boolean;
                      selection: boolean;
                      format: 'html' | 'text' | 'markdown' };
}
```

- Storage key: `capturePageDefaults`.
- Implementation: `src/background/capture-page-defaults.ts`.
- Fresh-install defaults:
  - `withoutSelection`: screenshot only.
  - `withSelection`: selection only, as markdown.
- The setter re-normalizes on write so a partial / dirty input from
  the Options page can't put a malformed object into storage.

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

- **Default action hotkey** — two-row table:
  - `Default action` (same as click on toolbar icon) → shows the
    `_execute_action` shortcut.
  - `Secondary action` (same as double-click) → shows the
    `secondary-action` shortcut.
  - Read-only — Chrome has no API to bind hotkeys. An inline "Chrome
    extension settings page" button opens
    `chrome://extensions/shortcuts`.
- **Default items to save on *Capture* page and in *Save default
  items*** — two side-by-side fieldsets that mirror `capture.html`.
  Sits second so users configuring the `save-defaults` shortcut see
  what it will write before picking it as a default action.
  - *Without selection*: Save screenshot, Save HTML.
  - *With selection*: Save screenshot, Save HTML, Save selection
    master + nested format radios (`as HTML / as text / as markdown`).
  - Unlike the Capture page, the Save-selection master and the
    format radios are independent — the format radios persist the
    *default* `as`-mode for whenever Save selection is on, so they
    stay enabled even when Save selection is off.
- **Default actions with no text selection** — table over every
  non-selection `CAPTURE_ACTIONS` entry. Columns: Click radio,
  Double-click radio, Action, Hotkey. Rows are bucketed by delay
  value under static section-row labels (`Capture immediately`,
  `Capture after 2 second delay`, `Capture after 5 second delay`).
- **Default actions with text selected** — table over the five
  `WITH_SELECTION_CHOICES` action ids
  (`capture`, `save-defaults`, `save-selection-{html,text,markdown}`)
  plus the `ignore-selection` sentinel. Same column shape.

### Footer buttons

Three buttons in a row, plus a status message. All three are
disabled while a save is in flight — a stray Undo or Defaults click
mid-save would otherwise be silently overwritten by the post-save
re-render, and a second Save click would race two concurrent
round-trips.

- **Save** — persists the four click/dbl ids and the
  `capturePageDefaults` object.
  - Status: "Settings saved." (or "Save failed: …" on error).
- **Undo changes** — re-renders the form from the most recently
  saved state (the `latest` cache, refreshed after every Save).
  - Discards unsaved edits without round-tripping the SW.
  - Status: "Restored saved settings."
- **Defaults** — re-renders the form with `OptionsData.factoryDefaults`.
  - Sourced from `DEFAULT_*_ID` constants in `default-action.ts`
    and `DEFAULT_CAPTURE_DETAILS_DEFAULTS` in `capture-page-defaults.ts`.
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
  ids, the current `capturePageDefaults`, the bound hotkey map, and
  a `factoryDefaults` block consumed by the Defaults button.
- `setOptions` — accepts new ids for any of the click/dbl slots plus
  a `capturePageDefaults` object. Each setter is wrapped
  independently so a stale value in one slot doesn't block the
  others. The action setters call `refreshMenusAndTooltip`,
  resyncing the context-menu labels and the toolbar tooltip.

### Hotkey refresh

Chrome fires no event when the user edits a shortcut at
`chrome://extensions/shortcuts`. The page resyncs the hotkey column
on `window` focus / blur and on every radio click — three coarse
signals that catch most "user just came back from the editor" cases
without needing an event.
