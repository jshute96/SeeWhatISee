// Unit tests for capture-directory discovery — the
// `chrome.storage.local` cache in front of the download-history
// lookup — and for the landing check on completed writes.
//
// The contract under test: `peekCaptureDirectory` never writes a file
// (cache → download history → null); every completed write that lands
// directly inside `SeeWhatISee/` refreshes the cache via
// `waitForDownloadComplete`; a write that lands anywhere else, or
// under another name, is reported as a failed write.

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
      download: async ({ filename, conflictAction }) => {
        const id = nextId++;
        downloadCalls.push({ filename, conflictAction });
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
  downloadArtifactComplete,
  downloadArtifactUniquely,
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

test('a complete write that lands under another name is a failed write', async () => {
  stubChrome();
  chrome.downloads.search = async (query) => {
    searchCalls.push(query);
    return [{ id: query.id, state: 'complete', filename: `${DIR}/shot (1).png` }];
  };
  await assert.rejects(
    downloadArtifactComplete('shot.png', 'data:,x'),
    /Couldn't write \/home\/user\/Downloads\/SeeWhatISee\/shot\.png: Chrome saved it as .*shot \(1\)\.png instead\.$/,
  );
});

test('a complete write that lands outside SeeWhatISee/ is a failed write', async () => {
  const store = stubChrome();
  // What Chrome does when the folder isn't writable: shows Save As and
  // lands the file in the Downloads root.
  chrome.downloads.search = async (query) => {
    searchCalls.push(query);
    return [{ id: query.id, state: 'complete', filename: '/home/user/Downloads/shot.png' }];
  };
  await assert.rejects(
    downloadArtifactComplete('shot.png', 'data:,x'),
    /Couldn't write Downloads\/SeeWhatISee\/shot\.png: Chrome saved it to \/home\/user\/Downloads\/shot\.png instead\. \(Is the SeeWhatISee folder writable\?\)$/,
  );
  await settle();
  assert.ok(!(CAPTURE_DIR_STORAGE_KEY in store));
});

test('a uniquify write reports where it landed and caches the directory', async () => {
  const store = stubChrome();
  const landed = await downloadArtifactUniquely('log.json', 'data:,x');
  assert.equal(downloadCalls.length, 1);
  assert.deepEqual(downloadCalls[0], { filename: 'SeeWhatISee/log.json', conflictAction: 'uniquify' });
  assert.equal(landed.path, `${DIR}/log.json`);
  await settle();
  assert.equal(store[CAPTURE_DIR_STORAGE_KEY], DIR);
});

test('a uniquify write deflected to a sibling name is still a landing', async () => {
  stubChrome();
  chrome.downloads.search = async (query) => {
    searchCalls.push(query);
    return [{ id: query.id, state: 'complete', filename: `${DIR}/log (1).json` }];
  };
  const landed = await downloadArtifactUniquely('log.json', 'data:,x');
  assert.equal(landed.path, `${DIR}/log (1).json`);
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
