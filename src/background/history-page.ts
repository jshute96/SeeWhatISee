// Service-worker side of the History page (`src/history.html` /
// `src/history.ts`).
//
// The page itself reads `chrome.storage.local` and
// `chrome.downloads.search` directly — it needs nothing from the SW to
// render. What lives here is only the *opening* of it, which has two
// entry points that must behave identically:
//
//   - The top-level History row on the toolbar icon's right-click menu
//     (`background.ts` calls `openHistoryPage` directly).
//   - The History button in the app-header of the Capture and Options
//     pages, which can't call it directly — `options.ts` is a classic
//     script and can't import at all, and pulling the SW module graph
//     into an extension page would be wrong even where it can. They
//     send `{ action: 'openHistoryPage' }` instead.
//
// Own listener rather than a branch inside the Options / Capture-page
// handlers, because it is neither: Chrome dispatches an onMessage to
// every registered listener, so a page can talk to whichever module
// actually owns the behaviour.

/**
 * `chrome.storage.session` key holding the tab id of the open History
 * page, if there is one. Session (not local) because a tab id is
 * meaningless once the browser restarts, and session storage survives
 * a service-worker respawn — which is the case that matters, since the
 * SW idles out constantly.
 */
const HISTORY_TAB_KEY = 'historyTabId';

/**
 * Why we track the tab id ourselves instead of
 * `chrome.tabs.query({ url })`:
 *
 * `query`'s `url` filter only matches tabs whose URL the extension is
 * allowed to see, and `tab.url` is populated only with the `"tabs"`
 * permission or a host permission covering that URL. This extension
 * has neither for `chrome-extension://` — `<all_urls>` does not span
 * that scheme — so **every** `tab.url` reads back `undefined` and a
 * `query({ url })` silently returns `[]`. The failure is invisible:
 * you just get a brand-new tab every time. Adding `"tabs"` would fix
 * it by granting read access to every tab's URL in the browser, which
 * is a wildly disproportionate permission for "focus my own page".
 */
async function getHistoryTabId(): Promise<number | undefined> {
  const data = await chrome.storage.session.get(HISTORY_TAB_KEY);
  const id = data[HISTORY_TAB_KEY] as unknown;
  return typeof id === 'number' ? id : undefined;
}

/**
 * Confirm `tabId` is still showing the History page.
 *
 * The stored id goes stale in two ways the tab merely existing can't
 * distinguish: the tab was closed (id may even be reused by an
 * unrelated tab), or the user navigated it somewhere else. Since we
 * can't read `tab.url` (see above), we ask the page directly — only
 * `history.ts`'s listener answers this ping, so a reply is proof the
 * History page is still the thing in that tab.
 *
 * Any failure ("no receiving end", tab gone, a content-script-less
 * website now sitting there) resolves `false` and the caller opens a
 * fresh tab.
 */
async function historyTabAlive(tabId: number): Promise<boolean> {
  try {
    const resp = (await chrome.tabs.sendMessage(tabId, {
      action: 'pingHistoryPage',
    })) as { ok?: boolean } | undefined;
    return resp?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Open the History page (`history.html`) in a tab.
 *
 * Reuses an already-open History tab (focusing its window too) instead
 * of stacking a second one: the page is a read-only view that
 * live-updates from storage, so two copies is never what the user
 * wanted — and the History button is on pages the user bounces between,
 * which would otherwise pile up tabs fast.
 */
export async function openHistoryPage(): Promise<void> {
  const tabId = await getHistoryTabId();
  if (tabId !== undefined && await historyTabAlive(tabId)) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  // Stale or absent — drop it so a failed ping isn't re-tried on every
  // open, and let the new page register itself when it loads.
  await chrome.storage.session.remove(HISTORY_TAB_KEY);
  await chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
}

export function installHistoryMessageHandler(): void {
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || !('action' in msg)) return false;
    const action = (msg as { action: unknown }).action;

    if (action === 'openHistoryPage') {
      void openHistoryPage().then(
        () => sendResponse({ ok: true }),
        (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }),
      );
      return true;
    }

    // Sent by history.ts on load. Registering from the page (rather
    // than recording the id we get back from `tabs.create`) also
    // covers History tabs we didn't open — a session restore, or the
    // user reloading one from browser history.
    if (action === 'historyPageReady') {
      const id = sender.tab?.id;
      if (id === undefined) {
        sendResponse({ error: 'no sender tab id' });
        return true;
      }
      void chrome.storage.session.set({ [HISTORY_TAB_KEY]: id }).then(
        () => sendResponse({ ok: true }),
        (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }),
      );
      return true;
    }

    return false;
  });

  // Hygiene: drop the id as soon as the tab goes away. The ping in
  // `openHistoryPage` already handles a stale id, so this only saves a
  // pointless round-trip — but it also stops us holding an id that a
  // later tab could reuse.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      if (await getHistoryTabId() === tabId) {
        await chrome.storage.session.remove(HISTORY_TAB_KEY);
      }
    })();
  });
}
