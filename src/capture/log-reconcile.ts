// Reconciling the on-disk `log.json` with the in-storage capture log.
//
// The rule this module implements: **disk is authoritative, and
// `chrome.storage.local` is a cache**. Before any capture overwrites
// `log.json`, we work out what is actually on disk and let that decide
// what the log should be — so deleting or hand-editing the file is a
// supported gesture rather than something a later capture silently
// undoes.
//
// What we can and can't see:
//
//   - The download record tells us the path, whether the file still
//     `exists`, and how big it was **when we wrote it**.
//   - `fetch('file://…')` gives us the real current contents, but only
//     when the user has enabled "Allow access to file URLs".
//   - A `uniquify` probe write tells us whether *some* file occupies a
//     path, with no permission at all.
//   - Nothing tells us about a user edit that leaves the file in
//     place: Chrome re-checks `exists` but never re-stats size.
//
// When we can't tell what is on disk, we refuse to write and hand the
// decision to the user (`LogWriteBlockedError`) rather than
// clobbering. See `docs/log-consistency.md` for the full design.

import { type CaptureRecord } from './types.js';
import {
  LOG_FILE_NAME,
  getCaptureDirectory,
  getLogFileRecord,
  joinCapturePath,
  logRecordSize,
  parentDirectory,
  pathToFileUrl,
  probeCaptureDirectory,
  probeLogFile,
} from './downloads.js';

/** Why we declined to write `log.json`. */
export type LogSyncBlockedReason =
  /** A file occupies `log.json`, we have no record of it, and can't read it. */
  | 'unknown-file'
  /** The file is a different size than the log we last wrote. */
  | 'size-mismatch'
  /** The record says the file is there, but reading it failed. */
  | 'unreadable';

/**
 * Thrown by `recordCapture` when the reconcile can't account for what
 * `log.json` holds. Deliberately a plain point-in-time failure with no
 * stored state behind it: the capture's files are on disk, `record` is
 * carried on the error so a prompt can offer Retry / Overwrite right
 * then, and dismissing the prompt simply drops the record. Nothing is
 * remembered — a later capture re-detects the same condition on its
 * own if it still holds.
 */
export class LogWriteBlockedError extends Error {
  constructor(
    readonly reason: LogSyncBlockedReason,
    readonly record: CaptureRecord,
    readonly directory?: string,
  ) {
    super("Saved this capture's files, but couldn't update the capture log.");
    this.name = 'LogWriteBlockedError';
  }
}

/**
 * Whether `file://` reads are available. The toggle lives in
 * `chrome://extensions`, is off by default, and flipping it reloads
 * the extension — so this is a fresh answer every service-worker life.
 *
 * Guarded rather than called bare: `chrome.extension` is a legacy
 * namespace, and a missing method should degrade to the record-only
 * path instead of failing the capture.
 */
async function canReadFiles(): Promise<boolean> {
  try {
    if (typeof chrome.extension?.isAllowedFileSchemeAccess !== 'function') return false;
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

/**
 * Read `log.json` from `directory`, or `null` if we can't.
 *
 * A missing file resolves non-ok rather than rejecting, which would
 * otherwise read as a successful load of an empty log and quietly
 * discard the user's history — the same trap `loadArchives` guards
 * against on the History page.
 */
async function readLogFile(directory: string): Promise<string | null> {
  try {
    const res = await fetch(pathToFileUrl(joinCapturePath(directory, LOG_FILE_NAME)));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // Denied (toggle off) and missing are indistinguishable here; the
    // caller disambiguates with the download record.
    return null;
  }
}

/** What the reconcile decided about the file on disk. */
export type LogFileState =
  /** We read it. Its contents replace the in-storage log. */
  | { kind: 'contents'; text: string }
  /** No file (or an empty one). Start a new log from this capture. */
  | { kind: 'fresh' }
  /** The file matches the log we last wrote. Append to storage as usual. */
  | { kind: 'insync' }
  /** The existence probe already wrote the fresh payload. */
  | { kind: 'written'; downloadId: number }
  /** We can't tell what's on disk — don't write; ask the user. */
  | { kind: 'blocked'; reason: LogSyncBlockedReason; directory?: string };

/**
 * Work out what `log.json` holds, so the caller knows what to append
 * to and whether it may write at all.
 *
 * `expectedText` is what the file would contain if it still matched
 * the in-storage log; `freshPayload` is what a brand-new log should
 * contain (just the capture being recorded).
 *
 * The order of the checks is the whole design:
 *
 * 1. **Read the file if we possibly can.** Its contents beat every
 *    inference we could make from a download record — that is what
 *    makes hand-deleted rows stay deleted.
 * 2. **Probe for the directory** when reading is available but no
 *    record tells us where to read from. Upgrades case 3 to case 1.
 * 3. **Fall back to the record**, which can still distinguish "gone"
 *    and "unchanged since we wrote it" from "something happened here
 *    and we can't see what".
 * 4. **Probe for existence** when there is no record at all, since a
 *    first write must not clobber a file we've never seen.
 */
export async function inspectLogFile(opts: {
  expectedText: string;
  freshPayload: string;
}): Promise<LogFileState> {
  const record = await getLogFileRecord();
  let directory = record?.filename
    ? parentDirectory(record.filename)
    : await currentCaptureDirectory();

  if (await canReadFiles()) {
    // Reading is possible but we don't know where — worth one
    // throwaway write to find out, because it upgrades us to the
    // read path for this capture and every one after it.
    if (!directory) directory = await probeCaptureDirectory();
    if (directory) {
      const text = await readLogFile(directory);
      if (text !== null) return { kind: 'contents', text };
      // The read failed. If the record agrees the file is gone (or
      // there is no record), that *is* the answer: start fresh.
      // Otherwise something we can't explain is in the way.
      if (!record || record.exists === false) return { kind: 'fresh' };
      return { kind: 'blocked', reason: 'unreadable', directory };
    }
  }

  if (!record) {
    // No record and no read access: the only way to learn whether a
    // file is there is to try to write one that won't clobber it.
    try {
      const probe = await probeLogFile(opts.freshPayload);
      if (!probe.collided) return { kind: 'written', downloadId: probe.downloadId };
      return { kind: 'blocked', reason: 'unknown-file', directory: probe.directory };
    } catch (err) {
      // A probe that won't start or won't settle leaves us knowing
      // nothing, which is the same position as a collision — and a
      // failed reconcile must never fail the capture around it, whose
      // files are already on disk.
      console.info('[SeeWhatISee] log.json existence probe failed:', err);
      return { kind: 'blocked', reason: 'unknown-file', directory: directory ?? undefined };
    }
  }

  if (record.exists === false) return { kind: 'fresh' };
  const size = logRecordSize(record);
  // **Both sides of the comparison below are ours.** `size` is what we
  // wrote and Chrome never re-measures it; `expectedText` is what the
  // browser copy would serialize to. So this detects the *browser
  // copy* drifting — storage wiped by a reinstall, a write interrupted
  // half-way — and not anything done to the file. Without the read
  // permission the file's contents are simply unknowable, and only its
  // deletion (`exists`, re-checked on demand) is visible at all.
  //
  // Zero therefore means the last thing *we* wrote was an empty file
  // (the pre-reconcile "Clear log history" menu entry truncated
  // `log.json` to zero). Nothing in it to preserve, so the log starts
  // over.
  if (size === 0) return { kind: 'fresh' };
  if (size === utf8Length(opts.expectedText)) return { kind: 'insync' };
  return { kind: 'blocked', reason: 'size-mismatch', directory: directory ?? undefined };
}

/** `getCaptureDirectory`, as `null` rather than a throw. */
async function currentCaptureDirectory(): Promise<string | null> {
  try {
    return await getCaptureDirectory();
  } catch {
    return null;
  }
}

/**
 * Byte length of `text` as UTF-8 — what actually lands on disk, and
 * therefore what a download record's size is comparable to. String
 * `.length` counts UTF-16 units and would mis-compare any log holding
 * a non-ASCII page title.
 */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
