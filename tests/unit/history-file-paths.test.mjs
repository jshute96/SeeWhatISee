// Unit tests for `getHistoryFilePaths` — the `chrome.downloads`-record
// index of `history-*.json` files. It backs the flush's
// filename-collision guard and, with the file-access toggle off, is
// the History page's only way to know older captures exist (what keeps
// the Load-older button on screen as a pointer at the feature).
//
// `chrome.downloads.search` is stubbed. Chrome applies the
// `filenameRegex` itself, so the stub records the query and one test
// checks that regex against sample paths — the filtering the function
// *does* do (ours only, complete, still on disk, newest record per
// path) is what the rest assert.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'our-extension-id';
const DIR = '/home/u/Downloads/SeeWhatISee';

/** The query passed to the last stubbed `search` call. */
let searchQuery = null;

/** Install a `chrome.downloads.search` that returns `items`. */
function stubDownloads(items) {
  globalThis.chrome = {
    runtime: { id: EXT_ID },
    downloads: {
      search: async (query) => {
        searchQuery = query;
        return items;
      },
    },
  };
}

function item(overrides) {
  return {
    byExtensionId: EXT_ID,
    state: 'complete',
    exists: true,
    ...overrides,
  };
}

stubDownloads([]);
const { getHistoryFilePaths } = await import('../../dist/capture/downloads.js');

test('returns history file paths in the newest-first order Chrome gave', async () => {
  stubDownloads([
    item({ filename: `${DIR}/history-20260302-080910-123.json` }),
    item({ filename: `${DIR}/history-20260101-120000-000.json` }),
  ]);
  assert.deepEqual(await getHistoryFilePaths(), [
    `${DIR}/history-20260302-080910-123.json`,
    `${DIR}/history-20260101-120000-000.json`,
  ]);
});

test('skips records that are foreign, incomplete, or known deleted', async () => {
  stubDownloads([
    item({ filename: `${DIR}/history-20260401-000000-000.json`, byExtensionId: 'someone-else' }),
    item({ filename: `${DIR}/history-20260301-000000-000.json`, state: 'in_progress' }),
    item({ filename: `${DIR}/history-20260201-000000-000.json`, exists: false }),
    item({ filename: `${DIR}/history-20260101-000000-000.json` }),
    item({ filename: '' }),
  ]);
  assert.deepEqual(await getHistoryFilePaths(), [
    `${DIR}/history-20260101-000000-000.json`,
  ]);
});

test('keeps the newest record for a re-written path', async () => {
  // `conflictAction: 'overwrite'` (a retried flush) leaves several
  // records on one path; newest-first input, first seen wins.
  stubDownloads([
    item({ filename: `${DIR}/history-20260101-120000-000.json` }),
    item({ filename: `${DIR}/history-20260101-120000-000.json`, exists: false }),
  ]);
  assert.deepEqual(await getHistoryFilePaths(), [
    `${DIR}/history-20260101-120000-000.json`,
  ]);
});

test('asks Chrome for exactly the history-file pattern', async () => {
  stubDownloads([]);
  await getHistoryFilePaths();
  assert.deepEqual(searchQuery.orderBy, ['-startTime']);
  const re = new RegExp(searchQuery.filenameRegex);
  assert.ok(re.test(`${DIR}/history-20260101-120000-000.json`));
  assert.ok(re.test('C:\\Users\\u\\Downloads\\SeeWhatISee\\history-20260101-120000-000.json'));
  assert.ok(!re.test(`${DIR}/log.json`));
  assert.ok(!re.test(`${DIR}/history-x/nested.json`));
  assert.ok(!re.test(`${DIR}/history-20260101-120000-000.json.crdownload`));
});
