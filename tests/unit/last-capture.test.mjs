// Unit tests for `src/background/last-capture.ts`.
//
// Focus is the round-trip contract: anything on a `DetailsSession`
// that isn't on `LAST_CAPTURE_EXCLUDED_KEYS` must survive a
// promote → setLastCapture → getLastCapture cycle byte-for-byte. The
// denylist refactor inverted the propagation from "explicitly copy
// each carried field" to "spread the whole session and drop the
// denylisted keys" — these tests pin the new semantics so a future
// `DetailsSession` field doesn't silently fall out of the slot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAST_CAPTURE_STORAGE_KEY,
  LAST_CAPTURE_EXCLUDED_KEYS,
  getLastCapture,
  setLastCapture,
  clearLastCapture,
  clearLastCaptureForQuota,
  promoteSessionToLastCapture,
} from '../../dist/background/last-capture.js';
import { detailsStorageKey } from '../../dist/background/capture-details.js';

/**
 * Install a minimal `chrome.storage.session` stub on `globalThis`
 * for the duration of one test. Backed by a plain object so a test
 * can drive `get` / `set` / `remove` deterministically and read the
 * resulting record back.
 *
 * `failSet` makes every `set` reject — used to verify the
 * promote-time quota-rejection swallow.
 */
function installSessionStub({ initial = {}, failSet = false } = {}) {
  const store = { ...initial };
  const stub = {
    get: async (key) => {
      if (typeof key === 'string') {
        return key in store ? { [key]: store[key] } : {};
      }
      return { ...store };
    },
    set: async (entries) => {
      if (failSet) throw new Error('stubbed quota rejection');
      Object.assign(store, entries);
    },
    remove: async (key) => {
      delete store[key];
    },
  };
  globalThis.chrome = { storage: { session: stub } };
  return {
    store,
    restore: () => {
      delete globalThis.chrome;
    },
  };
}

/**
 * Build a fully-populated mock `DetailsSession`. Includes every
 * carry-relevant field plus the excluded ones, so a single round-
 * trip test can assert both halves of the denylist in one go.
 *
 * `screenshotFilename` is set to the already-bumped form on purpose:
 * the prior-session-after-save state that triggered the `…-3-4.png`
 * bug. `bases.screenshot` carries the original un-bumped name.
 */
function mockSession() {
  return {
    capture: {
      screenshotFilename: 'screenshot-20260517-193339-375-3.png',
      contentsFilename: 'contents-20260517-193339-375.html',
      selectionFilenames: { md: 'selection-20260517-193339-375.md' },
      screenshotPngBase64: 'AAAA',
      htmlBlob: '<html></html>',
      selectionByFormat: { md: 'hi' },
    },
    openerTabId: 42,
    downloads: {
      screenshot: { downloadId: 7, editVersion: 2, path: '/Downloads/file.png' },
    },
    htmlEdited: true,
    selectionEdited: { md: true },
    revisions: { html: 1, selection: { md: 2 } },
    saved: {
      screenshot: { bumpIndex: 3, revision: 4 },
    },
    bases: {
      screenshot: 'screenshot-20260517-193339-375.png',
      contents: 'contents-20260517-193339-375.html',
      selections: { md: 'selection-20260517-193339-375.md' },
    },
    uiState: {
      prompt: 'hello',
      saveCheckboxes: { screenshot: true, html: false, selection: true, format: 'md' },
      edits: [{ id: 1, kind: 'box' }],
      editHistory: [{ op: 'add', id: 1 }],
      nextEditId: 2,
      editVersion: 3,
      selectedTool: 'box',
      zoomMode: 'fit',
    },
  };
}

test('LAST_CAPTURE_EXCLUDED_KEYS pins the denylist to {openerTabId, downloads}', () => {
  // Pin both contents and order so an accidental addition to the
  // denylist (broader than intended) shows up here as a test
  // failure rather than as silent data loss across Restore. If
  // you're deliberately growing the denylist, update this assertion
  // and add a matching round-trip test below.
  assert.deepEqual([...LAST_CAPTURE_EXCLUDED_KEYS], ['openerTabId', 'downloads']);
});

test('promoteSessionToLastCapture: no session at the tab id → no slot written', async () => {
  const { store, restore } = installSessionStub();
  try {
    await promoteSessionToLastCapture(99);
    assert.equal(LAST_CAPTURE_STORAGE_KEY in store, false);
  } finally {
    restore();
  }
});

test('promoteSessionToLastCapture: round-trips every field except the denylist', async () => {
  const session = mockSession();
  const key = detailsStorageKey(1);
  const { store, restore } = installSessionStub({ initial: { [key]: session } });
  try {
    await promoteSessionToLastCapture(1);
    const stored = store[LAST_CAPTURE_STORAGE_KEY];
    assert.ok(stored, 'slot should be written');

    // Every excluded key is absent.
    for (const k of LAST_CAPTURE_EXCLUDED_KEYS) {
      assert.equal(k in stored, false, `${k} should be stripped`);
    }

    // Everything else round-trips byte-for-byte. Building the
    // expected shape via destructure keeps this test honest if
    // `mockSession` grows new fields later.
    const expected = { ...session };
    for (const k of LAST_CAPTURE_EXCLUDED_KEYS) delete expected[k];
    assert.deepEqual(stored, expected);
  } finally {
    restore();
  }
});

test('promoteSessionToLastCapture: carries bases (regression for the …-3-4.png bug)', async () => {
  // Pre-refactor, `bases` was missing from `LastCaptureRecord` so
  // promote silently dropped it. Restore then rebuilt `bases` from
  // the already-bumped `capture.screenshotFilename`, producing
  // `…-3-4.png` instead of `…-4.png` on the next save.
  const session = mockSession();
  const key = detailsStorageKey(1);
  const { store, restore } = installSessionStub({ initial: { [key]: session } });
  try {
    await promoteSessionToLastCapture(1);
    const stored = store[LAST_CAPTURE_STORAGE_KEY];
    assert.ok(stored.bases, 'bases must carry across promote');
    assert.equal(
      stored.bases.screenshot,
      'screenshot-20260517-193339-375.png',
      'bases.screenshot must remain the un-bumped name even when capture.screenshotFilename has been bump-mutated',
    );
    // And the bumped capture filename also survives — restore uses
    // it as the "next save's filename" until an edit forces a bump.
    assert.equal(
      stored.capture.screenshotFilename,
      'screenshot-20260517-193339-375-3.png',
    );
  } finally {
    restore();
  }
});

test('promoteSessionToLastCapture: auto-carries an unknown future DetailsSession field', async () => {
  // The whole point of the denylist refactor: a field added to
  // `DetailsSession` that isn't on the denylist should ride through
  // promote with zero code changes in this file. Simulate that by
  // including an extra key on the stored session and asserting it
  // round-trips.
  const session = { ...mockSession(), futureField: { nested: 'value' } };
  const key = detailsStorageKey(1);
  const { store, restore } = installSessionStub({ initial: { [key]: session } });
  try {
    await promoteSessionToLastCapture(1);
    const stored = store[LAST_CAPTURE_STORAGE_KEY];
    assert.deepEqual(stored.futureField, { nested: 'value' });
  } finally {
    restore();
  }
});

test('promoteSessionToLastCapture: swallows storage.set rejection', async () => {
  const session = mockSession();
  const key = detailsStorageKey(1);
  const { restore } = installSessionStub({
    initial: { [key]: session },
    failSet: true,
  });
  try {
    // Must not throw — the user's real on-disk save (when the close
    // came from the Capture button) already landed; a quota miss
    // here is a best-effort failure, not a user-visible one.
    await promoteSessionToLastCapture(1);
  } finally {
    restore();
  }
});

test('getLastCapture / setLastCapture / clearLastCapture: basic plumbing', async () => {
  const { store, restore } = installSessionStub();
  try {
    assert.equal(await getLastCapture(), undefined);

    const record = { capture: { foo: 1 } };
    await setLastCapture(record);
    assert.deepEqual(store[LAST_CAPTURE_STORAGE_KEY], record);
    assert.deepEqual(await getLastCapture(), record);

    await clearLastCapture();
    assert.equal(LAST_CAPTURE_STORAGE_KEY in store, false);
    assert.equal(await getLastCapture(), undefined);
  } finally {
    restore();
  }
});

test('clearLastCaptureForQuota: true when slot existed, false when empty', async () => {
  const { restore } = installSessionStub();
  try {
    // Nothing to free.
    assert.equal(await clearLastCaptureForQuota(), false);

    // After a write, freeing returns true and leaves the slot empty.
    await setLastCapture({ capture: { foo: 1 } });
    assert.equal(await clearLastCaptureForQuota(), true);
    assert.equal(await getLastCapture(), undefined);

    // And a follow-up call is back to the empty-slot case.
    assert.equal(await clearLastCaptureForQuota(), false);
  } finally {
    restore();
  }
});
