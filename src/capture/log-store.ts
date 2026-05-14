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
// Also home to `compactTimestamp` — the filename suffix every
// capture uses to stay unique on disk. Lives here because the log
// is the canonical record of when each capture happened.

import { type CaptureRecord } from '../capture.js';
import { downloadArtifact } from './downloads.js';

export const LOG_STORAGE_KEY = 'captureLog';
// Cap the in-storage log so we don't grow unbounded and so rewriting
// log.json on every capture stays cheap (otherwise it's quadratic in the
// number of captures: each write copies the whole log). Oldest entries
// are evicted FIFO when the cap is exceeded.
const LOG_MAX_ENTRIES = 100;

/**
 * Empty the capture log in chrome.storage.local AND truncate the
 * on-disk log.json to zero bytes. Used by the Options page "Clear
 * log" button and by tests between runs.
 *
 * Wraps the storage delete + downloads.download in `serializeWrite`
 * so it can't interleave with a concurrent appendToLog() / capture
 * that's in the middle of its read-modify-write of the same
 * storage key or its own rewrite of `log.json`.
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
 * Append a record to the in-storage log, then re-render log.json
 * from the (capped) log array. Returns the new log so callers that
 * need the full slice (e.g. for re-rendering) don't have to do a
 * second `chrome.storage.local.get`.
 *
 * Caller is responsible for going through `serializeWrite` — the
 * read-modify-write here would race against itself otherwise.
 */
export async function appendToLog(record: CaptureRecord): Promise<CaptureRecord[]> {
  const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
  const log: CaptureRecord[] = data[LOG_STORAGE_KEY] ?? [];
  log.push(record);
  // Drop oldest entries past the cap. `splice` handles the case where the
  // log was already over-cap (e.g. cap was lowered) by trimming all excess
  // in one shot.
  if (log.length > LOG_MAX_ENTRIES) {
    log.splice(0, log.length - LOG_MAX_ENTRIES);
  }
  await chrome.storage.local.set({ [LOG_STORAGE_KEY]: log });
  return log;
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
