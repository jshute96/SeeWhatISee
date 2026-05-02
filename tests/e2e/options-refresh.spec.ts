// Tests for the Options-page hooks that aren't covered elsewhere.
//
// `getOptionsData` does double duty: it returns the catalog/state the
// page renders, AND it gives the SW a chance to resync the toolbar
// tooltip + context-menu labels against the current shortcut bindings.
// Chrome fires no event when the user edits a shortcut at
// chrome://extensions/shortcuts, so the SW would otherwise stay stale
// until the next toolbar/menu interaction. The Options page is a
// natural refresh point — users often arrive there straight after
// editing their shortcuts.
//
// The `chrome.commands.getAll` here is monkey-patched in the SW to
// fake bound shortcuts: Playwright can't drive
// chrome://extensions/shortcuts, and the production lookup chain
// (`getAll → commandsToShortcutMap → buildTooltip`) is the same code
// path either way.

import { test, expect } from '../fixtures/extension';

// Always restore `chrome.commands.getAll` and resync the cached
// fingerprint between tests, even if the test under test failed
// partway through (e.g. an `expect.poll` timed out). Otherwise the
// stub leaks into the next spec's SW state — the per-test
// `__origGetAll` capture guards against double-install but
// subsequent specs would still see the wrong `getAll`.
test.afterEach(async ({ getServiceWorker }) => {
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    interface Stubbed {
      __origGetAll?: typeof chrome.commands.getAll;
    }
    const g = self as unknown as Stubbed;
    if (g.__origGetAll) {
      chrome.commands.getAll = g.__origGetAll;
      g.__origGetAll = undefined;
    }
    const ctx = self as unknown as {
      SeeWhatISee: { refreshMenusIfHotkeysChanged: () => Promise<void> };
    };
    await ctx.SeeWhatISee.refreshMenusIfHotkeysChanged();
  });
});

test('opening the Options page refreshes the tooltip with current hotkeys', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();

  // Step 1: stub `chrome.commands.getAll` to claim both `_execute_action`
  // and `secondary-action` are bound. Pin the four defaults so the
  // expected tooltip layout is deterministic. The stub stays installed
  // until we restore it at the end of the test.
  await sw.evaluate(async () => {
    interface Stubbed {
      __origGetAll?: typeof chrome.commands.getAll;
    }
    const g = self as unknown as Stubbed;
    if (!g.__origGetAll) g.__origGetAll = chrome.commands.getAll.bind(chrome.commands);
    chrome.commands.getAll = (async () => {
      const cmds = await g.__origGetAll!();
      return cmds.map((c) => {
        if (c.name === '_execute_action') return { ...c, shortcut: 'Ctrl+Shift+Y' };
        if (c.name === '01-secondary-action') return { ...c, shortcut: 'Ctrl+Shift+S' };
        return c;
      });
    }) as typeof chrome.commands.getAll;

    const api = (
      self as unknown as {
        SeeWhatISee: {
          setDefaultWithSelectionId: (id: string) => Promise<void>;
          setDefaultWithoutSelectionId: (id: string) => Promise<void>;
          setDefaultDblWithSelectionId: (id: string) => Promise<void>;
          setDefaultDblWithoutSelectionId: (id: string) => Promise<void>;
        };
      }
    ).SeeWhatISee;
    await api.setDefaultWithoutSelectionId('capture');
    await api.setDefaultWithSelectionId('capture');
    await api.setDefaultDblWithoutSelectionId('capture');
    await api.setDefaultDblWithSelectionId('capture');
  });

  // Step 2: invalidate the cached fingerprint so the next refresh sees
  // a "shortcut binding changed" diff. This stands in for the user
  // having edited a shortcut at chrome://extensions/shortcuts since
  // the SW last rendered.
  await sw.evaluate(async () => {
    // Trigger refreshMenusAndTooltip directly to bake in a *different*
    // baseline (the unstubbed empty-shortcut state) before the Options
    // page load. We do this by temporarily uninstalling the stub.
    interface Stubbed {
      __origGetAll?: typeof chrome.commands.getAll;
      __stubbedGetAll?: typeof chrome.commands.getAll;
    }
    const g = self as unknown as Stubbed;
    g.__stubbedGetAll = chrome.commands.getAll;
    chrome.commands.getAll = g.__origGetAll!;
    // Refresh sets the cached fingerprint to the empty-shortcut
    // baseline.
    const ctx = self as unknown as {
      SeeWhatISee: { refreshActionTooltip: () => Promise<void> };
    };
    await ctx.SeeWhatISee.refreshActionTooltip();
    // Also refresh menus so the cached fingerprint matches the empty
    // baseline; using the public refresh isn't enough because
    // refreshActionTooltip alone doesn't update the cached
    // fingerprint. Easiest: drive a public hotkeys-changed sweep
    // against the unstubbed `getAll`.
    await ctx.SeeWhatISee.refreshMenusIfHotkeysChanged();
    // Restore the stub for the Options-page load to see the "new"
    // bindings.
    chrome.commands.getAll = g.__stubbedGetAll!;
  });

  // Sanity check: with the empty-shortcut baseline cached, the
  // tooltip has no [<key>] suffixes yet.
  const before = await sw.evaluate(() => chrome.action.getTitle({}));
  expect(before).not.toContain('[Ctrl+Shift+Y]');
  expect(before).not.toContain('[Ctrl+Shift+S]');

  // Step 3: open the Options page. `options.ts` fires the
  // `getOptionsData` message on first paint, which the SW handler
  // uses as a hotkey-refresh hook.
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  // The page sends `getOptionsData` early; wait until the action
  // title reflects the refresh. Polling instead of a fixed sleep so
  // the test isn't flaky on a slow runner.
  await expect
    .poll(() => sw.evaluate(() => chrome.action.getTitle({})), {
      timeout: 5000,
    })
    .toContain('[Ctrl+Shift+Y]');

  const after = await sw.evaluate(() => chrome.action.getTitle({}));
  // Both rows are Case 1 (capture/capture) → single-line, hotkey at
  // end of line.
  expect(after).toContain('Click: Capture...  [Ctrl+Shift+Y]');
  expect(after).toContain('Double-click: Capture...  [Ctrl+Shift+S]');

  await page.close();
  // afterEach restores the stub.
});

test('Save on the Options page refreshes the tooltip when only capturePageDefaults changed', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  // The action setters (setDefaultWithoutSelectionId &c.) already
  // self-refresh the tooltip, but `setCaptureDetailsDefaults` does
  // not — yet the tooltip's `save-defaults` line expands against
  // capturePageDefaults, so a Save that only toggles a checkbox in
  // the Capture-page section still has to drive a tooltip refresh.
  // Verifies via a `setOptions` message sent from a page context
  // (chrome.runtime.sendMessage from the SW to itself doesn't
  // dispatch back, so the test has to send from a page tab).
  const sw = await getServiceWorker();

  // Pin click=capture, dbl=save-defaults so the Dbl row's primary
  // fragment expands against capturePageDefaults.
  await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          setDefaultWithSelectionId: (id: string) => Promise<void>;
          setDefaultWithoutSelectionId: (id: string) => Promise<void>;
          setDefaultDblWithSelectionId: (id: string) => Promise<void>;
          setDefaultDblWithoutSelectionId: (id: string) => Promise<void>;
        };
      }
    ).SeeWhatISee;
    await api.setDefaultWithoutSelectionId('capture');
    await api.setDefaultWithSelectionId('capture');
    await api.setDefaultDblWithoutSelectionId('save-defaults');
    await api.setDefaultDblWithSelectionId('save-defaults');
  });

  // Use the Options page itself as the page context for messaging.
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForLoadState('domcontentloaded');

  // Baseline: send setOptions with capturePageDefaults that has only
  // screenshot checked in both branches. Tooltip should resolve to
  // `Double-click: Save screenshot` with no with-sel addendum
  // (Case 1 — both branches expand identically).
  const sendSetOptions = (capturePageDefaults: object) =>
    page.evaluate(
      (cpd) =>
        new Promise<void>((resolve) => {
          chrome.runtime.sendMessage(
            { action: 'setOptions', capturePageDefaults: cpd },
            () => resolve(),
          );
        }),
      capturePageDefaults,
    );
  await sendSetOptions({
    withoutSelection: { screenshot: true, html: false },
    withSelection: {
      screenshot: true,
      html: false,
      selection: false,
      format: 'markdown',
    },
    defaultButton: 'capture',
    promptEnter: 'send',
  });
  const before = await sw.evaluate(() => chrome.action.getTitle({}));
  expect(before).toContain('Double-click: Save screenshot');
  expect(before).not.toContain('Double-click: Save screenshot, HTML');

  // Save the change: flip withoutSelection.html on. No click/dbl
  // ids change — only capturePageDefaults moves.
  await sendSetOptions({
    withoutSelection: { screenshot: true, html: true },
    withSelection: {
      screenshot: true,
      html: true,
      selection: false,
      format: 'markdown',
    },
    defaultButton: 'capture',
    promptEnter: 'send',
  });

  const after = await sw.evaluate(() => chrome.action.getTitle({}));
  expect(after).toContain('Double-click: Save screenshot, HTML');

  await page.close();
});

test('a refreshHotkeys message from the Options page resyncs the tooltip', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  // Mirrors the focus/blur/radio-click path in `options.ts`'s
  // `refreshHotkeys`: the page detects a (potential) shortcut edit
  // and pings the SW, which compares fingerprints and refreshes if
  // anything changed. We open the Options page once with empty
  // bindings (so the cached fingerprint matches "no shortcuts"),
  // then stub `chrome.commands.getAll` to fake new bindings and
  // send the `refreshHotkeys` message — exactly what the page does
  // on focus.
  const sw = await getServiceWorker();

  // Empty-bindings baseline: open Options, then close it. After
  // this, the SW's cached fingerprint matches the unstubbed
  // empty-shortcut state.
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForLoadState('domcontentloaded');

  const before = await sw.evaluate(() => chrome.action.getTitle({}));
  expect(before).not.toContain('[Ctrl+Shift+');

  // Stub `getAll` to claim _execute_action is now bound.
  await sw.evaluate(() => {
    interface Stubbed {
      __origGetAll?: typeof chrome.commands.getAll;
    }
    const g = self as unknown as Stubbed;
    if (!g.__origGetAll) g.__origGetAll = chrome.commands.getAll.bind(chrome.commands);
    chrome.commands.getAll = (async () => {
      const cmds = await g.__origGetAll!();
      return cmds.map((c) =>
        c.name === '_execute_action' ? { ...c, shortcut: 'Ctrl+Shift+Y' } : c,
      );
    }) as typeof chrome.commands.getAll;
  });

  // Send the `refreshHotkeys` message exactly like the page would.
  // Running it from the page (rather than the SW directly) verifies
  // the cross-context wiring — runtime.sendMessage from
  // chrome-extension://<id>/options.html lands in the same SW
  // listener `installOptionsMessageHandlers` registered.
  await page.evaluate(
    () => new Promise<void>((resolve) => {
      chrome.runtime.sendMessage({ action: 'refreshHotkeys' }, () => resolve());
    }),
  );

  await expect
    .poll(() => sw.evaluate(() => chrome.action.getTitle({})), { timeout: 5000 })
    .toContain('[Ctrl+Shift+Y]');

  await page.close();
  // afterEach restores the stub.
});
