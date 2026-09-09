// Unit tests for `src/capture/watch-status.ts` — reading the status
// file a watch script publishes.
//
// The rule under test is "only show a Stop button for a watch we
// believe is there": anything we can't read, can't parse, or whose
// lease has run out reads as no watch at all. A session between two
// runs of a single-shot loop is still a watch, lease and all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const DIR = '/home/user/Downloads/SeeWhatISee';
const NOW = Date.parse('2026-08-30T12:00:00Z');

/** Toggles for the two things `readWatchStatus` checks before reading. */
let fileAccess = true;
let storedDir = DIR;
/** URLs passed to the stubbed `fetch`, oldest first. */
let fetchedUrls = [];
/** Download ids passed to `chrome.downloads.erase`. */
const erased = [];

globalThis.chrome = {
  runtime: { id: 'test' },
  extension: { isAllowedFileSchemeAccess: async () => fileAccess },
  storage: {
    local: {
      get: async () => (storedDir ? { captureDirectory: storedDir } : {}),
      set: async () => {},
    },
  },
  downloads: {
    // Enough for `requestWatchStop`'s tidy-up: the write completes, and
    // its record is erased.
    search: async ({ id }) => [{ id, state: 'complete', filename: `${DIR}/watch-stop.json` }],
    erase: async (query) => { erased.push(query.id); },
  },
};

/**
 * Stub `fetch` with a file:// response holding `text`, and no stop
 * request beside it. `stopText` supplies one.
 */
function stubFetch(text, ok = true, stopText = null) {
  fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(url);
    const stop = url.endsWith('watch-stop.json');
    const body = stop ? stopText : text;
    const found = stop ? stopText !== null : ok;
    return { ok: found, status: found ? 200 : 404, text: async () => body };
  };
}

const SESSION = '2026-08-30T11:00:00.123456Z';

/**
 * A status file whose lease has `leaseMs` left, measured from `from`.
 * The `readWatchStatus` tests pass the real clock, since they go
 * through the module's own freshness check rather than supplying a
 * `now` of their own.
 */
function statusJson(leaseMs, extra = {}, from = NOW) {
  return JSON.stringify({
    sessionStarted: SESSION,
    pid: 4242,
    expires: new Date(from + leaseMs).toISOString(),
    ...extra,
  });
}

/** A status file that is live right now. */
function liveStatusJson() {
  return statusJson(60_000, {}, Date.now());
}

/** A stop request naming `session`. */
function stopJson(session = SESSION) {
  return JSON.stringify({ sessionStarted: session, requestedAt: '2026-08-30T12:05:00Z' });
}

const {
  parseWatchStatus,
  readPublishedSession,
  readWatchStatus,
  requestWatchStop,
} = await import('../../dist/capture/watch-status.js');

test('parses a status file whose lease is still running', () => {
  assert.deepEqual(parseWatchStatus(statusJson(5_000), NOW), {
    sessionStarted: SESSION,
    pid: 4242,
  });
});

test('a session between two runs is still a watch', () => {
  // The gap: no run in flight, a long lease, and the --after the next
  // run is expected to carry.
  const gap = statusJson(300_000, { pid: null, resumeAfter: '2026-08-30T11:59:00.000Z' });
  assert.deepEqual(parseWatchStatus(gap, NOW), {
    sessionStarted: SESSION,
    pid: null,
  });
});

test('a lease that has run out reads as no watch', () => {
  assert.notEqual(parseWatchStatus(statusJson(1_000), NOW), null);
  assert.equal(parseWatchStatus(statusJson(-1_000), NOW), null);
});

test('a missing or unparseable lease reads as no watch', () => {
  assert.equal(
    parseWatchStatus(JSON.stringify({ sessionStarted: SESSION, pid: 1 }), NOW),
    null,
  );
  assert.equal(parseWatchStatus(statusJson(0, { expires: 'soon' }), NOW), null);
});

test('rejects contents that are not the shape we wrote', () => {
  assert.equal(parseWatchStatus('', NOW), null);
  assert.equal(parseWatchStatus('not json', NOW), null);
  assert.equal(parseWatchStatus('null', NOW), null);
  assert.equal(parseWatchStatus('[]', NOW), null);
  // A partial file caught mid-write, before the rename lands.
  assert.equal(parseWatchStatus('{"sessionStarted": "x", "pi', NOW), null);
  assert.equal(parseWatchStatus(statusJson(5_000, { sessionStarted: 42 }), NOW), null);
});

test('reads the status file from the capture directory', async () => {
  stubFetch(liveStatusJson());
  const status = await readWatchStatus();
  assert.ok(fetchedUrls.includes(`file://${DIR}/.watch-status.json`));
  assert.equal(status?.pid, 4242);
  assert.equal(status?.sessionStarted, SESSION);
});

test('a pending stop request for this session reads as no watch', async () => {
  stubFetch(liveStatusJson(), true, stopJson());
  assert.equal(await readWatchStatus(), null);
  // The record itself is still there, which is what a stop in flight
  // polls for.
  assert.equal((await readPublishedSession())?.sessionStarted, SESSION);
});

test('a stop request for some other session is ignored', async () => {
  stubFetch(liveStatusJson(), true, stopJson('1999-01-01T00:00:00.000000Z'));
  assert.equal((await readWatchStatus())?.sessionStarted, SESSION);
});

test('a missing status file is no watcher, not an error', async () => {
  stubFetch('', false);
  assert.equal(await readWatchStatus(), null);
});

test('never reads without file access or a known directory', async () => {
  stubFetch(liveStatusJson());
  fetchedUrls = [];
  fileAccess = false;
  assert.equal(await readWatchStatus(), null);
  fileAccess = true;
  storedDir = null;
  assert.equal(await readWatchStatus(), null);
  // Neither case may fall through to a probe write or a fetch.
  assert.deepEqual(fetchedUrls, []);
  storedDir = DIR;
});

test('the stop request names the session it is aimed at', async () => {
  let requested = null;
  chrome.downloads.download = async (opts) => { requested = opts; return 7; };
  await requestWatchStop({ sessionStarted: SESSION, pid: 4242 });
  assert.equal(requested.filename, 'SeeWhatISee/watch-stop.json');
  assert.equal(requested.conflictAction, 'overwrite');
  // The record tidy-up runs off the critical path, so give its
  // microtasks a turn before asserting on it.
  for (let i = 0; i < 20 && erased.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const body = JSON.parse(decodeURIComponent(requested.url.split(',')[1]));
  assert.equal(body.pid, 4242);
  // Copied verbatim: re-parsing it into a Date would truncate the
  // microseconds the script writes, and the strings must match.
  assert.equal(body.sessionStarted, SESSION);
  assert.ok(Date.parse(body.requestedAt) > 0);
  // The request is a message to a script, not a download the user
  // wants to keep looking at.
  assert.deepEqual(erased, [7]);
});
