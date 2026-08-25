// Unit tests for capture-directory discovery — the
// `chrome.storage.local` cache in front of the download-history
// lookup, and the probe-download last resort.
//
// The contract under test: `peekCaptureDirectory` never writes a file
// (cache → download history → null), `getCaptureDirectory` may fall
// back to one throwaway probe download, and every completed write
// that lands directly inside `SeeWhatISee/` refreshes the cache via
// `waitForDownloadComplete`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'our-extension-id';
const DIR = '/home/user/Downloads/SeeWhatISee';

/** `chrome.downloads.download` calls made during the test. */
let downloadCalls = [];
/** `chrome.downloads.search` calls made during the test. */
let searchCalls = [];

/**
 * Install a `chrome` stub. `records` is what a filename-regex search
 * returns (newest first, the way Chrome orders it); downloads started
 * during the test land in `DIR` and resolve as complete.
 */
function stubChrome({ records = [] } = {}) {
  downloadCalls = [];
  searchCalls = [];
  const store = {};
  let nextId = 1;
  const created = new Map();
  globalThis.chrome = {
    runtime: { id: EXT_ID },
    storage: {
      local: {
        get: async (key) => (key in store ? { [key]: store[key] } : {}),
        set: async (obj) => Object.assign(store, obj),
      },
    },
    downloads: {
      download: async ({ filename }) => {
        const id = nextId++;
        downloadCalls.push(filename);
        created.set(id, `${DIR}/${filename.replace(/^.*\//, '')}`);
        return id;
      },
      search: async (query) => {
        searchCalls.push(query);
        if (query.id !== undefined) {
          const filename = created.get(query.id);
          return filename ? [{ id: query.id, state: 'complete', filename }] : [];
        }
        return records;
      },
      removeFile: async () => {},
      erase: async () => {},
    },
  };
  return store;
}

function record(filename) {
  return { byExtensionId: EXT_ID, state: 'complete', filename };
}

stubChrome();
const {
  CAPTURE_DIR_STORAGE_KEY,
  getCaptureDirectory,
  peekCaptureDirectory,
  waitForDownloadComplete,
} = await import('../../dist/capture/downloads.js');

/** Storage writes are fire-and-forget; let them settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test('peek answers from the storage cache without searching', async () => {
  const store = stubChrome();
  store[CAPTURE_DIR_STORAGE_KEY] = DIR;
  assert.equal(await peekCaptureDirectory(), DIR);
  assert.equal(searchCalls.length, 0);
});

test('peek derives from download history and caches the answer', async () => {
  const store = stubChrome({ records: [record(`${DIR}/shot.png`)] });
  assert.equal(await peekCaptureDirectory(), DIR);
  await settle();
  assert.equal(store[CAPTURE_DIR_STORAGE_KEY], DIR);
});

test('peek skips another extension’s records and never writes a file', async () => {
  const foreign = { ...record(`${DIR}/theirs.png`), byExtensionId: 'someone-else' };
  const store = stubChrome({ records: [foreign] });
  assert.equal(await peekCaptureDirectory(), null);
  assert.equal(downloadCalls.length, 0);
  await settle();
  assert.ok(!(CAPTURE_DIR_STORAGE_KEY in store));
});

test('get falls back to a probe download and caches its landing spot', async () => {
  const store = stubChrome();
  assert.equal(await getCaptureDirectory(), DIR);
  // One throwaway write, into our subdirectory, under the probe name
  // that nothing else matches.
  assert.equal(downloadCalls.length, 1);
  assert.match(downloadCalls[0], /^SeeWhatISee\/probe-.*\.json$/);
  await settle();
  assert.equal(store[CAPTURE_DIR_STORAGE_KEY], DIR);
});

test('get throws when nothing is known and the probe cannot run', async () => {
  stubChrome();
  chrome.downloads.download = async () => {
    throw new Error('downloads blocked');
  };
  await assert.rejects(getCaptureDirectory(), /Could not locate/);
});

test('get prefers the cache and skips the probe', async () => {
  const store = stubChrome();
  store[CAPTURE_DIR_STORAGE_KEY] = DIR;
  assert.equal(await getCaptureDirectory(), DIR);
  assert.equal(downloadCalls.length, 0);
});

test('a completed write inside SeeWhatISee/ refreshes the cache', async () => {
  const store = stubChrome();
  const id = await chrome.downloads.download({ filename: 'SeeWhatISee/shot.png' });
  await waitForDownloadComplete(id);
  await settle();
  assert.equal(store[CAPTURE_DIR_STORAGE_KEY], DIR);
});

test('a completed write elsewhere (Save-as) leaves the cache alone', async () => {
  const store = stubChrome();
  const id = await chrome.downloads.download({ filename: 'elsewhere/shot.png' });
  // The stub lands everything in DIR; hand it a foreign path instead.
  chrome.downloads.search = async (query) => {
    searchCalls.push(query);
    return [{ id, state: 'complete', filename: '/home/user/Desktop/shot.png' }];
  };
  await waitForDownloadComplete(id);
  await settle();
  assert.ok(!(CAPTURE_DIR_STORAGE_KEY in store));
});
