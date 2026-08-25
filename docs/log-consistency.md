# Log consistency: disk vs. browser storage

**Status: implemented.** `src/capture/log-reconcile.ts` owns the state
machine below; `recordCapture` in `log-store.ts` acts on it.

## Why it changed

The previous model made `chrome.storage.local` authoritative and
`log.json` a snapshot rewritten from it:

- Two copies of the log existed and either could be edited
  independently.
- A user who deleted `log.json` (or the whole `SeeWhatISee/`
  directory) got their old history **resurrected** by the next
  capture.
- The toolbar's More submenu carried a **Clear log history** entry
  (removed by this change) that wiped the browser copy and truncated
  `log.json` to zero bytes. It left the history files and every
  screenshot / HTML file behind, so "clear" didn't clear — and the
  next capture refilled `log.json` anyway.

## The two copies

Naming them once, because the rest of this doc leans on the
distinction:

- **The files** — `log.json` and the **history files** beside it, in
  the user's capture directory. These *are* the capture log.
  - A history file is named `history-<timestamp>.json` and holds a
    batch of older records that no longer fit in `log.json`. They
    accumulate; nothing rewrites one once it's written. (The code
    calls them *archives* — `ARCHIVE_FILE_PREFIX`,
    `getArchiveFilePaths`, `LOG_ARCHIVE_BATCH`.)
- **The browser copy** — the same records cached in
  `chrome.storage.local`. It exists because a Chrome extension can't
  read its own files without a permission the user has to grant, and
  can only write whole files, never append to one.

## Principles

**1. The files are the log. The browser copy is only a cache.**
Where they disagree, the files win, and the cache is rebuilt from
them.

**2. A capture only ever *adds*.** All a capture does to the files is
put one more record into them. It never rewrites or removes a record
that is already there.

- The one rearrangement allowed: once `log.json` grows past its cap,
  the oldest records move into a history file beside it. They are
  still on disk, in the same directory, and the History page and
  `SeeWhatISee.py` read both.

**3. What the user does to the files always wins.** Deleting
`log.json`, deleting the whole capture directory, deleting rows out of
the file, editing rows — none of it is ever undone, and records
removed that way never come back.

- Deleting `log.json` therefore *starts a new log*. It doesn't get
  refilled from the browser copy.
- **Edits to a file need the file-read permission to be honored.**
  Without it we can't see inside `log.json` at all, and nothing else
  Chrome offers reveals a change to a file's contents — so an edit is
  overwritten by the next capture. Deletion is honored either way.
  This is the one principle that isn't unconditional, and the prompt
  says so where it matters.

**4. When we can't tell what's in the files, we don't write them.**
The capture still succeeds — its screenshot / HTML are saved and its
record is held in the browser — and the user is asked what to do. We
never overwrite a file whose contents we couldn't account for.

**5. Nothing here deletes the user's files.** Not `log.json`, not the
history files, not a capture's own screenshot or HTML. Deleting capture
history means deleting files, which is the user's to do (and, later, a
feature of its own).

The exceptions are all deliberate, and all listed under
[Where the principles bend](#where-the-principles-bend).

## What we can find out about the files

A Chrome extension has no filesystem access. It can't list a
directory, stat a file, or read one back — the only things it has are
the records Chrome keeps of downloads it performed, and (with a
permission) `fetch` on a `file://` URL.

| How | Needs | Tells us |
|---|---|---|
| The download record for `log.json` (`chrome.downloads.search`) | nothing | its path, whether it still exists, and the byte size **we last wrote** |
| `fetch('file://…')` on that path | the user's "Allow access to file URLs" toggle | the file's actual current contents |
| A `uniquify` write, which Chrome renames rather than overwriting | nothing | whether *some* file already occupies that name, plus the directory |

A file picker (`<input type="file">`) would also hand us the contents
with no standing permission, and is deliberately not offered: the
`File` it returns carries no path, so we could not tell our `log.json`
from one in a backup or another Chrome profile — and adopting the
wrong one means writing it back over the real one.

Two things nothing here can tell us, which the prompt text has to be
honest about:

- **Anything about a file's *current* contents or size.** The recorded
  size is captured when the file is written and never re-measured;
  Chrome re-checks whether a file still exists, but not what's in it.
  So an edit — even one that empties the file — is only ever visible
  as "the size we recorded no longer matches", never as what actually
  happened.
- **Why a download record is missing.** A cleared download history and
  a fresh install look identical from in here.

## Write ordering

A capture writes any history files first, then `log.json`, then
updates the browser copy — each step only after the one before it has
landed.

- The service worker can be killed between any two steps, so the order
  decides what a half-finished capture leaves behind. **The file
  running ahead of the browser copy is the recoverable direction**:
  the next capture reads the file and the copy catches up. The
  reverse — a record in the browser that reached no file — is what
  the ordering avoids (the interrupted-write case under
  [Where the principles bend](#where-the-principles-bend) is the
  residue).
- The `log.json` write is awaited to *completion*, not merely to the
  download starting. `chrome.downloads.download` resolves the moment
  the write begins, so without the wait the browser copy could still
  be updated first and the ordering would be nominal only.
- History files go first for the same reason: a record must not leave
  `log.json` before the history file carrying it exists.

## Working out what's in the file

Every capture does this before it writes anything, at the top of
`recordCapture` (`inspectLogFile` in `log-reconcile.ts`).

Whether we can **read the file** picks between the two sections
below:

- Reading needs the user's "Allow access to file URLs" toggle, which
  is off by default (`chrome.extension.isAllowedFileSchemeAccess`).
- Reading beats every inference, so it's used whenever available. The
  record-only route is the **fallback** that keeps everything working
  without the permission — at the cost of the blind spots it lists.

One guard is shared by both routes: **a `log.json` write still in
flight is waited out, not skipped** (`getLogFileRecord`).

- `chrome.downloads.download` resolves when the download *starts*, so
  a capture can return before its `log.json` is on disk — and a
  second capture right behind it arrives mid-write.
- Answering from the record of the write *before* that one would
  report a size that no longer matches, i.e. a spurious block.
- Worse with file reads: the `fetch` could catch a half-written file
  and adopt it.

### With file reads — the file's contents decide

Reading also needs to know *where* the file is. The user's download
directory isn't exposed by any API, so the path has to come from a
download record of something we wrote there — and normally one
exists: this capture's own screenshot / HTML were written moments
ago.

Failing that, one throwaway write answers it — the **directory
probe**:

- Writes a throwaway `probe-<epoch-ms>.json`, takes the completed
  download's path minus the filename as the directory, then deletes
  both the file and its download record.
- The name can't collide with anything, matches neither `log.json` nor
  the `history-*.json` pattern any reader looks for, and is never
  displayed — so even a failed cleanup is inert.
- Deliberately *not* a zero-byte `log.json`. If no file were there,
  that would leave an empty one behind — and an empty file we wrote is
  exactly what the fallback route reads as "this log was cleared,
  start over". The probe would manufacture the very state it's trying
  to observe.
- Needing it is rare: only a capture that writes no files of its own
  (a URL-only capture) on a profile with no download records at all.
  If the probe itself fails, fall through to the fallback route.

Then the read decides everything:

| Reading the file | What it means | Action |
|---|---|---|
| Succeeds | This is the log | Take its records, add this capture, write |
| Fails, and the download record says the file is gone (or there is no record) | The user deleted it | Start a new log from this capture |
| Fails, but the record says the file is there | Something we can't explain is in the way | **Don't write — prompt** |

Taking the file's contents wholesale — rather than merging them with
the browser copy — is the whole point: a row the user deleted from
`log.json` stays deleted, and an edited row stays edited.

### Without file reads — the download record decides

This is the fallback mode, and Chrome's default. We can't open
`log.json`, but Chrome still remembers writing it. Every download it
has ever performed has a record (`chrome.downloads.search`), and ours
for `log.json` carries three useful fields:

- **`state`** — `in_progress` while the write is still happening,
  `complete` once the bytes are on disk, `interrupted` if it failed.
  Only a `complete` record describes a file that exists.
- **`exists`** — whether the file is *still* there. Chrome re-checks
  this on demand and reports the answer as an event, so it is how a
  deletion becomes visible to us at all.
- **`fileSize`** — how many bytes were written. **At write time**: it
  is never re-measured, so it says what *we* last wrote, not what the
  file holds now.

Every capture rewrites `log.json` from the browser copy, so the size
we recorded should equal the size that copy would serialize to now:

| Download record | What it means | Action |
|---|---|---|
| `exists` is false | The user deleted the file | Start a new log from this capture |
| complete, size 0 | The last thing *we* wrote was an empty file | Start a new log from this capture |
| complete, size == the browser copy's size | They still agree | Append this capture and write |
| complete, size differs | The **browser copy** drifted from what we wrote | **Don't write — prompt** |
| no record at all | Chrome has forgotten, or never knew | Run the existence probe below |

**Read that mismatch row carefully — both sides of it are ours.** The
recorded size is what we wrote, and the browser copy is our own cache.
Nothing here measures the file. So the mismatch means the *browser
copy* changed unexpectedly — storage wiped by a reinstall or by
clearing site data, or a write interrupted half-way — and never that
the file changed.

Sizes are compared as UTF-8 bytes (`utf8Length`), because that's what
lands on disk — a page title with an accent in it counts for more than
one.

The size-0 row is the same story: the recorded size never changes
after a write, so it can only be zero if *we* wrote an empty file —
which the old *Clear log history* menu entry did, and a Retry or
Overwrite with nothing to write still does.

**In this mode, an edit to `log.json` is not detectable.** A deleted
row, an edited row, even emptying the whole file — none of it changes
anything this route can see, so the next capture rewrites the file
from the browser copy and the edit is gone. Only *deleting* the file
is honored, because file existence is the one thing Chrome does
re-check. Turning on the file-read permission is what makes edits
stick; see
[Where the principles bend](#where-the-principles-bend).

**The existence probe** answers the table's last row — is there
already a `log.json`? — when Chrome has no record of ours. It has to
target `log.json` itself, because that file's existence is the
unknown.

- Writes with `conflictAction: 'uniquify'`, so Chrome renames *our*
  file rather than overwriting anything: if something is already
  there, ours lands as `log (1).json`.
- **Nothing was there** (the name came back as `log.json`) — then a
  new log is exactly what should be written, and it already has been.
- **Something was there** (`log (1).json`) — delete our probe file and
  ask the user. Nothing on disk was touched.
- What we put *in* the probe only matters in the first case, since the
  second deletes it. So it always carries the fresh-start payload: a
  one-record log holding just this capture.
- Collision is detected by comparing the resulting name to `log.json`,
  not by looking for a ` (1)` suffix — that renaming pattern isn't a
  documented format.
- Either way, the completed write's path names the capture directory,
  which the prompt's remedy text uses.
- Never used for the history files, whose timestamped names are
  unique by construction.

## Asking the user

When the check above can't account for `log.json`, the capture
**fails right there** with `LogWriteBlockedError` — a point-in-time
failure like any other.

- Its screenshot / HTML are already on disk; the unwritten record
  rides on the error and exists nowhere else.
- Nothing about the failure is stored. Dismissing the prompt drops the
  record; if the same condition still holds at the next capture, that
  capture re-detects it on its own and asks again.

### The answers offered

Two meaningful ways forward, plus giving up:

- **Retry** — run the same append again from the top: reconcile, then
  write. Used after fixing something — turning on file reads, or
  deleting `log.json` (with the file gone there's nothing left to
  preserve, so a fresh log starts from this capture). With nothing
  changed it lands back on the same prompt.
- **Overwrite** (primary) — the same append with the reconcile
  skipped: the file is replaced with the browser's copy of the log
  plus this capture. The one place anything on disk is knowingly
  discarded, so it takes an explicit click. Usually the right call,
  because the usual cause is a cleared download history, where the
  file and the browser copy actually agree.
- **Extension settings** — opens the extension's own page in a
  background tab, where "Allow access to file URLs" can be turned on.
  Chrome won't link straight to the toggle, so the text has to name
  it. Then **Retry**.
- **Cancel** (the button, Esc, or just closing the page) — abandon the
  record. The capture's files stay on disk, but it is not in the log.

### Where it's asked

The wording lives in one place (`capture/log-sync-client.ts`), so the
two surfaces can't drift apart.

- **Capture page** — the save fails and the dialog opens over the page
  (`capture-page/log-sync.ts`). Retry / Overwrite re-run the whole
  save — it's idempotent (artifact files re-hit their download caches
  or rewrite the same pinned names) — so success flows through the
  page's normal saved path.
- **Captures from the context menu or a keyboard shortcut** have no
  page of their own, so the failure opens the same error page any
  other failed capture opens — `capture.html?error=…` in its "Capture
  failed" state — with the record carried in a `?logsync=` URL param
  and the same dialog on top. Retry / Overwrite send the record to
  the service worker to write (`logSyncWrite`); success closes the
  tab, and closing the tab is the Cancel gesture.

Reusing the failure surface is deliberate. The files did get written,
but the capture the user asked for isn't in their log, which is the
same outcome as a capture that failed outright — so it gets the same
one place to look rather than a second one to learn. The error text is
short (the `LogWriteBlockedError` message) because the dialog above it
carries the detail.

## Supporting changes

- **`getCaptureDirectory`** (`src/capture/downloads.ts`) matches any of
  our records under `SeeWhatISee/` rather than pinning to `log.json`.
  The match is structural — our extension's download, landing directly
  inside a directory named `SeeWhatISee/` — which every
  code-initiated write satisfies (`downloadArtifact` hardcodes that
  relative path); `byExtensionId` is the real guard against a stray
  `/tmp/SeeWhatISee/`. The directory is therefore known right after the
  first artifact of the first capture, which keeps the directory probe
  a rare fallback. A Save-as-dialog write lands wherever the user
  chose and so doesn't match, unless they picked a folder literally
  named `SeeWhatISee`.
- **`refreshLogFileExistence`** (`src/background/log-sync.ts`) runs a
  `downloads.search` for `log.json` on every service-worker load.
  `exists` is stale on read — the `search()` is what prompts Chrome's
  re-check — so this is what lets the next capture's reconcile see a
  deletion made while the browser was closed, instead of a stale
  "still there". A deletion made mid-session is noticed the same way,
  at the next capture; nothing watches for it live.
- **The toolbar's More submenu used to carry a *Clear log history*
  entry**, which wiped the browser copy and truncated `log.json` to
  zero bytes. It was removed with this change: under principle 1 that
  only clears a cache, and under principle 5 it isn't ours to do.
  Deleting `log.json` is the gesture that clears the log until a
  delete-the-files feature exists. `clearCaptureLog()` survives for
  tests and the service-worker console, and now empties the browser
  copy only.

## Where the principles bend

Everything above is enforced by the code except the cases below. They
were each considered and accepted; if a new one appears, it belongs
here or it belongs fixed.

### Deliberate, user-initiated

- **Overwrite.** The prompt's primary button replaces a file we
  couldn't account for with the browser copy. This is the one place
  anything on disk is knowingly discarded, and it takes an explicit
  click on a dialog that says so.
- **Re-writing a capture file before any record points at it.** Within
  one Capture-page session, the screenshot / HTML / selection keep a
  pinned filename, and a *pre-download* under that name (what the Copy
  filename buttons do) can be written again with edited bytes. Only
  reachable if the user edited that exact file on disk between two
  such clicks on the same open page.
  - Files that a log record already references are **not** in this
    category: they're locked, and a later save with edited bytes
    writes `<base>-N.<ext>` and points the new record at that, leaving
    the earlier file alone. Unchanged bytes reuse the same filename, so
    several records can share one file rather than duplicating it. See
    [capture-page.md](capture-page.md).

### Blind spots we accept

- **Any edit to `log.json`, with the file-read permission off.** Not
  just one that preserves the byte count: nothing available to us
  measures the file, so a deleted row, an edited row and an emptied
  file all look identical to an untouched one, and the next capture
  rewrites over them. Chrome re-checks whether a file still exists but
  never what's in it, so no amount of care closes this — only granting
  the read permission does. Deleting the file *is* honored, which is
  why that's the documented way to clear the log.
- **History files Chrome has forgotten.** A new history file takes a
  name no history file on disk is using — but we can only see the ones
  Chrome still has download records for. If the user cleared their
  download history *and* the new batch happens to end at the same
  record as an existing history file, that file is overwritten. Needs
  both halves to line up.
- **A capture directory that isn't ours.** Everything is keyed on the
  download records, so pointing Chrome's download directory somewhere
  that already contains a `SeeWhatISee/log.json` written by another
  profile reads as a file we can't account for — which prompts, rather
  than clobbers, so this one fails safe.

### Costs of failing safe

- **A cancelled prompt is a capture outside the log.** Its files are
  on disk, but no record points at them. That is the deal the prompt
  states: Retry or Overwrite to log it, Cancel to let it go.
- **An interrupted `log.json` write can drop its record.** The record
  still enters the browser copy, but the next reconcile rebuilds from
  the file — which never got it. The files stay on disk,
  unreferenced. Rare (the write is a tiny local `data:` download) and
  additive-only in effect.
- **Duplicate records in a history file.** A service worker killed
  after a rotation batch lands but before `log.json` is rewritten
  leaves the batch both in the new history file and still in the log;
  the retried rotation writes it again under a new name. Additive,
  never lossy, and the History page's exact-match dedupe hides it.
- **A stray probe file.** The existence probe's `log (1).json` is
  deleted immediately, but if that delete fails the file stays. It
  matches nothing any reader looks for.

## Resulting behaviors worth knowing

In either mode:

- Deleting `log.json` starts a clean log. The history files stay on
  disk and the History page still reads them, so the older history is
  still there — deleting the whole directory is what
  clears everything.
- Deleting `log.json` also drops whatever the browser copy still held
  that the file had. Correct: those records were in the file the user
  deleted. Captures that never made it into any file are the exception
  and are written to the new log.

With file reads:

- Deleting individual rows sticks — they are not brought back. Edits
  to rows stick the same way.

Without file reads:

- An edit inside the file can't be seen at all and the next capture
  overwrites it, which is why deleting the whole file is the gesture
  we document for clearing the log.
- With no download record either, the first capture after clearing
  download history prompts once; answering it puts us back on known
  ground.

## Testing

- `tests/unit/log-reconcile.test.mjs` covers each row of the tables
  above, plus the prompt's Retry / Overwrite paths (`recordCapture`
  re-run, with and without `force`), driving a faked
  `chrome.downloads.search` / `fetch` / probe write. This is where the
  no-read branches are covered, since the e2e harness always has file
  access.
- `tests/e2e/screenshot.spec.ts` covers the two headline behaviors
  end-to-end: deleting `log.json` starts a fresh log instead of
  bringing the old records back, and a browser copy that has lost its
  contents is rebuilt from the file rather than truncating it.
- **The e2e harness had to change for any of this to be testable.**
  Playwright renames every download to a UUID under its artifacts
  directory, so the extension's path-based lookups — capture
  directory, `log.json` re-read, file-existence checks — all missed.
  `tests/fixtures/extension.ts` now seeds `download.default_directory`
  in the profile's Preferences and sends `Browser.setDownloadBehavior
  { behavior: 'default' }` over CDP after launch, so files land under
  their real names in a per-worker temp directory.
- `resetCaptureState` (`tests/fixtures/files.ts`) replaces the bare
  `chrome.storage.local.clear()` tests used to open with: a storage
  wipe alone is no longer a clean slate, because the download record
  outlives it and the next capture reconciles against the file it
  names.
