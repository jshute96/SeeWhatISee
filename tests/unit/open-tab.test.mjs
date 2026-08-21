// Unit tests for `src/background/open-tab.ts` — the shared tab
// placement helpers. They touch only `chrome.tabs.create` and
// `chrome.windows.get`, which a tiny global stub covers, so both test
// without loading the extension.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Installed before the dynamic import below so the module sees a
// `chrome` global at call time.
const calls = [];
let nextResult = () => ({ id: 1 });
let windowType = 'normal';
globalThis.chrome = {
  tabs: {
    create: async (props) => {
      calls.push(props);
      return nextResult(props);
    },
  },
  windows: {
    get: async (windowId) => {
      if (windowType === 'gone') throw new Error(`No window with id: ${windowId}`);
      return { id: windowId, type: windowType };
    },
  },
};

const { tabPlacement, createTabWithPlacement } = await import(
  '../../dist/background/open-tab.js'
);

const opener = { id: 7, index: 2, windowId: 42 };

test('tabPlacement pins the opener window, the slot to its right, and the opener link', async () => {
  windowType = 'normal';
  assert.deepEqual(await tabPlacement(opener), {
    windowId: 42,
    index: 3,
    openerTabId: 7,
  });
});

test('tabPlacement omits fields the opener does not carry', async () => {
  windowType = 'normal';
  assert.deepEqual(await tabPlacement(undefined), {});
  assert.deepEqual(await tabPlacement({ index: 0 }), { index: 1 });
});

test('tabPlacement drops all placement for a popup / app window', async () => {
  // A chromeless window would accept the tab but hide our page.
  windowType = 'popup';
  assert.deepEqual(await tabPlacement(opener), {});
});

test('tabPlacement drops all placement when the opener window is gone', async () => {
  windowType = 'gone';
  assert.deepEqual(await tabPlacement(opener), {});
});

test('createTabWithPlacement passes placement through on success', async () => {
  windowType = 'normal';
  calls.length = 0;
  nextResult = () => ({ id: 9 });
  const tab = await createTabWithPlacement({ url: 'x', ...(await tabPlacement(opener)) });
  assert.equal(tab.id, 9);
  assert.deepEqual(calls, [{ url: 'x', windowId: 42, index: 3, openerTabId: 7 }]);
});

test('createTabWithPlacement retries unplaced when Chrome refuses the placement', async () => {
  windowType = 'normal';
  calls.length = 0;
  nextResult = (props) => {
    // Reject only the placed attempt, exactly as Chrome does when the
    // opener isn't in the target window.
    if (props.openerTabId !== undefined) {
      throw new Error('Tab opener must be in the same window as the updated tab.');
    }
    return { id: 11 };
  };
  const tab = await createTabWithPlacement({ url: 'x', ...(await tabPlacement(opener)) });
  assert.equal(tab.id, 11);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { url: 'x' });
});

test('createTabWithPlacement surfaces the original error when the retry fails too', async () => {
  windowType = 'normal';
  calls.length = 0;
  nextResult = (props) => {
    throw new Error(props.openerTabId !== undefined ? 'first' : 'second');
  };
  const placed = { url: 'x', ...(await tabPlacement(opener)) };
  await assert.rejects(() => createTabWithPlacement(placed), /first/);
  assert.equal(calls.length, 2);
});

test('createTabWithPlacement re-throws when there was no placement to drop', async () => {
  calls.length = 0;
  nextResult = () => {
    throw new Error('boom');
  };
  await assert.rejects(() => createTabWithPlacement({ url: 'x' }), /boom/);
  assert.equal(calls.length, 1);
});
