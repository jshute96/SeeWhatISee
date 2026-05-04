// E2E coverage for the toolbar context menu's "Set this tab as
// Ask button target" / "Unset this tab as Ask button target" entry.
//
// Playwright can't (cleanly) right-click the extension toolbar
// icon to drive the action context menu, so these tests poke the
// underlying helpers via `serviceWorker.evaluate` and spy on
// `chrome.contextMenus.update` to capture the title/enabled state
// the user would see at right-click time.
//
// Patch persistence: `captureMenuUpdates` installs the
// `chrome.contextMenus.update` patch once per SW lifetime (guarded
// by `__menuUpdatesPatched`) and never tears it down. That's fine
// for this spec — every test in here wants the spy. If a future
// spec sharing the SW needs to patch `chrome.contextMenus.update`
// itself, it'll need to coordinate with this one or run in a
// different worker.

import type { Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { openDetailsFlow } from './details-helpers';
import {
  installAskTestHooks,
  openFakeClaudeTab,
  overrideAskProviders,
} from './ask-helpers';

installAskTestHooks();

interface UpdatePayload {
  id: string;
  title?: string;
  enabled?: boolean;
}

/**
 * Patch `chrome.contextMenus.update` in the SW so each call lands
 * in `self.__menuUpdates`. Drains and returns the latest call's
 * payload so the tests can assert against just-this-refresh state.
 *
 * Restored to the original after each test via `installAskTestHooks`'s
 * afterEach (it nukes the patched property by re-evaluating the
 * patch fresh in each beforeEach call below — see the wrapper).
 */
async function captureMenuUpdates(sw: Worker): Promise<void> {
  await sw.evaluate(() => {
    interface UpdatesGlobal {
      __menuUpdates?: { id: string; details: chrome.contextMenus.UpdateProperties }[];
      __menuUpdatesPatched?: boolean;
      __originalMenuUpdate?: typeof chrome.contextMenus.update;
    }
    const g = self as unknown as UpdatesGlobal;
    if (g.__menuUpdatesPatched) {
      g.__menuUpdates = [];
      return;
    }
    g.__menuUpdates = [];
    g.__menuUpdatesPatched = true;
    g.__originalMenuUpdate = chrome.contextMenus.update.bind(chrome.contextMenus);
    chrome.contextMenus.update = ((
      id: string | number,
      details: chrome.contextMenus.UpdateProperties,
    ) => {
      g.__menuUpdates!.push({ id: String(id), details });
      return g.__originalMenuUpdate!(id, details);
    }) as typeof chrome.contextMenus.update;
  });
}

/** Drain all updates seen so far for the pin entry, latest first. */
async function readPinUpdates(sw: Worker): Promise<UpdatePayload[]> {
  return await sw.evaluate(() => {
    interface UpdatesGlobal {
      __menuUpdates?: { id: string; details: chrome.contextMenus.UpdateProperties }[];
    }
    const g = self as unknown as UpdatesGlobal;
    const all = g.__menuUpdates ?? [];
    g.__menuUpdates = [];
    return all
      .filter((u) => u.id === 'pin-ask-target')
      .map((u) => ({
        id: u.id,
        title: u.details.title as string | undefined,
        enabled: u.details.enabled as boolean | undefined,
      }));
  });
}

async function lastPinUpdate(sw: Worker): Promise<UpdatePayload | null> {
  const all = await readPinUpdates(sw);
  return all.length > 0 ? all[all.length - 1] : null;
}

test('toolbar pin: refresh on a non-provider tab leaves the entry disabled', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  await captureMenuUpdates(sw);

  // The capture page is the active tab — not on a fake-Claude URL,
  // so the entry should refresh to "Set…", disabled.
  await capturePage.bringToFront();
  await sw.evaluate(() => {
    return (
      self as unknown as { SeeWhatISee: { refreshPinAskTargetMenu: () => Promise<void> } }
    ).SeeWhatISee.refreshPinAskTargetMenu();
  });

  const update = await lastPinUpdate(sw);
  expect(update).toEqual({
    id: 'pin-ask-target',
    title: 'Set this tab as Ask button target',
    enabled: false,
  });

  await openerPage.close();
});

test('toolbar pin: refresh on a provider tab enables the entry with "Set…" wording', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);
  await captureMenuUpdates(sw);

  // Newly-opened fake-Claude tab is the active tab; refresh
  // should mark the entry "Set…", enabled.
  await claudePage.bringToFront();
  await sw.evaluate(() => {
    return (
      self as unknown as { SeeWhatISee: { refreshPinAskTargetMenu: () => Promise<void> } }
    ).SeeWhatISee.refreshPinAskTargetMenu();
  });

  const update = await lastPinUpdate(sw);
  expect(update).toEqual({
    id: 'pin-ask-target',
    title: 'Set this tab as Ask button target',
    enabled: true,
  });

  await claudePage.close();
  await openerPage.close();
});

test('toolbar pin: refresh on the already-pinned tab flips the title to "Unset…"', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);
  await captureMenuUpdates(sw);

  await claudePage.bringToFront();

  // Pin to this tab via the SW helper, then refresh and read the
  // resulting title.
  await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          togglePinAskTarget: (tab: chrome.tabs.Tab) => Promise<void>;
          refreshPinAskTargetMenu: () => Promise<void>;
        };
      }
    ).SeeWhatISee;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no active tab');
    await api.togglePinAskTarget(tab);
    await api.refreshPinAskTargetMenu();
  });

  const update = await lastPinUpdate(sw);
  expect(update).toEqual({
    id: 'pin-ask-target',
    title: 'Unset this tab as Ask button target',
    enabled: true,
  });

  await claudePage.close();
  await openerPage.close();
});

test('toolbar pin: clicking Unpin clears the pin', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await claudePage.bringToFront();

  // Toggle once → pin set; toggle again → pin cleared.
  const finalPin = await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          togglePinAskTarget: (tab: chrome.tabs.Tab) => Promise<void>;
          getAskPin: () => Promise<{ provider: string; tabId: number } | null>;
        };
      }
    ).SeeWhatISee;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no active tab');
    await api.togglePinAskTarget(tab);
    const afterFirst = await api.getAskPin();
    await api.togglePinAskTarget(tab);
    const afterSecond = await api.getAskPin();
    return { afterFirst, afterSecond };
  });
  expect(finalPin.afterFirst).not.toBeNull();
  expect(finalPin.afterSecond).toBeNull();

  await claudePage.close();
  await openerPage.close();
});

test('toolbar pin: not-pinned tab on an excluded URL stays disabled', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    excludeUrlPatterns: ['*?excluded=*'],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html?excluded=1`);
  await captureMenuUpdates(sw);

  await claudePage.bringToFront();
  await sw.evaluate(() => {
    return (
      self as unknown as { SeeWhatISee: { refreshPinAskTargetMenu: () => Promise<void> } }
    ).SeeWhatISee.refreshPinAskTargetMenu();
  });

  const update = await lastPinUpdate(sw);
  expect(update).toEqual({
    id: 'pin-ask-target',
    title: 'Set this tab as Ask button target',
    enabled: false,
  });

  await claudePage.close();
  await openerPage.close();
});

test('toolbar pin: already-pinned tab on a wrong page still offers Unset', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    excludeUrlPatterns: ['*?excluded=*'],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await claudePage.bringToFront();

  // Pin while the tab is on a valid URL, then navigate it to an
  // excluded URL. The menu should still offer "Unset…" enabled —
  // otherwise the user would be stranded with no way to clear the
  // pin from the tab it points at.
  await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          togglePinAskTarget: (tab: chrome.tabs.Tab) => Promise<void>;
        };
      }
    ).SeeWhatISee;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no active tab');
    await api.togglePinAskTarget(tab);
  });
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html?excluded=1`);
  await captureMenuUpdates(sw);

  await sw.evaluate(() => {
    return (
      self as unknown as { SeeWhatISee: { refreshPinAskTargetMenu: () => Promise<void> } }
    ).SeeWhatISee.refreshPinAskTargetMenu();
  });

  const update = await lastPinUpdate(sw);
  expect(update).toEqual({
    id: 'pin-ask-target',
    title: 'Unset this tab as Ask button target',
    enabled: true,
  });

  // And the Unset click actually clears the pin even though the
  // URL would no longer be a valid pin target.
  const cleared = await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          togglePinAskTarget: (tab: chrome.tabs.Tab) => Promise<void>;
          getAskPin: () => Promise<unknown>;
        };
      }
    ).SeeWhatISee;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no active tab');
    await api.togglePinAskTarget(tab);
    return api.getAskPin();
  });
  expect(cleared).toBeNull();

  await claudePage.close();
  await openerPage.close();
});
