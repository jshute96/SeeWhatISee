// Unit tests for `getCaptureFileExistence` — the bare-filename →
// still-on-disk map behind the History page's "(deleted)" markers.
//
// The rules it implements are all about *not* labelling a live file
// deleted on weak evidence, so the interesting cases are the ones that
// must come back absent from the map (= unknown) rather than `false`.
//
// `chrome.downloads.search` is stubbed: the ordering it promises
// (`orderBy: ['-startTime']`) is part of the contract under test, so
// the fixtures are written newest-first the way Chrome would return
// them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'our-extension-id';

/** Install a `chrome.downloads.search` that returns `items`. */
function stubDownloads(items) {
  globalThis.chrome = {
    runtime: { id: EXT_ID },
    downloads: { search: async () => items },
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

// Imported after the stub exists only to be safe about module-eval
// order; the module itself touches `chrome` lazily.
stubDownloads([]);
const { getCaptureFileExistence } = await import('../../dist/capture/downloads.js');

test('maps each capture file to its exists flag', async () => {
  stubDownloads([
    item({ filename: '/home/u/Downloads/SeeWhatISee/a.png', exists: true }),
    item({ filename: '/home/u/Downloads/SeeWhatISee/b.html', exists: false }),
  ]);
  const map = await getCaptureFileExistence();
  assert.equal(map.get('a.png'), true);
  assert.equal(map.get('b.html'), false);
});

test('newest record wins for a re-saved (overwritten) filename', async () => {
  // `conflictAction: 'overwrite'` leaves several records on one path.
  // Newest-first input, so the first one seen is the live one.
  stubDownloads([
    item({ filename: '/d/SeeWhatISee/shot.png', exists: true }),
    item({ filename: '/d/SeeWhatISee/shot.png', exists: false }),
  ]);
  const map = await getCaptureFileExistence();
  assert.equal(map.get('shot.png'), true);
});

test('an in-progress newest record leaves the name unknown, not deleted', async () => {
  // The regression this guards: an in-flight download reports
  // `exists: false`, and skipping it must not hand the answer to the
  // older record — that would flag a file being written right now.
  stubDownloads([
    item({ filename: '/d/SeeWhatISee/shot.png', state: 'in_progress', exists: false }),
    item({ filename: '/d/SeeWhatISee/shot.png', exists: false }),
  ]);
  const map = await getCaptureFileExistence();
  assert.equal(map.has('shot.png'), false);
});

test('ignores records written by other extensions', async () => {
  stubDownloads([
    item({ filename: '/d/SeeWhatISee/theirs.png', byExtensionId: 'someone-else', exists: false }),
  ]);
  const map = await getCaptureFileExistence();
  assert.equal(map.has('theirs.png'), false);
});

test('ignores interrupted records and records with no filename', async () => {
  stubDownloads([
    item({ filename: '/d/SeeWhatISee/gone.png', state: 'interrupted', exists: false }),
    item({ filename: '', exists: false }),
  ]);
  const map = await getCaptureFileExistence();
  assert.equal(map.size, 0);
});

test('takes the basename from Windows paths too', async () => {
  stubDownloads([
    item({ filename: 'C:\\Users\\u\\Downloads\\SeeWhatISee\\shot.png', exists: false }),
  ]);
  const map = await getCaptureFileExistence();
  assert.equal(map.get('shot.png'), false);
});
