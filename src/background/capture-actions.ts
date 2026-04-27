import {
  captureBothToMemory,
  captureSelection,
  captureVisible,
  downloadHtml,
  downloadScreenshot,
  recordDetailedCapture,
  savePageContents,
} from '../capture.js';
import { startCaptureWithDetails } from './capture-details.js';

// Capture actions surfaced to the user.
//
// Each action is a (base, delay) pair: the base says *what* to
// capture (plain screenshot, HTML contents, the Capture page flow, or
// one of the fixed-checkbox Capture page flow shortcuts) and the delay
// says *when* to capture (immediate, 2s, or 5s). We define the
// bases once and expand them across the delays at module load so
// every menu surface stays in sync from a single source.
//
// A base can opt out of delayed variants via
// `supportsDelayed: false`; it then produces only the 0s variant.
// Used for modes where a delay doesn't pay for itself — e.g.
// the `capture-selection-*` shortcuts (the user already made the
// selection before clicking) or `capture-url` (the click's intent
// is "record *this* URL"; a delayed version would just record a
// *different* URL if the user navigated).
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
export type ActionGroup = 'primary' | 'more';

interface BaseCaptureAction {
  /** Stable base id, e.g. `capture-screenshot`. Delayed variants append
   * `-<N>s`. */
  baseId: string;
  /** Short label for the undelayed variant, e.g. "Take screenshot". */
  baseTitle: string;
  /**
   * Short form of the title that slots into a tooltip line
   * (`Click: <fragment>` etc.). Authored sentence-case, with no
   * trailing "..." / ellipsis — capitalization is preserved on
   * acronyms (HTML / URL). The delayed derivation below just
   * appends ` in Ns` so the fragment text itself never has to be
   * transformed at render time.
   */
  baseTooltipFragment: string;
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

export interface CaptureAction {
  /** Stable id — used as the menu item id, the submenu child id
   * (with a prefix), and the storage value. */
  id: string;
  /** Short label shown in the context menu. */
  title: string;
  /**
   * Sentence-fragment form for tooltip lines — the base fragment
   * plus ` in Ns` for delayed variants. Satisfies `TooltipAction`
   * so the action object drops straight into `buildActionTooltip`.
   */
  tooltipFragment: string;
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
 * "Capture URL" — the Capture-page "neither file checked" path, run
 * without opening the page. Still goes through `captureBothToMemory`
 * so the delay / active-tab-after-delay semantics match every other
 * capture, but the screenshot + HTML payloads are discarded — only
 * the timestamp + URL (and any future prompt plumbing) hit the log.
 *
 * Deliberately ignores `data.htmlError` — a URL-only record doesn't
 * need HTML, so a restricted-URL scrape failure shouldn't block it.
 */
export async function captureUrlOnly(delayMs = 0): Promise<void> {
  const data = await captureBothToMemory(delayMs);
  await recordDetailedCapture({
    capture: data,
    includeScreenshot: false,
    includeHtml: false,
  });
}

/**
 * "Capture screenshot and HTML" — the Capture-page "both files
 * checked" path, run without opening the page. Grabs both artifacts,
 * writes them, and records a sidecar entry referencing both.
 *
 * Unlike the Capture page flow (which gracefully falls back to a
 * screenshot-only UI), this shortcut *requires* both artifacts by
 * definition, so we surface a `screenshotError` or `htmlError` as a
 * thrown error — the action's error-reporting channel then swaps the
 * icon / tooltip so the user sees why nothing landed.
 */
export async function captureBoth(delayMs = 0): Promise<void> {
  const data = await captureBothToMemory(delayMs);
  if (data.screenshotError) {
    throw new Error(data.screenshotError);
  }
  if (data.htmlError) {
    throw new Error(data.htmlError);
  }
  await downloadScreenshot(data);
  await downloadHtml(data);
  await recordDetailedCapture({
    capture: data,
    includeScreenshot: true,
    includeHtml: true,
  });
}

// Array order is user-visible: within each delay row / group, menu
// entries appear in the order their bases are declared here.
// `capture-with-details` is the most common pick (its own toolbar
// action and the default Double-click), so we list it first inside
// each section for top-of-mind visibility.
const BASE_CAPTURE_ACTIONS: BaseCaptureAction[] = [
  {
    baseId: 'capture-with-details',
    baseTitle: 'Capture...',
    // Tooltip fragment keeps the trailing "..." so the toolbar tooltip
    // signals "this opens another page" the same way the menu label
    // does — Capture... is the action's full name, not a sentence
    // continuation.
    baseTooltipFragment: 'Capture...',
    group: 'primary',
    run: (delayMs) => startCaptureWithDetails(delayMs),
  },
  {
    baseId: 'capture-screenshot',
    baseTitle: 'Take screenshot',
    baseTooltipFragment: 'Take screenshot',
    group: 'primary',
    run: (delayMs) => captureVisible(delayMs),
  },
  {
    baseId: 'capture-page-contents',
    baseTitle: 'Save HTML contents',
    baseTooltipFragment: 'Save HTML contents',
    group: 'primary',
    run: (delayMs) => savePageContents(delayMs),
  },
  {
    baseId: 'capture-url',
    baseTitle: 'Capture URL',
    baseTooltipFragment: 'Capture URL',
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
    baseTooltipFragment: 'Capture screenshot and HTML',
    group: 'more',
    // Promote delayed variants up into the Capture-with-delay
    // submenu (next to plain screenshot / HTML / details). The
    // undelayed variant stays in More — this is still a slightly
    // niche combo at 0s — but a delayed screenshot-AND-HTML is
    // useful enough to surface alongside the primary delayed entries.
    showInDelayedSubmenu: true,
    run: (delayMs) => captureBoth(delayMs),
  },
  // Three selection-format shortcuts. A single capture can only
  // produce one selection file, so we expose each serialization
  // format as its own action rather than asking the user to pick
  // mid-capture. `captureSelection` throws if the chosen format's
  // body is empty (e.g. "Capture selection as text" on an
  // image-only selection), and the toolbar error channel surfaces
  // the reason so the user can retry with a different format.
  {
    baseId: 'capture-selection-html',
    baseTitle: 'Capture selection as HTML',
    // The three `capture-selection-*` fragments deliberately elide
    // the word "selection" — these actions only ever surface in the
    // toolbar tooltip's `With selection: …` line (they're filtered
    // out of the without-selection default pool by `isSelectionBaseId`,
    // and not bindable as a click target elsewhere), and the prefix
    // already carries that context. Keeping the word would produce
    // `With selection: capture selection as html`, repeating itself.
    baseTooltipFragment: 'Capture as HTML',
    group: 'more',
    // The selection already exists when the user triggers the
    // action; waiting doesn't help. Still bindable as the default
    // click action at 0s via "Set default click action".
    supportsDelayed: false,
    run: (delayMs) => captureSelection('html', delayMs),
  },
  {
    baseId: 'capture-selection-text',
    baseTitle: 'Capture selection as text',
    baseTooltipFragment: 'Capture as text',
    group: 'more',
    supportsDelayed: false,
    run: (delayMs) => captureSelection('text', delayMs),
  },
  {
    baseId: 'capture-selection-markdown',
    baseTitle: 'Capture selection as markdown',
    baseTooltipFragment: 'Capture as markdown',
    group: 'more',
    supportsDelayed: false,
    run: (delayMs) => captureSelection('markdown', delayMs),
  },
];

// All delays (in seconds) we surface in the menu. 0 is the plain
// top-level entry set; 2 and 5 go into the "Capture with delay" submenu.
export const CAPTURE_DELAYS_SEC = [0, 2, 5] as const;

function delayedId(baseId: string, delaySec: number): string {
  return delaySec === 0 ? baseId : `${baseId}-${delaySec}s`;
}

// Build a delayed title. The "in Ns" phrase is appended verbatim,
// so dialog-style titles that end in "..." (e.g. "Capture...") read
// as "Capture... in 2s" — the ellipsis stays anchored to the action
// name and the delay sits as a plain trailing phrase.
function delayedTitle(baseTitle: string, delaySec: number): string {
  if (delaySec === 0) return baseTitle;
  return `${baseTitle} in ${delaySec}s`;
}

// Tooltip fragments don't carry the "..." dialog convention, so the
// delayed form is a plain suffix. Mirrors `delayedTitle` but without
// the ellipsis shuffle.
function delayedTooltipFragment(baseFragment: string, delaySec: number): string {
  return delaySec === 0 ? baseFragment : `${baseFragment} in ${delaySec}s`;
}

export const CAPTURE_ACTIONS: CaptureAction[] = BASE_CAPTURE_ACTIONS.flatMap((base) => {
  const delays = base.supportsDelayed === false ? [0] : CAPTURE_DELAYS_SEC;
  const showInDelayedSubmenu = base.showInDelayedSubmenu ?? base.group === 'primary';
  return delays.map((delaySec) => ({
    id: delayedId(base.baseId, delaySec),
    title: delayedTitle(base.baseTitle, delaySec),
    tooltipFragment: delayedTooltipFragment(base.baseTooltipFragment, delaySec),
    baseId: base.baseId,
    group: base.group,
    showInDelayedSubmenu,
    delaySec,
    run: () => base.run(delaySec * 1000),
  }));
});

export function captureActionsWithDelay(
  delaySec: number,
  group?: ActionGroup,
): CaptureAction[] {
  return CAPTURE_ACTIONS.filter(
    (a) => a.delaySec === delaySec && (group === undefined || a.group === group),
  );
}

export function isDefaultableDelay(delaySec: number): boolean {
  return (CAPTURE_DELAYS_SEC as readonly number[]).includes(delaySec);
}
