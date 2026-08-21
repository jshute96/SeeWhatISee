// Capture log: the chrome.storage.local-backed queue of captures
// and the `log.json` sidecar that mirrors it on disk.
//
// We can't truly append to log.json from a Chrome extension (the
// downloads API only writes whole files; the SW has no filesystem
// access), so the authoritative log lives in chrome.storage.local
// and log.json is a snapshot of it written on every capture. If a
// user manually deletes log.json, the next capture will recreate
// it from storage.
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
import { ARCHIVE_FILE_PREFIX, downloadArtifact } from './downloads.js';

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
 * Named for the **newest** record it contains, so the file's name
 * matches that capture's own screenshot / HTML filenames and the name
 * says what the file ends at. Deterministic, so a retried flush can't
 * produce two files with the same contents under different names.
 *
 * Falls back to `fallback` for a record whose timestamp won't parse (a
 * hand-edited log).
 *
 * **Never returns a name already in `used`** — the names handed out
 * during *this* drain — disambiguating with a `-1`, `-2`, … suffix the
 * way repeated saves in one Capture-page session name their
 * screenshots. Two batches *can* end on records sharing a timestamp,
 * because a record's `timestamp` doesn't identify it (a Capture
 * session pins one and writes a record per save), and every write uses
 * `conflictAction: 'overwrite'`, so a collision would silently destroy
 * the batch that landed first.
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
  const d = new Date(last?.timestamp ?? '');
  const stamp = compactTimestamp(Number.isNaN(d.getTime()) ? fallback : d);
  let name = `${ARCHIVE_FILE_PREFIX}${stamp}.json`;
  for (let n = 1; used.has(name); n += 1) {
    name = `${ARCHIVE_FILE_PREFIX}${stamp}-${n}.json`;
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
 */
export function serializeLog(records: CaptureRecord[]): string {
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
 * The case this exists for is **Restore last capture**: it rehydrates
 * a session with its pinned timestamp and filenames intact, so saving
 * without changing anything writes a record identical to the previous
 * one, pointing at the same files on disk. Two rows the user cannot
 * tell apart, describing one capture they re-sent.
 *
 * `serializeRecord` supplies the key, not `JSON.stringify`: a record
 * round-tripped through `chrome.storage.local` can come back with its
 * keys in a different order than the copy read from a file, and only
 * a canonical field order compares equal.
 *
 * **Exact equality is the whole point.** A record's `timestamp` does
 * not identify it (see `compactTimestamp`) — anything looser merges
 * the several distinct records one Capture session writes as the user
 * edits, which silently loses real captures.
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
 * Empty the capture log in chrome.storage.local AND truncate the
 * on-disk log.json to zero bytes. Used by the Options page "Clear
 * log" button and by tests between runs.
 *
 * Wraps the storage delete + downloads.download in `serializeWrite`
 * so it can't interleave with a concurrent `recordCapture()` that's
 * in the middle of its read-modify-write of the same storage key or
 * its own rewrite of `log.json`.
 *
 * Leaves the `history-*.json` archives alone: they're the user's
 * files, and clearing the log doesn't mean deleting what's already
 * been written to disk. The History page can still load them.
 *
 * Returns the `chrome.downloads` id of the empty `log.json` write so
 * tests can resolve it to an on-disk path and assert the file is
 * actually zero bytes. Production callers ignore the return.
 */
export async function clearCaptureLog(): Promise<number> {
  return await serializeWrite(async () => {
    await chrome.storage.local.remove(LOG_STORAGE_KEY);
    return await writeJsonFile('log.json', '');
  });
}

/**
 * Append a record to the capture log: archive whatever that pushes
 * past the cap, save the trimmed log to storage, and re-render
 * `log.json` from it. Returns the `chrome.downloads` id of the
 * `log.json` write, which the tab-capture paths hand back to the
 * Capture page (and tests resolve to an on-disk path).
 *
 * The single write path for every capture — screenshot, HTML,
 * selection, URL-only — so the archiving rules can't apply on some
 * paths and not others.
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
 */
export async function recordCapture(record: CaptureRecord): Promise<number> {
  return await serializeWrite(async () => {
    const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
    const stored: CaptureRecord[] = data[LOG_STORAGE_KEY] ?? [];
    // Never mutated in place: `kept` is reassigned per successful
    // batch, so an abandoned flush leaves a coherent list either way.
    let kept = [...stored, record];
    // `LOG_ARCHIVE_BATCH` is a tunable now that it's exported, and a
    // zero would make the loop below spin forever on an empty batch.
    const batchSize = Math.max(1, LOG_ARCHIVE_BATCH);
    const now = Date.now();
    let flushed = 0;
    const usedNames = new Set<string>();
    try {
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
    await chrome.storage.local.set({ [LOG_STORAGE_KEY]: kept });
    return await writeJsonFile('log.json', serializeLog(kept));
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
 * `CaptureRecord.timestamp` does not identify a record: a Capture-page
 * session pins one timestamp and writes a record per save, so
 * re-cropping or editing highlights produces several log records
 * sharing a timestamp, told apart only by their `-1`, `-2`, … filename
 * suffixes. Anything keying, deduping, or joining on `timestamp` alone
 * will silently merge real captures — this has already caused one bug
 * on the History page.
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
