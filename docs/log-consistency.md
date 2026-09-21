# Log consistency: the file is the log

**Status: implemented.** `src/capture/log-reconcile.ts` finds and
reads the file; `recordCapture` in `log-store.ts` writes it.

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

There is no browser copy any more. What survives in extension storage
is bookkeeping, not records: the cached capture directory, the pinned
history-file names, and a session note of the last capture's
filenames.

## The files

- **`log.json`** — the capture log: one JSON record per line, newest
  last, in the user's capture directory.
- **The history files** beside it. A history file is named
  `history-<timestamp>.json` for the moment it was written — not for
  any record inside it — and holds a batch of older records that no
  longer fit in `log.json`. They accumulate; nothing rewrites one once
  it's written, with one deliberate exception: a retried flush
  overwrites the file its abandoned attempt left behind (see
  [architecture.md → History files](architecture.md#history-files)).
- **The session note** (`lastCaptureFiles` in `chrome.storage.session`)
  — the filenames of the most recent capture, written after its
  record lands. It is what the toolbar's Copy-last-… entries copy,
  and (via `storage.onChanged`) how an open History page learns a
  capture landed. Not a copy of any record.

## Principles

**1. The file is the log, and the only copy of it.** Every reader —
the History page, the Python script, the MCP server — reads the file,
and every capture reads it back before writing it.

**2. A capture only ever *adds*.** All a capture does to the files is
put one more line on the end. It never rewrites or removes a line
that is already there — not even one that isn't a record.

- The one rearrangement allowed: once `log.json` grows past its cap,
  the oldest records move into a history file beside it. They are
  still on disk, in the same directory, and the History page and
  `SeeWhatISee.py` read both. That rewrite keeps records only; lines
  that aren't records are dropped, as every reader has been dropping
  them.

**3. What the user does to the files always wins.** Deleting
`log.json`, deleting the whole capture directory, deleting rows out of
the file, editing rows — none of it is ever undone, and records
removed that way never come back.

- Deleting `log.json` therefore *starts a new log*.
- Honoring an edit means reading the file, which is why "Allow
  access to file URLs" is required
  (`docs/chrome-extension.md` → "Allow access to file URLs" is
  required). Without it there is no way to see inside a file.

**4. When we can't read the file, we don't write it.** The capture
fails with a message saying what to fix — its screenshot / HTML are
already saved, but its record is not logged.

**5. Nothing here deletes the user's files.** Not `log.json`, not the
history files, not a capture's own screenshot or HTML. Deleting capture
history means deleting files, which is the user's to do (and, later, a
feature of its own).

The exceptions are all deliberate, and all listed under
[Where the principles bend](#where-the-principles-bend).

## What we can find out about the files

A Chrome extension has no filesystem API. It can't stat a file or
list a directory the ordinary way — what it has is `fetch` on a
`file://` URL (with the required toggle) and the records Chrome keeps
of downloads it performed.

| How | Tells us |
|---|---|
| `fetch('file://…/log.json')` | the file's actual current contents |
| `fetch('file://…/')` on the directory | Chrome's generated listing — how the history files are found |
| The download record for `log.json` (`chrome.downloads.search`) | its path, and whether it still exists (re-checked on demand) |

A file picker (`<input type="file">`) would also hand us the contents
and is deliberately not offered: the `File` it returns carries no
path, so we could not tell our `log.json` from one in a backup or
another Chrome profile — and adopting the wrong one means writing it
back over the real one.

One thing nothing here can tell us: **why a download record is
missing.** A cleared download history and a fresh install look
identical from in here — which is why the directory, not the record,
is what a read is keyed on.

## Write ordering

A capture writes any history files first, then `log.json`, then the
session note — each step only after the one before it has landed.

- The service worker can be killed between any two steps, so the order
  decides what a half-finished capture leaves behind: a history file
  with no matching trim is retried by the next capture (see the pinned
  names), and the note is only ever written for a record that reached
  the file.
- **Every write is awaited to *completion*, not merely to the download
  starting.** `chrome.downloads.download` resolves the moment the write
  begins, so without the wait the ordering would be nominal only.
  `downloadArtifactComplete` in `downloads.ts` is the shared shape;
  `writeJsonFileComplete` in `log-store.ts` wraps it for the log files.
- History files go first, and are waited out the same way: a record
  must not leave `log.json` before the history file carrying it exists.
  A worker killed in that window would otherwise drop the whole batch
  from the file that is authoritative.
- **A `log.json` write that doesn't land fails the capture**
  (`LogWriteFailedError`, message naming the file and Chrome's error
  code).
  - The record is dropped with the error; the capture's files stay on
    disk, unreferenced. Reported on the usual failure surfaces (the
    Capture page's status line, or the error page).
  - Chrome's download bubble shows the same failure as a bare
    "Something went wrong"; this is what says it was the log.
- **Capture-file writes (screenshot / HTML / selection) wait the same
  way** (`downloadArtifactComplete`, `downloads.ts`), and a failure
  there fails the capture *before* the log is touched — so a record
  never points at a file Chrome didn't write.
- **A write that lands somewhere else is a failed write too.**
  - When Chrome can't create the path it was given (the `SeeWhatISee/`
    folder isn't writable) it doesn't error: it ignores `saveAs:
    false`, shows its Save As dialog, and the file lands wherever that
    defaults to — the Downloads root. There is no option to turn this
    off.
  - A completed write whose path isn't `…/SeeWhatISee/<the name asked
    for>` is reported as failed, naming where the file went. The stray
    file is left where the user put it.
  - A cancelled dialog is an interrupted download, reported the
    ordinary way.

### Pruning the older `log.json` records

Every capture rewrites the same `log.json`, so Chrome's download list
would otherwise collect one row per capture, all naming the same file.
`pruneOldLogRecords` (`downloads.ts`) erases the rows older than
the one just written.

- Records only — the file itself is untouched, and only rows written
  by this extension for `log.json` are considered.
- Nothing else wants the older rows: `readLogFileRecord` answers from
  the newest `complete` record, and the rest describe a file that has
  been overwritten many times since.
- Runs only once the new write has landed. Pruning around a write that
  failed would throw away the last record describing what is actually
  on disk — the record a failed read consults for `exists`.
- Strictly *older* records. Every log write is serialized in the
  service worker, so a newer row shouldn't exist here — but should one
  ever appear, it describes the file next, and is left alone.
- A kept record that has itself gone from the list says nothing about
  which of the rest are older, so that prunes nothing.
- Best-effort: a row that wouldn't go away is cosmetic, never a reason
  to fail the capture.

## Working out what's in the file

Every capture does this before it writes anything, at the top of
`recordCapture` (`inspectLogFile` in `log-reconcile.ts`).

Reading needs "Allow access to file URLs", which the extension
requires: every entry point checks it before doing anything
(`docs/chrome-extension.md` → "Allow access to file URLs" is
required). `inspectLogFile` re-checks as a backstop and throws
`FileAccessRequiredError` rather than guess — a `fetch` refused for
lack of the toggle looks exactly like a deleted log.

**A `log.json` write still in flight is waited out, not read around**
(`getLogFileRecord`).

- `chrome.downloads.download` resolves when the download *starts*, so
  a capture can return before its `log.json` is on disk — and a
  second capture right behind it arrives mid-write.
- The `fetch` could catch a half-written file and adopt it as the log.

### Waiting for the existence re-check

**`DownloadItem.exists` is stale on read**, and taking it at face value
is how a deleted log came back.

- Chrome doesn't watch the filesystem. `search()` *triggers* an
  existence re-check, and the refreshed value arrives afterwards as a
  `downloads.onChanged` delta — the search that triggered it still
  returns the old one.
- So a `log.json` deleted this session reads as present. A failed
  read would then be blamed on the file rather than on its absence,
  and the capture failed over a log the user deleted on purpose.

`startExistsWatch` (`capture/downloads.ts`) closes it: the listener is
registered *before* the search that triggers the re-check, and
`confirmExists()` waits briefly for a delta on our record instead of
trusting `exists`.

- Registering after the search would race the event.
- **`onChanged` fires only on a *change*, so a file that is still there
  produces no event and waits out the timeout in full.** There is no
  positive confirmation to wait for; that cost is unavoidable.
- So `getLogFileRecord` hands back the record and `confirmExists()`
  *separately*, and the reconcile calls it only where `exists` decides
  something — a failed read, where the alternative is failing the
  capture of someone who simply deleted their log. **Not** on a
  successful read,
  the common case: the file's contents have already answered
  everything.
- Skipping it there isn't just an optimization: paying it on every
  capture put a 200ms-delay capture over the 500ms bound in
  `html-snapshot.spec.ts`.
- A record already saying `exists: false` short-circuits — nothing to
  re-confirm.
- `_setExistsRecheckTimeoutForTest` keeps the unit tests off the clock.

### Finding the file, then reading it

Reading needs to know *where* the file is. The user's download
directory isn't exposed by any API, so the path comes from the
`log.json` download record, else the cached capture directory
(`peekCaptureDirectory`) — and normally one of those knows: this
capture's own screenshot / HTML were written moments ago.

Failing both, nothing can be read — and the only way to learn the
directory is to write something. So the capture writes the log
itself, **without overwriting** (`claimNewLog`, `log-reconcile.ts`;
`conflictAction: 'uniquify'`):

- It lands as `log.json` → there was no log. This capture is
  recorded, and the completed write's path caches the directory. One
  write, no cleanup.
- It lands as `log (1).json` → a log was there after all. The copy
  is deleted (file and download record), and the log is read the
  ordinary way, which now knows the directory. The rest is the
  normal append.
- Needing it is rare: only a capture that writes no files of its own
  (a URL-only capture) on a profile with no download records and no
  cached directory. If the write fails, or lands outside a
  `SeeWhatISee/` directory, the capture fails (`LogWriteFailedError`):
  nothing was learned, and guessing "no log" would overwrite one.
- Why not a throwaway probe file: this is one write instead of two in
  the common (no log) case, and nothing needs cleaning up.

Then the read decides everything:

| Reading the file | What it means | Action |
|---|---|---|
| Succeeds | This is the log | Append this capture's line to it and write |
| Fails, and the download record says the file is gone (or there is no record) | The user deleted it | Start a new log from this capture |
| Fails, after the first write was deflected by the file | It is there but unreadable, whatever the records say | Fail; the message names the file |
| Fails, but the record says the file is there | Something we can't explain is in the way | **Don't write — fail** |

### The append is verbatim

The steady-state write is the file's text as read, plus one line
(`appendLogLine`, `log-store.ts`). Nothing already there is
re-serialized.

- A hand-edited row keeps its edit *and* its formatting.
- A line that isn't a record — a truncated write, a stray paste — is
  left where it is. Every reader skips such lines (`parseLogText`,
  the Python script, the MCP server), so nothing is lost by carrying
  one, and nothing is gained by refusing to write around it.
- The file's records are parsed only to keep the new timestamp unique
  and to count them against the cap.
- A file missing its trailing newline gets one, so the new record
  can't run onto the previous line.

The one write that does re-serialize `log.json` is a flush (records
moving to a history file), which has to drop lines from it anyway;
non-record lines go with them.

- A flush that was due but landed no history file takes the verbatim
  path instead — nothing left the log, so nothing needs rewriting.

## Reporting the failure

When `log.json` can't be read — or Chrome can't finish writing it —
the capture **fails right there** with
`LogWriteFailedError`, a point-in-time failure like any other.

- Its screenshot / HTML are already on disk; the record is dropped.
  Nothing about the failure is stored, and capturing again is the
  retry.
- The message says what to do, since every case is one the user
  resolves outside the extension. `<log>` is the file's full path
  when the directory is known, else `Downloads/SeeWhatISee/log.json`
  (`describeCaptureFile`, `downloads.ts`):
  - *couldn't read `<log>`. Fix or delete the file, then capture
    again.*
  - *couldn't write `<log>`: download failed (FILE_FAILED).*
  - *couldn't write `<log>`: Chrome saved it to /…/Downloads/log.json
    instead. (Is the SeeWhatISee folder writable?)*
  - *couldn't write `<log>`: the download did not finish.* — also
    what a Save As dialog left open looks like from here: the
    completion wait gives up after a few seconds, and a file saved
    from the dialog after that lands unwatched.
- Each reason is a sentence of its own, so a message reads as
  "Couldn't write `<path>`: Reason. (Aside.)" whichever reason it
  carries. Capture-file failures (`ArtifactWriteError`) name the file
  the same way.
- Where it shows is where any capture failure shows: the Capture
  page's status line, or the `capture.html?error=…` page a
  context-menu / hotkey capture opens.
- There used to be a Retry / Overwrite / Cancel dialog here. Its one
  remaining value once file reads became required was forcing an
  overwrite without leaving the extension — but a user in this state
  got there with another tool, and can fix the file with it.

## Supporting changes

- **Capture-directory discovery** (`src/capture/downloads.ts`) is
  cache-first:
  - `peekCaptureDirectory()` checks the `chrome.storage.local` cache
    (key `captureDirectory`), then download history; it never writes a
    file, and returns `null` when neither knows. Every reader uses it
    — the History page load, reopen, the watch indicator, the copy-last
    menu items, and the reconcile — and treats `null` as "nothing
    captured yet". Only the capture write itself learns the directory
    by writing (`claimNewLog`, above).
  - The download-history match is structural: our extension's download
    (`byExtensionId` guards against a stray `/tmp/SeeWhatISee/`),
    landing directly inside a directory named `SeeWhatISee/`. Any
    artifact matches, not just `log.json`. A Save-as-dialog write
    lands wherever the user chose and so doesn't match, unless they
    picked a folder literally named `SeeWhatISee`.
  - Writes awaited through `waitForDownloadComplete` — capture files,
    log writes, history-file flushes — refresh the cache when they
    land inside `SeeWhatISee/`, so the cache tracks a download root
    the user has since moved.
- **`refreshLogFileExistence`** (`src/capture/downloads.ts`) runs a
  `downloads.search` for `log.json` on every service-worker load, which
  gets Chrome re-checking early rather than leaving it to the first
  failed read. The reconcile doesn't depend on it having finished; see
  [Waiting for the existence re-check](#waiting-for-the-existence-re-check).
- **The flush's collision guard** (`recordCapture`, `log-store.ts`)
  seeds the names already taken by listing the capture directory over
  `file://` — the same index the History page uses — so a history
  file Chrome has no download record for is still seen.
- **The toolbar's More submenu used to carry a *Clear log history*
  entry**, which truncated `log.json` to zero bytes. It was removed:
  under principle 5 it isn't ours to do. Deleting `log.json` is the
  gesture that clears the log until a delete-the-files feature exists.
- **The Copy-last-… menu entries** read the session note, not the log:
  the entries only make sense right after a capture, so the note
  needn't outlive the browser session, and the log needn't be parsed
  for them.

## Where the principles bend

Everything above is enforced by the code except the cases below. They
were each considered and accepted; if a new one appears, it belongs
here or it belongs fixed.

### Deliberate, user-initiated

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

- **An unreadable `log.json` with no download record.** A failed read
  consults the record's `exists` to tell "deleted" from "in the way";
  with the record gone (download history cleared) there is nothing to
  ask, and the read failure reads as a deleted file — the capture
  starts a fresh log over one that may still be there. Needs both a
  cleared download history and a file that exists but can't be read.
- **A capture directory that isn't ours.** Pointing Chrome's download
  directory somewhere that already contains a `SeeWhatISee/log.json`
  written by another profile or a script reads as *the* log: its
  records are adopted and appended to. Additive, never lossy — and
  what a user who moved their directory on purpose would want.

### Costs of failing safe

- **A failed log write is a capture outside the log.** The capture
  fails with the reason, and the record is stored nowhere — its files
  stay on disk, unreferenced. Rare: a write Chrome can't finish (a
  tiny local `data:` download), or a file that exists but can't be
  read.
- **Duplicate records in a history file.** A service worker killed
  after a flush batch lands but before `log.json` is rewritten
  leaves the batch both in the new history file and still in the log;
  the retried flush writes it again under a new name. Additive,
  never lossy, and the History page's exact-match dedupe hides it.
- **A stray `log (1).json`.** A deflected first write (see "Finding
  the file") is deleted immediately; if that delete fails the copy
  stays. It matches nothing any reader looks for.
- **A failed read waits out the re-check timeout.** The only route
  that consults `exists` (see
  [Waiting for the existence re-check](#waiting-for-the-existence-re-check)),
  so a healthy capture never pays it. Latency, not correctness.

## Resulting behaviors worth knowing

- Deleting `log.json` starts a clean log. The history files stay on
  disk and the History page still reads them, so the older history is
  still there — deleting the whole directory is what clears
  everything. The History page shows the deletion immediately: it
  reads the file — see `docs/history-page.md` → Data source.
- Deleting individual rows sticks — they are not brought back. Edits
  to rows stick the same way, formatting included.
- A line that isn't a record stays in `log.json` until the next flush
  carries it away; nothing displays it.
- Clearing Chrome's download history changes nothing: the cached
  directory still says where to read, and the file is what's read.

## Testing

- `tests/unit/log-reconcile.test.mjs` covers each row of the table
  above, the unknown-directory first write (landed, deflected, and
  failed), the file-access backstop, and the failure messages,
  driving a faked `chrome.downloads` / `fetch`.
  - Its stub reproduces the **stale `exists`** contract: a `search()`
    returns the old value and fires the `onChanged` delta afterwards.
    That's what makes "a log deleted this session starts fresh, not a
    failure" a real test rather than a restatement of the code.
  - The verbatim append — an edited line and a non-record line kept
    byte for byte, a missing terminator supplied — is covered here
    too.
- `tests/unit/capture-directory.test.mjs` covers the landing check: a
  write that lands under another name or outside `SeeWhatISee/` is a
  failed write, and only writes inside it refresh the cache.
- `tests/e2e/more-captures.spec.ts` drives the first-write path in real
  Chrome: with download history erased and the cache dropped, a
  URL-only capture appends to an existing log (the deflected copy
  cleaned up) or starts one.
- `tests/unit/log-history-files.test.mjs` covers the failed `log.json`
  write: the capture rejects with `LogWriteFailedError`, no session
  note is left, and the flushed batch's pinned name survives for the
  retry.
- `tests/e2e/screenshot.spec.ts` covers the headline behaviors
  end-to-end: deleting `log.json` starts a fresh log instead of
  bringing the old records back — once deleted through
  `chrome.downloads.removeFile`, and once deleted on the filesystem
  (pinned as an expected failure: real Chrome doesn't re-check
  `exists` on `search()`, see the test's comment) — and a capture
  appends to a hand-edited file without rewriting what's there.
- **The e2e harness had to change for any of this to be testable.**
  Playwright renames every download to a UUID under its artifacts
  directory, so the extension's path-based lookups — capture
  directory, `log.json` re-read, file-existence checks — all missed.
  `tests/fixtures/extension.ts` now seeds `download.default_directory`
  in the profile's Preferences and sends `Browser.setDownloadBehavior
  { behavior: 'default' }` over CDP after launch, so files land under
  their real names in a per-worker temp directory.
- `resetCaptureState` (`tests/fixtures/files.ts`) deletes the capture
  files and their download records as well as extension storage:
  the file is the log, so a storage wipe alone clears nothing.
  `seedCaptureLog` / `seedCaptureLogText` write a `log.json` for a
  test to start from, and `readCaptureLog` reads it back.
- **Not covered end-to-end:** the failure messages on a real page.
  Reaching them means making `log.json` unreadable or unwritable,
  which the harness's real download directory makes awkward. The
  decisions and messages are unit-tested; the surfaces are the same
  ones every other capture failure uses.
