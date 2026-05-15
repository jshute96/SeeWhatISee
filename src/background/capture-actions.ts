import {
  captureBothToMemory,
  captureSelection,
  captureVisible,
  recordDetailedCapture,
  savePageContents,
} from '../capture.js';
import type { SelectionFormat } from '../capture/types.js';
import {
  downloadHtml,
  downloadScreenshot,
  downloadSelection,
} from '../capture/downloads.js';
import { getCaptureDetailsDefaults } from './capture-page-defaults.js';
import { startCaptureWithDetails } from './capture-details.js';

// Capture actions surfaced to the user.
//
// Each action is a (base, delay) pair: the base says *what* to
// capture (plain screenshot, HTML contents, the Capture page flow, or
// one of the fixed-checkbox Capture page flow shortcuts) and the delay
// says *when* to capture (immediate or 3s). We define the bases once
// and expand them across the delays at module load so every menu
// surface stays in sync from a single source.
//
// A base can opt out of delayed variants via
// `supportsDelayed: false`; it then produces only the 0s variant.
// Used for modes where a delay doesn't pay for itself — e.g.
// the `save-selection-*` shortcuts (the user already made the
// selection before clicking) or `save-url` (the click's intent
// is "record *this* URL"; a delayed version would just record a
// *different* URL if the user navigated). Today only `capture` and
// `save-screenshot` keep their delayed variants — those are the two
// that the More submenu's delayed-shortcut block surfaces.
//
// Each base also carries a `group: 'primary' | 'more'` that decides
// which section of the action menu surfaces its undelayed variant
// — see the `ActionGroup` comment below.
//
// The resulting flat `CAPTURE_ACTIONS` array drives:
//   - the More submenu's action rows (every `more`-group delay-0
//     entry, plus the `capture` action manually inserted at the top,
//     plus the delay > 0 entries inserted as a delayed-shortcut block)
//   - the top-level shortcut rows, which are recreated with
//     `-shortcut`-suffixed menu ids from a hand-picked subset
//     (`TOP_LEVEL_SHORTCUT_ACTION_IDS` in `context-menu.ts`) — the
//     menu cap means promotion is opt-in, not automatic per `group`.
// It is also the lookup table `handleActionClick` uses to run the
// currently-selected default. The Options page reads the same list
// over the SW message wire to render its action tables.
//
// Keep the first base action at delay 0 first: that's the default
// fallback when nothing is stored yet, and its tooltip matches the
// manifest's `action.default_title` so the hover text is correct
// during the brief window between a fresh install and the first
// tooltip refresh from `refreshActionTooltip()`.

/**
 * Which section of the action menu surfaces an undelayed base action:
 *   - `'primary'` — eligible for promotion to a top-level shortcut
 *     row (the actual set is hand-picked in
 *     `TOP_LEVEL_SHORTCUT_ACTION_IDS` because the action menu is at
 *     the 6-cap).
 *   - `'more'`    — entry inside the More submenu.
 *     A `'more'`-group base can still be promoted to a top-level
 *     shortcut row by adding its id to `TOP_LEVEL_SHORTCUT_ACTION_IDS`
 *     (e.g. `save-defaults` is a more-group action that's also one of
 *     the three top-level shortcuts).
 *
 * Delayed variants (`delaySec > 0`) surface as a single block inside
 * the More submenu, regardless of the base's `group`. Today only
 * `capture` and `save-screenshot` produce delayed variants.
 */
export type ActionGroup = 'primary' | 'more';

interface BaseCaptureAction {
  /** Stable base id, e.g. `save-screenshot`. Delayed variants append
   * `-<N>s`. */
  baseId: string;
  /** Short label for the undelayed variant, e.g. "Save screenshot". */
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
  /** When `false`, only the 0s variant is generated — no 3s entry
   * shows up anywhere. Defaults to `true`. */
  supportsDelayed?: boolean;
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
  /** 0 for immediate; >0 for a delayed variant. Used to slot the
   * entry into the right menu section. */
  delaySec: number;
  /** Runs when the user picks this action (either from a menu entry
   * or a toolbar click when it's the current default). */
  run: () => Promise<unknown>;
}

/**
 * "Save URL" — the Capture-page "neither file checked" path, run
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
 * "Save default items" — runs the same artifact-write path the
 * Capture page would on Save click, applying the user's stored
 * `capturePageDefaults` (split by selection-presence) without ever
 * opening the page. Selection-aware on its own: probes the captured
 * page state and picks the with-selection branch when at least one
 * selection format has saveable content, mirroring the Capture page's
 * own master-row enable rule.
 *
 * Throws when the user's defaults asked for an artifact that errored
 * at scrape time — same behavior as `captureAll`. The toolbar error
 * channel surfaces the reason on the icon / tooltip so the user
 * understands why nothing landed.
 *
 * Selection format pick mirrors the Capture page: prefer the user's
 * configured default; fall back to the first format with non-empty
 * content when the preferred format is empty for this capture (e.g.
 * image-only selection → empty text body, configured default = text).
 */
export async function saveDefaults(delayMs = 0): Promise<void> {
  const data = await captureBothToMemory(delayMs);
  const defaults = await getCaptureDetailsDefaults();

  const allFormats: SelectionFormat[] = ['html', 'text', 'markdown'];
  const contentfulFormats = data.selections
    ? allFormats.filter((fmt) => (data.selections![fmt] ?? '').trim().length > 0)
    : [];
  const useWithSelection = contentfulFormats.length > 0;
  const branch = useWithSelection ? defaults.withSelection : defaults.withoutSelection;

  // `htmlUnavailable` is the image-flow signal (right-click image,
  // upload, or an image-tab capture) that no page HTML exists to
  // save. Skip the HTML write silently — same posture as the
  // selection-not-present branch below. A user with `branch.html=true`
  // navigating to a bare image gets the image (the important thing)
  // without a noisy error.
  const includeHtml = branch.html && !data.htmlUnavailable;

  if (branch.screenshot && data.screenshotError) {
    throw new Error(data.screenshotError);
  }
  if (includeHtml && data.htmlError) {
    throw new Error(data.htmlError);
  }

  let selectionFormat: SelectionFormat | undefined;
  if (useWithSelection && defaults.withSelection.selection) {
    const preferred = defaults.withSelection.format;
    selectionFormat = contentfulFormats.includes(preferred)
      ? preferred
      : contentfulFormats[0];
  }

  if (branch.screenshot) await downloadScreenshot(data);
  if (includeHtml) await downloadHtml(data);
  if (selectionFormat) await downloadSelection(data, selectionFormat);

  await recordDetailedCapture({
    capture: data,
    includeScreenshot: branch.screenshot,
    includeHtml,
    selectionFormat,
  });
}

/**
 * "Save everything" — saves the screenshot, the HTML, and (when the
 * page has a non-empty selection at capture time) the selection in
 * the user's configured selection-format default. No dialog; no
 * Capture page round-trip.
 *
 * Selection format: prefer `capturePageDefaults.withSelection.format`;
 * fall back to the first format with non-empty content if the
 * preferred format is empty for this capture (e.g. image-only
 * selection → empty text body, configured default = text). When the
 * selection scrape failed (`selectionError`) or no selection was
 * present, the selection branch is skipped silently — saving "what's
 * there" is the action's contract, not "fail if no selection".
 *
 * Unlike the Capture page flow (which gracefully falls back to a
 * screenshot-only UI), this shortcut *requires* the screenshot and
 * HTML by definition, so a `screenshotError` or `htmlError` throws
 * — the action's error-reporting channel then swaps the icon /
 * tooltip so the user sees why nothing landed.
 */
export async function captureAll(delayMs = 0): Promise<void> {
  const data = await captureBothToMemory(delayMs);
  if (data.screenshotError) {
    throw new Error(data.screenshotError);
  }
  // `htmlUnavailable` (image-tab / image-context / upload) means
  // there's no page HTML to save in the first place — skip silently,
  // same as the selection-not-present branch below. "Save everything"
  // here means "everything we have."
  const includeHtml = !data.htmlUnavailable;
  if (includeHtml && data.htmlError) {
    throw new Error(data.htmlError);
  }
  await downloadScreenshot(data);
  if (includeHtml) await downloadHtml(data);

  const allFormats: SelectionFormat[] = ['html', 'text', 'markdown'];
  const contentfulFormats = data.selections
    ? allFormats.filter((fmt) => (data.selections![fmt] ?? '').trim().length > 0)
    : [];
  let selectionFormat: SelectionFormat | undefined;
  if (contentfulFormats.length > 0) {
    const defaults = await getCaptureDetailsDefaults();
    const preferred = defaults.withSelection.format;
    selectionFormat = contentfulFormats.includes(preferred)
      ? preferred
      : contentfulFormats[0];
    await downloadSelection(data, selectionFormat);
  }

  await recordDetailedCapture({
    capture: data,
    includeScreenshot: true,
    includeHtml,
    selectionFormat,
  });
}

// Array order is user-visible: within each delay row / group, menu
// entries appear in the order their bases are declared here.
// `capture` (the Capture... dialog) is the most common pick (its own
// toolbar action and the default Double-click), so we list it first
// inside each section for top-of-mind visibility. Every other action
// is a `save-*` variant that writes directly to disk — the naming
// pairs with the on-page Save checkboxes so the menu labels match
// the artifact verbs the user sees inside the Capture page.
const BASE_CAPTURE_ACTIONS: BaseCaptureAction[] = [
  {
    baseId: 'capture',
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
    // Runs the same artifact-write path the Capture page would on
    // Save click, applying the user's stored `capturePageDefaults`.
    // Lives in the More group; the delay-0 row is also pulled up to
    // the top level via `TOP_LEVEL_SHORTCUT_ACTION_IDS` because
    // Save-without-dialog is the everyday pick for users who've
    // configured defaults. No delayed variants — the delayed-shortcut
    // block in the More submenu is reserved for `capture` and
    // `save-screenshot`.
    baseId: 'save-defaults',
    baseTitle: 'Save default items',
    baseTooltipFragment: 'Save default items',
    group: 'more',
    supportsDelayed: false,
    run: (delayMs) => saveDefaults(delayMs),
  },
  {
    baseId: 'save-screenshot',
    baseTitle: 'Save screenshot',
    baseTooltipFragment: 'Save screenshot',
    group: 'more',
    run: (delayMs) => captureVisible(delayMs),
  },
  {
    baseId: 'save-page-contents',
    baseTitle: 'Save HTML contents',
    baseTooltipFragment: 'Save HTML contents',
    group: 'more',
    // No delayed variants — see `save-defaults`.
    supportsDelayed: false,
    run: (delayMs) => savePageContents(delayMs),
  },
  {
    baseId: 'save-url',
    baseTitle: 'Save URL',
    baseTooltipFragment: 'Save URL',
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
    baseId: 'save-all',
    baseTitle: 'Save everything',
    baseTooltipFragment: 'Save everything',
    group: 'more',
    // No delayed variants — see `save-defaults`.
    supportsDelayed: false,
    run: (delayMs) => captureAll(delayMs),
  },
  // Three selection-format shortcuts. A single capture can only
  // produce one selection file, so we expose each serialization
  // format as its own action rather than asking the user to pick
  // mid-capture. `captureSelection` throws if the chosen format's
  // body is empty (e.g. "Save selection as text" on an
  // image-only selection), and the toolbar error channel surfaces
  // the reason so the user can retry with a different format.
  {
    baseId: 'save-selection-html',
    baseTitle: 'Save selection as HTML',
    // All three `save-selection-*` actions share the same tooltip
    // fragment `Save selection` — the format (HTML / text / markdown)
    // is omitted so the row-collapse rule in `tooltip.ts` can pair
    // a `save-selection-*` slot with a single-word `Save <noun>`
    // sibling and yield `Save <noun> or selection` cleanly. The
    // user-visible menu title still carries the format so users
    // pick the right action from the menu; only the tooltip
    // fragment elides it.
    baseTooltipFragment: 'Save selection',
    group: 'more',
    // The selection already exists when the user triggers the
    // action; waiting doesn't help. Still bindable as the default
    // click action at 0s via the Options page.
    supportsDelayed: false,
    run: (delayMs) => captureSelection('html', delayMs),
  },
  {
    baseId: 'save-selection-text',
    baseTitle: 'Save selection as text',
    baseTooltipFragment: 'Save selection',
    group: 'more',
    supportsDelayed: false,
    run: (delayMs) => captureSelection('text', delayMs),
  },
  {
    baseId: 'save-selection-markdown',
    baseTitle: 'Save selection as markdown',
    baseTooltipFragment: 'Save selection',
    group: 'more',
    supportsDelayed: false,
    run: (delayMs) => captureSelection('markdown', delayMs),
  },
];

// All delays (in seconds) we surface in the menu. 0 is the plain
// top-level / More-submenu entry set; 3 goes into the
// delayed-shortcut block inside the More submenu.
export const CAPTURE_DELAYS_SEC = [0, 3] as const;

function delayedId(baseId: string, delaySec: number): string {
  return delaySec === 0 ? baseId : `${baseId}-${delaySec}s`;
}

// Build a delayed title. The "in Ns" phrase is appended verbatim,
// so dialog-style titles that end in "..." (e.g. "Capture...") read
// as "Capture... in 3s" — the ellipsis stays anchored to the action
// name and the delay sits as a plain trailing phrase. Exported so
// `context-menu.ts` can render the same form when a non-action label
// (e.g. the stock-defaults "Save screenshot or selection" placeholder)
// needs the matching delay suffix.
export function delayedTitle(baseTitle: string, delaySec: number): string {
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
  return delays.map((delaySec) => ({
    id: delayedId(base.baseId, delaySec),
    title: delayedTitle(base.baseTitle, delaySec),
    tooltipFragment: delayedTooltipFragment(base.baseTooltipFragment, delaySec),
    baseId: base.baseId,
    group: base.group,
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
