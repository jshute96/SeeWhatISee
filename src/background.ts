import {
  captureBothToMemory,
  captureVisible,
  clearCaptureLog,
  saveDetailedCapture,
  savePageContents,
  type InMemoryCapture,
} from './capture.js';

// User-visible error reporting for failed captures.
//
// The service worker has no modal-dialog API. We surface failures on
// two `chrome.action` channels so the user can see both *that*
// something failed and *what* failed, without requesting a noisy
// permission like `notifications`:
//   - The icon itself is the glanceable signal: we swap in a
//     pre-rendered "error" variant of each icon size (small red `!`
//     painted in the bottom-right corner) until the *next*
//     successful capture restores the originals. We deliberately
//     avoid `chrome.action.setBadgeText` for error state because
//     Chrome's badge pill is uncomfortably large relative to the
//     icon and there's no API to shrink it; `setIcon` gives us
//     pixel-level control. (The badge *is* used for the countdown
//     timer during delayed captures — see `countdownSleep` in
//     capture.ts — where the large size is actually a plus.)
//   - The tooltip (action title) is the reference channel: hovering
//     the icon shows the default tooltip plus a second line with
//     the last error message, so the user can go back and read
//     *what* failed without digging through the devtools console.
//
// Both calls are fire-and-forget: a follow-on error here shouldn't
// mask the original capture error. Logged to console but not
// re-thrown.
//
// Icon paths (relative to the extension root) for the normal and
// error states. Same three sizes as in the manifest's
// `action.default_icon`; the error variants are committed alongside
// the base icons in `src/icons/` and produced by
// `scripts/generate-error-icons.mjs` (re-run only when the base
// icons change).
const NORMAL_ICON_PATHS = {
  16: 'icons/icon-16.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};
const ERROR_ICON_PATHS = {
  16: 'icons/icon-error-16.png',
  48: 'icons/icon-error-48.png',
  128: 'icons/icon-error-128.png',
};

async function reportCaptureError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.warn('[SeeWhatISee] capture failed:', err);
  try {
    await chrome.action.setIcon({ path: ERROR_ICON_PATHS });
  } catch (iconErr) {
    console.warn('[SeeWhatISee] failed to set error icon:', iconErr);
  }
  try {
    // Base tooltip is whichever CAPTURE_ACTIONS entry the user has
    // picked as the default click action (falls back to capture-with-details).
    // Final line shows the error. Chrome's toolbar tooltip honors
    // embedded newlines on macOS / Windows / most Linux DEs.
    const baseTitle = await getDefaultActionTooltip();
    await chrome.action.setTitle({
      title: `${baseTitle}\nLast error: ${message}`,
    });
  } catch (titleErr) {
    console.warn('[SeeWhatISee] failed to set error tooltip:', titleErr);
  }
}

async function clearCaptureError(): Promise<void> {
  try {
    await chrome.action.setIcon({ path: NORMAL_ICON_PATHS });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to restore normal icon:', err);
  }
  try {
    // Dynamic: reflects the user's currently selected default
    // click action, not a hardcoded manifest string.
    await chrome.action.setTitle({ title: await getDefaultActionTooltip() });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to reset tooltip:', err);
  }
}

/**
 * Run a capture-like action with unified error reporting. A
 * successful run clears any lingering error state (restores the
 * normal icon + default tooltip); a failure swaps in the error
 * icon variant and appends a `Last error: …` line to the tooltip.
 * Used by every user-initiated capture path (toolbar click,
 * context-menu entries).
 */
async function runWithErrorReporting(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    await clearCaptureError();
  } catch (err) {
    await reportCaptureError(err);
  }
}

// Targeted suppression for one specific user-actionable failure.
// Manually poking captureVisible from the SW devtools console (e.g.
// `SeeWhatISee.captureVisible()` while DevTools itself is the focused
// window) makes the active-tab lookup fail; without this handler, that
// rejection bubbles up as unhandled and Chrome promotes it onto the
// chrome://extensions Errors page, looking like an extension bug.
//
// We deliberately match on the error message rather than swallowing
// every unhandled rejection: a blanket catch would also silence
// genuine bugs (failed downloads, storage quota errors, future
// listener bodies that forget their try/catch) — and the Errors page
// is the only async signal most developers have. Anything we don't
// recognize is left alone so it still surfaces.
const SUPPRESSED_UNHANDLED = [
  'No active tab found to capture',
  'Failed to retrieve page contents',
  'saveDetailedCapture called with nothing to save',
];
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const message = String((event.reason as Error)?.message ?? event.reason);
  if (SUPPRESSED_UNHANDLED.some((s) => message.includes(s))) {
    console.warn('[SeeWhatISee] capture failed:', event.reason);
    event.preventDefault();
  }
});

// Capture actions surfaced to the user.
//
// Each action is a (base, delay) pair: the base says *what* to
// capture (plain screenshot, HTML contents, or the details flow)
// and the delay says *when* to capture (immediate, 2s, or 5s). We
// define the three bases once and expand them across the delays at
// module load so the top-level menu, the "Capture with delay" submenu,
// and the "Set default click action" submenu all stay in sync from
// a single source.
//
// The resulting flat `CAPTURE_ACTIONS` array drives three things:
//   - the top-level menu entries (delay 0 only)
//   - the "Capture with delay" submenu children (delay > 0)
//   - the "Set default click action" submenu radios (delays in
//     `DEFAULTABLE_DELAYS_SEC`, i.e. 0 and 2)
// and is the lookup table `handleActionClick` uses to run the
// currently-selected default.
//
// Keep the first base action at delay 0 first: that's the default
// fallback when nothing is stored yet, and its tooltip matches the
// manifest's `action.default_title` so the hover text is correct
// during the brief window between a fresh install and the first
// tooltip refresh from `refreshActionTooltip()`.

interface BaseCaptureAction {
  /** Stable base id, e.g. `capture-now`. Delayed variants append
   * `-<N>s`. */
  baseId: string;
  /** Short label for the undelayed variant, e.g. "Take screenshot". */
  baseTitle: string;
  /** Tooltip for the undelayed variant. */
  baseTooltip: string;
  /** Runs the action with the given delay (ms). `delayMs === 0` is
   * the immediate / no-delay path. */
  run: (delayMs: number) => Promise<unknown>;
}

interface CaptureAction {
  /** Stable id — used as the menu item id, the submenu child id
   * (with a prefix), and the storage value. */
  id: string;
  /** Short label shown in the context menu. */
  title: string;
  /** Tooltip shown on the toolbar icon when this action is the
   * current default. */
  tooltip: string;
  /** Which base action this came from (for grouping / rendering). */
  baseId: string;
  /** 0 for immediate; >0 for a delayed variant. Used to slot the
   * entry into the right menu section. */
  delaySec: number;
  /** Runs when the user picks this action (either from the top-level
   * menu entry, the Capture with delay submenu, or a toolbar click
   * when it's the current default). */
  run: () => Promise<unknown>;
}

const BASE_CAPTURE_ACTIONS: BaseCaptureAction[] = [
  {
    baseId: 'capture-now',
    baseTitle: 'Take screenshot',
    baseTooltip: 'SeeWhatISee — Capture visible tab\nDouble-click for capture with details',
    run: (delayMs) => captureVisible(delayMs),
  },
  {
    baseId: 'save-page-contents',
    baseTitle: 'Save html contents',
    baseTooltip: 'SeeWhatISee — Save HTML contents\nDouble-click for capture with details',
    run: (delayMs) => savePageContents(delayMs),
  },
  {
    baseId: 'capture-with-details',
    baseTitle: 'Capture with details...',
    baseTooltip: 'SeeWhatISee — Capture with details\nDouble-click for screenshot',
    run: (delayMs) => startCaptureWithDetails(delayMs),
  },
];

// All delays (in seconds) we surface in the menu. 0 is the plain
// top-level entry set; 2 and 5 go into the "Capture with delay" submenu.
const CAPTURE_DELAYS_SEC = [0, 2, 5] as const;

// Delays that are settable as the default click action. 0 and 2
// cover the common cases; 5s is available from the Capture with delay
// submenu but can't be made the default — that would cost an extra
// radio row per base action without much real-world value.
const DEFAULTABLE_DELAYS_SEC = [0, 2] as const;

function delayedId(baseId: string, delaySec: number): string {
  return delaySec === 0 ? baseId : `${baseId}-${delaySec}s`;
}

// Build a delayed title. For base titles that end in "..." (the
// "opens a dialog" convention used by "Capture with details..."),
// we slot the "in Ns" phrase *before* the ellipsis so the ellipsis
// still trails the whole label: "Capture with details in 2s...".
function delayedTitle(baseTitle: string, delaySec: number): string {
  if (delaySec === 0) return baseTitle;
  if (baseTitle.endsWith('...')) {
    return `${baseTitle.slice(0, -3)} in ${delaySec}s...`;
  }
  return `${baseTitle} in ${delaySec}s`;
}

function delayedTooltip(baseTooltip: string, delaySec: number): string {
  if (delaySec === 0) return baseTooltip;
  const [firstLine, ...rest] = baseTooltip.split('\n');
  const delayed = `${firstLine} in ${delaySec}s`;
  return rest.length > 0 ? `${delayed}\n${rest.join('\n')}` : delayed;
}

const CAPTURE_ACTIONS: CaptureAction[] = BASE_CAPTURE_ACTIONS.flatMap((base) =>
  CAPTURE_DELAYS_SEC.map((delaySec) => ({
    id: delayedId(base.baseId, delaySec),
    title: delayedTitle(base.baseTitle, delaySec),
    tooltip: delayedTooltip(base.baseTooltip, delaySec),
    baseId: base.baseId,
    delaySec,
    run: () => base.run(delaySec * 1000),
  })),
);

function captureActionsWithDelay(delaySec: number): CaptureAction[] {
  return CAPTURE_ACTIONS.filter((a) => a.delaySec === delaySec);
}

function isDefaultableDelay(delaySec: number): boolean {
  return (DEFAULTABLE_DELAYS_SEC as readonly number[]).includes(delaySec);
}

const DEFAULT_CLICK_ACTION_KEY = 'defaultClickAction';
const DEFAULT_CLICK_ACTION_ID = 'capture-with-details';
const DEFAULT_CLICK_PARENT_ID = 'default-click-parent';
const DELAYED_PARENT_ID = 'delayed-capture-parent';
// Child radio items under "Set default click action" use this prefix on
// their ids so the onClicked handler can tell "pick this default"
// clicks apart from the top-level / Delayed-capture "run this now"
// entries, which share the CAPTURE_ACTIONS ids verbatim.
const DEFAULT_CLICK_CHILD_PREFIX = 'set-default-';

function findCaptureAction(id: string | undefined): CaptureAction | undefined {
  return CAPTURE_ACTIONS.find((a) => a.id === id);
}

async function getDefaultClickActionId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEFAULT_CLICK_ACTION_KEY);
  const id = stored[DEFAULT_CLICK_ACTION_KEY];
  // Fall back to capture-with-details if storage is empty or holds
  // a stale id (e.g. after a release that renamed an action).
  return typeof id === 'string' && findCaptureAction(id)
    ? id
    : DEFAULT_CLICK_ACTION_ID;
}

async function getDefaultClickAction(): Promise<CaptureAction> {
  const id = await getDefaultClickActionId();
  return findCaptureAction(id) ?? CAPTURE_ACTIONS[0]!;
}

async function getDefaultActionTooltip(): Promise<string> {
  return (await getDefaultClickAction()).tooltip;
}

const DEFAULT_SELECTED_PREFIX = '✓ ';
const DEFAULT_UNSELECTED_PREFIX = '    ';

function defaultMenuTitle(action: CaptureAction, selected: boolean): string {
  const prefix = selected ? DEFAULT_SELECTED_PREFIX : DEFAULT_UNSELECTED_PREFIX;
  return prefix + action.title;
}

/**
 * Persist a new default click action and update the toolbar
 * tooltip to match. Also update every entry in the "Set default
 * click action" submenu so only the chosen one shows a ✓
 * prefix.
 *
 * Updating a not-yet-created menu id throws
 * `No item with id "…"`; we suppress that because
 * `setDefaultClickActionId` is also called from tests before the
 * first menu install.
 */
async function setDefaultClickActionId(id: string): Promise<void> {
  if (!findCaptureAction(id)) {
    throw new Error(`Unknown capture action id: ${id}`);
  }
  await chrome.storage.local.set({ [DEFAULT_CLICK_ACTION_KEY]: id });
  const defaultables = CAPTURE_ACTIONS.filter((a) => isDefaultableDelay(a.delaySec));
  await Promise.all(
    defaultables.map(async (a) => {
      const childId = DEFAULT_CLICK_CHILD_PREFIX + a.id;
      try {
        await chrome.contextMenus.update(childId, {
          title: defaultMenuTitle(a, a.id === id),
        });
      } catch {
        // Menu not installed yet — first install will pick up the
        // stored preference via installContextMenu.
      }
    }),
  );
  await refreshActionTooltip();
}

/**
 * Update `chrome.action.setTitle` to match the currently selected
 * default click action. Called after the preference changes and on
 * service-worker install/startup so a stale title from a previous
 * session doesn't linger.
 */
async function refreshActionTooltip(): Promise<void> {
  try {
    await chrome.action.setTitle({ title: await getDefaultActionTooltip() });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to refresh action tooltip:', err);
  }
}

// Toolbar icon click → run whichever capture action is the current
// default. Default (on fresh install or if storage is wiped) is
// `capture-with-details`.
//
// The click counts as a user gesture, which is what makes the `activeTab`
// permission (declared in manifest.json) kick in for the current tab —
// including restricted URLs like chrome:// pages, where `<all_urls>` host
// permission alone is not enough. Don't drop `activeTab` from the manifest
// without testing on chrome://extensions or you'll silently re-break this.
//
// We deliberately don't pass the listener's `tab` arg through to
// captureVisible — instead captureVisible re-queries the active tab
// itself, so the immediate and delayed paths share one resolution
// strategy (active tab in the last-focused window).
//
// runWithErrorReporting downgrades rejection to console.warn +
// user-visible icon swap + tooltip "Last error:" line, so
// user-actionable failures like "No active tab found to capture"
// don't get promoted onto the chrome://extensions Errors page.
//
// Extracted from the listener body so tests can drive the dispatch
// directly via `self.SeeWhatISee.handleActionClick()` — Playwright
// has no way to trigger `chrome.action.onClicked` from outside.
//
// Double-click detection state. A second click within the window
// runs an alternate action:
//   - Default is capture-with-details → double-click takes a screenshot
//   - Any other default → double-click opens capture with details
let pendingClickTimer: ReturnType<typeof setTimeout> | undefined;

const DOUBLE_CLICK_MS = 250;

async function handleActionClick(): Promise<void> {
  // If the user is currently looking at a capture.html tab, clicking
  // the toolbar icon triggers its Capture button — same as clicking
  // it on the page. Only the active tab is affected; background
  // capture tabs are left alone.
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.id !== undefined) {
    const stored = await chrome.storage.session.get(detailsStorageKey(activeTab.id));
    if (stored[detailsStorageKey(activeTab.id)]) {
      if (pendingClickTimer !== undefined) {
        clearTimeout(pendingClickTimer);
        pendingClickTimer = undefined;
      }
      await chrome.tabs.sendMessage(activeTab.id, { action: 'triggerCapture' });
      return;
    }
  }

  const actionId = await getDefaultClickActionId();

  // Double-click: run the alternate action.
  if (pendingClickTimer !== undefined) {
    clearTimeout(pendingClickTimer);
    pendingClickTimer = undefined;
    if (actionId === DEFAULT_CLICK_ACTION_ID) {
      await runWithErrorReporting(() => captureVisible());
    } else {
      await runWithErrorReporting(() => startCaptureWithDetails());
    }
    return;
  }

  // First click: wait for a potential second click before running
  // the default action. If the user switches tabs during the 250 ms
  // window, the capture targets whatever tab is visible when the
  // timer fires — captureVisibleTab can only capture what's on
  // screen, and re-activating the original tab would be surprising.
  await new Promise<void>((resolve) => {
    pendingClickTimer = setTimeout(() => {
      pendingClickTimer = undefined;
      const action = findCaptureAction(actionId) ?? CAPTURE_ACTIONS[0]!;
      void runWithErrorReporting(() => action.run()).then(resolve, resolve);
    }, DOUBLE_CLICK_MS);
  });
}

chrome.action.onClicked.addListener(handleActionClick);

// Right-click context menu on the toolbar action. Structure:
//
//   Take screenshot
//   Save html contents
//   Capture with details...
//   Capture with delay  ▸              (submenu)
//       • Take screenshot in 2s
//       • Save html contents in 2s
//       • Capture with details in 2s...
//       ─────────
//       • Take screenshot in 5s
//       • Save html contents in 5s
//       • Capture with details in 5s...
//   Set default click action  ▸     (submenu, ✓ on selected)
//       ✓ Take screenshot
//         Save html contents
//         Capture with details...
//       ─────────
//         Take screenshot in 2s
//         Save html contents in 2s
//         Capture with details in 2s...
//
// Chrome caps each extension at
// `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level
// items in the action context menu. Overflow fails silently via
// `chrome.runtime.lastError`, so a careless addition silently drops
// a previously-working entry. The menu above has 5 top-level
// entries (3 undelayed + 2 submenu parents). "Clear log history"
// is temporarily hidden from the menu — the underlying
// `clearCaptureLog()` is still on `self.SeeWhatISee` for the
// devtools console. **Do not add another top-level entry past 6**
// — nest new items under an existing submenu or introduce a new
// one.
//
// In-submenu separators are free (they don't count against the
// top-level cap) so we use them to group the submenu contents by
// delay.
//
// Every top-level entry, every "Capture with delay" child, and every
// "Set default click action" entry is built from the same
// CAPTURE_ACTIONS array, so ids / titles / run functions can't
// drift. `handleActionClick` looks up the current default out of
// the same array.
//
// The registration runs on `chrome.runtime.onInstalled`; Chrome
// persists the entries across service-worker restarts so we don't
// have to recreate them on every wakeup.
//
// Note: "Take screenshot" is functionally identical to a plain
// left-click when `capture-now` is the default — listed in the
// menu for discoverability so users don't have to know the toolbar
// click also captures.

// Id used by the (currently hidden) "Clear log history" entry.
// Kept alongside the onClicked branch below so re-adding the
// menu item is a one-line change in installContextMenu — don't
// delete as dead code.
const CLEAR_LOG_MENU_ID = 'clear-log';

// "Capture with details…" flow. We grab both the screenshot and
// the HTML up-front (so the user can decide which to save without
// worrying that the page will have changed in the meantime) and
// stash them under a per-tab key in chrome.storage.session.
// The capture.html extension page fetches its data by sending a
// runtime message; we match sender.tab.id to the stored key.
//
// Storage lives in `session` rather than a module-level Map because
// the MV3 service worker can be torn down between the menu click
// and the user clicking Capture on the page — session storage is
// in-memory but survives SW idle-out.
//
// We wrap the InMemoryCapture so we can also remember the opener
// tab id for re-focusing on close. Re-reading
// `chrome.tabs.get(detailsTabId).openerTabId` later isn't reliable —
// `Tab.openerTabId` is one of the fields Chrome strips when the
// extension lacks the `tabs` permission, and `<all_urls>` host
// permission doesn't cover our own `chrome-extension://` details
// tab. Stashing it at create time sidesteps the gap.
const DETAILS_STORAGE_PREFIX = 'captureDetails_';

interface DetailsSession {
  capture: InMemoryCapture;
  // Tab id of the page the user captured from, so we can re-focus
  // it when the details tab closes. Optional: the active-tab
  // lookup can in principle return no id (chrome:// pages, races).
  openerTabId?: number;
}

function detailsStorageKey(tabId: number): string {
  return `${DETAILS_STORAGE_PREFIX}${tabId}`;
}

async function startCaptureWithDetails(delayMs = 0): Promise<void> {
  // Capture both artifacts *before* opening the new tab so we
  // snapshot the user's current page (not the empty capture.html
  // tab). captureBothToMemory queries the active tab itself, after
  // the optional delay, so delayed details captures follow focus /
  // hover state the same way delayed screenshots do.
  const data = await captureBothToMemory(delayMs);

  // Re-query the active tab so we can position the details tab
  // immediately to its right and remember it as the opener. The
  // tab strip hasn't moved between captureBothToMemory's query
  // and now (no async user input in between), so this resolves to
  // the same tab the screenshot came from.
  //
  // We also tried `index: active.index` (left of the opener) on
  // the theory that Chrome's "activate the right neighbor on
  // close" behavior would naturally restore focus to the opener
  // and let us drop the explicit re-activation in `saveDetails`.
  // It didn't pan out: in the headless Playwright tests, after
  // closing a programmatically-opened tab Chrome activates the
  // tab two positions to the right of the closed slot in the
  // original ordering, not the immediate right neighbor. The
  // e2e test caught this. We stick with right-of-active position
  // + explicit re-activation in the finally block.
  //
  // openerTabId helps Chrome group the new tab visually with
  // its opener; it has no role in close-time activation.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const createProps: chrome.tabs.CreateProperties = {
    url: chrome.runtime.getURL('capture.html'),
  };
  if (active?.index !== undefined) createProps.index = active.index + 1;
  if (active?.id !== undefined) createProps.openerTabId = active.id;

  const tab = await chrome.tabs.create(createProps);
  if (tab.id === undefined) {
    throw new Error('Failed to open capture details tab');
  }
  const session: DetailsSession = { capture: data, openerTabId: active?.id };
  await chrome.storage.session.set({ [detailsStorageKey(tab.id)]: session });
}

interface GetDetailsMessage {
  action: 'getDetailsData';
}
interface SaveDetailsMessage {
  action: 'saveDetails';
  screenshot: boolean;
  html: boolean;
  prompt: string;
  /**
   * True when the user drew at least one highlight on the preview.
   * Causes the saved record to carry `highlights: true` (only when
   * `screenshot` is also true — see capture.ts).
   */
  highlights: boolean;
  /**
   * Optional replacement screenshot data URL with the user's
   * highlights baked into the PNG bytes. The capture page sends this
   * only when the user both drew highlights and chose to save the
   * screenshot — otherwise the original (un-annotated) capture in
   * session storage is used as-is.
   */
  screenshotOverride?: string;
}
type DetailsMessage = GetDetailsMessage | SaveDetailsMessage;

chrome.runtime.onMessage.addListener((msg: DetailsMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;

  if (msg.action === 'getDetailsData') {
    void (async () => {
      const key = detailsStorageKey(tabId);
      const stored = await chrome.storage.session.get(key);
      const session = stored[key] as DetailsSession | undefined;
      // The page only needs the capture itself, not the opener id
      // bookkeeping — keep the wire shape unchanged.
      sendResponse(session?.capture);
    })();
    return true; // keep the message channel open for the async response
  }

  if (msg.action === 'saveDetails') {
    void runWithErrorReporting(async () => {
      const key = detailsStorageKey(tabId);
      const stored = await chrome.storage.session.get(key);
      const session = stored[key] as DetailsSession | undefined;
      if (!session) throw new Error('Capture data missing for details tab');
      const capture = session.capture;
      // Swap in the highlight-baked PNG when the page sent one. We
      // shallow-clone so we don't mutate the session-storage object
      // (still owned by Chrome until we remove it in the finally block
      // below) and so a re-read elsewhere wouldn't see the override.
      const captureForSave: InMemoryCapture = msg.screenshotOverride
        ? { ...capture, screenshotDataUrl: msg.screenshotOverride }
        : capture;
      try {
        await saveDetailedCapture({
          capture: captureForSave,
          includeScreenshot: msg.screenshot,
          includeHtml: msg.html,
          prompt: msg.prompt,
          hasHighlights: msg.highlights,
        });
      } finally {
        // Always clean up the stored capture and close the tab, even
        // if saveDetailedCapture throws: the stashed data is no longer
        // useful and the user can click the menu item again to retry.
        //
        // Trade-off: on failure the details tab disappears out from
        // under the user, and the only visible signal is the usual
        // error-icon / tooltip swap from runWithErrorReporting. That's
        // consistent with every other capture path (they all fail
        // silently on-screen and surface the error on the toolbar),
        // and leaving the tab open on failure would strand a
        // now-stale preview the user would have to close by hand.
        await chrome.storage.session.remove(key);
        // Re-activate the opener (the page the user captured from)
        // *before* removing the details tab.
        //
        // We tested removing this and relying on Chrome's natural
        // close behavior. Chrome's pick is not reliably the right
        // neighbor — in headless Playwright tests it activated the
        // tab two positions right of the closed slot, not the
        // immediate right neighbor. The e2e test pins this down.
        //
        // Order matters: activate first, then remove. If we removed
        // first, Chrome would briefly flash its own pick before
        // our update could land.
        const openerTabId = session.openerTabId;
        if (openerTabId !== undefined) {
          try {
            await chrome.tabs.update(openerTabId, { active: true });
          } catch (err) {
            // Best-effort: if the opener was closed during the
            // details flow, just log and proceed with the close.
            console.warn('[SeeWhatISee] failed to focus opener tab:', err);
          }
        }
        try {
          await chrome.tabs.remove(tabId);
        } catch (err) {
          console.warn('[SeeWhatISee] failed to close details tab:', err);
        }
      }
    });
    // No response expected — background closes the tab when done.
    return false;
  }

  return false;
});

// If the user closes a details tab manually (without clicking
// Capture), drop its stashed data so session storage doesn't grow
// until the browser restarts.
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(detailsStorageKey(tabId));
});

async function installContextMenu(): Promise<void> {
  // Read the current default up front so each submenu child can be
  // created with the correct title prefix — `removeAll` wipes
  // Chrome's per-item state along with the entries themselves, so
  // we can't rely on persisted state.
  const defaultId = await getDefaultClickActionId();

  // ── Top-level entries (delay 0 only) ────────────────────────
  // The three undelayed capture actions, one per base action.
  for (const action of captureActionsWithDelay(0)) {
    chrome.contextMenus.create({
      id: action.id,
      title: action.title,
      contexts: ['action'],
    });
  }

  // ── "Capture with delay" submenu ──────────────────────────────
  // One parent row; Chrome renders the ▸ because it has children
  // (set via parentId below).
  chrome.contextMenus.create({
    id: DELAYED_PARENT_ID,
    title: 'Capture with delay',
    contexts: ['action'],
  });
  const delayedDelays = CAPTURE_DELAYS_SEC.filter((d) => d !== 0);
  for (let i = 0; i < delayedDelays.length; i++) {
    const delaySec = delayedDelays[i]!;
    if (i > 0) {
      // Visual separator between delay groups. Separators inside a
      // submenu don't count against the top-level cap.
      chrome.contextMenus.create({
        id: `${DELAYED_PARENT_ID}-sep-${delaySec}`,
        parentId: DELAYED_PARENT_ID,
        type: 'separator',
        contexts: ['action'],
      });
    }
    for (const action of captureActionsWithDelay(delaySec)) {
      chrome.contextMenus.create({
        id: action.id,
        parentId: DELAYED_PARENT_ID,
        title: action.title,
        contexts: ['action'],
      });
    }
  }

  // ── "Set default click action" submenu ──────────────────────
  // Uses normal items with a ✓ prefix on the selected entry
  // instead of radio items. Chrome's radio mutual-exclusion only
  // covers a contiguous run, so a separator causes two items to
  // appear selected. Normal items with a text marker avoid that.
  chrome.contextMenus.create({
    id: DEFAULT_CLICK_PARENT_ID,
    title: 'Set default click action',
    contexts: ['action'],
  });
  for (let i = 0; i < DEFAULTABLE_DELAYS_SEC.length; i++) {
    const delaySec = DEFAULTABLE_DELAYS_SEC[i]!;
    if (i > 0) {
      chrome.contextMenus.create({
        id: `${DEFAULT_CLICK_PARENT_ID}-sep-${delaySec}`,
        parentId: DEFAULT_CLICK_PARENT_ID,
        type: 'separator',
        contexts: ['action'],
      });
    }
    for (const action of captureActionsWithDelay(delaySec)) {
      chrome.contextMenus.create({
        id: DEFAULT_CLICK_CHILD_PREFIX + action.id,
        parentId: DEFAULT_CLICK_PARENT_ID,
        title: defaultMenuTitle(action, action.id === defaultId),
        contexts: ['action'],
      });
    }
  }

  // "Clear log history" is temporarily hidden — we left the
  // handler branch in `onClicked` and kept `clearCaptureLog()`
  // exposed on `self.SeeWhatISee`, so restoring the entry later is
  // just un-skipping this create call.
}

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first because onInstalled fires on `install`, `update`,
  // and `chrome_update`. On the update paths the previously-created
  // menu entries are still in Chrome's persisted extension state, and
  // calling `create` with the same id would throw "Cannot create item
  // with duplicate id". `removeAll` is a clean wipe that handles all
  // three cases identically.
  chrome.contextMenus.removeAll(() => {
    void installContextMenu();
  });
  // Also make sure the icon tooltip reflects the stored default
  // after an update — the old build may have written a title that's
  // no longer accurate.
  void refreshActionTooltip();
});

// Browser restart: onInstalled doesn't fire, but we still want the
// tooltip to match the stored preference. Chrome persists the
// `chrome.action.setTitle` value across restarts, so this is a
// belt-and-suspenders refresh in case anything has fallen out of
// sync (e.g. a storage write that raced the previous shutdown).
chrome.runtime.onStartup.addListener(() => {
  void refreshActionTooltip();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const id = String(info.menuItemId);

  // "Set default click action" submenu: a click just persists the
  // new preference. Not routed through runWithErrorReporting —
  // flipping a setting isn't a capture, and painting the error
  // icon on a failed storage write would be misleading.
  //
  // On failure the ✓ prefix stays on the old item (the title
  // updates happen after the storage write), so the menu remains
  // consistent with the stored value.
  if (id.startsWith(DEFAULT_CLICK_CHILD_PREFIX)) {
    const actionId = id.slice(DEFAULT_CLICK_CHILD_PREFIX.length);
    try {
      await setDefaultClickActionId(actionId);
    } catch (err) {
      console.warn('[SeeWhatISee] failed to set default click action:', err);
    }
    return;
  }

  // Top-level capture entry: run its action.
  const action = findCaptureAction(id);
  if (action) {
    await runWithErrorReporting(() => action.run());
    return;
  }

  // Clear history. Routed through runWithErrorReporting for
  // consistency with the capture paths: on success the error
  // state is cleared, and on failure the same icon/tooltip
  // channels tell the user something went wrong.
  if (id === CLEAR_LOG_MENU_ID) {
    await runWithErrorReporting(() => clearCaptureLog());
    return;
  }

  // Fallthrough: a click on a menu item we don't recognize.
  // Shouldn't happen in the current menu, but if a future
  // contextMenus.create call adds an id without a matching branch
  // above, this warning makes the drop visible in the SW console
  // instead of silently doing nothing.
  console.warn('[SeeWhatISee] unhandled context menu id:', id);
});

// Expose capture functions on the service worker global so they can be
// invoked from:
//   - Playwright tests via `serviceWorker.evaluate(() => self.SeeWhatISee.captureVisible())`
//   - the service worker devtools console for manual debugging
//
// Each future menu variation (full page, element, etc.) should be added here
// as a new entry so it stays callable from tests without additional plumbing.
(self as unknown as { SeeWhatISee: Record<string, unknown> }).SeeWhatISee = {
  captureVisible,
  savePageContents,
  captureBothToMemory,
  saveDetailedCapture,
  startCaptureWithDetails,
  clearCaptureLog,
  reportCaptureError,
  clearCaptureError,
  runWithErrorReporting,
  handleActionClick,
  getDefaultClickActionId,
  setDefaultClickActionId,
  refreshActionTooltip,
};
