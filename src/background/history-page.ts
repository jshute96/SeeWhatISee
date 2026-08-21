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
//
// The one thing the page *can't* do itself is *Restore last capture*
// from a row: reading the `lastCapture` slot and re-opening a Capture
// page are both SW-side, and importing `last-capture.js` into the page
// would drag the whole capture module graph into it. So the SW hands
// the page the restorable record's `logKey` (on registration, and
// again whenever the slot changes) and takes the restore click back as
// a message.

import { restoreLastCapture } from './capture-details.js';
import { getLastCapture } from './last-capture.js';

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

/**
 * `logKey` of the capture a *Restore last capture* would re-open, or
 * `null` when there's nothing to restore — or when the restorable
 * capture never saved, so no log row describes it.
 */
async function restorableLogKey(): Promise<string | null> {
  const record = await getLastCapture();
  return record?.logKey ?? null;
}

/**
 * Push the current restorable `logKey` to an open History page so its
 * Restore button follows the slot.
 *
 * Pings first, through the same `historyTabAlive` helper
 * `openHistoryPage` uses. Not paranoia about wasted messages: a stale
 * id can belong to a completely unrelated tab (ids are reused), and
 * the payload is the serialized log record — the captured URL, page
 * title and the user's prompt text. That doesn't get sent anywhere we
 * haven't confirmed is our own page.
 *
 * Fire-and-forget past that: a page mid-load, or one that goes away
 * between the ping and the send, just doesn't get the update, and it
 * re-asks on its next load anyway.
 *
 * Driven from the same `chrome.storage.onChanged` listener in
 * `background.ts` that re-enables the menu entry, so every writer of
 * the slot (Capture-page close, new capture, restore, quota relief) is
 * covered without threading a call through each one.
 */
export async function notifyHistoryPageRestorable(): Promise<void> {
  const tabId = await getHistoryTabId();
  if (tabId === undefined) return;
  if (!(await historyTabAlive(tabId))) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'restorableCaptureChanged',
      logKey: await restorableLogKey(),
    });
  } catch {
    // The page went away between the ping and the send. Nothing to
    // update, and its next load re-asks.
  }
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
      // The reply carries the restorable `logKey` too, so the page
      // gets its initial Restore-button state from the same round
      // trip it was already making. A failure here just means no
      // button — the page treats that as "nothing to restore".
      //
      // Kept in the two-callback `.then(onOk, onErr)` shape rather
      // than a try/catch around the reply: with `sendResponse` inside
      // the try, a throw from `sendResponse` itself (the page
      // navigated away mid-load, closing the channel) would reach the
      // handler and send a *second* response, which Chrome reports as
      // an error on the extension's Errors page.
      void (async () => {
        await chrome.storage.session.set({ [HISTORY_TAB_KEY]: id });
        return await restorableLogKey();
      })().then(
        (logKey) => sendResponse({ ok: true, logKey }),
        (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }),
      );
      return true;
    }

    // Restore click on a History row. The page can't do this itself
    // (see the module comment); `sender.tab` is the History tab, so
    // the Capture page opens beside it and returns focus there on
    // close, the same as any other opener.
    //
    // An empty slot is reported as a failure, not as `ok`. The page's
    // button is gone-or-disabled after a success, so silently
    // succeeding on nothing to restore would strand a dead button on
    // the row; the page re-enables it with this message instead.
    if (action === 'restoreLastCaptureFromHistory') {
      void restoreLastCapture(sender.tab).then(
        (restored) => sendResponse(
          restored ? { ok: true } : { error: 'That capture is no longer available to restore.' },
        ),
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
