// Resolving *which tab* a capture targets.
//
// Every capture entry point has to answer the same question first:
// what tab are we capturing? This module owns that single answer.
//
// The short version: `chrome.tabs.query({ lastFocusedWindow: true })`
// is Chrome's own focus bookkeeping, not "the window the user clicked
// in", and it can go stale — so we prefer the tab the gesture itself
// happened on. `chrome.action.onClicked`,
// `chrome.contextMenus.onClicked` and `chrome.commands.onCommand` all
// hand us that tab, and it's the same tab the `activeTab` grant
// covers.
//
// The full story — the user-visible symptom, why the bookkeeping goes
// stale, and the `activeTab` error that gives it away — is in
// `docs/capture-actions.md` → "Target-tab resolution".

/**
 * The tab a user gesture happened on, when there was one.
 *
 * Toolbar clicks, context-menu clicks and keyboard commands all
 * supply one. It can still be absent: a hotkey pressed with no
 * browser window focused, and the gestureless callers — SW devtools
 * console and the e2e harness — which fall back to the active-tab
 * query.
 */
export type GestureTab = chrome.tabs.Tab | undefined;

/** Sleeps for the capture's countdown. See `resolveCaptureTab`. */
export type DelaySleep = (delayMs: number) => Promise<void>;

/** The active-tab query, as a named fallback. */
async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [active] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return active;
}

/**
 * Re-read a tab snapshot so `windowId` / `index` / `url` reflect
 * anything that moved since the gesture. Falls back to the snapshot
 * when the tab is gone — the capture then fails downstream with a
 * clear error rather than here with a confusing one.
 *
 * `keepSnapshotText` restores `url` / `title` when the refreshed tab
 * reports them empty. Those fields are permission-gated: they come
 * back only with host permission for the page or an `activeTab` grant
 * on the tab. Only the immediate path passes `true` — there the page
 * cannot have changed under us, so an empty field means a permission
 * quirk and the snapshot is the better value. On a delayed capture an
 * empty field may instead mean the tab *navigated* somewhere we can't
 * read, and reporting the pre-navigation URL would be a lie.
 */
async function refreshTab(
  tab: chrome.tabs.Tab,
  keepSnapshotText: boolean,
): Promise<chrome.tabs.Tab> {
  if (tab.id === undefined) return tab;
  try {
    const fresh = await chrome.tabs.get(tab.id);
    if (!keepSnapshotText) return fresh;
    return {
      ...fresh,
      url: fresh.url || tab.url,
      title: fresh.title || tab.title,
    };
  } catch {
    return tab;
  }
}

/**
 * Whether Chrome currently reports `windowId` as the focused window.
 * A lookup failure counts as "no" — a window we can't read is not one
 * we should redirect a capture to.
 *
 * Note this is not *independent* evidence: `focused` is maintained by
 * the same `onFocusChanged` plumbing that feeds `lastFocusedWindow`.
 * It's a better signal (a live per-window flag rather than a
 * "most recent" pointer), which is why it's one of the checks and not
 * the only one.
 */
async function isFocusedWindow(windowId: number): Promise<boolean> {
  try {
    return (await chrome.windows.get(windowId)).focused;
  } catch {
    return false;
  }
}

/**
 * Sleep for `delayMs` (when asked) and resolve the tab to capture.
 *
 * The wait happens *inside* this function on purpose: we sample the
 * active-tab query before it too, and that "before" value is what
 * lets us tell a real focus change from stale bookkeeping. Callers
 * with `delayMs > 0` must therefore pass `sleep` rather than sleeping
 * themselves.
 *
 * The rules:
 *
 * - **No gesture tab** — the active-tab query is all we have.
 * - **`delayMs === 0`** — the gesture tab. It's the tab the user was
 *   looking at when they clicked, and the one `activeTab` was granted
 *   on.
 * - **`delayMs > 0`** — delayed captures are *documented* to follow
 *   focus: the countdown exists so the user can set up hover states,
 *   open menus, or switch windows before the shot freezes. So we
 *   re-query and take the result when any of these says the answer is
 *   real rather than stale:
 *     - it's in the gesture's own window (a tab switch, or nothing
 *       changed and it's just a fresher snapshot);
 *     - it names a *different* window than the pre-delay sample did,
 *       i.e. focus demonstrably moved while we waited;
 *     - Chrome reports its window as focused right now.
 *
 *   Failing all three, the query is telling us the same thing it told
 *   us before the delay and can't confirm it — the stale case — so we
 *   stay on the gesture tab.
 *
 * Throws when nothing resolves — the action / context-menu wrappers
 * catch it and surface it on the friendly error page.
 */
export async function resolveCaptureTab(
  gestureTab: GestureTab,
  delayMs = 0,
  sleep?: DelaySleep,
): Promise<chrome.tabs.Tab> {
  // Sampled before the wait, so it reflects the same (possibly
  // stale) bookkeeping the gesture saw.
  const before = delayMs > 0 ? (await queryActiveTab())?.windowId : undefined;
  if (delayMs > 0 && sleep) await sleep(delayMs);

  if (gestureTab?.id === undefined) {
    const active = await queryActiveTab();
    if (!active) throw new Error('No active tab found to capture');
    return active;
  }

  if (delayMs === 0) return refreshTab(gestureTab, true);

  const queried = await queryActiveTab();
  if (!queried) return refreshTab(gestureTab, false);
  if (queried.windowId === gestureTab.windowId) return queried;
  if (before !== undefined && queried.windowId !== before) return queried;
  if (await isFocusedWindow(queried.windowId)) return queried;
  return refreshTab(gestureTab, false);
}
