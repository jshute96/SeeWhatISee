// The extension's half of the watch-script stop protocol.
//
// A `/see-what-i-see-watch` loop (`SeeWhatISee.py --watch
// --pid-lockfile`) publishes `.watch-status.json` in the capture
// directory while it runs, and exits when a `watch-stop.json` file
// appears beside it. This module reads the first and writes the
// second; the Capture page's UI on top of it lives in
// `src/capture-page/watch-status.ts`. See `docs/watch-protocol.md`.
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

/** Published by a running watcher; absent when none is running. */
export const WATCH_STATUS_FILE = '.watch-status.json';

/**
 * Written by us to ask the running watcher to exit.
 *
 * The only file in the protocol that isn't a dotfile, because
 * `chrome.downloads.download` — our only way to write one — rejects a
 * leading-dot filename outright ("Invalid filename").
 */
export const WATCH_STOP_FILE = 'watch-stop.json';

/**
 * How long a `heartbeat` may go quiet before we stop believing it.
 * The script refreshes it every 30s, so this is three missed beats —
 * long enough to ride out a busy machine, short enough that the files
 * a SIGKILLed watcher stranded don't advertise it for long.
 */
const HEARTBEAT_STALE_MS = 90_000;

/** What `.watch-status.json` says about the running watcher. */
export interface WatchStatus {
  pid: number;
  /** ISO 8601 (UTC) instant the watcher claimed the slot. */
  started: string;
}

/**
 * The running watcher, or `null` if there isn't one we can see.
 *
 * `null` folds together every "no" — file reads off, directory
 * unknown, no status file, unreadable or unparseable contents, a
 * heartbeat that has gone quiet — because the caller does the same
 * thing with all of them: show nothing.
 *
 * `peekCaptureDirectory` rather than `getCaptureDirectory`: this runs
 * on a timer, and a passive check must never write a probe file to
 * find out where to look.
 */
export async function readWatchStatus(): Promise<WatchStatus | null> {
  if (!(await canReadFiles())) return null;
  const directory = await peekCaptureDirectory();
  if (!directory) return null;
  const text = await readCaptureFileText(directory, WATCH_STATUS_FILE);
  return text === null ? null : parseWatchStatus(text, Date.now());
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
  const { pid, started, heartbeat } = data as Record<string, unknown>;
  if (typeof pid !== 'number' || typeof started !== 'string') return null;
  // An unparseable or missing heartbeat reads as stale, not as fresh:
  // the Stop button is only worth offering when we can tell someone is
  // still there to answer it.
  const beat = typeof heartbeat === 'string' ? Date.parse(heartbeat) : NaN;
  if (!(now - beat < HEARTBEAT_STALE_MS)) return null;
  return { pid, started };
}

/**
 * Ask the running watcher to exit, by downloading `watch-stop.json`
 * into the capture directory.
 *
 * The contents say which watcher we meant — the script ignores them
 * today (any stop request is for whoever is watching now, and it
 * clears requests that predate it), but a stale request is far easier
 * to explain when the file says what it was aimed at.
 */
export async function requestWatchStop(status: WatchStatus): Promise<void> {
  const payload = `${JSON.stringify({
    pid: status.pid,
    started: status.started,
    requestedAt: new Date().toISOString(),
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
