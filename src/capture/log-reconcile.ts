// Reconciling the on-disk `log.json` with the in-storage capture log.
//
// The rule this module implements: **disk is authoritative, and
// `chrome.storage.local` is a cache**. Before any capture overwrites
// `log.json`, we read what is actually on disk and let that decide
// what the log should be — so deleting or hand-editing the file is a
// supported gesture rather than something a later capture silently
// undoes.
//
// Reading needs the user's "Allow access to file URLs" toggle, which
// the extension requires (`file-access.ts`): every entry point checks
// it before getting here, so this module treats reads as available and
// only re-checks as a backstop.
//
// What we can and can't see:
//
//   - `fetch('file://…')` gives us the file's real current contents.
//   - The download record tells us the path, and whether the file
//     still `exists` — which is how a failed read is told apart from a
//     deleted file.
//
// When we can't tell what is on disk, we refuse to write and hand the
// decision to the user (`LogWriteBlockedError`) rather than
// clobbering. See `docs/log-consistency.md` for the full design.

import { type CaptureRecord } from './types.js';
import {
  type LogFileRecordLookup,
  canReadFiles,
  getLogFileRecord,
  parentDirectory,
  peekCaptureDirectory,
  probeCaptureDirectory,
  readLogText,
} from './downloads.js';
import { FileAccessRequiredError } from './file-access.js';

/** Why we declined to write `log.json`. */
export type LogSyncBlockedReason =
  /** The record says the file is there, but reading it failed. */
  | 'unreadable'
  /** We read it, but some of its lines aren't records we can rewrite. */
  | 'corrupt-file';

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
 * Thrown by `recordCapture` when the reconcile allowed the write but
 * Chrome couldn't complete it — the target is a directory, the disk is
 * full, and so on. Chrome's download bubble shows a bare "Something
 * went wrong"; this is what tells the user it was their capture log.
 *
 * Like `LogWriteBlockedError`, nothing is stored — but this isn't a
 * decision for the user to make, so it reports as a plain capture
 * failure rather than opening the Retry / Overwrite prompt: there is
 * nothing to overwrite *with*. The record is dropped with it; the
 * capture's files stay on disk, unreferenced.
 */
export class LogWriteFailedError extends Error {
  constructor(reason: string) {
    super(`Saved this capture's files, but couldn't write log.json: ${reason}.`);
    this.name = 'LogWriteFailedError';
  }
}

/** What the reconcile decided about the file on disk. */
export type LogFileState =
  /** We read it. Its contents replace the in-storage log. */
  | { kind: 'contents'; text: string; directory: string }
  /** No file. Start a new log from this capture. */
  | { kind: 'fresh' }
  /** We can't tell what's on disk — don't write; ask the user. */
  | { kind: 'blocked'; reason: LogSyncBlockedReason; directory?: string };

/**
 * Work out what `log.json` holds, so the caller knows what to append
 * to and whether it may write at all.
 *
 * 1. **Find the directory.** Reading needs a path, and the user's
 *    download directory isn't exposed by any API — so it comes from
 *    the `log.json` download record, the cached capture directory, or
 *    as a last resort a throwaway probe write. If even that fails, the
 *    capture fails: a probe that timed out says nothing about whether
 *    a log is there, and guessing "no" would overwrite one.
 * 2. **Read the file.** Its contents beat every inference we could
 *    make from a download record — that is what makes hand-deleted
 *    rows stay deleted.
 * 3. **A failed read** is either a deleted file (start fresh) or
 *    something in the way (block); the download record's re-checked
 *    `exists` tells the two apart.
 */
export async function inspectLogFile(): Promise<LogFileState> {
  // Backstop: every entry point has already checked, and flipping the
  // toggle restarts the extension, so this shouldn't fire — but a
  // `fetch` refused for lack of the toggle would otherwise read as a
  // deleted log and start a new one over the user's history.
  if (!(await canReadFiles())) throw new FileAccessRequiredError();
  const lookup = await getLogFileRecord();
  try {
    return await decideLogFileState(lookup);
  } finally {
    // Drops the `onChanged` listener whichever branch we left by.
    lookup.release();
  }
}

async function decideLogFileState(lookup: LogFileRecordLookup): Promise<LogFileState> {
  const record = lookup.record;
  // Swallow lookup failures: an unknown directory degrades to the
  // probe below, and must never fail the capture.
  let directory = record?.filename
    ? parentDirectory(record.filename)
    : await peekCaptureDirectory().catch(() => null);
  // Nothing knows where the files go — the first capture on a profile
  // with no download records, and one that wrote no files of its own.
  // Worth one throwaway write to find out. If even that fails we know
  // nothing, and a `log.json` write would most likely fail the same
  // way — so fail now, before deciding anything about the log
  // (principle 4: when we can't tell what's on disk, we don't write).
  if (!directory) directory = await probeCaptureDirectory();
  if (!directory) throw new LogWriteFailedError("couldn't find the capture directory");
  const text = await readLogText(directory);
  // Whether its lines are all round-trippable is checked by the
  // caller, which already parses this text — keeping the parser
  // dependency pointing log-store → log-reconcile, not both ways.
  if (text !== null) return { kind: 'contents', text, directory };
  // The read failed. If the file is really gone (or there is no
  // record), that *is* the answer: start fresh. Otherwise something we
  // can't explain is in the way. Worth confirming rather than trusting
  // the record's stale `exists` — prompting a user who simply deleted
  // their log would be a poor answer.
  if (!await lookup.confirmExists()) return { kind: 'fresh' };
  return { kind: 'blocked', reason: 'unreadable', directory };
}
