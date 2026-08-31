// Unit tests for `src/capture/watch-status.ts` — reading the status
// file a running watch script publishes.
//
// The rule under test is "only show a Stop button for a watcher we
// believe is there": anything we can't read, can't parse, or whose
// heartbeat has gone quiet reads as no watcher at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const DIR = '/home/user/Downloads/SeeWhatISee';
const NOW = Date.parse('2026-08-30T12:00:00Z');

/** Toggles for the two things `readWatchStatus` checks before reading. */
let fileAccess = true;
let storedDir = DIR;
/** URL passed to the last stubbed `fetch` call. */
let fetchedUrl = null;
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

/** Stub `fetch` with a file:// response holding `text`. */
function stubFetch(text, ok = true) {
  globalThis.fetch = async (url) => {
    fetchedUrl = url;
    return { ok, status: ok ? 200 : 404, text: async () => text };
  };
}

/**
 * A status file whose heartbeat is `ageMs` old, measured from `from`.
 * The `readWatchStatus` tests pass the real clock, since they go
 * through the module's own freshness check rather than supplying a
 * `now` of their own.
 */
function statusJson(ageMs, extra = {}, from = NOW) {
  return JSON.stringify({
    pid: 4242,
    started: '2026-08-30T11:00:00Z',
    heartbeat: new Date(from - ageMs).toISOString(),
    ...extra,
  });
}

/** A status file that is fresh right now. */
function liveStatusJson() {
  return statusJson(1_000, {}, Date.now());
}

const { parseWatchStatus, readWatchStatus, requestWatchStop } =
  await import('../../dist/capture/watch-status.js');

test('parses a status file with a fresh heartbeat', () => {
  assert.deepEqual(parseWatchStatus(statusJson(5_000), NOW), {
    pid: 4242,
    started: '2026-08-30T11:00:00Z',
  });
});

test('a heartbeat that has gone quiet reads as no watcher', () => {
  // 90s is the cutoff: three missed 30s beats.
  assert.notEqual(parseWatchStatus(statusJson(89_000), NOW), null);
  assert.equal(parseWatchStatus(statusJson(91_000), NOW), null);
});

test('a missing or unparseable heartbeat reads as no watcher', () => {
  assert.equal(
    parseWatchStatus(JSON.stringify({ pid: 1, started: 'x' }), NOW),
    null,
  );
  assert.equal(parseWatchStatus(statusJson(0, { heartbeat: 'soon' }), NOW), null);
});

test('rejects contents that are not the shape we wrote', () => {
  assert.equal(parseWatchStatus('', NOW), null);
  assert.equal(parseWatchStatus('not json', NOW), null);
  assert.equal(parseWatchStatus('null', NOW), null);
  assert.equal(parseWatchStatus('[]', NOW), null);
  // A partial file caught mid-write, before the rename lands.
  assert.equal(parseWatchStatus('{"pid": 42, "star', NOW), null);
  assert.equal(parseWatchStatus(statusJson(0, { pid: '4242' }), NOW), null);
});

test('reads the status file from the capture directory', async () => {
  stubFetch(liveStatusJson());
  const status = await readWatchStatus();
  assert.equal(fetchedUrl, `file://${DIR}/.watch-status.json`);
  assert.equal(status?.pid, 4242);
});

test('a missing status file is no watcher, not an error', async () => {
  stubFetch('', false);
  assert.equal(await readWatchStatus(), null);
});

test('never reads without file access or a known directory', async () => {
  stubFetch(liveStatusJson());
  fetchedUrl = null;
  fileAccess = false;
  assert.equal(await readWatchStatus(), null);
  fileAccess = true;
  storedDir = null;
  assert.equal(await readWatchStatus(), null);
  // Neither case may fall through to a probe write or a fetch.
  assert.equal(fetchedUrl, null);
  storedDir = DIR;
});

test('the stop request names the watcher it is aimed at', async () => {
  let requested = null;
  chrome.downloads.download = async (opts) => { requested = opts; return 7; };
  await requestWatchStop({ pid: 4242, started: '2026-08-30T11:00:00Z' });
  assert.equal(requested.filename, 'SeeWhatISee/watch-stop.json');
  assert.equal(requested.conflictAction, 'overwrite');
  // The record tidy-up runs off the critical path, so give its
  // microtasks a turn before asserting on it.
  for (let i = 0; i < 20 && erased.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const body = JSON.parse(decodeURIComponent(requested.url.split(',')[1]));
  assert.equal(body.pid, 4242);
  assert.equal(body.started, '2026-08-30T11:00:00Z');
  assert.ok(Date.parse(body.requestedAt) > 0);
  // The request is a message to a script, not a download the user
  // wants to keep looking at.
  assert.deepEqual(erased, [7]);
});
