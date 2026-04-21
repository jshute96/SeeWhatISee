import {
  captureBothToMemory,
  captureSelection,
  captureVisible,
  clearCaptureLog,
  downloadHtml,
  downloadScreenshot,
  downloadSelection,
  DOWNLOAD_SUBDIR,
  LOG_STORAGE_KEY,
  recordDetailedCapture,
  savePageContents,
  waitForDownloadComplete,
  type CaptureRecord,
  type EditableArtifactKind,
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
  'No text selected',
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
// capture (plain screenshot, HTML contents, the details flow, or
// one of the fixed-checkbox details-flow shortcuts) and the delay
// says *when* to capture (immediate, 2s, or 5s). We define the
// bases once and expand them across the delays at module load so
// every menu surface stays in sync from a single source.
//
// A base can opt out of delayed variants via
// `supportsDelayed: false`; it then produces only the 0s variant.
// Used for modes where a delay doesn't pay for itself — e.g.
// `capture-selection` (the user already made the selection before
// clicking) or `capture-url` (the click's intent is "record *this*
// URL"; a delayed version would just record a *different* URL if
// the user navigated).
//
// Each base also carries a `group: 'primary' | 'more'` that decides
// which section of the action menu surfaces its undelayed variant
// — see the `ActionGroup` comment below.
//
// The resulting flat `CAPTURE_ACTIONS` array drives four things:
//   - the top-level menu entries (primary, delay 0)
//   - the "Capture with delay" submenu children (primary, delay > 0)
//   - the "More" submenu's capture shortcuts at the top (more, delay 0)
//   - the "Set default click action" submenu (every base × every delay)
// and is the lookup table `handleActionClick` uses to run the
// currently-selected default.
//
// Keep the first base action at delay 0 first: that's the default
// fallback when nothing is stored yet, and its tooltip matches the
// manifest's `action.default_title` so the hover text is correct
// during the brief window between a fresh install and the first
// tooltip refresh from `refreshActionTooltip()`.

/**
 * Which section of the action menu surfaces an undelayed base action:
 *   - `'primary'` — top-level menu entry + a slot in the "Capture
 *     with delay" submenu for each delayed variant.
 *   - `'more'`    — entry at the top of the More submenu; delayed
 *     variants are only reachable via "Set default click action".
 *
 * Every base action also appears in "Set default click action" regardless
 * of group (all defaultable delays × all bases).
 */
type ActionGroup = 'primary' | 'more';

interface BaseCaptureAction {
  /** Stable base id, e.g. `capture-now`. Delayed variants append
   * `-<N>s`. */
  baseId: string;
  /** Short label for the undelayed variant, e.g. "Take screenshot". */
  baseTitle: string;
  /** Tooltip for the undelayed variant. */
  baseTooltip: string;
  /** Menu placement for the undelayed variant (see `ActionGroup`). */
  group: ActionGroup;
  /** When `false`, only the 0s variant is generated — no 2s / 5s
   * entries show up anywhere. Defaults to `true`. */
  supportsDelayed?: boolean;
  /** Whether delayed variants appear in the "Capture with delay"
   * submenu. Defaults to `group === 'primary'` — i.e. primary bases
   * surface their delayed variants there, more-group bases don't.
   * Setting `true` on a more-group base promotes its delayed
   * variants up into Capture-with-delay while leaving the undelayed
   * variant in the More submenu. */
  showInDelayedSubmenu?: boolean;
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
  /** Inherited from the base action — controls which menu section
   * this entry goes in. */
  group: ActionGroup;
  /** Inherited from the base action's `showInDelayedSubmenu`.
   * Non-zero-delay entries with this `true` appear in the
   * "Capture with delay" submenu regardless of their `group`. */
  showInDelayedSubmenu: boolean;
  /** 0 for immediate; >0 for a delayed variant. Used to slot the
   * entry into the right menu section. */
  delaySec: number;
  /** Runs when the user picks this action (either from the top-level
   * menu entry, the Capture with delay submenu, or a toolbar click
   * when it's the current default). */
  run: () => Promise<unknown>;
}

/**
 * "Capture URL" — the details-page "neither file checked" path, run
 * without opening the page. Still goes through `captureBothToMemory`
 * so the delay / active-tab-after-delay semantics match every other
 * capture, but the screenshot + HTML payloads are discarded — only
 * the timestamp + URL (and any future prompt plumbing) hit the log.
 *
 * Deliberately ignores `data.htmlError` — a URL-only record doesn't
 * need HTML, so a restricted-URL scrape failure shouldn't block it.
 */
async function captureUrlOnly(delayMs = 0): Promise<void> {
  const data = await captureBothToMemory(delayMs);
  await recordDetailedCapture({
    capture: data,
    includeScreenshot: false,
    includeHtml: false,
    includeSelection: false,
  });
}

/**
 * "Capture screenshot and HTML" — the details-page "both files
 * checked" path, run without opening the page. Grabs both artifacts,
 * writes them, and records a sidecar entry referencing both.
 *
 * Unlike the details flow (which gracefully falls back to a
 * screenshot-only UI), this shortcut *requires* HTML by definition,
 * so we surface an `htmlError` as a thrown error — the action's
 * error-reporting channel then swaps the icon / tooltip so the user
 * sees why nothing landed.
 */
async function captureBoth(delayMs = 0): Promise<void> {
  const data = await captureBothToMemory(delayMs);
  if (data.htmlError) {
    throw new Error(data.htmlError);
  }
  await downloadScreenshot(data);
  await downloadHtml(data);
  await recordDetailedCapture({
    capture: data,
    includeScreenshot: true,
    includeHtml: true,
    includeSelection: false,
  });
}

// Array order is user-visible: within each delay row / group, menu
// entries appear in the order their bases are declared here.
const BASE_CAPTURE_ACTIONS: BaseCaptureAction[] = [
  {
    baseId: 'capture-now',
    baseTitle: 'Take screenshot',
    baseTooltip: 'SeeWhatISee — Capture visible tab\nDouble-click for capture with details',
    group: 'primary',
    run: (delayMs) => captureVisible(delayMs),
  },
  {
    baseId: 'save-page-contents',
    baseTitle: 'Save html contents',
    baseTooltip: 'SeeWhatISee — Save HTML contents\nDouble-click for capture with details',
    group: 'primary',
    run: (delayMs) => savePageContents(delayMs),
  },
  {
    baseId: 'capture-with-details',
    baseTitle: 'Capture with details...',
    baseTooltip: 'SeeWhatISee — Capture with details\nDouble-click for screenshot',
    group: 'primary',
    run: (delayMs) => startCaptureWithDetails(delayMs),
  },
  {
    baseId: 'capture-url',
    baseTitle: 'Capture URL',
    baseTooltip: 'SeeWhatISee — Capture URL only\nDouble-click for capture with details',
    group: 'more',
    // A URL capture is a trivially cheap log write, so the only
    // thing a delay could change is the URL itself (user navigates
    // mid-countdown). That's a surprising interaction — the click's
    // intent is "record *this* URL" — and it's easy to reproduce
    // intentionally by just opening the other page first.
    supportsDelayed: false,
    run: (delayMs) => captureUrlOnly(delayMs),
  },
  {
    baseId: 'capture-both',
    baseTitle: 'Capture screenshot and HTML',
    baseTooltip: 'SeeWhatISee — Capture screenshot + HTML\nDouble-click for capture with details',
    group: 'more',
    // Promote delayed variants up into the Capture-with-delay
    // submenu (next to plain screenshot / HTML / details). The
    // undelayed variant stays in More — this is still a slightly
    // niche combo at 0s — but a delayed screenshot-AND-HTML is
    // useful enough to surface alongside the primary delayed entries.
    showInDelayedSubmenu: true,
    run: (delayMs) => captureBoth(delayMs),
  },
  {
    baseId: 'capture-selection',
    baseTitle: 'Capture selection',
    baseTooltip: 'SeeWhatISee — Capture selected text\nDouble-click for capture with details',
    group: 'more',
    // The selection already exists when the user triggers the
    // action; waiting doesn't help. Still bindable as the default
    // click action at 0s via "Set default click action".
    supportsDelayed: false,
    run: (delayMs) => captureSelection(delayMs),
  },
];

// All delays (in seconds) we surface in the menu. 0 is the plain
// top-level entry set; 2 and 5 go into the "Capture with delay" submenu.
const CAPTURE_DELAYS_SEC = [0, 2, 5] as const;

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

const CAPTURE_ACTIONS: CaptureAction[] = BASE_CAPTURE_ACTIONS.flatMap((base) => {
  const delays = base.supportsDelayed === false ? [0] : CAPTURE_DELAYS_SEC;
  const showInDelayedSubmenu = base.showInDelayedSubmenu ?? base.group === 'primary';
  return delays.map((delaySec) => ({
    id: delayedId(base.baseId, delaySec),
    title: delayedTitle(base.baseTitle, delaySec),
    tooltip: delayedTooltip(base.baseTooltip, delaySec),
    baseId: base.baseId,
    group: base.group,
    showInDelayedSubmenu,
    delaySec,
    run: () => base.run(delaySec * 1000),
  }));
});

function captureActionsWithDelay(delaySec: number, group?: ActionGroup): CaptureAction[] {
  return CAPTURE_ACTIONS.filter(
    (a) => a.delaySec === delaySec && (group === undefined || a.group === group),
  );
}

function isDefaultableDelay(delaySec: number): boolean {
  return (CAPTURE_DELAYS_SEC as readonly number[]).includes(delaySec);
}

const DEFAULT_CLICK_ACTION_KEY = 'defaultClickAction';
const DEFAULT_CLICK_ACTION_ID = 'capture-with-details';
const DEFAULT_CLICK_PARENT_ID = 'default-click-parent';
const DELAYED_PARENT_ID = 'delayed-capture-parent';
const MORE_PARENT_ID = 'more-parent';
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

// Hints marking which top-level / "Capture with delay" entries will
// run on toolbar click vs. double-click.
//   - Faked italics via Unicode mathematical sans-serif italic
//     letters — `chrome.contextMenus` titles are plain text, no
//     markup support.
//   - No column alignment — the API has no accelerator / secondary-
//     label slot, and menu rendering uses the platform UI font
//     (Segoe UI / GTK / NSMenu), so space-padding only approximates
//     a column on one machine. An inline dash reads as intentional
//     on every platform.
const HINT_SEPARATOR = '  -  ';
const CLICK_HINT = `${HINT_SEPARATOR}(𝘊𝘭𝘪𝘤𝘬)`;
const DOUBLE_CLICK_HINT = `${HINT_SEPARATOR}(𝘋𝘰𝘶𝘣𝘭𝘦-𝘤𝘭𝘪𝘤𝘬)`;

// The double-click target is derived from the current click default:
// if details is the default, double-click takes a screenshot; otherwise
// double-click opens capture-with-details. Mirrors the branch in
// handleActionClick so menu hints always match runtime behavior.
function doubleClickActionId(clickId: string): string {
  return clickId === DEFAULT_CLICK_ACTION_ID ? 'capture-now' : DEFAULT_CLICK_ACTION_ID;
}

function actionMenuTitle(
  action: CaptureAction,
  clickId: string,
  doubleClickId: string,
): string {
  if (action.id === clickId) return action.title + CLICK_HINT;
  if (action.id === doubleClickId) return action.title + DOUBLE_CLICK_HINT;
  return action.title;
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
  const dblId = doubleClickActionId(id);
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
  // Refresh the (Click) / (Double-click) hints on every run entry —
  // every CAPTURE_ACTIONS entry is registered under `a.id` in exactly
  // one place (top-level when delaySec === 0, Capture-with-delay
  // submenu otherwise), so a single update call per id covers both.
  await Promise.all(
    CAPTURE_ACTIONS.map(async (a) => {
      try {
        await chrome.contextMenus.update(a.id, {
          title: actionMenuTitle(a, id, dblId),
        });
      } catch {
        // Menu not installed yet — first install picks up the hints
        // via installContextMenu.
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
//   Capture with delay  ▸              (submenu, bases with showInDelayedSubmenu)
//       • Take screenshot in 2s
//       • Save html contents in 2s
//       • Capture with details in 2s...
//       • Capture screenshot and HTML in 2s
//       ─────────
//       • Take screenshot in 5s
//       • Save html contents in 5s
//       • Capture with details in 5s...
//       • Capture screenshot and HTML in 5s
//   Set default click action  ▸     (submenu, ✓ on selected; every base × its delays)
//       ✓ Take screenshot
//         Save html contents
//         Capture with details...
//         Capture URL                 (no delayed variants)
//         Capture screenshot and HTML
//         Capture selection           (no delayed variants)
//       ─────────
//         Take screenshot in 2s
//         Save html contents in 2s
//         Capture with details in 2s...
//         Capture screenshot and HTML in 2s
//       ─────────
//         Take screenshot in 5s
//         Save html contents in 5s
//         Capture with details in 5s...
//         Capture screenshot and HTML in 5s
//   More  ▸                         (submenu)
//       • Capture URL
//       • Capture screenshot and HTML
//       • Capture selection     (saves HTML of the page selection)
//       ─────────
//       • Copy last screenshot filename   (greyed unless latest record has a screenshot)
//       • Copy last HTML filename     (greyed unless latest record has HTML)
//       ─────────
//       • Snapshots directory
//       ─────────
//       • Clear log history
//
// Chrome caps each extension at
// `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level
// items in the action context menu. Overflow fails silently via
// `chrome.runtime.lastError`, so a careless addition silently drops
// a previously-working entry. The menu above has 6 top-level
// entries (3 undelayed + 3 submenu parents) — **at the cap**. Do
// not add another top-level entry — nest new items under an
// existing submenu (the `More` submenu is a natural home for
// infrequent utilities).
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

// Id used by the "Clear log history" entry under the More submenu.
const CLEAR_LOG_MENU_ID = 'clear-log';
// Id used by the "Snapshots directory" entry under the More submenu.
const SNAPSHOTS_DIR_MENU_ID = 'snapshots-directory';
// Ids for the "Copy last …" entries at the top of the More submenu.
// Their enabled state mirrors whether the most recent capture record
// carries the matching field (`screenshot` / `contents`); see
// `refreshCopyMenuState`.
const COPY_LAST_SCREENSHOT_MENU_ID = 'copy-last-screenshot';
const COPY_LAST_HTML_MENU_ID = 'copy-last-html';

/**
 * Read the most recent capture record from chrome.storage.local. Used
 * to drive both the Copy-last-… menu enable state and the actual copy
 * action when one is clicked.
 */
async function getLatestCaptureRecord(): Promise<CaptureRecord | undefined> {
  const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
  const log = (data[LOG_STORAGE_KEY] as CaptureRecord[] | undefined) ?? [];
  return log[log.length - 1];
}

/**
 * Toggle `enabled` on the two Copy-last-… menu entries to match the
 * most recent capture record. Called on install/startup, and from a
 * `chrome.storage.onChanged` listener so every capture (and the Clear
 * log history action) refreshes the state without explicit plumbing
 * between capture.ts and background.ts.
 *
 * `chrome.contextMenus.update` rejects if the menu isn't installed yet
 * — harmless during the first install pass before the items have been
 * created — so we swallow the error.
 */
async function refreshCopyMenuState(): Promise<void> {
  const r = await getLatestCaptureRecord();
  // Same suppression pattern as `setDefaultClickActionId`: updating a
  // not-yet-created menu id throws `No item with id "…"`; harmless
  // during first install before the items exist.
  try {
    await chrome.contextMenus.update(COPY_LAST_SCREENSHOT_MENU_ID, {
      enabled: !!r?.screenshot,
    });
  } catch {
    /* menu not installed yet */
  }
  try {
    await chrome.contextMenus.update(COPY_LAST_HTML_MENU_ID, {
      enabled: !!r?.contents,
    });
  } catch {
    /* menu not installed yet */
  }
}

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/**
 * Copy `text` to the system clipboard via an offscreen document.
 *
 * MV3 service workers have no DOM and don't expose `navigator.clipboard`,
 * so we host a hidden offscreen page (`offscreen.html` + `offscreen.ts`)
 * whose only job is to do the copy via `document.execCommand('copy')`
 * on a temporary <textarea>.
 *
 * The document is created on demand and **kept alive** for the SW
 * lifetime. We deliberately don't close it after each copy:
 *   - Closing creates a race against a second concurrent copy — the
 *     teardown from call A would tear out the document call B is
 *     still mid-message on, and B sees `undefined` (no listener).
 *   - The page is hidden and holds only a single message listener,
 *     so the resource cost is negligible.
 *   - When the SW idles out, Chrome tears down the document with it,
 *     so we don't leak past an SW lifetime either.
 *
 * `createDocument` rejects if the document already exists; we
 * try-catch and reuse rather than calling `hasDocument()` first to
 * keep the *creation* step race-free against a second concurrent
 * copy that arrives while creation is in flight.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Copy capture filename to the clipboard.',
    });
  } catch (err) {
    // "Only a single offscreen document may be created" — fine, reuse.
    if (!(err instanceof Error) || !err.message.includes('Only a single offscreen document')) {
      throw err;
    }
  }
  const response = (await chrome.runtime.sendMessage({
    target: 'offscreen-copy',
    text,
  })) as { ok?: boolean; error?: string } | undefined;
  // Distinguish "no listener responded" from "listener responded but
  // execCommand returned false" — the two failure modes have very
  // different fixes (loader timing vs. browser policy / focus).
  if (response === undefined) {
    throw new Error('Offscreen document did not respond (listener not registered yet?)');
  }
  if (!response.ok) {
    throw new Error(`Clipboard copy rejected${response.error ? `: ${response.error}` : ''}`);
  }
}

/**
 * Resolve the absolute on-disk directory where this extension writes
 * its captures (`<downloads>/SeeWhatISee/`). The user's downloads root
 * is OS- and config-dependent and not exposed by any Chrome API, so we
 * derive it by searching `chrome.downloads.search` for our `log.json`
 * record (every capture overwrites it, so the most recent match points
 * at the live directory — even on a fresh SW load where in-memory
 * state is empty).
 *
 * - Pinning the search to `log.json` rather than any file under a
 *   `SeeWhatISee/` folder avoids false matches in same-named
 *   directories the user happens to use (e.g. `/tmp/SeeWhatISee/`).
 * - `byExtensionId` is checked client-side (the `DownloadQuery` type
 *   doesn't accept it as a filter — it's a result-only field) as a
 *   second guard against an unrelated `log.json` in such a folder.
 *
 * Throws when no capture has happened yet so the caller can surface
 * a "capture once first" message via the icon/tooltip error channel.
 */
async function getCaptureDirectory(): Promise<string> {
  const candidates = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\]log\\.json$`,
    orderBy: ['-startTime'],
  });
  const ours = candidates.find((it) => it.byExtensionId === chrome.runtime.id);
  const fullPath = ours?.filename;
  if (!fullPath) {
    throw new Error(
      `No captures yet — capture something first to create the ${DOWNLOAD_SUBDIR} directory.`,
    );
  }
  // Strip the basename. `chrome.downloads.search().filename` is
  // documented to be the absolute path to a file (never ends in a
  // separator), so this always trims one segment.
  return fullPath.replace(/[/\\][^/\\]+$/, '');
}

/**
 * Join `dir` and `name` using whichever separator `dir` already uses.
 * `chrome.downloads.search` returns OS-native paths — backslashes on
 * Windows, forward slashes elsewhere — so reusing the existing
 * separator keeps the result paste-ready in the user's OS shell /
 * file manager.
 */
function joinCapturePath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${name}`;
}

// The `if (!r) ...` / `if (!r.screenshot) ...` branches below are
// defensive — under normal use the menu items are greyed out (so the
// click can't fire), but the user can still hit a small race window
// if they Clear log history (or it gets cleared) between the
// `refreshCopyMenuState` storage callback firing and Chrome rendering
// the new enabled state. Splitting the two messages keeps the
// "Last error: …" tooltip line legible in either case.
async function copyLastScreenshotFilename(): Promise<void> {
  const r = await getLatestCaptureRecord();
  if (!r) throw new Error('No captures in the log to copy from');
  if (!r.screenshot) throw new Error('Latest capture has no screenshot to copy');
  const dir = await getCaptureDirectory();
  await copyToClipboard(joinCapturePath(dir, r.screenshot.filename));
}

async function copyLastHtmlFilename(): Promise<void> {
  const r = await getLatestCaptureRecord();
  if (!r) throw new Error('No captures in the log to copy from');
  if (!r.contents) throw new Error('Latest capture has no HTML snapshot to copy');
  const dir = await getCaptureDirectory();
  await copyToClipboard(joinCapturePath(dir, r.contents.filename));
}

/**
 * Open the on-disk capture directory in a new tab as a `file://` URL
 * so the user can browse the saved screenshots / HTML / `log.json`.
 */
async function openSnapshotsDirectory(): Promise<void> {
  const dir = await getCaptureDirectory();
  // Build a properly-encoded file:// URL. Normalize Windows backslashes
  // to forward slashes, prepend a leading `/` for Windows paths like
  // `C:/Users/…` so the URL parser sees an absolute path, and let
  // `new URL` percent-encode anything weird (spaces in user names,
  // `#`, `?`, non-ASCII characters).
  const normalized = dir.replace(/\\/g, '/');
  const fileUrl = new URL(`file://${normalized.startsWith('/') ? '' : '/'}${normalized}`).href;
  await chrome.tabs.create({ url: fileUrl });
}

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
  // Per-artifact download tracking.
  //
  // The page's Copy-filename buttons materialize the file on demand
  // so the clipboard always carries a real on-disk path. Subsequent
  // clicks (and the eventual Capture click) reuse the cached path
  // unless something has invalidated it:
  //   - `screenshot.editVersion` is the page's monotonically
  //     incrementing edit counter at download time. A change in
  //     edit count means the user drew / undid / cleared a
  //     highlight, so the next request re-downloads with the new
  //     baked-in PNG.
  //   - HTML / selection invalidate only when the user saves an edit
  //     in the corresponding Edit dialog — handled by the generic
  //     `updateArtifact` message (see `applyArtifactEdit`).
  downloads?: {
    screenshot?: { downloadId: number; editVersion: number; path: string };
    html?: { downloadId: number; path: string };
    // Selection follows the same cache + invalidation policy as
    // `html`: unconditional until the user saves an edit via the
    // Edit selection dialog, which fires `updateArtifact` and drops
    // this entry so the next Copy / Capture re-materializes the
    // edited body under the same pinned `selectionFilename`.
    selection?: { downloadId: number; path: string };
  };
  /**
   * Sticky per-artifact "was edited" flags. Set by the
   * `updateArtifact` handler when the user saves in the
   * corresponding dialog, and forwarded to `recordDetailedCapture`
   * at save time so the sidecar record's `contents` / `selection`
   * artifact object carries `isEdited: true`. Never cleared within
   * a session — once the body is the user's edit, it stays the
   * user's edit for any later save.
   */
  htmlEdited?: boolean;
  selectionEdited?: boolean;
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
interface EnsureDownloadedMessage {
  action: 'ensureDownloaded';
  /** Which artifact the page wants on disk and a path for. */
  kind: 'screenshot' | 'html' | 'selection';
  /**
   * Page's monotonically-incrementing edit counter at the moment of
   * this request. Only meaningful for `kind === 'screenshot'`; the
   * SW's per-tab cache compares it against the version of the last
   * download and re-downloads on mismatch. HTML messages send 0 (or
   * omit) — the SW never invalidates the HTML cache.
   */
  editVersion?: number;
  /**
   * Highlight-baked PNG data URL, sent only when `kind ===
   * 'screenshot'` and `edits.length > 0` on the page. Used as the
   * download body when a re-download fires. Ignored when the cache
   * matches and we return the existing path.
   */
  screenshotOverride?: string;
}
interface UpdateArtifactMessage {
  action: 'updateArtifact';
  /** Which captured body to replace. */
  kind: EditableArtifactKind;
  /**
   * Full replacement body. Sent by the details page when the user
   * saves an edit in the corresponding Edit dialog.
   */
  value: string;
}
interface SaveDetailsMessage {
  action: 'saveDetails';
  screenshot: boolean;
  html: boolean;
  selection: boolean;
  prompt: string;
  /**
   * True when at least one un-converted red rectangle or line is on
   * the preview. Causes the saved record's screenshot artifact to
   * carry `hasHighlights: true` (only when `screenshot` is also
   * true — see capture.ts). Rectangles the user converted to
   * redactions / crops don't count — those get their own flags.
   */
  highlights: boolean;
  /**
   * True when the baked PNG contains at least one redaction
   * rectangle. Causes the saved record's screenshot artifact to
   * carry `hasRedactions: true` (only when `screenshot` is also
   * true).
   */
  hasRedactions: boolean;
  /**
   * True when the baked PNG was cropped to a user-selected region.
   * Causes the saved record's screenshot artifact to carry
   * `isCropped: true` (only when `screenshot` is also true).
   */
  isCropped: boolean;
  /** Edit counter — same meaning as on `EnsureDownloadedMessage`. */
  editVersion?: number;
  /**
   * Optional replacement screenshot data URL with the user's
   * highlights baked into the PNG bytes. The capture page sends this
   * only when the user both drew highlights and chose to save the
   * screenshot — otherwise the original (un-annotated) capture in
   * session storage is used as-is.
   */
  screenshotOverride?: string;
}
type DetailsMessage =
  | GetDetailsMessage
  | EnsureDownloadedMessage
  | UpdateArtifactMessage
  | SaveDetailsMessage;

/**
 * Read the per-tab DetailsSession out of session storage. Returns
 * `undefined` when the entry is missing (e.g. the user closed the
 * details tab between message dispatch and handler, or the SW was
 * torn down and lost the in-memory link). Most callers wrap this
 * with `requireDetailsSession` to throw; `getDetailsData` calls it
 * directly so it can no-op silently and let the page render a
 * blank state instead of surfacing an error.
 */
async function loadDetailsSession(tabId: number): Promise<DetailsSession | undefined> {
  const key = detailsStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] as DetailsSession | undefined;
}

/**
 * Throwing wrapper around `loadDetailsSession`. Use this from
 * handlers that can't sensibly proceed without a session (the
 * `ensureDownloaded` and `saveDetails` paths).
 */
async function requireDetailsSession(tabId: number): Promise<DetailsSession> {
  const session = await loadDetailsSession(tabId);
  if (!session) throw new Error('Capture data missing for details tab');
  return session;
}

/**
 * Persist a (possibly mutated) DetailsSession back to session
 * storage under the same per-tab key. Used after we update the
 * `downloads` cache so future Copy / Capture clicks can reuse the
 * already-downloaded files.
 */
async function saveDetailsSession(tabId: number, session: DetailsSession): Promise<void> {
  await chrome.storage.session.set({ [detailsStorageKey(tabId)]: session });
}

/**
 * Shared skeleton for the ensure*Downloaded helpers. All three (and
 * any future ones) follow the same shape:
 *
 *   1. Load session.
 *   2. Precondition check (optional) — throw if the capture
 *      doesn't carry what the artifact needs.
 *   3. Cache hit? Return the cached path immediately. The "is this
 *      cache entry still valid?" decision is parameterized via
 *      `getCachedPath` so the screenshot path can compare
 *      `editVersion` and invalidate, while html/selection just
 *      accept any existing entry.
 *   4. Start the download + wait for it to complete.
 *   5. Re-read the session and either (a) commit the new entry or
 *      (b) defer to a newer entry another concurrent call wrote
 *      while our download was in flight. `shouldCommit` lets the
 *      screenshot branch override this when our version is still
 *      as fresh as the committed one.
 *   6. Return the on-disk path.
 *
 * Concurrency caveat: the read-modify-write on `session.downloads`
 * is *not* atomic across artifacts. Two concurrent calls for
 * *different* artifacts (e.g. screenshot + html completing close
 * together) each re-read session independently, and the later
 * writer can clobber the earlier one's just-committed entry. In
 * practice the user latency between clicking Copy and clicking
 * Capture (or drawing highlights) is orders of magnitude larger
 * than download completion, so this window doesn't occur — but if
 * the helper is ever used from a path that issues truly concurrent
 * multi-artifact downloads, add a mutex here.
 */
async function ensureArtifactDownloaded<T extends { downloadId: number; path: string }>(
  tabId: number,
  options: {
    /** Returns the path of a still-valid cached entry, or
     * `undefined` to force a fresh download. */
    getCachedPath: (session: DetailsSession) => string | undefined;
    /** Throws if the session state can't support this artifact. */
    precondition?: (session: DetailsSession) => void;
    /** Start the actual download. */
    startDownload: (capture: InMemoryCapture) => Promise<number>;
    /** Build the cache entry object for the downloaded file. */
    makeCacheEntry: (downloadId: number, path: string) => T;
    /**
     * Decide whether our just-completed download should win over a
     * cache entry another concurrent call (or an edit handler) may
     * have committed / dropped while we were waiting. Gets both
     * the re-read session and the current per-kind cache entry:
     *   - html / selection: `!fresh && freshSession[kind]Edited ===
     *     wasEditedAtStart` — refuse to commit when an edit landed
     *     during our download (our on-disk bytes are pre-edit).
     *   - screenshot: `!fresh || our editVersion >= fresh.editVersion`.
     */
    shouldCommit: (fresh: T | undefined, freshSession: DetailsSession) => boolean;
    /** Key under which to store the entry on session.downloads. */
    downloadsKey: 'screenshot' | 'html' | 'selection';
  },
): Promise<string> {
  const session = await requireDetailsSession(tabId);
  if (options.precondition) options.precondition(session);

  const cachedPath = options.getCachedPath(session);
  if (cachedPath !== undefined) return cachedPath;

  const downloadId = await options.startDownload(session.capture);
  const path = await waitForDownloadComplete(downloadId);

  const fresh = await requireDetailsSession(tabId);
  const freshCached = fresh.downloads?.[options.downloadsKey] as T | undefined;
  if (options.shouldCommit(freshCached, fresh)) {
    fresh.downloads = {
      ...(fresh.downloads ?? {}),
      [options.downloadsKey]: options.makeCacheEntry(downloadId, path),
    };
    await saveDetailsSession(tabId, fresh);
  }
  return path;
}

/**
 * Materialize the screenshot file on disk if needed and return its
 * absolute on-disk path. Cache key is `editVersion`: a change means
 * the user drew / undid / cleared a highlight, so the on-disk PNG
 * is stale and we re-download with the page's freshly baked-in
 * override. Same-version reads hit the cache.
 *
 * Concurrency: a fast user clicking Copy → drawing → clicking Copy
 * again can interleave two in-flight downloads on the same tab. The
 * `shouldCommit` predicate keeps a slow v1 download from clobbering
 * a v2 entry that's already landed; the wait-for-complete latency
 * is the only window where this matters.
 */
async function ensureScreenshotDownloaded(
  tabId: number,
  editVersion: number,
  screenshotOverride: string | undefined,
): Promise<string> {
  return ensureArtifactDownloaded(tabId, {
    getCachedPath: (s) => {
      const c = s.downloads?.screenshot;
      return c && c.editVersion === editVersion ? c.path : undefined;
    },
    startDownload: (capture) => downloadScreenshot(capture, screenshotOverride),
    makeCacheEntry: (downloadId, path) => ({ downloadId, editVersion, path }),
    shouldCommit: (fresh) => !fresh || editVersion >= fresh.editVersion,
    downloadsKey: 'screenshot',
  });
}

/**
 * Build the `shouldCommit` predicate used by `ensureHtmlDownloaded`
 * / `ensureSelectionDownloaded`. Closes over the pre-download value
 * of the artifact's sticky "edited" flag so the predicate can
 * refuse to commit when an Edit-dialog save landed while our
 * download was in flight — if it committed blindly, the on-disk
 * file would hold pre-edit bytes but the eventual sidecar's
 * `isEdited: true` would claim otherwise.
 */
function editableShouldCommit(
  editedFlag: 'htmlEdited' | 'selectionEdited',
  wasEditedAtStart: boolean,
): (fresh: unknown, freshSession: DetailsSession) => boolean {
  return (fresh, freshSession) => {
    if (fresh) return false;
    return (freshSession[editedFlag] === true) === wasEditedAtStart;
  };
}

/**
 * Materialize the HTML file on disk if needed and return its
 * absolute on-disk path. The cache is unconditional until the user
 * saves an edit in the Edit HTML dialog — the `updateArtifact`
 * handler drops the cache entry so the next call re-downloads with
 * the edited body under the same pinned `contentsFilename`.
 *
 * Throws when the capture carries an `htmlError` (scrape failed at
 * capture time). Under normal use the page's Save HTML checkbox and
 * Copy / Edit buttons are disabled in that case, so this branch is
 * unreachable; it's a belt-and-suspenders guard so a stale page
 * message can't write an empty HTML file.
 */
async function ensureHtmlDownloaded(tabId: number): Promise<string> {
  // Snapshot the sticky edited flag so the commit predicate can
  // detect an Edit-dialog save landing mid-flight and skip committing
  // a cache entry whose on-disk file holds pre-edit bytes.
  const pre = await requireDetailsSession(tabId);
  const wasEdited = pre.htmlEdited === true;
  return ensureArtifactDownloaded(tabId, {
    precondition: (s) => {
      if (s.capture.htmlError) {
        throw new Error(`HTML not captured: ${s.capture.htmlError}`);
      }
    },
    getCachedPath: (s) => s.downloads?.html?.path,
    startDownload: downloadHtml,
    makeCacheEntry: (downloadId, path) => ({ downloadId, path }),
    shouldCommit: editableShouldCommit('htmlEdited', wasEdited),
    downloadsKey: 'html',
  });
}

/**
 * Materialize the selection file on disk if needed and return its
 * absolute on-disk path. Cache + invalidation policy mirrors
 * `ensureHtmlDownloaded`: unconditional until the user saves in the
 * Edit selection dialog, with the same pre-start snapshot of
 * `selectionEdited` protecting a mid-flight download from
 * committing a stale cache entry.
 *
 * Throws when the capture carries a `selectionError` (scrape failed
 * at capture time) or when no selection was present. Under normal
 * use the page's Save selection checkbox and Copy / Edit buttons are
 * disabled in both cases, so this branch is unreachable; it's a
 * belt-and-suspenders guard so a stale page message can't write an
 * empty file.
 */
async function ensureSelectionDownloaded(tabId: number): Promise<string> {
  const pre = await requireDetailsSession(tabId);
  const wasEdited = pre.selectionEdited === true;
  return ensureArtifactDownloaded(tabId, {
    precondition: (s) => {
      if (s.capture.selectionError) {
        throw new Error(`Selection not captured: ${s.capture.selectionError}`);
      }
      if (!s.capture.selection || !s.capture.selectionFilename) {
        throw new Error('No selection was captured');
      }
    },
    getCachedPath: (s) => s.downloads?.selection?.path,
    startDownload: downloadSelection,
    makeCacheEntry: (downloadId, path) => ({ downloadId, path }),
    shouldCommit: editableShouldCommit('selectionEdited', wasEdited),
    downloadsKey: 'selection',
  });
}

/**
 * Per-kind spec driving the generic `updateArtifact` handler. Each
 * entry says how to commit the edited body to the session and
 * which `session.downloads` entry to drop so the next Copy /
 * Capture re-materializes under the same pinned filename.
 *
 * New editable artifact kinds add one entry here (and one to the
 * `EditableArtifactKind` literal union); the handler loop and the
 * surrounding session bookkeeping stay untouched.
 */
const EDITABLE_ARTIFACTS: Record<
  EditableArtifactKind,
  {
    write: (session: DetailsSession, value: string) => void;
    downloadsKey: EditableArtifactKind;
  }
> = {
  html: {
    write: (s, v) => {
      s.capture.html = v;
      s.htmlEdited = true;
    },
    downloadsKey: 'html',
  },
  selection: {
    write: (s, v) => {
      s.capture.selection = v;
      s.selectionEdited = true;
    },
    downloadsKey: 'selection',
  },
};

/**
 * Apply an Edit-dialog save to the given session: replace the body
 * + set the sticky edited flag + drop the corresponding download
 * cache so the next Copy / Capture re-downloads with the edited
 * content at the pinned filename. Mutates `session` in place;
 * caller must persist via `saveDetailsSession`.
 *
 * Throws when the matching `*Error` is set on the capture (scrape
 * failed at capture time). Under normal use the page-side Edit
 * button is disabled in that case, so the message never arrives;
 * the throw is a defense-in-depth guard so a stray `updateArtifact`
 * can't write content the SW would then refuse to materialize via
 * its `ensure*Downloaded` precondition — leaving the sticky edit
 * flag set on a body the user can never actually save.
 */
function applyArtifactEdit(
  session: DetailsSession,
  kind: EditableArtifactKind,
  value: string,
): void {
  const errorKey = `${kind}Error` as const;
  const reason = session.capture[errorKey];
  if (reason) {
    throw new Error(`Cannot edit ${kind}: ${reason}`);
  }
  const spec = EDITABLE_ARTIFACTS[kind];
  spec.write(session, value);
  if (session.downloads && spec.downloadsKey in session.downloads) {
    const copy = { ...session.downloads };
    delete copy[spec.downloadsKey];
    session.downloads = copy;
  }
}

chrome.runtime.onMessage.addListener((msg: DetailsMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;

  if (msg.action === 'getDetailsData') {
    void (async () => {
      // Page on first load shouldn't error if the SW lost its
      // session — let it render a blank state instead. Hence the
      // non-throwing `loadDetailsSession`, unlike the
      // `requireDetailsSession` call in `saveDetails`.
      const session = await loadDetailsSession(tabId);
      if (!session) {
        sendResponse(undefined);
        return;
      }
      // Forward the fields the page actually renders or mirrors:
      // the preview image, the captured URL, the HTML body (for
      // byte counting + the Edit HTML dialog), and the selection
      // body (for the Edit selection dialog + enabling the Save
      // selection controls — presence of a non-empty string plays
      // the role the old `hasSelection` flag did). File paths are
      // not sent here; they come back via the on-demand
      // `ensureDownloaded` round-trip when a Copy button is clicked.
      //
      // `htmlError` / `selectionError` propagate any scrape failure
      // from `captureBothToMemory` so the page can grey out the
      // corresponding rows and show an error icon with the reason.
      sendResponse({
        screenshotDataUrl: session.capture.screenshotDataUrl,
        html: session.capture.html,
        selection: session.capture.selection,
        url: session.capture.url,
        htmlError: session.capture.htmlError,
        selectionError: session.capture.selectionError,
      });
    })();
    return true;
  }

  if (msg.action === 'ensureDownloaded') {
    void (async () => {
      try {
        let path: string;
        if (msg.kind === 'screenshot') {
          path = await ensureScreenshotDownloaded(
            tabId,
            msg.editVersion ?? 0,
            msg.screenshotOverride,
          );
        } else if (msg.kind === 'html') {
          path = await ensureHtmlDownloaded(tabId);
        } else {
          path = await ensureSelectionDownloaded(tabId);
        }
        sendResponse({ path });
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg.action === 'updateArtifact') {
    void (async () => {
      try {
        const session = await requireDetailsSession(tabId);
        applyArtifactEdit(session, msg.kind, msg.value);
        await saveDetailsSession(tabId, session);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg.action === 'saveDetails') {
    void runWithErrorReporting(async () => {
      const key = detailsStorageKey(tabId);
      const session = await requireDetailsSession(tabId);
      try {
        // Each artifact runs through the same `ensure…Downloaded`
        // helper as the Copy buttons. Files the user already
        // pre-downloaded via Copy (with the same `editVersion` for
        // screenshots) hit the cache and are not re-written.
        if (msg.screenshot) {
          await ensureScreenshotDownloaded(
            tabId,
            msg.editVersion ?? 0,
            msg.screenshotOverride,
          );
        }
        if (msg.html) {
          await ensureHtmlDownloaded(tabId);
        }
        if (msg.selection) {
          await ensureSelectionDownloaded(tabId);
        }
        await recordDetailedCapture({
          capture: session.capture,
          includeScreenshot: msg.screenshot,
          includeHtml: msg.html,
          includeSelection: msg.selection,
          prompt: msg.prompt,
          hasHighlights: msg.highlights,
          hasRedactions: msg.hasRedactions,
          isCropped: msg.isCropped,
          htmlEdited: session.htmlEdited,
          selectionEdited: session.selectionEdited,
        });
      } finally {
        // Always clean up the stored capture and close the tab, even
        // if recordDetailedCapture throws: the stashed data is no longer
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
  const platform = await chrome.runtime.getPlatformInfo();
  // ChromeOS rendering of `type: 'separator'` in extension menus is
  // sometimes broken/invisible; on that platform we fall back to a
  // disabled normal item titled with U+2500 box-drawing chars.
  //
  // A11y trade-off: `chrome.contextMenus` has no API to mark an item
  // non-focusable or aria-hidden, so the fake separator is still
  // reachable via keyboard and screen readers announce it as a row
  // of dashes (dimmed). Native `type: 'separator'` entries skip
  // focus. We accept this because the native path is already broken
  // on ChromeOS — invisible grouping is worse than a dimmed dash row.
  const useFakeSeparator = platform.os === 'cros';

  // Chrome menus use the OS's proportional system font, so character
  // count only approximates pixel width. 24 U+2500 chars was chosen
  // empirically to look like a full-width rule against the current
  // submenu entries; revisit if noticeably wider entries are added.
  const FAKE_SEPARATOR_TITLE = '─'.repeat(24);

  const createSeparator = (id: string, parentId: string) => {
    if (useFakeSeparator) {
      chrome.contextMenus.create({
        id,
        parentId,
        title: FAKE_SEPARATOR_TITLE,
        enabled: false,
        contexts: ['action'],
      });
    } else {
      chrome.contextMenus.create({
        id,
        parentId,
        type: 'separator',
        contexts: ['action'],
      });
    }
  };

  // Read the current default up front so each submenu child can be
  // created with the correct title prefix — `removeAll` wipes
  // Chrome's per-item state along with the entries themselves, so
  // we can't rely on persisted state.
  const defaultId = await getDefaultClickActionId();
  const dblId = doubleClickActionId(defaultId);

  // ── Top-level entries (delay 0, primary group only) ────────
  // The three undelayed primary capture actions, one per base action.
  // Titles carry a right-side (Click) / (Double-click) hint when
  // they match the current defaults — see actionMenuTitle. More-group
  // base actions (capture-url, capture-both) live in the More submenu
  // and don't get a top-level slot.
  for (const action of captureActionsWithDelay(0, 'primary')) {
    chrome.contextMenus.create({
      id: action.id,
      title: actionMenuTitle(action, defaultId, dblId),
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
      createSeparator(
        `${DELAYED_PARENT_ID}-sep-${delaySec}`,
        DELAYED_PARENT_ID,
      );
    }
    const entries = CAPTURE_ACTIONS.filter(
      (a) => a.delaySec === delaySec && a.showInDelayedSubmenu,
    );
    for (const action of entries) {
      chrome.contextMenus.create({
        id: action.id,
        parentId: DELAYED_PARENT_ID,
        title: actionMenuTitle(action, defaultId, dblId),
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
  for (let i = 0; i < CAPTURE_DELAYS_SEC.length; i++) {
    const delaySec = CAPTURE_DELAYS_SEC[i]!;
    if (i > 0) {
      createSeparator(
        `${DEFAULT_CLICK_PARENT_ID}-sep-${delaySec}`,
        DEFAULT_CLICK_PARENT_ID,
      );
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

  // ── "More" submenu ──────────────────────────────────────────
  // Home for:
  //   - capture actions that don't earn a top-level slot (the
  //     "neither / both files" shortcuts for the details flow —
  //     equivalent to opening capture-with-details and ticking
  //     neither or both checkboxes, minus the dialog round-trip)
  //   - infrequent utilities that would otherwise compete for a
  //     top-level slot against the primary capture entries
  chrome.contextMenus.create({
    id: MORE_PARENT_ID,
    title: 'More',
    contexts: ['action'],
  });
  // More-group capture actions (delay 0 only — delayed variants are
  // reachable via "Set default click action"). They use the bare
  // CAPTURE_ACTIONS id like the primary top-level entries, so the
  // onClicked dispatcher's `findCaptureAction(id)` branch handles them
  // without a special case, and `setDefaultClickActionId`'s
  // hint-refresh loop can update their titles too.
  for (const action of captureActionsWithDelay(0, 'more')) {
    chrome.contextMenus.create({
      id: action.id,
      parentId: MORE_PARENT_ID,
      title: actionMenuTitle(action, defaultId, dblId),
      contexts: ['action'],
    });
  }
  createSeparator(`${MORE_PARENT_ID}-sep-capture`, MORE_PARENT_ID);
  // The Copy-last-… entries are created `enabled: false` and flipped
  // on by `refreshCopyMenuState()` once we've checked the latest
  // record. That avoids a brief flash of "enabled but does nothing"
  // on the first install / after a Clear log history.
  chrome.contextMenus.create({
    id: COPY_LAST_SCREENSHOT_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Copy last screenshot filename',
    enabled: false,
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: COPY_LAST_HTML_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Copy last HTML filename',
    enabled: false,
    contexts: ['action'],
  });
  createSeparator(`${MORE_PARENT_ID}-sep-copy`, MORE_PARENT_ID);
  chrome.contextMenus.create({
    id: SNAPSHOTS_DIR_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Snapshots directory',
    contexts: ['action'],
  });
  createSeparator(`${MORE_PARENT_ID}-sep-snapshots`, MORE_PARENT_ID);
  chrome.contextMenus.create({
    id: CLEAR_LOG_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Clear log history',
    contexts: ['action'],
  });

  // After all entries exist, sync the Copy-last-… enable state to
  // whatever the most recent capture record looks like.
  await refreshCopyMenuState();
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
  void refreshCopyMenuState();
});

// React to capture-log changes so the Copy-last-… menu entries
// flip enabled state without explicit plumbing from capture.ts.
// Covers every code path that mutates the log: each capture's
// `appendToLog`, and `clearCaptureLog` (which removes the key).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LOG_STORAGE_KEY]) {
    void refreshCopyMenuState();
  }
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

  // Open the on-disk capture directory in a new tab. Same
  // error-reporting rationale as the Clear log path: the
  // "no captures yet" failure surfaces via the icon swap +
  // tooltip line so the user actually sees it.
  if (id === SNAPSHOTS_DIR_MENU_ID) {
    await runWithErrorReporting(() => openSnapshotsDirectory());
    return;
  }

  // Copy the latest screenshot / HTML filename to the clipboard. The
  // menu entries are greyed when the latest record doesn't carry the
  // matching field, so under normal operation these calls always have
  // something to copy.
  if (id === COPY_LAST_SCREENSHOT_MENU_ID) {
    await runWithErrorReporting(() => copyLastScreenshotFilename());
    return;
  }
  if (id === COPY_LAST_HTML_MENU_ID) {
    await runWithErrorReporting(() => copyLastHtmlFilename());
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
  captureUrlOnly,
  captureBoth,
  captureSelection,
  downloadScreenshot,
  downloadHtml,
  downloadSelection,
  recordDetailedCapture,
  ensureScreenshotDownloaded,
  ensureHtmlDownloaded,
  ensureSelectionDownloaded,
  startCaptureWithDetails,
  clearCaptureLog,
  openSnapshotsDirectory,
  copyLastScreenshotFilename,
  copyLastHtmlFilename,
  reportCaptureError,
  clearCaptureError,
  runWithErrorReporting,
  handleActionClick,
  getDefaultClickActionId,
  setDefaultClickActionId,
  refreshActionTooltip,
};
