# Ask widget

Small status / recovery panel injected into the destination AI tab
during every Ask flow. Lives in `src/ask-widget.ts`. Renders the
inject's per-step progress, exposes per-item Copy + Retry, and
gives the user a clipboard-based recovery surface even after the
Capture page closes.

The Ask flow itself is documented in [`ask-on-web.md`](ask-on-web.md);
this doc is the deep dive on the widget — what it shows, how it's
laid out, the cross-world architecture that lets it drive the inject.

## What it shows

- **Title bar (expanded)** — extension icon, "SeeWhatISee" text,
  status icon, `_` minimize, `×` close. Status icon is a CSS spinner
  while injecting, a green ✓ on success, a red ✕ on error. Clicking
  anywhere on the bar that isn't a button toggles between collapsed
  and expanded.
- **Status** — `Injecting <what>…` while the inject runtime works,
  then `Injected successfully.` or a count-based error summary —
  e.g. `Attachment not accepted. Retry or use copy/paste.` /
  `2 attachments not accepted. Retry or use copy/paste.` /
  `Prompt not accepted. Retry or use copy/paste.` The raw error
  text from the MAIN-world helper still lives on each failed
  row's icon tooltip for debugging.
- **Content** — one row per orchestration item (Screenshot, HTML,
  Selection, Prompt). Each row carries:
  - A status icon on the left (spinner while in flight, ✓ on
    success, ✕ on error, blank if not yet started).
  - A Copy button — same clipboard semantics as before. HTML and
    rich-format selections write both the format-specific MIME and
    `text/plain`.
  - A retry button (`↻`) on errored rows — re-runs just that step.
    Disabled while any other item is still in flight.
- **Source** — the source page's title + URL, mirroring the
  Capture page's URL/title card. Both are clickable links to the
  source; each row has its own Copy button.

## Visual theme

- Title bar (both expanded `.swis-titlebar` and the collapsed strip
  `.swis-collapsed`) uses `#e0d4f0`, with a deep-purple-200
  (`#b39ddb`) divider — a touch darker than the Capture / Options
  page header (`#ede7f6`). The widget needs the extra contrast
  against its own pale-purple body; the page headers sit on white
  and don't.
- Body uses `#f5f0fa` so the title bar still reads as a distinct
  band and the whole widget stays tinted against mostly-white
  provider pages.
- Close-button hover (`.swis-titlebar-btn:hover`) is `#c8b8e2` —
  visibly darker than the bar without going all the way to the
  outer border's deep-purple-200.
- Outer border is `#b39ddb` for theme consistency with the shared
  `.app-header` / `.app-footer` chrome in `shared-styles.css`.

## States

- **Expanded** by default while sending. ~220 px wide with the
  sections listed above.
- **Collapsed** strip pinned to the right edge — the title-bar
  children laid out vertically (icon, name, status, `×`; no `_`
  since clicking the strip itself expands), and arranged so the
  natural reading direction (bottom-to-top, matching the rotated
  "SeeWhatISee" label) presents them in title-bar order.
- Auto-collapses on success; stays expanded on error.
- A new send re-expands a collapsed widget so the user sees the
  in-flight Status without having to click the strip.
- `×` removes the widget DOM AND clears that tab's storage record
  (full dismiss). It also posts `askPlaceholderClosed` to the SW so
  an in-flight new-tab Ask waiting on page-load skips the
  promote-to-injecting step (the user wants the bare loaded page,
  not the widget). `_` just collapses the UI; the record stays.

### Status lifecycle

Mirrors `AskWidgetStatus` in `widget-store.ts`:

- `placeholder` — new-tab Ask only. The SW writes this *before*
  the destination tab finishes loading so the widget can mount
  early and show "Waiting for `<provider>` to load…" in the
  Status section. Same chrome (spinner, sections) as `injecting`,
  but `shouldStartOrchestration` gates on `'injecting'` only so
  the items don't start walking.
- `injecting` — orchestration is walking the items. The SW patches
  `placeholder` → `injecting` (with a fresh `runId`) once the page
  is ready. The fresh `runId` is what the storage listener latches
  onto to fire `tryStartRun`. The transition is in-place — no
  DOM tear-down — so the user sees a status text change rather
  than a re-mount.
- `success` / `error` — terminal.

## Architecture: widget owns the inject

The SW resolves the destination tab (focus, open-new-tab) and then
steps back; the widget walks each item via a postMessage bridge
into MAIN-world helpers in `ask-inject.ts`.

- **Items model** — the SW's `buildItems` flattens the payload into
  an ordered list: one `attachment` step per file, then a `prompt`
  step (if non-empty), then a `submit` step (only when `autoSubmit`
  is on AND the prompt is non-empty). Each item carries a status
  (`pending` / `in_progress` / `success` / `error`) plus an error
  string for failed steps.
- **Per-item walking** — the widget runs items in order. On each
  step it patches the storage record (status flip), which fires
  `chrome.storage.onChanged` and re-renders the affected row.
- **Partial success** — if an attachment fails, the prompt is still
  attempted (text injection often works even when file uploads
  don't). The submit step is skipped if any prior item ended in
  error.
- **Retry** — failed rows expose a `↻` button that re-runs that one
  step. The button is disabled while any other item is `in_progress`
  so retries can't race the orchestration loop.

## Cross-world bridge

- The widget runs ISOLATED; the inject helpers run MAIN. They talk
  via `window.postMessage`:
  - Widget → MAIN: `{swis: 'request', id, op, args}`
  - MAIN → widget: `{swis: 'response', id, ok, result/error}`
- Both sides filter on `ev.source === window` plus the `swis`
  marker so unrelated postMessages on the page don't collide.
- Bridge install is idempotent — the IIFE in `ask-inject.ts` sets
  `window.__seeWhatISeeAskBridgeInstalled` to avoid double-listeners
  if the file is re-injected.
- The widget's `callMain` carries per-op timeouts that sit a small
  margin above each helper's longest legitimate work, so a healthy
  call never trips them and a crashed/unresponsive bridge can't
  hang the orchestrator:
  - `attachFile` — 15 s (covers the 1.5 s settle + 8 s
    chip-confirm). The chip gate proves the page accepted the
    selection, NOT that the upload reached the server.
  - `typePrompt` — 5 s (sub-second in practice).
  - `clickSubmit` — 35 s (covers the 30 s submit-enable poll while
    the upload reaches the server). We never wait for the AI's
    response — only for the submit button to be clickable.
- The live-test specs in `tests/e2e-live/` drive the same bridge,
  posting `attachFile` / `typePrompt` / `clickSubmit` requests one at
  a time so the suite exercises the same code path the widget uses
  in production.

## Storage record

- `chrome.storage.session` keyed by destination `tabId`
  (`askWidget:<tabId>`).
- Carries:
  - `status` (overall) + `error` summary.
  - `items[]` — per-step state with `kind`, `label`, `status`,
    `error`, plus `attachmentIndex` for attachment steps.
  - `selectors` — the provider's selector tables. The SW writes
    them at send time; the widget re-reads from storage on every
    item / retry, so an external mutation (e.g. a selector hot-fix
    written via `chrome.storage.session.set`) lands on the next
    step without a restart.
  - `autoSubmit` — drives the submit-step decision.
  - `runId` — monotonic counter incremented on every fresh send. A
    re-Ask while the previous run is still walking causes the old
    run to bail at its next checkpoint and the new run to take over.
  - The full attachment payload + prompt text — enough for the
    widget to render a full recovery surface even after the Capture
    page closes.
- `tabs.onRemoved` clears records for closed tabs so session storage
  doesn't accumulate orphans across the day.
- `writeWidgetRecord` rejects on storage failures (notably
  `QUOTA_BYTES` exceeded for very large payloads); the SW returns
  this as a clear capture-page error rather than waiting for the
  60 s widget-completion timeout.
- **Lazy-read on Copy / Retry click**:
  - Paint-time closures capture only primitives — `runId`, `tabId`,
    `attachmentIndex`. No reference to the heavy attachment bytes.
  - The click handler reads the latest record from
    `chrome.storage.session` and uses that. Storage thus stays the
    single in-memory copy.
  - Records are matched on `runId`. If it's gone (X dismiss) or has
    been replaced (re-Ask increments `runId`), the button briefly
    flashes "Content no longer available" instead of operating on
    stale bytes.
  - Retry shares the same gate before touching storage — without it
    a stale retry click could clobber the new run's items.

## Wire layout

```
SW sendToAi():
  ── new-tab path only ──────────────────────────────────────────
  ├─▶ openNewProviderTabWithPlaceholder(provider, recordTemplate):
  │     ├─▶ chrome.tabs.create(provider.newTabUrl)
  │     ├─▶ writeWidgetRecord(tabId, {status:'placeholder', …})
  │     ├─▶ on first tabs.onUpdated 'loading':
  │     │     mountAskWidget(tabId)  ── early best-effort mount;
  │     │                                widget paints "Waiting
  │     │                                for <provider> to load…"
  │     └─▶ await waitForTabComplete(tabId, …)
  │
  ├─▶ if cancelledTabs.delete(tabId): clearWidgetRecord + return
  │   "Cancelled" — user dismissed via × during page load
  ── both paths ─────────────────────────────────────────────────
  ├─▶ writeWidgetRecord(tabId, {status:'injecting',
  │     items:[…pending], selectors, runId:NEW, …})
  │     ── newTab: promotes the placeholder record (storage event
  │        fires; widget storage listener picks up the runId bump
  │        and starts tryStartRun)
  │     ── existingTab: first write of the record
  ├─▶ executeScript MAIN: load ask-inject.js (bridge)
  ├─▶ executeScript ISOLATED: stash tabId on window
  ├─▶ executeScript ISOLATED: load ask-widget.js  (idempotent —
  │     re-mount on the loaded page if the early one died on a
  │     transient document)
  └─▶ waitForWidgetCompletion(tabId)  ─── awaits storage
                                          onChanged

  Widget                                    MAIN-world bridge
  ───────                                   ─────────────────
  shouldStartOrchestration?
    runItems(record) ─┐
                      ├──▶ postMessage({op: 'attachFile', …})
                      │           ◀── postMessage({ok, error?})
                      │   patchWidgetItem(i, {status: 'success'|'error', …})
                      ├──▶ postMessage({op: 'typePrompt', …})
                      │           ◀──
                      └─?─ postMessage({op: 'clickSubmit', …})
                                  bridge call skipped if any prior
                                  item failed; the submit item is
                                  still patched (status='pending',
                                  error='Skipped: prior items failed')
                                  so the row reads correctly.
    patchStatus('success'|'error')  ───▶  SW resolves capture page
```

The SW's `waitForWidgetCompletion` has a 60 s timeout. Most flows
finish in a few seconds; multi-MB uploads on slow connections can
exceed it. The capture page sees an error in that case but the
widget keeps walking — the user can still observe per-row status
and use the Copy buttons.

## Cancel-and-replace on re-Ask

- Re-Asking into the same tab writes a fresh record with a new
  `runId`. The widget's storage listener detects the runId change
  and starts a new orchestration; the in-flight loop sees
  `activeRunId !== myRunId` at its next checkpoint and bails.
- The orchestrator also pre-checks `activeRunId` before each
  `callMain` so an OLD run can't fire an extra MAIN-world call
  against a composer the NEW run is now mutating.
- `mountWidget` defensively removes any element with the host id
  before creating a new one, so an SPA navigation that wiped the
  in-script global but left the host element in place can't leave
  two widgets stacked.

## Why ISOLATED world

- The widget needs `chrome.runtime.getURL` (icon) and
  `chrome.storage.session` (state). Both are unavailable to MAIN-world
  scripts.
- Shadow DOM gives style isolation from the host page's CSS without
  needing MAIN-world reach. The widget never touches the page's
  prompt composer — that's the MAIN-world bridge's job.

## Idempotent mount

- The IIFE checks `window.__seeWhatISeeWidget` (ISOLATED-world
  global, per-tab). If a handle exists, it just calls `refresh()`
  with the latest record. If not, it mounts fresh.
- The SW therefore re-injects `ask-widget.js` before every Ask
  without having to track per-tab mount state — an X'd widget
  reappears on the next send by the same path that mounted it the
  first time.
