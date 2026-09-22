// Deleting one capture from the history: its files off disk, its
// record out of the log files. The one place the extension deletes
// anything the user didn't just ask it to write — see
// `docs/log-consistency.md` → "Deleting a capture".
//
// The order is files first, log second, on purpose. A record whose
// files are gone renders as `(deleted)` on the History page and is
// still there to be deleted again; a file whose record is gone is an
// orphan nothing will ever find. So a file that won't delete stops the
// whole thing before the log is touched.
//
// What happens to the record depends on which file holds it:
//
// - In `log.json` it becomes a **tombstone** — `{ timestamp, deleted }`
//   (`tombstoneRecord`). The timestamp is a cursor for watchers
//   (`--after`, the MCP `watch` tool), and a cursor that vanishes from
//   the log would strand every watcher holding it. Readers skip the
//   marker (`isTombstone`).
// - In a history file it is simply dropped: nothing cursors into a
//   history file. A history file left with nothing in it is deleted.
//   (A flush can later carry a `log.json` tombstone into a history
//   file; readers skip it there too.)
//
// Every log file is scanned, not just the one the page read the record
// from: the same record can sit in `log.json` *and* a history file (a
// flush whose trim never landed), and the History page's dedup would
// keep showing whichever copy survived.
//
// The files go whether or not another record names them. A
// reopened-but-unedited capture shares its screenshot with the record
// it came from; deleting either takes the file, and the other row
// shows it `(deleted)`. Deliberate: "delete this capture's files"
// means what it says, and a file quietly kept for a row the user
// can't see (one in an unloaded history file) would be the bigger
// surprise.

import { type CaptureRecord } from './types.js';
import {
  ArtifactWriteError,
  LOG_FILE_NAME,
  basename,
  downloadArtifactComplete,
  eraseDownloadRecord,
  historyFilesAmong,
  isLogFileName,
  joinCapturePath,
  listCaptureDirectory,
  peekCaptureDirectory,
  pruneOldLogRecords,
  readCaptureFileText,
} from './downloads.js';
import {
  parseLogLine,
  serializeRecord,
  serializeWrite,
  tombstoneRecord,
  writeJsonFileComplete,
} from './log-store.js';

/** What a deletion did, for the History page's tooltip / status. */
export interface DeleteOutcome {
  /** Capture files removed from disk (bare names). */
  removedFiles: string[];
}

/** One log file holding the record: its lines, and which are the record. */
interface FileHits {
  name: string;
  lines: string[];
  hits: Set<number>;
}

/**
 * A zero-byte body, for writing over a file we have no download record
 * for. `chrome.downloads.removeFile` deletes only files Chrome itself
 * downloaded and still has a record of; a capture file whose record
 * the user cleared (or that never had one — a Save-as write, a copied
 * profile) is out of its reach. Downloading nothing over the top gives
 * it a record to delete by. Untyped, so Chrome has no reason to second-
 * guess the extension in the filename we ask for.
 */
const EMPTY_FILE_DATA_URL = 'data:application/octet-stream;base64,';

/**
 * Delete `record` — the files it names, then the record itself — from
 * the capture history. Resolves with what was removed; rejects with a
 * message fit for the History page's row (shown after "Delete
 * failed: ").
 *
 * Runs inside `serializeWrite`, like every log write: a capture
 * landing mid-deletion would otherwise read the file this is about to
 * rewrite and put its own version back over ours.
 *
 * Nothing is written until every file that should go is gone, and the
 * listing (`listCaptureDirectory`, the filesystem's own answer)
 * confirms it — `removeFile` reports success against a stale record
 * too readily to be believed on its own.
 */
export async function deleteCapture(record: CaptureRecord): Promise<DeleteOutcome> {
  return await serializeWrite(async () => {
    const directory = await peekCaptureDirectory();
    if (directory === null) {
      throw new Error('no capture directory is known');
    }
    const key = serializeRecord(record);
    const onDisk = await listDirectory(directory);

    // Every log file, `log.json` first. Reading them all is what finds
    // a duplicated record.
    const logFiles = [
      ...(onDisk.has(LOG_FILE_NAME) ? [LOG_FILE_NAME] : []),
      ...historyFilesAmong(directory, onDisk).map(basename),
    ];
    const holders: FileHits[] = [];
    for (const name of logFiles) {
      const text = await readCaptureFileText(directory, name);
      if (text === null) {
        throw new Error(`${joinCapturePath(directory, name)}: could not be read`);
      }
      const lines = text.split('\n');
      const hits = new Set<number>();
      lines.forEach((line, i) => {
        const parsed = parseLogLine(line);
        if (parsed !== null && serializeRecord(parsed) === key) hits.add(i);
      });
      if (hits.size > 0) holders.push({ name, lines, hits });
    }
    if (holders.length === 0) {
      // The page is showing a record the files no longer hold — edited
      // or deleted out from under it. Reloading the page is the fix,
      // and there is nothing here to do.
      throw new Error('this capture is no longer in the log; reload the page');
    }

    // The files. `isLogFileName` and the separator check: the record
    // is data off disk, and a name it carries is followed only if it
    // is a bare capture filename — the rule `reopenCapture` applies
    // before reading one, for the same reasons.
    //
    // Two passes, with the filesystem asked in between. `removeFile`
    // resolves against a stale record too readily to be believed on
    // its own, so a file it "removed" is re-listed; one still there
    // goes to the overwrite route, which gives Chrome a record it can
    // act on. A final listing has the last word.
    const removedFiles: string[] = [];
    /** Download records to forget once the log no longer names the files. */
    const staleRecordIds: number[] = [];
    const toDelete = [...new Set(artifactNames(record).filter(isBareCaptureFileName))];
    for (const name of toDelete) {
      const records = await downloadRecordsFor(joinCapturePath(directory, name));
      staleRecordIds.push(...records.map((r) => r.id));
      // Already gone from disk (the page showed it `(deleted)`): only
      // the stale download records are left to tidy.
      if (!onDisk.has(name)) continue;
      await removeFileByRecords(records);
      removedFiles.push(name);
    }
    if (removedFiles.length > 0) {
      let present = await listDirectory(directory);
      for (const name of removedFiles) {
        if (!present.has(name)) continue;
        staleRecordIds.push(await removeFileByOverwrite(name, joinCapturePath(directory, name)));
      }
      present = await listDirectory(directory);
      const remaining = removedFiles.filter((name) => present.has(name));
      if (remaining.length > 0) {
        const paths = remaining.map((name) => joinCapturePath(directory, name));
        throw new Error(`${paths.join(', ')}: still on disk after deleting`);
      }
    }

    // The record. Files are rewritten line for line, so every other
    // line — records, hand edits, lines that aren't records — is kept
    // byte for byte, the same promise the append makes.
    for (const holder of holders) {
      if (holder.name === LOG_FILE_NAME) {
        const stone = serializeRecord(tombstoneRecord(record.timestamp));
        const lines = holder.lines.map((line, i) => (holder.hits.has(i) ? stone : line));
        const downloadId = await writeLogFile(LOG_FILE_NAME, lines.join('\n'));
        // This write is now the one `log.json` record, as after a capture.
        await pruneOldLogRecords(downloadId);
      } else {
        const lines = holder.lines.filter((_, i) => !holder.hits.has(i));
        if (lines.some((line) => parseLogLine(line) !== null)) {
          const downloadId = await writeLogFile(holder.name, lines.join('\n'));
          // Same tidy-up as `log.json`: one row per file in the
          // download list, not one per deletion.
          await pruneOldLogRecords(downloadId, holder.name);
        } else {
          // Nothing left in it worth a file. Deleted the way a capture
          // file is, and left alone if that fails: an empty history
          // file is harmless, and the record is already out of it.
          const path = joinCapturePath(directory, holder.name);
          try {
            const records = await downloadRecordsFor(path);
            await removeFileByRecords(records);
            const ids = records.map((r) => r.id);
            if ((await listDirectory(directory)).has(holder.name)) {
              ids.push(await removeFileByOverwrite(holder.name, path));
            }
            for (const id of ids) await eraseDownloadRecord(id);
          } catch (err) {
            console.info('[SeeWhatISee] could not delete the emptied history file:', err);
          }
        }
      }
    }

    // The files are gone and nothing names them; the download rows
    // that still describe them are the last trace. Best-effort, like
    // every record erase.
    for (const id of staleRecordIds) await eraseDownloadRecord(id);

    return { removedFiles };
  });
}

/**
 * The capture directory's listing, or a message the row can show.
 *
 * Every message thrown here follows the page's "Delete failed: "
 * prefix, in the shape `<path>: <reason>`. Full paths, as every file
 * failure message in the extension gives: the user fixes these
 * outside the extension, and the path is what they need for that.
 */
async function listDirectory(directory: string): Promise<Set<string>> {
  try {
    return await listCaptureDirectory(directory);
  } catch {
    throw new Error(`${directory}: the directory could not be listed`);
  }
}

/**
 * `writeJsonFileComplete`, with a failure reworded to follow the page's
 * prefix like every other message here ("<path>: <reason>").
 */
async function writeLogFile(name: string, text: string): Promise<number> {
  try {
    return await writeJsonFileComplete(name, text);
  } catch (err) {
    if (err instanceof ArtifactWriteError) {
      throw new Error(`${err.path}: ${writeReason(err.reason, 'rewrite')}`);
    }
    throw err;
  }
}

/**
 * An `ArtifactWriteError.reason` reworded for a delete. Those reasons
 * (`downloadFailureReason`, `downloads.ts`) say "download", which is
 * what a capture write is to Chrome but not what the user asked for
 * here; `what` names the write in the user's terms — the log
 * `rewrite`, or the `download-to-overwrite` that stands in for a
 * delete. The trailing period goes too: the failure lines are
 * `<path>: <reason>` fragments, not sentences.
 */
function writeReason(reason: string, what: 'rewrite' | 'download-to-overwrite'): string {
  return trimPeriod(reason)
    .replace(/^download failed/, `${what} failed`)
    .replace(/^the download did not finish/, `the ${what} did not finish`)
    // The "saved it to" reason carries a "(Is the folder writable?)"
    // aside after "instead"; `(.*)` keeps it.
    .replace(/^Chrome saved it to (.*?) instead(.*)$/, `the ${what} landed at $1 instead$2`)
    .replace(/^Chrome saved it as (.*?) instead(.*)$/, `the ${what} landed as $1 instead$2`);
}

/** `reason` without a trailing period, so it can end a fragment. */
function trimPeriod(reason: string): string {
  return reason.replace(/\.$/, '');
}

/** The bare filenames a record points at. */
function artifactNames(r: CaptureRecord): string[] {
  const names: string[] = [];
  for (const artifact of [r.screenshot, r.contents, r.selection]) {
    if (artifact && typeof artifact.filename === 'string' && artifact.filename) {
      names.push(artifact.filename);
    }
  }
  return names;
}

/** A filename we'll act on: a basename that isn't one of the log files. */
function isBareCaptureFileName(name: string): boolean {
  return !name.includes('/') && !name.includes('\\') && !isLogFileName(name);
}

/**
 * Chrome's completed download records for the file at `path`, ours or
 * not — whoever wrote it, the record is a handle `removeFile` accepts.
 * `filename` on a `DownloadQuery` is an exact match on the absolute
 * path, and `path` was built with the separator the records use.
 */
async function downloadRecordsFor(path: string): Promise<chrome.downloads.DownloadItem[]> {
  const items = await chrome.downloads.search({ filename: path });
  return items.filter((item) => item.state === 'complete');
}

/**
 * `chrome.downloads.removeFile` against each of `records` until one
 * resolves. Chrome will only delete what it has a record of, and a
 * record it no longer trusts for the path (it thinks the file is gone,
 * or the download didn't finish) rejects — so every failure is
 * swallowed here, and the caller asks the filesystem whether the file
 * actually went. Nothing to try is fine too: the overwrite route
 * follows.
 */
async function removeFileByRecords(records: chrome.downloads.DownloadItem[]): Promise<void> {
  for (const item of records) {
    try {
      await chrome.downloads.removeFile(item.id);
      return;
    } catch {
      // Try the next.
    }
  }
}

/**
 * Delete the file at `path` by downloading an empty file over it and
 * deleting *that*: a fresh record Chrome trusts. Returns the overwrite
 * download's id, which is stale the moment it resolves.
 *
 * The overwrite lands before the delete, so a `removeFile` that fails
 * here leaves a zero-byte file where the capture file was. Accepted:
 * the user asked for the file to go, and the record is left pointing
 * at it so a second click can finish the job.
 *
 * Throws when either step fails; the message names the path.
 */
async function removeFileByOverwrite(name: string, path: string): Promise<number> {
  let id: number;
  try {
    id = await downloadArtifactComplete(name, EMPTY_FILE_DATA_URL);
  } catch (err) {
    // `ArtifactWriteError` already names the path; only its reason is new.
    const reason = err instanceof ArtifactWriteError
      ? writeReason(err.reason, 'download-to-overwrite')
      : trimPeriod(err instanceof Error ? err.message : String(err));
    throw new Error(`${path}: ${reason}`);
  }
  try {
    await chrome.downloads.removeFile(id);
  } catch (err) {
    const reason = trimPeriod(err instanceof Error ? err.message : String(err));
    throw new Error(`${path}: removing the download-to-overwrite failed: ${reason}`);
  }
  return id;
}
