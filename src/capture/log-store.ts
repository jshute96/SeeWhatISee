// Capture log: the `log.json` file on disk.
//
// We can't truly append to log.json from a Chrome extension (the
// downloads API only writes whole files; the SW has no filesystem
// access), so every capture rewrites the whole file — but **the file
// is the log, and the only copy of it**: each capture reads it back
// first (`log-reconcile.ts`) and writes it out again with its own
// record on the end, byte for byte otherwise. Deleting log.json starts
// a new log rather than being undone by the next capture, hand-edited
// rows survive as edited, and lines that aren't records survive too
// (until a flush). When the file can't be read, or Chrome can't finish
// the write, the capture fails with `LogWriteFailedError` and a
// message saying what to fix — see `docs/log-consistency.md`.
//
// Entries that age out of `log.json` aren't lost: they're flushed in
// batches to `history-<timestamp>.json` history files beside it, so
// the full capture history survives on disk without any single write
// growing without bound. See "Flushing" below.
//
// Also home to `compactTimestamp` — the filename suffix every
// capture uses to stay unique on disk. Lives here because the log
// is the canonical record of when each capture happened.

import { type CaptureRecord } from './types.js';
import {
  HISTORY_FILE_PREFIX,
  LOG_FILE_NAME,
  ArtifactWriteError,
  downloadArtifactComplete,
  listHistoryFiles,
  pruneOldLogRecords,
} from './downloads.js';
import { LogWriteFailedError, inspectLogFile } from './log-reconcile.js';

/**
 * `chrome.storage.session` key holding the filenames of the most
 * recent capture — what the toolbar's Copy-last-… entries copy, and
 * the signal (via `storage.onChanged`) that a capture just landed,
 * which the History page uses to re-read `log.json`.
 *
 * Session, not local, on purpose: copying the last filename only
 * makes sense right after the capture, so it needn't survive a
 * browser restart — and the log itself lives in the file, nowhere
 * else.
 */
export const LAST_CAPTURE_FILES_KEY = 'lastCaptureFiles';

/** What `LAST_CAPTURE_FILES_KEY` holds. Filenames are bare basenames. */
export interface LastCaptureFiles {
  /** The record's timestamp — distinct per capture, so a repeat set still fires `onChanged`. */
  timestamp: string;
  screenshot?: string;
  contents?: string;
  selection?: string;
}

/**
 * Cap on `log.json`, so it doesn't grow unbounded and so rewriting it
 * on every capture stays cheap (otherwise it's quadratic in the number
 * of captures: each write copies the whole log).
 *
 * Exported for the tests, which have to seed a full log to reach the
 * flush — hardcoding the number there would turn a deliberate change
 * here into a mystifying test failure.
 */
export const LOG_MAX_ENTRIES = 100;
/**
 * How many of the oldest entries are flushed to a history file each
 * time the log goes over `LOG_MAX_ENTRIES`.
 *
 * Half the cap, deliberately, rather than evicting one entry per
 * capture: a history file write is a whole extra file, so amortising it
 * over 50 captures keeps the steady-state cost of a capture at one
 * `log.json` rewrite. The visible consequence is that once the log has
 * filled, `log.json` (and so the History page's live view) holds
 * `LOG_MAX_ENTRIES - LOG_HISTORY_BATCH + 1` to `LOG_MAX_ENTRIES`
 * entries depending on where in the cycle it is.
 */
export const LOG_HISTORY_BATCH = 50;

/**
 * `chrome.storage.local` key pinning the history-file name each
 * pending batch was given — a `{ [batchKey]: filename }` map.
 *
 * A capture can write its history file and then die (SW killed, or
 * `log.json` never trimmed). The next capture reconciles against the
 * untrimmed `log.json` and re-derives the identical batch — and since
 * names come off the clock, it would mint a fresh one, leaving two
 * files holding the same records. `dedupeRecords` hides that on the
 * History page, but `skills/SeeWhatISee.py` concatenates history files
 * without deduping, so an agent would see every record twice.
 *
 * So the name is recorded *before* the file is written and the retry
 * reuses it, landing on top of the orphan instead of beside it.
 *
 * An entry is dropped once its batch is out of the log for good. A
 * batch abandoned mid-drain keeps its entry — it is still in the log
 * and is exactly what will be retried. A clean drain drops the whole
 * key, collecting entries for batches nothing can re-derive any more
 * (a hand-edited or deleted `log.json`).
 */
export const PENDING_HISTORY_STORAGE_KEY = 'pendingHistoryFiles';

/**
 * Identity of a flush batch, stable across the capture that retries
 * it: the count plus the first and last record. The retry re-derives
 * the batch from the same `log.json`, and `uniqueTimestamp` keeps our
 * record timestamps distinct, so those three can't match two different
 * batches in a log we wrote.
 *
 * A hand-edited log can defeat it — swapping a record in the middle
 * keys the same — but then the retry overwrites the orphan with what
 * the log now says, which is what disk authority wants anyway.
 *
 * `serializeRecord`, not `JSON.stringify`: a record read back from a
 * file the user (or a script) has edited can carry its keys in any
 * order, and only canonical field order compares equal. Ends only,
 * because the key is stored and 50 whole records per pending batch is
 * a lot to spend on this.
 */
function batchKey(batch: CaptureRecord[]): string {
  // Never empty: the drain only runs while the log is over its cap,
  // and `batchSize` is floored at 1.
  return [
    batch.length,
    serializeRecord(batch[0]),
    serializeRecord(batch[batch.length - 1]),
  ].join('\n');
}

/**
 * How far ahead of the clock an existing stamp may be and still be
 * believed — a DST fall-back hour and ordinary skew, with room to
 * spare. Past it the file is treated as bogus and ignored; otherwise
 * one file written under a wildly wrong clock would drag every later
 * name forward with it, permanently.
 */
const STAMP_FLOOR_LOOKAHEAD_MS = 25 * 60 * 60 * 1000;

/**
 * Earliest instant a new history file may be stamped with, so names
 * stay in ascending order even when the clock doesn't. Fires on a DST
 * fall-back hour (`compactTimestamp` is local time, so that hour's
 * stamps repeat) and on a clock set backwards.
 *
 * Matters because `SeeWhatISee.py --limit` walks files from the newest
 * end and stops early: a name that sorts too low doesn't reorder the
 * output, it returns the wrong records. Costs no I/O — `used` already
 * holds every history file the drain could find.
 *
 * The price when it fires is a name ahead of the true write time.
 * Nothing reads the stamp back as a time; it sorts, and it is
 * recognizable in a directory listing.
 */
function stampFloor(used: Set<string>, now: number): number {
  let floor = now;
  for (const name of used) {
    const m = /^.*?(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.json$/.exec(name);
    if (!m) continue;
    const [, y, mo, d, h, min, s, ms] = m.map(Number);
    // Local time, matching `compactTimestamp`, so this round-trips the
    // stamp back to the instant that produced it.
    const t = new Date(y, mo - 1, d, h, min, s, ms).getTime();
    if (Number.isNaN(t)) continue;
    if (t >= floor && t - now <= STAMP_FLOOR_LOOKAHEAD_MS) floor = t + 1;
  }
  return floor;
}

/**
 * Name for a history file about to be written: `writtenAt`, which the
 * drain advances a millisecond per batch.
 *
 * Not a stamp from a record inside the file — record timestamps are
 * pinned when the capture is *taken*, so they aren't in append order,
 * and a batch can end on a record older than one in an earlier file.
 * Filename order has to be chronological; see `stampFloor`.
 *
 * **Never returns a name already in `used`** (the files on disk, plus
 * this drain's own), advancing a millisecond until it is free: every
 * write is `conflictAction: 'overwrite'`, so a collision would destroy
 * whichever batch landed first. Bumping the stamp rather than adding a
 * `-N` suffix keeps every name matching one pattern. It rarely fires —
 * `stampFloor` has already cleared every name the drain can see, so
 * what is left is two batches in the same millisecond.
 *
 * A retry normally takes its name from the pending map instead (see
 * `PENDING_HISTORY_STORAGE_KEY`), reaching here only when that map
 * couldn't be read or its entry was already collected.
 */
function historyFileName(writtenAt: Date, used: Set<string>): string {
  let d = writtenAt;
  let name = `${HISTORY_FILE_PREFIX}${compactTimestamp(d)}.json`;
  while (used.has(name)) {
    d = new Date(d.getTime() + 1);
    name = `${HISTORY_FILE_PREFIX}${compactTimestamp(d)}.json`;
  }
  used.add(name);
  return name;
}

/**
 * Render a slice of the log as the newline-delimited JSON both
 * `log.json` and the history files use — one `serializeRecord` per
 * line, trailing newline included.
 *
 * Used for the history files and for a `log.json` that a flush has to
 * rewrite; the steady-state append uses `appendLogLine` instead so the
 * file's existing bytes are kept. `parseLogText` is the matching
 * reader.
 *
 * An empty list renders as the empty string, not a bare newline.
 */
export function serializeLog(records: CaptureRecord[]): string {
  if (records.length === 0) return '';
  return records.map((r) => serializeRecord(r)).join('\n') + '\n';
}

/**
 * `text` (the file as it is) with `line` appended as the last line —
 * the newline-delimited layout `serializeLog` produces, reached
 * without touching what's already there. Supplies the newline a file
 * missing its terminator needs, so the new record can't run onto the
 * previous line and take it down with it.
 */
export function appendLogLine(text: string, line: string): string {
  if (text.length === 0) return `${line}\n`;
  return `${text.endsWith('\n') ? text : `${text}\n`}${line}\n`;
}

/**
 * Parse the newline-delimited JSON of a `log.json` / history file.
 *
 * Lenient on purpose: these files sit in the user's Downloads folder
 * where they can be edited, truncated mid-write, or concatenated. A
 * line that doesn't parse (or parses to something that isn't a record
 * object) is skipped rather than failing the whole file — losing one
 * row beats losing the rest of the history. Every reader does this,
 * the Python script and MCP server included, and the writer does too:
 * the steady-state append keeps such lines in place untouched, and a
 * flush drops them along with the records it moves out.
 */
export function parseLogText(text: string): CaptureRecord[] {
  const records: CaptureRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      // Valid JSON that isn't a record object — a bare string or an
      // array — is skipped the same way.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as CaptureRecord);
      }
    } catch {
      // Not JSON at all.
    }
  }
  return records;
}

/** The session note `recordCapture` leaves for the Copy-last-… entries. */
function lastCaptureFilesOf(record: CaptureRecord): LastCaptureFiles {
  const files: LastCaptureFiles = { timestamp: record.timestamp };
  if (record.screenshot) files.screenshot = record.screenshot.filename;
  if (record.contents) files.contents = record.contents.filename;
  if (record.selection) files.selection = record.selection.filename;
  return files;
}

/**
 * Drop records that are byte-for-byte repeats of one already in the
 * list, keeping the first occurrence. For *display* only — the log
 * files stay a faithful record of every save.
 *
 * `uniqueTimestamp` gives every save its own timestamp, so no two
 * records the log *writes* can collide here. What's left is one copy
 * of a record reaching the History page twice: the page merges
 * `log.json` with the history files, and a batch that reached a
 * history file while the service worker died before the matching
 * `log.json` trim sits in both.
 *
 * `serializeRecord` supplies the key, not `JSON.stringify`: two copies
 * of a record can carry their keys in different orders (one hand-edited
 * or script-written), and only a canonical field order compares equal.
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
 * Append a record to the capture log: read `log.json` back, move
 * whatever the append pushes past the cap into a history file, write
 * `log.json`, then note the capture's filenames in session storage.
 * Returns the `chrome.downloads` id of the `log.json` write, which the
 * tab-capture paths hand back to the Capture page (and tests resolve
 * to an on-disk path).
 *
 * The single write path for every capture — screenshot, HTML,
 * selection, URL-only — so the reconcile and flush rules can't
 * apply on some paths and not others.
 *
 * ## Reconcile
 *
 * `inspectLogFile` decides what we're appending *to*:
 *
 * - **contents** — the file's text. The steady-state case.
 * - **fresh** — the file is gone, so the log starts over at this
 *   capture. This is what stops a deleted log from being resurrected.
 *
 * ## The append is verbatim
 *
 * In the steady state the file is written back as it was, plus one
 * line. Its records are parsed — leniently, like every reader — only
 * to keep the new timestamp unique and to count them against the cap.
 * So a hand-edited row keeps its edit *and* its formatting, and a line
 * that isn't a record at all is left where it is: every reader skips
 * it, so nothing is lost by carrying it.
 *
 * The one write that re-serializes the file is a flush (below), which
 * has to drop records from it anyway. Lines that aren't records are
 * dropped there too — which is what every reader has already been
 * doing with them.
 *
 * ## Failures
 *
 * Anything that stops `log.json` being updated **throws
 * `LogWriteFailedError`** with a message saying what to do: the file
 * couldn't be read, or Chrome couldn't finish the write (a directory
 * in the way, a full disk). The record is dropped; its artifacts stay
 * on disk, unreferenced. History files flushed before it stay put
 * with their names still pinned, so the next capture's drain
 * overwrites rather than duplicates them.
 *
 * ## Ordering
 *
 * History files, then `log.json`, then the session note. Each step
 * waits for the one before it to land, so a worker killed midway
 * leaves the files consistent: a history file with no matching trim
 * is retried (see the pins), and the note is only ever set for a
 * record that reached the file.
 *
 * ## Flushing
 *
 * Once the log exceeds `LOG_MAX_ENTRIES` the oldest
 * `LOG_HISTORY_BATCH` records are written to their own
 * `history-<timestamp>.json` beside `log.json` and dropped from it.
 * `while`, not `if`, so a log that starts far over the cap (the cap
 * was lowered, or entries predate flushing) drains in batches instead
 * of one oversized file.
 *
 * **Order matters:** a record leaves `log.json` only *after* its
 * history file has been written. `kept` advances one batch at a time
 * and only once that batch is on disk, so records are never trimmed
 * out from under a write that didn't happen.
 *
 * **A failed history file write is not a failed capture.** The capture's
 * screenshot / HTML is already on disk by the time we're called, so
 * rejecting here would leave that file referenced by nothing and lose
 * the record entirely. Instead the flush is abandoned, every record
 * that hasn't moved — the new one included — stays in `log.json`
 * (appended verbatim, as if no flush had been due), and the next
 * capture retries. The log sits over its cap in the meantime, which
 * is the harmless failure. Records whose batch *did* land are already
 * trimmed, so nothing is written twice.
 *
 * Goes through `serializeWrite` itself, so callers don't have to: two
 * rapid captures would otherwise both read the file before either
 * wrote it, and the second would drop the first.
 *
 * **Edits `record.timestamp`** on the way in, via `uniqueTimestamp` —
 * a visible side effect on the caller's object, and deliberately so.
 */
export async function recordCapture(record: CaptureRecord): Promise<number> {
  return await serializeWrite(async () => {
    const state = await inspectLogFile();
    // What we're appending to: the file's text, or nothing if it's
    // gone. Parsed leniently — a line that isn't a record is skipped
    // here exactly as every reader skips it.
    const text = state.kind === 'contents' ? state.text : '';
    const base = parseLogText(text);
    uniqueTimestamp(record, base);
    // Never mutated in place: `kept` is reassigned per successful
    // batch, so an abandoned flush leaves a coherent list either way.
    let kept = [...base, record];
    // `LOG_HISTORY_BATCH` is a tunable now that it's exported, and a
    // zero would make the loop below spin forever on an empty batch.
    const batchSize = Math.max(1, LOG_HISTORY_BATCH);
    const now = Date.now();
    // Where this drain's history file names start. Normally `now`;
    // `stampFloor` pushes it later when the clock has gone backwards
    // since the newest file on disk.
    let mintFrom = now;
    let flushed = 0;
    const usedNames = new Set<string>();
    // Names pinned by an earlier capture whose flush wrote the file
    // but didn't get to finish. Empty in the steady state; see
    // `PENDING_HISTORY_STORAGE_KEY`.
    let pendingNames: Record<string, string> = {};
    // Seeded with the history files already on disk — the directory
    // listed over `file://`, the same index the History page uses, so
    // it sees every file present rather than only the ones Chrome
    // still has download records for. Only paid when a flush is
    // actually about to happen — once per batch, not once per capture.
    //
    // Its own try/catch, *outside* the write loop's: this listing is
    // only a collision guard, so failing it must not skip the drain.
    // Sharing the loop's catch would leave the log permanently over
    // its cap, with every later capture repeating the same failure and
    // `log.json` growing without bound.
    if (kept.length > LOG_MAX_ENTRIES) {
      try {
        // `fresh` has no file and never flushes (`kept` is one
        // record), so the directory is the one the file was read from.
        if (state.kind === 'contents') {
          for (const path of await listHistoryFiles(state.directory)) {
            usedNames.add(path.replace(/^.*[/\\]/, ''));
          }
        }
      } catch (err) {
        console.info('[SeeWhatISee] could not list existing history files; names unseeded:', err);
      }
      // Same "only a guard" reasoning as the listing above: without
      // it a retry writes a second copy of a batch, which is bad, but
      // skipping the drain is worse.
      try {
        const stash = await chrome.storage.local.get(PENDING_HISTORY_STORAGE_KEY);
        const value: unknown = stash[PENDING_HISTORY_STORAGE_KEY];
        // Shape-checked, not cast: a non-object here would make the
        // `pendingNames[key] = name` below throw inside the *drain's*
        // catch, abandoning the flush on this capture and identically
        // on every one after it.
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          pendingNames = value as Record<string, string>;
        }
      } catch (err) {
        console.info('[SeeWhatISee] could not read pending history file names:', err);
      }
      // Pins are off-limits to a fresh mint, same as the files on
      // disk: a pin is claimed only when its own batch comes up, so
      // without this an earlier batch could mint a later batch's
      // pinned name and be overwritten by it.
      for (const name of Object.values(pendingNames)) usedNames.add(name);
      // After both seedings, so it sees every name the drain knows of.
      mintFrom = stampFloor(usedNames, now);
    }
    // Batches whose file landed and whose records are about to leave
    // the log — their pins have done their job. A batch abandoned
    // mid-drain deliberately isn't here: it stays in the log, so the
    // retry must find the same name waiting.
    const settledKeys: string[] = [];
    // A clean drain drops the whole key, which also collects entries
    // for batches nothing can re-derive any more — those appear in no
    // `settledKeys` and would otherwise linger forever.
    let drainClean = true;
    try {
      while (kept.length > LOG_MAX_ENTRIES) {
        const batch = kept.slice(0, batchSize);
        const key = batchKey(batch);
        // A pinned name means this exact batch already had a file
        // written for it by a capture that didn't survive to trim it
        // out of the log. Reuse the name so the write overwrites that
        // orphan instead of duplicating it.
        let name = pendingNames[key];
        if (name === undefined) {
          // A millisecond per batch, so a multi-batch drain stays
          // ordered within itself.
          name = historyFileName(new Date(mintFrom + flushed), usedNames);
          pendingNames[key] = name;
          // Recorded *before* the write, so the name survives a crash
          // anywhere after the download begins.
          await chrome.storage.local.set({ [PENDING_HISTORY_STORAGE_KEY]: pendingNames });
        } else {
          usedNames.add(name);
        }
        flushed += 1;
        // **Awaited to completion, not just to the download starting.**
        // A record must not leave `log.json` before the history file
        // carrying it is on disk: `log.json` is written below and is
        // authoritative, so a service worker killed in between would
        // drop the whole batch. `chrome.downloads.download` resolves
        // the moment the write begins, so without this the ordering
        // would be nominal only — the same reason `log.json` waits.
        await writeJsonFileComplete(name, serializeLog(batch));
        kept = kept.slice(batchSize);
        settledKeys.push(key);
      }
    } catch (err) {
      // Expected-and-handled: the entries stay put and the next
      // capture retries, so this must not reach the chrome://extensions
      // Errors page. `kept` is reassigned only after a batch lands, so
      // an abandoned drain leaves a coherent list either way.
      drainClean = false;
      console.info('[SeeWhatISee] history file write failed; retrying next capture:', err);
    }
    // Verbatim append unless a batch actually landed — see "The append
    // is verbatim" above. `settledKeys`, not `flushed`: the latter
    // counts attempts (it spaces the names), and a flush whose first
    // write failed has moved nothing, so the file needs no rewriting.
    const body = settledKeys.length > 0
      ? serializeLog(kept)
      : appendLogLine(text, serializeRecord(record));
    // Awaited to completion, not just to the download *starting*.
    // **A write that doesn't land fails the capture** — see
    // "Failures" above.
    let downloadId: number;
    try {
      downloadId = await writeJsonFileComplete(LOG_FILE_NAME, body);
    } catch (err) {
      const reason = err instanceof ArtifactWriteError
        ? err.reason
        : err instanceof Error ? err.message : String(err);
      throw new LogWriteFailedError(`couldn't write log.json: ${reason}.`);
    }
    // The capture is in the log: say so. This is what the Copy-last-…
    // menu entries copy, and the History page's cue to re-read the
    // file. Best-effort — the log is written; a lost note costs a
    // stale menu entry and an open History tab its live update.
    try {
      await chrome.storage.session.set({ [LAST_CAPTURE_FILES_KEY]: lastCaptureFilesOf(record) });
    } catch (err) {
      console.info('[SeeWhatISee] could not note the last capture:', err);
    }
    // This write is now the one true `log.json` record, so the rows
    // every earlier capture left behind — all naming this same file —
    // can go.
    await pruneOldLogRecords(downloadId);
    // The trimmed log is on disk, so the batches in `settledKeys` are
    // gone for good and nothing can re-derive them — their pinned
    // names can go.
    //
    // Only reached once the file actually landed: an interrupted write
    // threw above, leaving the untrimmed log on disk — and disk is
    // authoritative, so the next capture re-derives the same batch,
    // which with the pins dropped would mint a second name for it.
    //
    // Swallowed: the cost is a stale entry, which the next clean drain
    // collects.
    if (settledKeys.length > 0) {
      try {
        if (drainClean) {
          await chrome.storage.local.remove(PENDING_HISTORY_STORAGE_KEY);
        } else {
          for (const key of settledKeys) delete pendingNames[key];
          await chrome.storage.local.set({ [PENDING_HISTORY_STORAGE_KEY]: pendingNames });
        }
      } catch (err) {
        console.info('[SeeWhatISee] could not clear pending history file names:', err);
      }
    }
    return downloadId;
  });
}

/**
 * Write a JSON log file — `log.json` or a `history-*.json` — to the
 * download dir, overwriting any existing file, resolving only once the
 * bytes are on disk and throwing, with a message naming the file, if
 * they never get there (`downloadArtifactComplete`).
 *
 * `text` is the pre-formatted JSON to write (callers use
 * `serializeLog` for canonical key order). Returns the download id,
 * which tests resolve to an on-disk path.
 *
 * Every log write goes through here: the history-file writes, where
 * the next step (rewriting `log.json` without those records) must not
 * happen until the file carrying them has landed, and `log.json`
 * itself.
 */
async function writeJsonFileComplete(name: string, text: string): Promise<number> {
  return downloadArtifactComplete(
    name,
    `data:application/json;charset=utf-8,${encodeURIComponent(text)}`,
  );
}

/**
 * Stringify a CaptureRecord with a stable, explicit key order.
 *
 * A record can reach here in any key order — parsed back from a file
 * the user or a script edited, or built up field by field. To keep
 * log.json grep-friendly and diff-stable, we never just
 * `JSON.stringify(record)`; we rebuild a fresh object with keys in the
 * canonical order at the call site.
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
  // Records written before these fields existed surface here as
  // `undefined`; the truthiness check elides them the same way.
  if (r.url) ordered.url = r.url;
  if (r.title) ordered.title = r.title;
  // `imageUrl` closes the metadata block, after `url` / `title`. Emitted
  // independently of `screenshot` so the source-image URL survives
  // even when the user unchecks Save Screenshot in the Capture page.
  // Sitting after `title` keeps the per-record metadata block (page
  // URL, page title, source image URL) visually grouped at the end.
  if (r.imageUrl) ordered.imageUrl = r.imageUrl;
  // Last, after the metadata block: it says nothing about the capture,
  // only who should act on it. Emitted only when true, so an ordinary
  // capture's line is unchanged.
  if (r.skipInWatcher) ordered.skipInWatcher = true;
  return JSON.stringify(ordered, null, indent);
}

// Simple in-memory mutex: every log write goes through this promise
// chain so a second captureVisible() call started before the first
// finishes its read-modify-write of `log.json` can't lose entries. The chain is reset if
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
 * maintained there rather than across the history files, and a
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
