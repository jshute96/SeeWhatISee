// Default click-action preferences + toolbar-click dispatch. Owns the
// four `defaultClick…` / `defaultDbl…` storage keys, the
// with-selection choice list, the single/double-click
// `handleActionClick` dispatcher, and the `getDefaultActionTooltip`
// builder that renders the toolbar tooltip from the four stored
// defaults.

import { scrapeSelection } from '../capture.js';
import {
  CAPTURE_ACTIONS,
  type CaptureAction,
} from './capture-actions.js';
import { runWithErrorReporting } from './error-reporting.js';
import { detailsStorageKey } from './capture-details.js';
import { commandsToShortcutMap, refreshMenusAndTooltip } from './context-menu.js';

// The default click and double-click actions are each split in two
// (with-selection / without-selection) so the toolbar behaves
// sensibly in both states the user can put a page in:
//   - With a selection on the page — most users want the selection
//     captured; the three "Capture selection as …" shortcuts and the
//     Capture page flow (with the selection-only checkbox set) are
//     meaningful defaults here. `Ignore selection` is the opt-out:
//     treat the click as if no selection existed and fall through to
//     the other default.
//   - Without a selection — any of the CAPTURE_ACTIONS entries except
//     the `capture-selection-*` format shortcuts (which would just
//     error with `No selection content`).
const DEFAULT_CLICK_WITH_SELECTION_KEY = 'defaultClickWithSelection';
const DEFAULT_CLICK_WITHOUT_SELECTION_KEY = 'defaultClickWithoutSelection';
const DEFAULT_DBL_WITH_SELECTION_KEY = 'defaultDblWithSelection';
const DEFAULT_DBL_WITHOUT_SELECTION_KEY = 'defaultDblWithoutSelection';
const DEFAULT_CLICK_WITH_SELECTION_ID = 'capture-with-details';
const DEFAULT_CLICK_WITHOUT_SELECTION_ID = 'capture-with-details';
const DEFAULT_DBL_WITH_SELECTION_ID = 'capture-selection-markdown';
const DEFAULT_DBL_WITHOUT_SELECTION_ID = 'capture-screenshot';
// Sentinel id used in place of a CAPTURE_ACTIONS id when the user
// wants a page selection to *not* steer the click default. Never
// appears in CAPTURE_ACTIONS; `handleActionClick` treats it as "fall
// through to the without-selection default", and in the tooltip the
// corresponding `With selection:` line is omitted entirely.
export const IGNORE_SELECTION_ID = 'ignore-selection';

// Every `capture-selection-<format>` baseId — the union we filter out
// of the without-selection default pool. Kept in one place so adding
// a new selection format only adds one entry here (plus the entry in
// BASE_CAPTURE_ACTIONS).
const SELECTION_BASE_IDS: ReadonlySet<string> = new Set([
  'capture-selection-html',
  'capture-selection-text',
  'capture-selection-markdown',
]);

export function isSelectionBaseId(baseId: string): boolean {
  return SELECTION_BASE_IDS.has(baseId);
}

export function findCaptureAction(id: string | undefined): CaptureAction | undefined {
  return CAPTURE_ACTIONS.find((a) => a.id === id);
}

// Selectable defaults for the "when there is a selection" section of
// the default-click submenu. The four action-backed entries are
// derived from CAPTURE_ACTIONS so their titles + tooltip fragments
// stay in lockstep with the menu entries — editing a fragment on the
// base action picks up here too, and the selection-specific fragments
// (`capture as html`, etc.) are the ones that flow into the tooltip's
// `With selection: …` line. The `ignore-selection` sentinel is
// authored in place; it has no CAPTURE_ACTIONS entry because it maps
// to "fall through to the without-selection default" rather than a
// real action.
export interface WithSelectionChoice {
  id: string;
  title: string;
  /** Fragment for the tooltip's `With selection:` line, or `null`
   *  to omit the line. */
  tooltipFragment: string | null;
}

// Order is user-visible (Set-default submenu, Options page).
// `capture-with-details` is listed first to put the most common pick
// at the top of the section.
const WITH_SELECTION_CHOICE_ACTION_IDS = [
  'capture-with-details',
  'capture-selection-html',
  'capture-selection-text',
  'capture-selection-markdown',
] as const;

export const WITH_SELECTION_CHOICES: WithSelectionChoice[] = [
  ...WITH_SELECTION_CHOICE_ACTION_IDS.map((id) => {
    const action = findCaptureAction(id);
    if (!action) throw new Error(`with-selection choice missing action: ${id}`);
    return {
      id: action.id,
      title: action.title,
      tooltipFragment: action.tooltipFragment,
    };
  }),
  {
    id: IGNORE_SELECTION_ID,
    title: 'Ignore selection (use default below)',
    tooltipFragment: null,
  },
];

export function findWithSelectionChoice(id: string | undefined): WithSelectionChoice | undefined {
  return WITH_SELECTION_CHOICES.find((c) => c.id === id);
}

export async function getDefaultWithSelectionId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEFAULT_CLICK_WITH_SELECTION_KEY);
  const id = stored[DEFAULT_CLICK_WITH_SELECTION_KEY];
  return typeof id === 'string' && findWithSelectionChoice(id)
    ? id
    : DEFAULT_CLICK_WITH_SELECTION_ID;
}

// Legacy → current id migration. Two base ids were renamed so the
// chrome.commands names stay consistent (`capture-*`): `capture-now`
// → `capture-screenshot`, `save-page-contents` →
// `capture-page-contents`. A user who had customized the
// without-selection default would otherwise get silently reset. We
// rewrite storage lazily on read so the migration is a single map
// lookup with no extra onInstalled plumbing.
//
// Scope: these legacy ids were only ever valid as the
// `defaultClickWithoutSelection` storage value. The with-selection
// slot never accepted them (its pool is the `capture-selection-*`
// formats + `capture-with-details` + `ignore-selection`), so
// `getDefaultWithSelectionId` doesn't need the same migration.
const LEGACY_BASE_ID_MAP: Record<string, string> = {
  'capture-now': 'capture-screenshot',
  'save-page-contents': 'capture-page-contents',
};

function migrateLegacyActionId(id: string): string {
  for (const [oldBase, newBase] of Object.entries(LEGACY_BASE_ID_MAP)) {
    if (id === oldBase) return newBase;
    if (id.startsWith(`${oldBase}-`)) {
      // Preserve the delay suffix: `capture-now-2s` → `capture-screenshot-2s`.
      return `${newBase}${id.slice(oldBase.length)}`;
    }
  }
  return id;
}

export async function getDefaultWithoutSelectionId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEFAULT_CLICK_WITHOUT_SELECTION_KEY);
  const rawId = stored[DEFAULT_CLICK_WITHOUT_SELECTION_KEY];
  // Fall back if storage is empty, holds a stale id, or holds one of
  // the `capture-selection-*` format shortcuts (no longer permitted
  // in this slot — they'd just error on every click without a
  // selection).
  if (typeof rawId !== 'string') return DEFAULT_CLICK_WITHOUT_SELECTION_ID;
  const id = migrateLegacyActionId(rawId);
  if (id !== rawId) {
    await chrome.storage.local.set({ [DEFAULT_CLICK_WITHOUT_SELECTION_KEY]: id });
  }
  const action = findCaptureAction(id);
  if (!action || isSelectionBaseId(action.baseId)) {
    return DEFAULT_CLICK_WITHOUT_SELECTION_ID;
  }
  return id;
}

export async function getDefaultWithoutSelectionAction(): Promise<CaptureAction> {
  const id = await getDefaultWithoutSelectionId();
  return findCaptureAction(id) ?? CAPTURE_ACTIONS[0]!;
}

// ── Double-click defaults ────────────────────────────────────────
//
// Both Dbl slots draw from the same id pools as their Click siblings —
// any non-selection action for `getDefaultDblWithoutSelectionId`, the
// `WITH_SELECTION_CHOICES` set (4 actions + ignore-selection) for
// `getDefaultDblWithSelectionId`. Stored under their own keys so the
// user can mix-and-match (e.g. Click=Capture..., Double-click=Take
// screenshot for a fast no-dialog screenshot habit).

export async function getDefaultDblWithoutSelectionId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEFAULT_DBL_WITHOUT_SELECTION_KEY);
  const rawId = stored[DEFAULT_DBL_WITHOUT_SELECTION_KEY];
  if (typeof rawId !== 'string') return DEFAULT_DBL_WITHOUT_SELECTION_ID;
  const id = migrateLegacyActionId(rawId);
  if (id !== rawId) {
    await chrome.storage.local.set({ [DEFAULT_DBL_WITHOUT_SELECTION_KEY]: id });
  }
  const action = findCaptureAction(id);
  if (!action || isSelectionBaseId(action.baseId)) {
    return DEFAULT_DBL_WITHOUT_SELECTION_ID;
  }
  return id;
}

export async function getDefaultDblWithSelectionId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEFAULT_DBL_WITH_SELECTION_KEY);
  const id = stored[DEFAULT_DBL_WITH_SELECTION_KEY];
  return typeof id === 'string' && findWithSelectionChoice(id)
    ? id
    : DEFAULT_DBL_WITH_SELECTION_ID;
}

export async function setDefaultDblWithoutSelectionId(id: string): Promise<void> {
  const action = findCaptureAction(id);
  if (!action) throw new Error(`Unknown capture action id: ${id}`);
  if (isSelectionBaseId(action.baseId)) {
    throw new Error(`${action.baseId} is not a valid without-selection default`);
  }
  await chrome.storage.local.set({ [DEFAULT_DBL_WITHOUT_SELECTION_KEY]: id });
  await refreshMenusAndTooltip();
}

export async function setDefaultDblWithSelectionId(id: string): Promise<void> {
  if (!findWithSelectionChoice(id)) {
    throw new Error(`Unknown with-selection default id: ${id}`);
  }
  await chrome.storage.local.set({ [DEFAULT_DBL_WITH_SELECTION_KEY]: id });
  await refreshMenusAndTooltip();
}

/**
 * Build the toolbar icon tooltip from the four stored defaults.
 *
 * Every fragment is authored on the action / with-selection choice
 * itself (see `baseTooltipFragment` on `BASE_CAPTURE_ACTIONS` and
 * `tooltipFragment` on `WITH_SELECTION_CHOICES`), so this function
 * does no string manipulation — it just reads storage state and
 * concatenates the pre-built pieces. Layout is:
 *
 *   SeeWhatISee
 *   <blank>                                       (only when errorMessage !== undefined)
 *   ERROR: <errorMessage>                         (only when errorMessage !== undefined)
 *   <blank>
 *   Click: <click-no-sel.tooltipFragment>
 *   Double-click: <dbl-no-sel.tooltipFragment>
 *   With selection click: <click-with-sel.tooltipFragment>          (if not ignore-selection)
 *   With selection double-click: <dbl-with-sel.tooltipFragment>     (if not ignore-selection)
 *   <blank>
 *
 * The blanks give each block breathing room — bracketing the ERROR
 * line when present, bracketing the action block always, and
 * separating the trailing action line from whatever Chrome appends
 * below (the "Wants access to this site" permission line, for
 * example).
 *
 * The two `With selection …` lines are independently omitted when
 * the corresponding stored choice is `ignore-selection` (its
 * `tooltipFragment` is `null`) — that branch then behaves identically
 * with or without a selection, so the extra line would be noise.
 */
export async function getDefaultActionTooltip(errorMessage?: string): Promise<string> {
  const click = await getDefaultWithoutSelectionAction();
  const dblWithoutId = await getDefaultDblWithoutSelectionId();
  const doubleClick = findCaptureAction(dblWithoutId) ?? CAPTURE_ACTIONS[0]!;
  const clickWithChoice = findWithSelectionChoice(await getDefaultWithSelectionId());
  const dblWithChoice = findWithSelectionChoice(await getDefaultDblWithSelectionId());
  // The `_execute_action` hotkey — when bound — is equivalent to
  // clicking the toolbar icon, so we fold it into the `Click:`
  // label rather than adding another action line. When unbound
  // (fresh install / no user binding) the label stays the plain
  // `Click:` so users who haven't touched shortcuts don't see
  // empty-looking hints.
  const commands = await chrome.commands.getAll();
  const execHotkey = commandsToShortcutMap(commands).get('_execute_action');
  const clickLabel = execHotkey ? `Click, ${execHotkey}` : 'Click';
  const lines: string[] = ['SeeWhatISee'];
  if (errorMessage !== undefined) lines.push('', `ERROR: ${errorMessage}`);
  lines.push(
    '',
    `${clickLabel}: ${click.tooltipFragment}`,
    `Double-click: ${doubleClick.tooltipFragment}`,
  );
  // The with-selection lines are omitted when the corresponding
  // choice is `ignore-selection` — its `tooltipFragment` is `null`
  // precisely so the line drops, since a click with selection then
  // behaves identically to a click without one and the line would
  // just be noise.
  if (clickWithChoice && clickWithChoice.tooltipFragment !== null) {
    lines.push(`With selection click: ${clickWithChoice.tooltipFragment}`);
  }
  if (dblWithChoice && dblWithChoice.tooltipFragment !== null) {
    lines.push(`With selection double-click: ${dblWithChoice.tooltipFragment}`);
  }
  // Trailing empty entry → one trailing `\n` after `join('\n')`,
  // which Chrome's tooltip renderer shows as one blank line below
  // the action block.
  lines.push('');
  return lines.join('\n');
}

/**
 * Persist a new "when there is no selection" click default and
 * update the toolbar tooltip + "Set default click action" submenu
 * checkmarks / hint labels to match.
 *
 * Updating a not-yet-created menu id throws `No item with id "…"`;
 * we suppress that because these setters are also called from tests
 * before the first menu install.
 */
export async function setDefaultWithoutSelectionId(id: string): Promise<void> {
  const action = findCaptureAction(id);
  if (!action) throw new Error(`Unknown capture action id: ${id}`);
  if (isSelectionBaseId(action.baseId)) {
    // The `capture-selection-*` shortcuts would just error on every
    // click without a selection, so they're deliberately not offered
    // in this slot.
    throw new Error(`${action.baseId} is not a valid without-selection default`);
  }
  await chrome.storage.local.set({ [DEFAULT_CLICK_WITHOUT_SELECTION_KEY]: id });
  await refreshMenusAndTooltip();
}

/**
 * Persist a new "when there is a selection" click default. Same
 * swallowed-update shape as `setDefaultWithoutSelectionId`, but only
 * the with-selection section's ✓ prefixes need updating — the
 * without-selection hints are derived from the other default and
 * stay put.
 */
export async function setDefaultWithSelectionId(id: string): Promise<void> {
  if (!findWithSelectionChoice(id)) {
    throw new Error(`Unknown with-selection default id: ${id}`);
  }
  await chrome.storage.local.set({ [DEFAULT_CLICK_WITH_SELECTION_KEY]: id });
  await refreshMenusAndTooltip();
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
// user-visible icon swap + tooltip "ERROR:" line, so
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
//   - Any other default → double-click opens Capture page
let pendingClickTimer: ReturnType<typeof setTimeout> | undefined;

const DOUBLE_CLICK_MS = 250;

/**
 * Probe the active tab for a non-empty selection. Used by the click
 * dispatch to pick between the with/without-selection defaults.
 *
 * Errors (no active tab, restricted URL, scripting rejection) all
 * fall through to `false` — a probe failure shouldn't block the
 * click from running the without-selection default, and the
 * subsequent action itself will surface any real failure through
 * the icon/tooltip error channel.
 */
export async function activeTabHasSelection(): Promise<boolean> {
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id === undefined) return false;
    return !!(await scrapeSelection(active.id, active.url ?? ''));
  } catch {
    return false;
  }
}

/**
 * Run one of the four stored defaults, picked by (single vs.
 * double-click) × (selection present vs. not). The selection probe
 * happens inside the timer / on the second click so it reflects
 * the tab state at dispatch time (after any tab switch during the
 * double-click window). Ignore-selection short-circuits the probe.
 */
async function dispatchAction(withoutId: string, withId: string): Promise<void> {
  let useWith = false;
  if (withId !== IGNORE_SELECTION_ID) {
    useWith = await activeTabHasSelection();
  }
  if (useWith) {
    const action = findCaptureAction(withId);
    if (action) {
      await action.run();
      return;
    }
    // Unrecognized with-selection id falls through to without —
    // the setters reject unknown ids, so this only fires on a
    // storage migration regression or stale value left over from
    // a prior build.
    console.warn(
      '[SeeWhatISee] unknown with-selection default id, falling through:',
      withId,
    );
  }
  const action = findCaptureAction(withoutId) ?? CAPTURE_ACTIONS[0]!;
  await action.run();
}

/**
 * Run the stored Double-click defaults — used by the
 * `01-secondary-action` keyboard command. Mirrors the second-click
 * branch of `handleActionClick` but skips the timer entirely (a
 * keyboard press has no need for double-press detection — there's a
 * separate command for that).
 */
export async function runDblDefault(): Promise<void> {
  const dblWithoutId = await getDefaultDblWithoutSelectionId();
  const dblWithId = await getDefaultDblWithSelectionId();
  await dispatchAction(dblWithoutId, dblWithId);
}

export async function handleActionClick(): Promise<void> {
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

  const clickWithoutId = await getDefaultWithoutSelectionId();
  const clickWithId = await getDefaultWithSelectionId();
  const dblWithoutId = await getDefaultDblWithoutSelectionId();
  const dblWithId = await getDefaultDblWithSelectionId();

  // Double-click: cancel the pending first-click timer and run the
  // dbl-* defaults instead.
  if (pendingClickTimer !== undefined) {
    clearTimeout(pendingClickTimer);
    pendingClickTimer = undefined;
    await runWithErrorReporting(() => dispatchAction(dblWithoutId, dblWithId));
    return;
  }

  // First click: wait for a potential second click before running
  // the click-* defaults. If the user switches tabs during the
  // 250 ms window, the capture targets whatever tab is visible when
  // the timer fires — captureVisibleTab can only capture what's on
  // screen, and re-activating the original tab would be surprising.
  await new Promise<void>((resolve) => {
    pendingClickTimer = setTimeout(() => {
      pendingClickTimer = undefined;
      void runWithErrorReporting(() =>
        dispatchAction(clickWithoutId, clickWithId),
      ).then(resolve, resolve);
    }, DOUBLE_CLICK_MS);
  });
}
