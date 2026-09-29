// Unit tests for the history index (`history-files.json`) and
// `findHistoryFiles`, which unions it with the directory listing or,
// where the listing is denied, with our download records.
//
// `fetch` serves the files in `onDisk` (plus the index text in
// `indexText`); everything else rejects, the way a missing file does
// over `file://`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const DIR = '/home/user/Downloads/SeeWhatISee';

/** Files the stubbed `fetch` will serve; everything else rejects. */
let onDisk = new Set();
/** Body of `history-files.json`, or `null` for no index. */
let indexText = null;
/** Download records `chrome.downloads.search` will answer with. */
let records = [];

globalThis.fetch = async (url) => {
  const path = decodeURIComponent(url.replace('file://', ''));
  if (path === `${DIR}/history-files.json` && indexText !== null) {
    return { ok: true, status: 200, text: async () => indexText, body: null };
  }
  if (!onDisk.has(path)) throw new TypeError('Failed to fetch');
  return { ok: true, status: 200, text: async () => '', body: { cancel: async () => {} } };
};

globalThis.chrome = {
  runtime: { id: 'test' },
  downloads: { search: async () => records },
};

const {
  findHistoryFiles, isHistoryIndexEntry, parseHistoryIndex, serializeHistoryIndex, isLogFileName,
  joinCapturePath, historyIndexEntryOf,
} = await import('../../dist/capture/downloads.js');

test.beforeEach(() => {
  onDisk = new Set();
  indexText = null;
  records = [];
});

test('index entries: relative .json paths, subdirectories allowed', () => {
  for (const ok of [
    'history-20260101-120000-000.json', 'old/history-x.json', 'mine.json', 'old/SeeWhatISee.json',
  ]) {
    assert.equal(isHistoryIndexEntry(ok), true, ok);
  }
  for (const bad of [
    '/etc/x.json', '../x.json', 'a/../x.json', './x.json', 'a//x.json', 'a\\x.json',
    'D:x.json', 'x.txt', 'log.json', 'Log.JSON', 'History-Files.json',
    'SeeWhatISee/x.json', 'a/seewhatisee/x.json', 'history-files.json', '', 3, null,
  ]) {
    assert.equal(isHistoryIndexEntry(bad), false, String(bad));
  }
});

test('parseHistoryIndex keeps the valid entries, once each', () => {
  assert.deepEqual(
    parseHistoryIndex('["a.json", "../b.json", 7, "a.json", "sub/c.json"]'),
    ['a.json', 'sub/c.json'],
  );
  // Malformed is `null`, not empty, so the flush can leave it alone.
  assert.equal(parseHistoryIndex('not json'), null);
  assert.equal(parseHistoryIndex('{"a": 1}'), null);
});

test('serializeHistoryIndex round-trips', () => {
  const entries = ['history-20260101-120000-000.json', 'sub/x.json'];
  assert.deepEqual(parseHistoryIndex(serializeHistoryIndex(entries)), entries);
});

test('a subdirectory entry joins with the directory\'s own separator, and back', () => {
  // Chrome's download records hold native paths, and a delete looks
  // one up by exact match, so a Windows path mustn't mix separators.
  const win = 'C:\\Users\\u\\Downloads\\SeeWhatISee';
  const path = joinCapturePath(win, 'old/history-x.json');
  assert.equal(path, `${win}\\old\\history-x.json`);
  assert.equal(historyIndexEntryOf(win, path), 'old/history-x.json');
  assert.equal(joinCapturePath(DIR, 'old/history-x.json'), `${DIR}/old/history-x.json`);
});

test('the index is a log file, never a capture file', () => {
  assert.equal(isLogFileName('history-files.json'), true);
});

test('with a listing: the listing plus the index, newest first by name', async () => {
  const listing = new Set(['history-20260101-120000-000.json', 'log.json', 'shot.png']);
  indexText = JSON.stringify([
    'history-20260101-120000-000.json', // also listed: once only
    'history-20260301-000000-000.json', // top level, not listed: gone
    'old/history-20260201-000000-000.json', // subdirectory: probed
    'old/history-20260202-000000-000.json', // subdirectory, missing
  ]);
  onDisk = new Set([`${DIR}/old/history-20260201-000000-000.json`]);
  assert.deepEqual(await findHistoryFiles(DIR, listing), [
    `${DIR}/old/history-20260201-000000-000.json`,
    `${DIR}/history-20260101-120000-000.json`,
  ]);
});

test('without a listing: the download records plus the index, each probed', async () => {
  // The case the index exists for: the user cleared download history,
  // so only the index still knows about the older file.
  const recorded = `${DIR}/history-20260301-000000-000.json`;
  const indexedOnly = `${DIR}/history-20260101-120000-000.json`;
  records = [{ id: 1, filename: recorded, byExtensionId: 'test', state: 'complete' }];
  indexText = JSON.stringify(['history-20260101-120000-000.json', 'history-20260201-000000-000.json']);
  onDisk = new Set([recorded, indexedOnly]);
  assert.deepEqual(await findHistoryFiles(DIR, null), [recorded, indexedOnly]);
});

test('no index is the same as an empty one', async () => {
  const listing = new Set(['history-20260101-120000-000.json']);
  assert.deepEqual(await findHistoryFiles(DIR, listing), [`${DIR}/history-20260101-120000-000.json`]);
});

test('an index already read is used instead of reading it again', async () => {
  indexText = JSON.stringify(['ignored.json']);
  onDisk = new Set([`${DIR}/given.json`, `${DIR}/ignored.json`]);
  assert.deepEqual(await findHistoryFiles(DIR, null, ['given.json']), [`${DIR}/given.json`]);
});
