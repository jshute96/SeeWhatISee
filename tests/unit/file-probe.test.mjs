// Unit tests for the two helpers that answer "what is on disk" where
// the `file://` directory listing is denied — ChromeOS, see
// `docs/chrome-extension.md` → "Directory listings can be denied".
//
// `captureFileExists` probes one file. `historyFilesFromDownloads`
// enumerates the `history-*.json` files from our own download records
// and probes each; "Load older captures" and a delete's duplicate scan
// fall back to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const DIR = '/home/user/Downloads/SeeWhatISee';

/** Files the stubbed `fetch` will serve; everything else rejects. */
let onDisk = new Set();
/** Paths the stubbed `fetch` was asked for, in order. */
let fetched = [];
/** Whether each served body was cancelled. */
let cancelled = [];

globalThis.fetch = async (url) => {
  fetched.push(url);
  const path = decodeURIComponent(url.replace('file://', ''));
  if (path === DIR) {
    // A directory: Chrome serves its listing with `status: 0`.
    return { ok: false, status: 0, body: null, text: async () => '' };
  }
  // Missing and permission-denied look the same from JavaScript.
  if (!onDisk.has(path)) throw new TypeError('Failed to fetch');
  const i = cancelled.push(false) - 1;
  return { ok: true, status: 200, body: { cancel: async () => { cancelled[i] = true; } } };
};

/** Download records `chrome.downloads.search` will answer with. */
let records = [];
let searchQuery = null;
globalThis.chrome = {
  runtime: { id: 'test' },
  downloads: {
    search: async (query) => {
      searchQuery = query;
      if (records instanceof Error) throw records;
      return records;
    },
  },
};

/** One of our own download records for `path`. */
function ourRecord(path) {
  return { id: 1, filename: path, byExtensionId: 'test', state: 'complete' };
}

const { captureFileExists, historyFilesFromDownloads } =
  await import('../../dist/capture/downloads.js');

test.beforeEach(() => {
  onDisk = new Set();
  fetched = [];
  cancelled = [];
  records = [];
  searchQuery = null;
});

test('captureFileExists: a readable file is there, a missing one is not', async () => {
  onDisk.add(`${DIR}/log.json`);
  assert.equal(await captureFileExists(DIR, 'log.json'), true);
  assert.equal(await captureFileExists(DIR, 'gone.json'), false);
  assert.deepEqual(fetched, [`file://${DIR}/log.json`, `file://${DIR}/gone.json`]);
});

test('captureFileExists: the body is dropped, not read', async () => {
  // A screenshot is megabytes and nothing here wants the bytes.
  onDisk.add(`${DIR}/screenshot-20260101-120000-000.png`);
  await captureFileExists(DIR, 'screenshot-20260101-120000-000.png');
  assert.deepEqual(cancelled, [true]);
});

test('captureFileExists: a directory is not a file', async () => {
  // It resolves — with the generated listing as its body — so `ok` is
  // what keeps it from reading as a capture file that is still there.
  assert.equal(await captureFileExists(parentOf(DIR), basenameOf(DIR)), false);
});

function parentOf(path) { return path.slice(0, path.lastIndexOf('/')); }
function basenameOf(path) { return path.slice(path.lastIndexOf('/') + 1); }

test('history files come back newest first, and only the ones on disk', async () => {
  const older = `${DIR}/history-20260101-120000-000.json`;
  const newer = `${DIR}/history-20260302-080910-123.json`;
  const gone = `${DIR}/history-20260401-000000-000.json`;
  records = [ourRecord(older), ourRecord(gone), ourRecord(newer)];
  onDisk = new Set([older, newer]);
  assert.deepEqual(await historyFilesFromDownloads(DIR), [newer, older]);
});

test('records from another directory or another extension are ignored', async () => {
  // The user moved Chrome's download directory: the old records still
  // name their absolute paths, and those files are not this history.
  const moved = '/home/user/Old/SeeWhatISee/history-20260101-120000-000.json';
  const mine = `${DIR}/history-20260302-080910-123.json`;
  const theirs = { ...ourRecord(`${DIR}/history-20260201-000000-000.json`),
                   byExtensionId: 'someone-else' };
  records = [ourRecord(moved), theirs, ourRecord(mine)];
  onDisk = new Set([moved, mine, theirs.filename]);
  assert.deepEqual(await historyFilesFromDownloads(DIR), [mine]);
});

test('names that only look like history files are rejected', async () => {
  // Same rule as the listing path (`historyFilesAmong`) and the Python
  // backend: a fixed-width stamp, nothing else.
  const real = `${DIR}/history-20260302-080910-123.json`;
  const notes = `${DIR}/history-notes.json`;
  records = [ourRecord(notes), ourRecord(real)];
  onDisk = new Set([notes, real]);
  assert.deepEqual(await historyFilesFromDownloads(DIR), [real]);
});

test('a failed download search gives up quietly, with nothing to offer', async () => {
  records = new Error('downloads unavailable');
  assert.deepEqual(await historyFilesFromDownloads(DIR), []);
});

test('the search asks only for our own history files', async () => {
  await historyFilesFromDownloads(DIR);
  assert.match(searchQuery.filenameRegex, /history-/);
  assert.equal(searchQuery.orderBy?.[0], '-startTime');
});
