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
// in batches to `history-<timestamp>.json` history files beside
// `log.json`, so the full capture history survives on disk without
// any single write growing without bound. See "Flushing" below.
//
// Also home to `compactTimestamp` — the filename suffix every
// capture uses to stay unique on disk. Lives here because the log
// is the canonical record of when each capture happened.

import { type CaptureRecord } from './types.js';
import {
  HISTORY_FILE_PREFIX,
  LOG_FILE_NAME,
  downloadArtifact,
  getHistoryFilePaths,
  pruneOldLogRecords,
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
 * How many of the oldest entries are flushed to a history file each
 * time the log goes over `LOG_MAX_ENTRIES`.
 *
 * Half the cap, deliberately, rather than evicting one entry per
 * capture: a history file write is a whole extra file, so amortising it
 * over 50 captures keeps the steady-state cost of a capture at one
 * `log.json` rewrite. The visible consequence is that once the log has
 * filled, `log.json` (and the History page's in-storage view) holds
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
 * `serializeRecord`, not `JSON.stringify`: a record round-tripped
 * through `chrome.storage.local` can come back with its keys
 * reordered, and only canonical field order compares equal. Ends only,
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
 * Parse the newline-delimited JSON of a `log.json` / history file.
 *
 * Lenient on purpose: these files sit in the user's Downloads folder
 * where they can be edited, truncated mid-write, or concatenated. A
 * line that doesn't parse (or parses to something that isn't a record
 * object) is skipped rather than failing the whole file — losing one
 * row beats losing the rest of the history.
 */
export function parseLogText(text: string): CaptureRecord[] {
  return parseLogLines(text).records;
}

/**
 * `parseLogText`, plus a count of the lines it had to throw away.
 *
 * **Skipping a line is only safe for a reader.** The History page
 * displays what parsed and the lost row is merely absent; the
 * reconcile re-serializes what it parsed and writes it back over
 * `log.json`, which would delete the bad lines from the user's file
 * for good. So the reconcile checks this count and refuses to write
 * instead — principle 4 in `docs/log-consistency.md`: when we can't
 * account for what's in the file, we don't write it.
 */
export function parseLogLines(
  text: string,
): { records: CaptureRecord[]; skipped: number } {
  const records: CaptureRecord[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as CaptureRecord);
      } else {
        // Valid JSON, but not a record object — a bare string or an
        // array. Still a line we can't round-trip.
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

/**
 * Drop records that are byte-for-byte repeats of one already in the
 * list, keeping the first occurrence. For *display* only — the log
 * files stay a faithful record of every save.
 *
 * `uniqueTimestamp` gives every save its own timestamp, so no two
 * records the log *writes* can collide here. What's left is one copy
 * of a record reaching the History page twice: the page merges the
 * in-storage log with the history files, and a batch that reached a
 * history file while the service worker died before the matching storage
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
 * Leaves `log.json` and the `history-*.json` history files alone: they're
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
 * disk, move whatever the append pushes past the cap into a history
 * file, write `log.json`, then save the result to storage. Returns the
 * `chrome.downloads` id of the `log.json` write, which the tab-capture
 * paths hand back to the Capture page (and tests resolve to an on-disk
 * path).
 *
 * The single write path for every capture — screenshot, HTML,
 * selection, URL-only — so the reconcile and flush rules can't
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
 * anything is written: no history files, no `log.json`, no storage
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
 * History files, then `log.json`, then storage. Every step depends on the
 * one before it having landed, and biasing the crash window toward
 * *the file being ahead of storage* is what makes it recoverable: the
 * next reconcile reads the file and heals. The reverse order loses a
 * record whose artifacts are already written.
 *
 * ## Flushing
 *
 * Once the log exceeds `LOG_MAX_ENTRIES` the oldest
 * `LOG_HISTORY_BATCH` entries are written to their own
 * `history-<timestamp>.json` beside `log.json` and dropped from
 * storage. `while`, not `if`, so a log that starts far over the cap
 * (the cap was lowered, or entries predate flushing) drains in
 * batches instead of one oversized file.
 *
 * **Order matters:** an entry leaves storage only *after* its history
 * file has been written. `kept` advances one batch at a time and only
 * once that batch is on disk, so entries are never trimmed out from
 * under a write that didn't happen.
 *
 * **A failed history file write is not a failed capture.** The capture's
 * screenshot / HTML is already on disk by the time we're called, so
 * rejecting here would leave that file referenced by nothing and lose
 * the record entirely. Instead the flush is abandoned, every entry
 * that hasn't moved — the new record included — stays in storage, and
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
    // exactly what we handed it and there is nothing to move out.
    if (state.kind === 'written') {
      await chrome.storage.local.set({ [LOG_STORAGE_KEY]: [record] });
      return state.downloadId;
    }
    // What we're appending to. `stored` only wins in the steady state;
    // otherwise the file (or the absence of one) decides.
    let base: CaptureRecord[];
    if (state.kind === 'contents') {
      // Adopting the file means re-serializing it back over itself, so
      // a line we can't parse would be *deleted* from the user's file
      // rather than merely skipped the way a reader skips it. Refuse
      // instead — principle 4: when we can't account for what's in the
      // file, we don't write it. Overwrite is still offered for a user
      // who doesn't want the unreadable lines kept.
      const parsed = parseLogLines(state.text);
      if (parsed.skipped > 0) {
        throw new LogWriteBlockedError('corrupt-file', record, state.directory);
      }
      base = parsed.records;
    } else {
      base = state.kind === 'fresh' ? [] : stored;
    }
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
    // Seeded with the history files already on disk, so a flush can't land
    // on top of one. Only paid when a flush is actually about to
    // happen — once per 50 captures, not once per capture. History files
    // Chrome has lost track of (download history cleared) are
    // invisible here, which is the residual case noted in
    // `docs/log-consistency.md`.
    //
    // Its own try/catch, *outside* the write loop's: this listing is
    // only a collision guard, so failing it must not skip the drain.
    // Sharing the loop's catch would leave the log permanently over
    // its cap, with every later capture repeating the same failure and
    // `log.json` growing without bound.
    if (kept.length > LOG_MAX_ENTRIES) {
      try {
        for (const path of await getHistoryFilePaths()) {
          usedNames.add(path.replace(/^.*[/\\]/, ''));
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
    // File first, storage second — see "Ordering" above. Awaited to
    // completion, not just to the download *starting*, so the ordering
    // is real: `chrome.downloads.download` resolves the moment the
    // write begins, which would leave storage able to land first after
    // all.
    const downloadId = await writeJsonFile(LOG_FILE_NAME, serializeLog(kept));
    let logWritten = true;
    try {
      await waitForDownloadComplete(downloadId);
    } catch (err) {
      // The record still belongs in storage: its artifacts are on
      // disk, and the next capture reconciles against whatever the
      // file turned out to be.
      logWritten = false;
      console.info('[SeeWhatISee] log.json write did not complete:', err);
    }
    await chrome.storage.local.set({ [LOG_STORAGE_KEY]: kept });
    // This write is now the one true `log.json` record, so the rows
    // every earlier capture left behind — all naming this same file —
    // can go. Skipped when the write didn't land: then an older record
    // is still the newest one describing the file on disk.
    if (logWritten) await pruneOldLogRecords(downloadId);
    // The trimmed log is now both on disk and in storage, so the
    // batches in `settledKeys` are gone for good and nothing can
    // re-derive them — their pinned names can go.
    //
    // **Only once the file actually landed.** An interrupted write
    // leaves the untrimmed log on disk, and disk is authoritative, so
    // the next capture re-derives the same batch — which with the pins
    // dropped would mint a second name for it.
    //
    // Swallowed for the same reason: the cost is a stale entry, which
    // the next clean drain collects.
    if (logWritten && settledKeys.length > 0) {
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
 * download dir, overwriting any existing file.
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
 * `writeJsonFile`, but resolving only once the bytes are on disk —
 * and throwing if they never get there.
 *
 * `chrome.downloads.download` resolves when the download *starts*, so
 * anything that depends on the file actually existing has to wait for
 * the completion event too. Used by the history-file writes, where the
 * next step (rewriting `log.json` without those records) must not
 * happen until the file carrying them has landed.
 *
 * `log.json`'s own write doesn't use this: it needs the download id
 * even when the wait fails, because the record still belongs in
 * storage. See `recordCapture`.
 */
async function writeJsonFileComplete(name: string, text: string): Promise<number> {
  const downloadId = await writeJsonFile(name, text);
  await waitForDownloadComplete(downloadId);
  return downloadId;
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
