// Finding and reading the on-disk `log.json` before a capture appends
// to it.
//
// The rule this module implements: **the file is the log, and the
// only copy of it**. Before any capture overwrites `log.json`, we read
// what is actually on disk and append to that — so deleting or
// hand-editing the file is a supported gesture rather than something
// a later capture silently undoes.
//
// Reading needs the user's "Allow access to file URLs" toggle, which
// the extension requires (`file-access.ts`): every entry point checks
// it before getting here, so this module treats reads as available and
// only re-checks as a backstop.
//
// What we can and can't see:
//
//   - `fetch('file://…')` gives us the file's real current contents.
//   - Fetching the directory lists what is in it — which is how a
//     failed read is told apart from a deleted file.
//   - The download records only say *where* the directory is
//     (`peekCaptureDirectory`); nothing about the files is taken from
//     them.
//
// When we can't tell what is on disk, we refuse to write: the capture
// fails (`LogWriteFailedError`) with a message saying what to fix,
// rather than clobbering. See `docs/log-consistency.md`.

import {
  ArtifactWriteError,
  LOG_FILE_NAME,
  basename,
  canReadFiles,
  describeCaptureFile,
  discardDownload,
  downloadArtifactUniquely,
  joinCapturePath,
  jsonDataUrl,
  listCaptureDirectory,
  parentDirectory,
  peekCaptureDirectory,
  readLogText,
} from './downloads.js';
import { FileAccessRequiredError } from './file-access.js';

/**
 * Thrown by `recordCapture` when `log.json` couldn't be updated: the
 * file couldn't be read, no capture directory could be found, or
 * Chrome couldn't complete the write (the target is a directory, the
 * disk is full). Chrome's download
 * bubble shows a bare "Something went wrong" for the latter; this is
 * what tells the user it was their capture log, and what to do.
 *
 * A plain point-in-time failure: nothing is stored, the record is
 * dropped, and the capture's files stay on disk, unreferenced. Every
 * case is one the user resolves outside the extension (fix or delete
 * the file, free up disk), so there is no prompt — capturing again
 * afterwards is the retry. `problem` completes the sentence "Saved
 * this capture's files, but …".
 */
export class LogWriteFailedError extends Error {
  constructor(problem: string) {
    super(`Saved this capture's files, but ${problem}`);
    this.name = 'LogWriteFailedError';
  }
}

/** The problem when `log.json` at `path` needs fixing by hand. */
function unreadableLogProblem(path: string): string {
  return `couldn't read ${path}. Fix or delete the file, then capture again.`;
}

/** What the reconcile decided about the file on disk. */
export type LogFileState =
  /** We read it. Its text is what the capture appends to. */
  | { kind: 'contents'; text: string; directory: string }
  /** No file. Start a new log from this capture. */
  | { kind: 'fresh' }
  /**
   * Nothing knows where captures land, so the file can't be read.
   * The caller resolves this with `claimNewLog`.
   */
  | { kind: 'unknown-directory' };

/**
 * Work out what `log.json` holds, so the caller knows what to append
 * to and whether it may write at all.
 *
 * 1. **Find the directory.** Reading needs a path, and the user's
 *    download directory isn't exposed by any API — so it comes from
 *    the cached capture directory, else our download records
 *    (`peekCaptureDirectory`). When neither knows, the answer is
 *    `unknown-directory`: nothing can be read, and the caller learns
 *    the directory from its own write instead (`claimNewLog`).
 * 2. **Read the file.** Its contents are the log — that is what makes
 *    hand-deleted rows stay deleted.
 * 3. **A failed read** is either a deleted file (start fresh) or
 *    something in the way (fail, naming the file); listing the
 *    directory tells the two apart.
 */
export async function inspectLogFile(): Promise<LogFileState> {
  // Backstop: every entry point has already checked, and flipping the
  // toggle restarts the extension, so this shouldn't fire — but a
  // `fetch` refused for lack of the toggle would otherwise read as a
  // deleted log and start a new one over the user's history.
  if (!(await canReadFiles())) throw new FileAccessRequiredError();
  // Swallow lookup failures: an unknown directory is a state the
  // caller handles, and must never fail the capture by itself.
  const directory = await peekCaptureDirectory().catch(() => null);
  if (!directory) return { kind: 'unknown-directory' };
  const text = await readLogText(directory);
  // Not parsed here: the caller appends to the text as it is and only
  // parses for the timestamp check — keeping the parser dependency
  // pointing log-store → log-reconcile, not both ways.
  if (text !== null) return { kind: 'contents', text, directory };
  // The read failed. Ask the filesystem, not the download records:
  // `DownloadItem.exists` is never refreshed (see
  // `listCaptureDirectory`), so it would call a log deleted in a file
  // manager "still there" forever, failing every capture after it.
  if (!(await logFileListed(directory))) return { kind: 'fresh' };
  throw new LogWriteFailedError(unreadableLogProblem(joinCapturePath(directory, LOG_FILE_NAME)));
}

/**
 * Whether `log.json` is in the capture directory's listing. A
 * directory that can't be listed counts as not holding it: the
 * expected reason is that the user deleted the whole `SeeWhatISee/`
 * folder, the other supported way to start over. A folder that is
 * there but can't be listed while its log can't be read either is an
 * accepted blind spot (`docs/log-consistency.md` → Where the
 * principles bend); the toggle being off was ruled out above.
 */
async function logFileListed(directory: string): Promise<boolean> {
  try {
    return (await listCaptureDirectory(directory)).has(LOG_FILE_NAME);
  } catch {
    return false;
  }
}

/** What `claimNewLog` found out. */
export type ClaimedLog =
  /** No log existed: `line` is now the whole of `log.json`. */
  | { kind: 'written'; downloadId: number }
  /** A log was already there; this is what it holds. */
  | Extract<LogFileState, { kind: 'contents' }>;

/**
 * Start `log.json` when nothing knows where it would be — the first
 * capture on a profile with no download history, or one whose
 * history and extension storage have both been cleared.
 *
 * There is no API that says where downloads go, so the only way to
 * learn the directory is to write something. Rather than a throwaway
 * probe file, write the log itself, with `conflictAction: 'uniquify'`
 * so an existing file can't be clobbered:
 *
 * - It lands as `log.json` → there was no log. This capture is
 *   recorded and the directory is now cached (`waitForDownloadComplete`
 *   remembers it). One write, no cleanup.
 * - It lands as `log (1).json` → a log was there after all, and the
 *   landing path says where. The stray copy is deleted and the log is
 *   read from that directory. The caller appends to that text.
 *
 * `line` is the record as it would be appended, newline included. In
 * the second case its timestamp hasn't been checked against the
 * existing records yet, so the caller redoes that from the contents —
 * which is why the deflected copy is discarded rather than kept.
 *
 * A write that fails, or lands outside a `SeeWhatISee/` directory,
 * fails the capture (`LogWriteFailedError`): nothing was learned, and
 * guessing "no log" would overwrite one. So does a deflected write
 * whose log then can't be read: the deflection is proof a file is
 * there, so unlike a failed read in `inspectLogFile` this can't be a
 * deleted log — and overwriting it would lose it.
 */
export async function claimNewLog(line: string): Promise<ClaimedLog> {
  let landed: { id: number; path: string };
  try {
    landed = await downloadArtifactUniquely(LOG_FILE_NAME, jsonDataUrl(line));
  } catch (err) {
    throw new LogWriteFailedError(await logWriteProblem(err));
  }
  if (basename(landed.path) === LOG_FILE_NAME) {
    return { kind: 'written', downloadId: landed.id };
  }
  // Read from the path in hand rather than re-running
  // `peekCaptureDirectory`: that would depend on the cache write
  // `waitForDownloadComplete` fires off without awaiting, and on a
  // download record the discard below erases.
  const directory = parentDirectory(landed.path);
  const text = await readLogText(directory);
  await discardDownload(landed.id);
  if (text === null) {
    throw new LogWriteFailedError(unreadableLogProblem(joinCapturePath(directory, LOG_FILE_NAME)));
  }
  return { kind: 'contents', text, directory };
}

/**
 * The problem to report for a failed `log.json` write: the file by
 * its path and the download helper's own reason when it is one of its
 * errors (they're kept apart on it for exactly this), else whatever
 * the error says.
 */
export async function logWriteProblem(err: unknown): Promise<string> {
  if (err instanceof ArtifactWriteError) return `couldn't write ${err.path}: ${err.reason}`;
  const path = await describeCaptureFile(LOG_FILE_NAME);
  const reason = err instanceof Error ? err.message : String(err);
  return `couldn't write ${path}: ${reason}.`;
}
