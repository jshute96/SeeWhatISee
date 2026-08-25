// Capture log: the `log.json` file on disk, and the
// chrome.storage.local buffer that backs it.
//
// We can't truly append to log.json from a Chrome extension (the
// downloads API only writes whole files; the SW has no filesystem
// access), so every capture rewrites the whole file. But **the file
// is authoritative and storage is a cache**: each capture reconciles
// against disk first (`log-reconcile.ts`) and only ever *adds* its own
// record to what it finds there. Deleting log.json starts a new log
// rather than being undone by the next capture, and hand-edited rows
// survive wherever we can read the file. When we can't tell what is on
// disk, the capture fails with `LogWriteBlockedError` and the user is
// asked — see `docs/log-consistency.md`.
//
// Entries that age out of that buffer aren't lost: they're flushed
// in batches to `history-<timestamp>.json` archive files beside
// `log.json`, so the full capture history survives on disk without
// any single write growing without bound. See "Archiving" below.
//
// Also home to `compactTimestamp` — the filename suffix every
// capture uses to stay unique on disk. Lives here because the log
// is the canonical record of when each capture happened.

import { type CaptureRecord } from './types.js';
import {
  ARCHIVE_FILE_PREFIX,
  LOG_FILE_NAME,
  downloadArtifact,
  getArchiveFilePaths,
  waitForDownloadComplete,
} from './downloads.js';
import { LogWriteBlockedError, inspectLogFile } from './log-reconcile.js';

export const LOG_STORAGE_KEY = 'captureLog';
/**
 * Cap on the in-storage log, so it doesn't grow unbounded and so
 * rewriting `log.json` on every capture stays cheap (otherwise it's
 * quadratic in the number of captures: each write copies the whole
 * log).
 *
 * Exported for the tests, which have to seed a full log to reach the
 * flush — hardcoding the number there would turn a deliberate change
 * here into a mystifying test failure.
 */
export const LOG_MAX_ENTRIES = 100;
/**
 * How many of the oldest entries are flushed to an archive file each
 * time the log goes over `LOG_MAX_ENTRIES`.
 *
 * Half the cap, deliberately, rather than evicting one entry per
 * capture: an archive write is a whole extra file, so amortising it
 * over 50 captures keeps the steady-state cost of a capture at one
 * `log.json` rewrite. The visible consequence is that once the log has
 * filled, `log.json` (and the History page's in-storage view) holds
 * `LOG_MAX_ENTRIES - LOG_ARCHIVE_BATCH + 1` to `LOG_MAX_ENTRIES`
 * entries depending on where in the cycle it is.
 */
export const LOG_ARCHIVE_BATCH = 50;

/**
 * Name of the archive file holding `batch`.
 *
 * Named for the **newest** record it contains, so the name says what
 * the file ends at and normally matches that capture's own screenshot
 * / HTML filenames — normally, because `uniqueTimestamp` can leave a
 * repeat save's record a millisecond past the stamp its files were
 * written with. Deterministic, so a retried flush can't produce two
 * files with the same contents under different names.
 *
 * Falls back to `fallback` for a record whose timestamp won't parse (a
 * hand-edited log).
 *
 * **Never returns a name already in `used`** — the archive files
 * already on disk, plus the names handed out during *this* drain —
 * advancing the stamp a millisecond at a time until it's free. Every
 * write uses `conflictAction: 'overwrite'`, so a collision would
 * silently destroy the batch that landed first, and archives on disk
 * are exactly what a capture must never damage.
 *
 * A same-name clash with an existing archive isn't hypothetical: a
 * user who deletes rows out of a `log.json` that later refills past
 * the cap produces a different batch of 50 ending at the same record,
 * and so the same name.
 *
 * Bumping the stamp rather than appending a `-1`, `-2`, … suffix keeps
 * every archive name matching one pattern, so anything reading the
 * directory can parse the stamp without a special case. It essentially
 * never fires, because `uniqueTimestamp` keeps the record timestamps
 * these names come from unique.
 *
 * Batches from *separate* `recordCapture` calls aren't covered: they'd
 * have to be 50 apart yet still share a millisecond-precision stamp,
 * i.e. one pinned timestamp spanning >50 records. Left alone rather
 * than paying a `downloads.search` per flush to close it.
 *
 * A *retried* flush deliberately reuses the name: same batch, same
 * contents, and overwriting the failed write is what we want.
 */
function archiveFileName(
  batch: CaptureRecord[],
  fallback: Date,
  used: Set<string>,
): string {
  const last = batch[batch.length - 1];
  const parsed = new Date(last?.timestamp ?? '');
  let d = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  let name = `${ARCHIVE_FILE_PREFIX}${compactTimestamp(d)}.json`;
  while (used.has(name)) {
    d = new Date(d.getTime() + 1);
    name = `${ARCHIVE_FILE_PREFIX}${compactTimestamp(d)}.json`;
  }
  used.add(name);
  return name;
}

/**
 * Render a slice of the log as the newline-delimited JSON both
 * `log.json` and the archive files use — one `serializeRecord` per
 * line, trailing newline included.
 *
 * Every write of either file goes through here so the two formats
 * can't drift; `parseLogText` is the matching reader.
 *
 * An empty list renders as the empty string, not a bare newline: the
 * reconcile compares this against the byte size of the file we last
 * wrote, and a phantom byte would make an empty log look like a file
 * that had been tampered with.
 */
export function serializeLog(records: CaptureRecord[]): string {
  if (records.length === 0) return '';
  return records.map((r) => serializeRecord(r)).join('\n') + '\n';
}

/**
 * Parse the newline-delimited JSON of a `log.json` / archive file.
 *
 * Lenient on purpose: these files sit in the user's Downloads folder
 * where they can be edited, truncated mid-write, or concatenated. A
 * line that doesn't parse (or parses to something that isn't a record
 * object) is skipped rather than failing the whole file — losing one
 * row beats losing the rest of the history.
 */
export function parseLogText(text: string): CaptureRecord[] {
  const out: CaptureRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as CaptureRecord);
      }
    } catch {
      // Unparseable line — skip it and keep reading.
    }
  }
  return out;
}

/**
 * Drop records that are byte-for-byte repeats of one already in the
 * list, keeping the first occurrence. For *display* only — the log
 * files stay a faithful record of every save.
 *
 * `uniqueTimestamp` gives every save its own timestamp, so no two
 * records the log *writes* can collide here. What's left is one copy
 * of a record reaching the History page twice: the page merges the
 * in-storage log with the archive files, and a batch that reached an
 * archive while the service worker died before the matching storage
 * write sits in both.
 *
 * `serializeRecord` supplies the key, not `JSON.stringify`: a record
 * round-tripped through `chrome.storage.local` can come back with its
 * keys in a different order than the copy read from a file, and only
 * a canonical field order compares equal.
 *
 * **Exact equality is the whole point.** Anything looser merges the
 * several distinct records one Capture session writes as the user
 * edits — they describe different content, and dropping one silently
 * loses a real capture, which has already shipped once.
 */
export function dedupeRecords(records: CaptureRecord[]): CaptureRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = serializeRecord(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Drop the capture-log buffer in chrome.storage.local. Used by tests
 * between runs, and available from the service-worker console.
 *
 * **Storage-only, and deliberately not a user-facing feature.** Under
 * disk authority, storage is a cache: the next capture reconciles
 * against `log.json` and puts back whatever the file holds, so
 * "clearing" it wouldn't clear anything a user could see. Deleting
 * capture history means deleting files, which will come back as its
 * own feature.
 *
 * Wrapped in `serializeWrite` so it can't interleave with a
 * concurrent `recordCapture()` mid read-modify-write.
 *
 * Leaves `log.json` and the `history-*.json` archives alone: they're
 * the user's files.
 */
export async function clearCaptureLog(): Promise<void> {
  await serializeWrite(async () => {
    await chrome.storage.local.remove(LOG_STORAGE_KEY);
  });
}

/**
 * Advance `record`'s timestamp past every timestamp already in
 * `stored`, so no two records in the log carry the same one.
 *
 * A Capture-page session pins one timestamp and writes a record per
 * save, so re-cropping or editing highlights would otherwise append
 * records no timestamp can tell apart — and every consumer that uses
 * one as a cursor (`--after`, the MCP `watch` tool and
 * `captures/stream`) needs "the record at T" to be a single record.
 * Milliseconds are a uniqueness device rather than a measurement, so
 * spending them this way costs nothing; nothing displays them.
 *
 * **Edits `record` in place** so every caller sees what landed. The
 * save path stores `serializeRecord` of the record it passed here as
 * the key the History page matches a *Restore last capture* row by; a
 * copy would leave that key describing a record the log doesn't hold.
 *
 * Only the record moves — its files keep the stamp they were written
 * with, so a repeat save's record can sit a millisecond past its own
 * filenames. An unparseable timestamp is left alone.
 */
function uniqueTimestamp(record: CaptureRecord, stored: CaptureRecord[]): void {
  if (!stored.some((r) => r.timestamp === record.timestamp)) return;
  const parsed = new Date(record.timestamp);
  if (Number.isNaN(parsed.getTime())) return;
  const taken = new Set(stored.map((r) => r.timestamp));
  let ms = parsed.getTime();
  let bumped: string;
  do {
    ms += 1;
    bumped = new Date(ms).toISOString();
  } while (taken.has(bumped));
  record.timestamp = bumped;
}

/**
 * Append a record to the capture log: reconcile against the file on
 * disk, archive whatever the append pushes past the cap, write
 * `log.json`, then save the result to storage. Returns the
 * `chrome.downloads` id of the `log.json` write, which the tab-capture
 * paths hand back to the Capture page (and tests resolve to an on-disk
 * path).
 *
 * The single write path for every capture — screenshot, HTML,
 * selection, URL-only — so the reconcile and archiving rules can't
 * apply on some paths and not others.
 *
 * ## Reconcile
 *
 * `inspectLogFile` decides what we're appending *to*, which is not
 * necessarily what's in storage:
 *
 * - **contents** — we read the file, so it replaces the buffer.
 *   Rows the user deleted by hand stay deleted, and edits survive.
 * - **fresh** — the file is gone or empty, so the log starts over at
 *   this capture and the buffer is discarded. This is what stops a
 *   deleted log from being resurrected.
 * - **insync** — the file still matches what we last wrote; append to
 *   the buffer as usual. The steady-state case.
 * - **written** — there was no file and no record of one, so the
 *   existence probe already wrote a one-record log. Nothing left to do
 *   but record it.
 * - **blocked** — see below.
 *
 * ## Out of sync
 *
 * A blocked reconcile **throws `LogWriteBlockedError`** before
 * anything is written: no archive files, no `log.json`, no storage
 * change. The capture's screenshot / HTML are already on disk, and the
 * record rides on the error so the prompt that catches it can offer
 * Retry (call this again) or Overwrite (call this again with `force`).
 * Nothing about the failure is stored — dismissing the prompt drops
 * the record, and a later capture re-detects the same condition on its
 * own if it still holds. Overwriting on a guess is the one thing we
 * won't do — the file may hold history that exists nowhere else.
 *
 * ## Force
 *
 * `opts.force` — the prompt's **Overwrite** button — skips the
 * reconcile entirely and appends to the storage buffer, replacing
 * whatever file we couldn't account for with the browser's copy of the
 * log. The only path that clobbers a file we couldn't read, and only
 * ever on an explicit click.
 *
 * ## Ordering
 *
 * Archives, then `log.json`, then storage. Every step depends on the
 * one before it having landed, and biasing the crash window toward
 * *the file being ahead of storage* is what makes it recoverable: the
 * next reconcile reads the file and heals. The reverse order loses a
 * record whose artifacts are already written.
 *
 * ## Archiving
 *
 * Once the log exceeds `LOG_MAX_ENTRIES` the oldest
 * `LOG_ARCHIVE_BATCH` entries are written to their own
 * `history-<timestamp>.json` beside `log.json` and dropped from
 * storage. `while`, not `if`, so a log that starts far over the cap
 * (the cap was lowered, or entries predate archiving) drains in
 * batches instead of one oversized file.
 *
 * **Order matters:** an entry leaves storage only *after* its archive
 * file has been written. `kept` advances one batch at a time and only
 * once that batch is on disk, so entries are never trimmed out from
 * under a write that didn't happen.
 *
 * **A failed archive write is not a failed capture.** The capture's
 * screenshot / HTML is already on disk by the time we're called, so
 * rejecting here would leave that file referenced by nothing and lose
 * the record entirely. Instead the flush is abandoned, every
 * un-archived entry — the new record included — stays in storage, and
 * the next capture retries. The log sits over its cap in the meantime,
 * which is the harmless failure. Entries whose batch *did* land are
 * already trimmed, so nothing is written twice.
 *
 * Goes through `serializeWrite` itself, so callers don't have to: the
 * read-modify-write of the storage key would otherwise race two rapid
 * captures against each other.
 *
 * **Edits `record.timestamp`** on the way in, via `uniqueTimestamp` —
 * a visible side effect on the caller's object, and deliberately so.
 */
export async function recordCapture(
  record: CaptureRecord,
  opts?: { force?: boolean },
): Promise<number> {
  return await serializeWrite(async () => {
    const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
    const stored: CaptureRecord[] = data[LOG_STORAGE_KEY] ?? [];
    // Force appends to the buffer as though the file still matched it
    // — that is what "replace the file with the browser's copy" means.
    const state = opts?.force
      ? { kind: 'insync' as const }
      : await inspectLogFile({
          expectedText: serializeLog(stored),
          freshPayload: serializeLog([record]),
        });
    // Nothing written, nothing stored — see "Out of sync" above.
    if (state.kind === 'blocked') {
      throw new LogWriteBlockedError(state.reason, record, state.directory);
    }
    // The probe already wrote the file it was probing, so the log is
    // exactly what we handed it and there is nothing to archive.
    if (state.kind === 'written') {
      await chrome.storage.local.set({ [LOG_STORAGE_KEY]: [record] });
      return state.downloadId;
    }
    // What we're appending to. `stored` only wins in the steady state;
    // otherwise the file (or the absence of one) decides.
    const base = state.kind === 'contents'
      ? parseLogText(state.text)
      : state.kind === 'fresh' ? [] : stored;
    uniqueTimestamp(record, base);
    // Never mutated in place: `kept` is reassigned per successful
    // batch, so an abandoned flush leaves a coherent list either way.
    let kept = [...base, record];
    // `LOG_ARCHIVE_BATCH` is a tunable now that it's exported, and a
    // zero would make the loop below spin forever on an empty batch.
    const batchSize = Math.max(1, LOG_ARCHIVE_BATCH);
    const now = Date.now();
    let flushed = 0;
    const usedNames = new Set<string>();
    try {
      // Seeded with the archives already on disk, so a flush can't
      // land on top of one. Only paid when a flush is actually about
      // to happen — once per 50 captures, not once per capture.
      // Archives Chrome has lost track of (download history cleared)
      // are invisible here, which is the residual case noted in
      // `docs/log-consistency.md`.
      if (kept.length > LOG_MAX_ENTRIES) {
        for (const path of await getArchiveFilePaths()) {
          usedNames.add(path.replace(/^.*[/\\]/, ''));
        }
      }
      while (kept.length > LOG_MAX_ENTRIES) {
        const batch = kept.slice(0, batchSize);
        // The fallback advances a millisecond per batch so a drain of
        // several batches whose timestamps *all* fail to parse still
        // reads as distinct times; `usedNames` is what actually
        // guarantees no two batches share a filename.
        const fallback = new Date(now + flushed);
        flushed += 1;
        await writeJsonFile(archiveFileName(batch, fallback, usedNames), serializeLog(batch));
        kept = kept.slice(batchSize);
      }
    } catch (err) {
      // Expected-and-handled: the entries stay put and the next
      // capture retries, so this must not reach the chrome://extensions
      // Errors page.
      console.info('[SeeWhatISee] log archive write failed; retrying next capture:', err);
    }
    // File first, storage second — see "Ordering" above. Awaited to
    // completion, not just to the download *starting*, so the ordering
    // is real: `chrome.downloads.download` resolves the moment the
    // write begins, which would leave storage able to land first after
    // all.
    const downloadId = await writeJsonFile(LOG_FILE_NAME, serializeLog(kept));
    try {
      await waitForDownloadComplete(downloadId);
    } catch (err) {
      // The record still belongs in storage: its artifacts are on
      // disk, and the next capture reconciles against whatever the
      // file turned out to be.
      console.info('[SeeWhatISee] log.json write did not complete:', err);
    }
    await chrome.storage.local.set({ [LOG_STORAGE_KEY]: kept });
    return downloadId;
  });
}

/**
 * Write a JSON sidecar to the download dir, overwriting any existing file.
 * `text` is the pre-formatted JSON to write (callers use serializeRecord
 * to guarantee canonical key order). Returns the chrome.downloads
 * download id, which tests use to resolve the on-disk path.
 */
export async function writeJsonFile(name: string, text: string): Promise<number> {
  return downloadArtifact(
    name,
    `data:application/json;charset=utf-8,${encodeURIComponent(text)}`,
  );
}

/**
 * Stringify a CaptureRecord with a stable, explicit key order.
 *
 * `chrome.storage.local` does not guarantee that object key insertion
 * order survives the serialize/deserialize roundtrip, so an entry that
 * comes back out of storage may have its keys in a different order than
 * when we wrote it. To keep log.json grep-friendly and diff-stable, we
 * never just `JSON.stringify(record)`; we rebuild a fresh object with
 * keys in the canonical order at the call site.
 *
 * `indent` maps directly to JSON.stringify's third argument: 0 for
 * compact NDJSON-style output, 2 for human-readable.
 */
export function serializeRecord(r: CaptureRecord, indent = 0): string {
  // Build the output object field by field so optional entries are
  // *absent* (not `undefined`) when unset — JSON.stringify drops
  // undefined values, but writing them explicitly is noisier. Fixed
  // key order keeps log.json diff-stable.
  const ordered: Record<string, unknown> = { timestamp: r.timestamp };
  // `screenshot` / `contents` / `selection` are all artifact objects
  // (`{ filename, <flags>? }`) — emitted as-is so `JSON.stringify`
  // handles the nested shape and the optional per-kind flags
  // (`hasHighlights` / `hasRedactions` / `isCropped` on screenshots,
  // `isEdited` on contents/selection) naturally.
  if (r.screenshot !== undefined) ordered.screenshot = r.screenshot;
  if (r.contents !== undefined) ordered.contents = r.contents;
  if (r.selection !== undefined) ordered.selection = r.selection;
  if (r.prompt !== undefined) ordered.prompt = r.prompt;
  // `url` / `title` are typed as required `string` on the in-memory
  // record (write paths always assign one — possibly empty), but
  // we only *emit* them when non-empty so an unavailable URL or
  // title is absent from `log.json` rather than serialised as `""`.
  // Keeps the JSON schema honest: presence implies "we have it".
  // Records persisted in `chrome.storage.local` before these fields
  // existed surface here as `undefined`; the truthiness check elides
  // them the same way.
  if (r.url) ordered.url = r.url;
  if (r.title) ordered.title = r.title;
  // `imageUrl` is the rightmost field, after `url` / `title`. Emitted
  // independently of `screenshot` so the source-image URL survives
  // even when the user unchecks Save Screenshot in the Capture page.
  // Sitting after `title` keeps the per-record metadata block (page
  // URL, page title, source image URL) visually grouped at the end.
  if (r.imageUrl) ordered.imageUrl = r.imageUrl;
  return JSON.stringify(ordered, null, indent);
}

// Simple in-memory mutex: every storage-touching write goes through this
// promise chain so a second captureVisible() call started before the first
// finishes its read-modify-write can't lose entries. The chain is reset if
// the service worker is torn down, but that only happens when there is no
// in-flight work to lose.
let writeChain: Promise<unknown> = Promise.resolve();
export function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  // `then(fn, fn)` runs `fn` whether the previous chain link fulfilled
  // or rejected — i.e. a prior failure doesn't permanently poison
  // subsequent writes. `fn` ignores its argument so it doesn't care
  // which side it was called from. The .catch() below additionally
  // absorbs any rejection from `next` itself before assigning back to
  // writeChain, so the chain stored on the module is always a fulfilled
  // promise that future writes can safely .then() off of. The original
  // rejection still propagates to *this* caller via `return next`.
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * Format a Date as `YYYYMMDD-HHMMSS-mmm` in the local timezone.
 *
 * Used as the unique suffix in capture filenames
 * (`screenshot-*.png`, `contents-*.html`, `selection-*.html`) so
 * they sort lexicographically by capture time and stay short /
 * shell-safe.
 *
 * **Uniqueness assumption.** The rest of the extension assumes
 * different captures produce different `compactTimestamp` values
 * and treats that as the filename-uniqueness guarantee — so writes
 * can use `conflictAction: 'overwrite'` uniformly without worrying
 * about clobbering an unrelated capture. Two captures inside the
 * same millisecond would break this. It hasn't come up (user-
 * driven clicks can't happen that fast, and the Capture page flow
 * pins a single timestamp per session), so we don't guard against
 * it.
 *
 * **This is a guarantee about *filenames*, not about records.** A
 * Capture-page session pins one timestamp and writes a record per
 * save, so re-cropping or editing highlights produces several records
 * that were all built from this one stamp — and they keep sharing
 * these filenames.
 *
 * Their `CaptureRecord.timestamp`s are pulled apart on the way into
 * the log by `uniqueTimestamp`, so one names a single record within
 * `log.json` — enough to cursor on, and no more. Uniqueness is
 * maintained there rather than across the archive files, and a
 * record can sit a millisecond past the stamp in its own filenames.
 * Exact-match dedup (`dedupeRecords`) still keys on the whole record
 * — anything looser has already caused one bug on the History page.
 *
 * Example: a capture taken at 2026-04-08 20:30:12.345 local time
 * produces `20260408-203012-345`.
 */
export function compactTimestamp(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}` +
    `-${pad3(d.getMilliseconds())}`
  );
}
