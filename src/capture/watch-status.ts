// The extension's half of the watch-script stop protocol.
//
// A `/see-what-i-see-watch` loop (`SeeWhatISee.py --watch`) publishes
// `.watch-status.json` in the capture directory, and exits when a
// `watch-stop.json` file appears beside it. This module reads the first and writes the second; the Capture
// page's UI on top of it lives in `src/capture-page/watch-status.ts`.
// See `docs/watch-protocol.md`.
//
// The status file describes a watch *session*, not a process. A
// single-shot loop is a series of runs with gaps between them — the
// agent describing the capture it was just handed — and the session
// stays published across those gaps, leased. So there is no "is a
// process alive" question here: `expires` is the whole test.
//
// Two deliberate limits:
//
//   - **Reads only.** Detection is a `file://` fetch, so it needs
//     "Allow access to file URLs". Without it we report no watcher and
//     the Capture page shows nothing — better than a Stop button whose
//     effect we could never confirm.
//   - **No file is cleaned up from this side.** The extension can only
//     delete files it downloaded itself, and doesn't need to: the
//     watch script clears both files on exit, and clears a stale
//     `watch-stop.json` when the next watcher starts. (The stop
//     request's *download record* is erased — see `requestWatchStop`.)

import {
  canReadFiles,
  downloadArtifact,
  eraseDownloadRecord,
  peekCaptureDirectory,
  readCaptureFileText,
  waitForDownloadComplete,
} from './downloads.js';

/**
 * The watch session: published across the gaps between runs, and left
 * behind with a spent lease once the watch is over.
 */
export const WATCH_STATUS_FILE = '.watch-status.json';

/**
 * Written by us to ask the running watcher to exit.
 *
 * The only file in the protocol that isn't a dotfile, because
 * `chrome.downloads.download` — our only way to write one — rejects a
 * leading-dot filename outright ("Invalid filename").
 */
export const WATCH_STOP_FILE = 'watch-stop.json';

/** What `.watch-status.json` says about the watch session. */
export interface WatchStatus {
  /**
   * ISO 8601 (UTC) instant the session began — and its identity. Sent
   * back verbatim in a stop request, never re-parsed and re-serialized:
   * `Date` would truncate the microseconds the script writes.
   */
  sessionStarted: string;
  /** The run in flight, or `null` between two runs of a loop. */
  pid: number | null;
}

/**
 * The watch to show, or `null` if there isn't one we can see.
 *
 * `null` folds together every "no" — file reads off, directory
 * unknown, no status file, unreadable or unparseable contents, a lease
 * that has run out, a stop already requested — because the caller does
 * the same thing with all of them: show nothing.
 *
 * `peekCaptureDirectory` rather than `getCaptureDirectory`: this runs
 * whenever the page comes back to the front, and a passive check must
 * never write a probe file to find out where to look.
 */
export async function readWatchStatus(): Promise<WatchStatus | null> {
  const status = await readPublishedSession();
  if (status === null) return null;
  // A request naming this session means the watch is over, however
  // much of its lease is left: it is either being answered by the run
  // in flight, or waiting on disk for the next one. Either way there
  // is nothing left to offer a Stop button for.
  return (await readStopRequestSession()) === status.sessionStarted
    ? null
    : status;
}

/**
 * The session the status file publishes, ignoring any stop request.
 *
 * `readWatchStatus` is the question the UI asks ("is there a watch to
 * show?"); this is the narrower one a stop needs ("is the record still
 * there?"), where a request we just wrote must not count as an answer.
 */
export async function readPublishedSession(): Promise<WatchStatus | null> {
  if (!(await canReadFiles())) return null;
  const directory = await peekCaptureDirectory();
  if (!directory) return null;
  const text = await readCaptureFileText(directory, WATCH_STATUS_FILE);
  return text === null ? null : parseWatchStatus(text, Date.now());
}

/** The session a pending stop request names, or `null` if there is none. */
async function readStopRequestSession(): Promise<string | null> {
  const directory = await peekCaptureDirectory();
  if (!directory) return null;
  const text = await readCaptureFileText(directory, WATCH_STOP_FILE);
  if (text === null) return null;
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object') return null;
    const { sessionStarted } = data as Record<string, unknown>;
    return typeof sessionStarted === 'string' ? sessionStarted : null;
  } catch {
    return null;
  }
}

/**
 * Validate one status file's contents. Exported for tests, and split
 * out so the freshness rule is checkable without a filesystem.
 *
 * `now` is passed in rather than read, for the same reason.
 *
 * There is no version field: a file that omits one is version 0, the
 * shape below. If a later script grows a field worth branching on, it
 * can add a version then — until then, an unexpected shape is just a
 * file we don't understand and won't act on.
 */
export function parseWatchStatus(text: string, now: number): WatchStatus | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { sessionStarted, pid, expires } = data as Record<string, unknown>;
  if (typeof sessionStarted !== 'string') return null;
  // A lease we can't read has expired, not "hasn't yet": the Stop
  // button is only worth offering for a watch we believe is there.
  const deadline = typeof expires === 'string' ? Date.parse(expires) : NaN;
  if (!(deadline > now)) return null;
  // `pid` is absent between two runs of a single-shot loop. Anything
  // that isn't a number is that gap as far as we're concerned — we
  // only ever pass it back for diagnostics.
  return { sessionStarted, pid: typeof pid === 'number' ? pid : null };
}

/**
 * Ask a watch session to end, by downloading `watch-stop.json` into
 * the capture directory.
 *
 * `sessionStarted` is the part the script acts on: a run honors a
 * request naming the session it belongs to and deletes one naming any
 * other. That is what lets a click land while no run is in flight —
 * the next run of the session finds the request and stops on entry
 * instead of waiting for a capture.
 */
export async function requestWatchStop(status: WatchStatus): Promise<void> {
  const payload = `${JSON.stringify({
    sessionStarted: status.sessionStarted,
    requestedAt: new Date().toISOString(),
    pid: status.pid,
  })}\n`;
  const id = await downloadArtifact(
    WATCH_STOP_FILE,
    `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`,
  );
  // Take the row back out of Chrome's download list once it has
  // landed. This is a message to a script, not something the user
  // downloaded, and the watcher deletes the file moments later —
  // leaving a record behind only clutters the download bubble with an
  // entry whose file is already gone.
  //
  // Deliberately not awaited: purely cosmetic, and `waitForDownloadComplete`
  // has a 5s timeout of its own, which would otherwise be spent before
  // the caller even starts its own 5s wait for the watcher to exit.
  void (async () => {
    try {
      await waitForDownloadComplete(id);
      await eraseDownloadRecord(id);
    } catch (err) {
      console.info('[SeeWhatISee] could not tidy the stop request:', err);
    }
  })();
}
