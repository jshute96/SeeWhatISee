// Unit tests for `pruneOldLogRecords` — the tidy-up that keeps
// Chrome's download list to a single `log.json` row instead of one per
// capture, all naming the same rewritten file.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'our-extension-id';

/** Ids passed to `chrome.downloads.erase`. */
let erased = [];

/**
 * Stub `chrome.downloads` with `items` as the whole download list,
 * written newest first — the stub's own order stands in for the
 * `orderBy: ['-startTime']` the real search is asked for, which is
 * what tells the prune which records are older.
 *
 * The search stub applies the caller's own `filenameRegex`, so the
 * "is this one of ours" matching is exercised for real.
 */
function stubChrome(items, { eraseFails = false, searchFails = false } = {}) {
  erased = [];
  globalThis.chrome = {
    runtime: { id: EXT_ID },
    downloads: {
      search: async (query) => {
        if (searchFails) throw new Error('nope');
        const re = new RegExp(query.filenameRegex);
        return items.filter((item) => re.test(item.filename));
      },
      erase: async ({ id }) => {
        if (eraseFails) throw new Error('nope');
        erased.push(id);
      },
    },
  };
}

stubChrome([]);
const { pruneOldLogRecords } = await import('../../dist/capture/downloads.js');

/** A `log.json` download record with the given id. */
function logRecord(id, over = {}) {
  return {
    id,
    filename: '/home/user/Downloads/SeeWhatISee/log.json',
    byExtensionId: EXT_ID,
    state: 'complete',
    ...over,
  };
}

test('erases the log.json records older than the one being kept', async () => {
  stubChrome([logRecord(3), logRecord(2), logRecord(1)]);
  await pruneOldLogRecords(3);
  assert.deepEqual(erased.sort((a, b) => a - b), [1, 2]);
});

test('leaves other files and other extensions alone', async () => {
  stubChrome([
    logRecord(9),
    logRecord(1),
    logRecord(2, { byExtensionId: 'someone-else' }),
    logRecord(3, { filename: '/home/user/Downloads/SeeWhatISee/history-x.json' }),
    logRecord(4, { filename: '/home/user/Downloads/log.json' }),
    logRecord(5, { filename: '/home/user/Downloads/SeeWhatISee/shot.png' }),
  ]);
  await pruneOldLogRecords(9);
  assert.deepEqual(erased, [1]);
});

// A newer write — from another context, possibly still in flight — is
// what will describe the file next, so it outlives our own record.
test('leaves records newer than the kept one alone', async () => {
  stubChrome([logRecord(3, { state: 'in_progress' }), logRecord(2), logRecord(1)]);
  await pruneOldLogRecords(2);
  assert.deepEqual(erased, [1]);
});

// Without our own record there is no way to tell which of the rest
// predate it, so nothing is safe to erase.
test('prunes nothing when the kept record is gone', async () => {
  stubChrome([logRecord(1), logRecord(2)]);
  await pruneOldLogRecords(9);
  assert.deepEqual(erased, []);
});

// Cosmetic cleanup: a capture must never fail because the download
// list wouldn't cooperate. The erase failure is swallowed a level down
// in `eraseDownloadRecord`; a failing search is what the prune's own
// `try` is there for.
test('survives a failing erase', async () => {
  stubChrome([logRecord(2), logRecord(1)], { eraseFails: true });
  await pruneOldLogRecords(2);
  assert.deepEqual(erased, []);
});

test('survives a failing search', async () => {
  stubChrome([logRecord(2), logRecord(1)], { searchFails: true });
  await pruneOldLogRecords(2);
  assert.deepEqual(erased, []);
});
