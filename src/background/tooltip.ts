// Toolbar-icon tooltip layout. Pure logic — no chrome.* calls — so the
// algorithm is unit-testable from node:test. `getDefaultActionTooltip`
// in `default-action.ts` reads the live storage state and shortcut map
// and feeds the resulting snapshot into `buildTooltip` here.
//
// Layout — header + optional error block + one line per row + trailing
// blank:
//
//   SeeWhatISee
//   [blank]
//   [ERROR: <msg>]
//   [blank]
//   Click[ [<hotkey>]]: <fragment>          ← always single-line
//   Double-click[ [<hotkey>]]: <fragment>
//   [blank]
//
// Per-row rule. Each row computes a no-sel fragment and a with-sel
// fragment, then collapses them:
//
//   - Equal fragments → that single fragment.
//   - Both of form `Save <single-word>` (different words) →
//     `Save <noSelWord> or <withSelWord>` (the stock-defaults case
//     reads as `Save screenshot or selection`).
//   - Otherwise → `...` (literal ellipsis — the configuration is too
//     mixed to summarise on one line; the right-click menu carries
//     the per-action breakdown).
//
// `save-defaults` per-branch expansion. When a branch saves exactly
// one artifact (screenshot, HTML, or selection — format dropped),
// the fragment is `Save <item>`. When it saves none or multiple,
// the fragment falls back to the catalog `Save default items` (the
// "or"-form requires a single one-word noun on each side).

import { type CaptureDetailsDefaults } from './capture-page-defaults.js';

/**
 * Minimal projection of `CaptureAction` that the tooltip builder cares
 * about. Defined here (rather than imported) so this module stays free
 * of chrome.* transitives — the unit test imports it directly.
 */
export interface TooltipAction {
  id: string;
  baseId: string;
  delaySec: number;
  /** Pre-rendered fragment for non-`save-defaults` actions. For
   * `save-defaults` it's the placeholder `Save default items[ in Ns]`,
   * which the builder replaces with `Save <item>` when the branch
   * saves exactly one artifact. */
  tooltipFragment: string;
}

export interface TooltipInputs {
  click: TooltipAction;
  /** With-selection click choice. `undefined` covers both the
   *  `ignore-selection` sentinel and any unrecognized id; in either
   *  case the row's with-sel branch falls through to the no-sel
   *  action (matching the runtime dispatch in `default-action.ts`). */
  clickWithSel: TooltipAction | undefined;
  doubleClick: TooltipAction;
  dblWithSel: TooltipAction | undefined;
  captureDefaults: CaptureDetailsDefaults;
  /** `_execute_action` shortcut, if bound. */
  clickHotkey: string | undefined;
  /** `secondary-action` shortcut, if bound. */
  dblHotkey: string | undefined;
  /** When set, the tooltip prepends an `ERROR: <msg>` line. */
  errorMessage?: string;
}

type Branch = 'withoutSelection' | 'withSelection';

/**
 * Compute the single-item summary for a `save-defaults` action under
 * the given branch, or `null` if the branch saves zero or multiple
 * items. The format is intentionally dropped from the selection slot
 * (`selection`, not `selection markdown`) because the row-collapse
 * rule requires a single one-word noun on each side, and most users
 * never see two formats coexist on screen.
 */
function singleSaveDefaultsItem(
  defaults: CaptureDetailsDefaults,
  branch: Branch,
): string | null {
  const items: string[] = [];
  if (branch === 'withoutSelection') {
    if (defaults.withoutSelection.screenshot) items.push('screenshot');
    if (defaults.withoutSelection.html) items.push('HTML');
  } else {
    if (defaults.withSelection.screenshot) items.push('screenshot');
    if (defaults.withSelection.html) items.push('HTML');
    if (defaults.withSelection.selection) items.push('selection');
  }
  return items.length === 1 ? items[0]! : null;
}

/**
 * Render an action's fragment for a single branch. Strictly per-branch
 * — never produces a combined `Save X or Y` (the row-level
 * `combineFragments` does that). For `save-defaults`, drops to the
 * catalog `Save default items` when the branch isn't a single item;
 * the `Save X or Y` collapse rule needs a one-word noun on each
 * side.
 */
export function expandFragment(
  action: TooltipAction,
  defaults: CaptureDetailsDefaults,
  branch: Branch,
): string {
  if (action.baseId !== 'save-defaults') return action.tooltipFragment;
  const single = singleSaveDefaultsItem(defaults, branch);
  if (!single) return action.tooltipFragment;
  const base = `Save ${single}`;
  return action.delaySec === 0 ? base : `${base} in ${action.delaySec}s`;
}

/**
 * Match a `Save <single-word>[ in Ns]` fragment and return the
 * one-word noun (and shared delay suffix), or `null` for any other
 * shape. Used by `combineFragments` to decide whether two distinct
 * branch fragments can collapse into a `Save X or Y` row instead of
 * the bail-out ellipsis.
 *
 * Allowing the optional ` in Ns` suffix lets a row whose two
 * branches share the *same* delay still collapse — anything else
 * (mismatched delays, multi-word nouns, leading verb that isn't
 * `Save`) falls through to `...`.
 *
 * The noun is restricted to `[A-Za-z]+` (alphabetic only) rather
 * than `\w+`. Every fragment the codebase actually produces today
 * matches alpha-only (`screenshot`, `HTML`, `selection`, `URL`,
 * `everything`); the tighter pattern blocks accidental matches on
 * any future fragment that includes digits or underscores from
 * silently collapsing a row that the design wouldn't authorise.
 */
function parseSaveWordFragment(
  fragment: string,
): { word: string; delay: string } | null {
  const m = fragment.match(/^Save ([A-Za-z]+)( in \d+s)?$/);
  if (!m) return null;
  return { word: m[1]!, delay: m[2] ?? '' };
}

/**
 * Combine the no-sel and with-sel fragments for a row into a single
 * line. See the file header for the three cases (equal, `Save X or
 * Y`, fall-through ellipsis).
 */
export function combineFragments(noSelFrag: string, withSelFrag: string): string {
  if (noSelFrag === withSelFrag) return noSelFrag;
  const noParsed = parseSaveWordFragment(noSelFrag);
  const withParsed = parseSaveWordFragment(withSelFrag);
  if (
    noParsed !== null
    && withParsed !== null
    && noParsed.word !== withParsed.word
    && noParsed.delay === withParsed.delay
  ) {
    return `Save ${noParsed.word} or ${withParsed.word}${noParsed.delay}`;
  }
  return '...';
}

/**
 * Build one row (Click or Double-click). Always single-line:
 *
 *   `<label>: <fragment>[  [<hotkey>]]`
 *
 * The hotkey, when bound, trails the fragment in `[…]` separated by
 * two spaces — same shape the old Case-1 (single-line) row used,
 * since every row is single-line under the new rules.
 *
 * `withSel === undefined` means the runtime dispatch falls through
 * to the no-sel action (`ignore-selection` sentinel) — the with-sel
 * branch is computed against `noSel` itself so a `save-defaults`
 * no-sel default still expands the with-sel branch correctly.
 */
export function buildRow(
  label: string,
  noSel: TooltipAction,
  withSel: TooltipAction | undefined,
  defaults: CaptureDetailsDefaults,
  hotkey: string | undefined,
): string {
  const effectiveWithSel = withSel ?? noSel;
  const noSelFrag = expandFragment(noSel, defaults, 'withoutSelection');
  const withSelFrag = expandFragment(effectiveWithSel, defaults, 'withSelection');
  const fragment = combineFragments(noSelFrag, withSelFrag);
  const hkSuffix = hotkey ? `  [${hotkey}]` : '';
  return `${label}: ${fragment}${hkSuffix}`;
}

/**
 * Assemble the complete tooltip. See the file header for the layout.
 * Trailing blank gives the row block breathing room from whatever
 * Chrome appends below (the "Wants access to this site" permission
 * line, etc.).
 */
export function buildTooltip(inputs: TooltipInputs): string {
  const lines: string[] = ['SeeWhatISee'];
  if (inputs.errorMessage !== undefined) {
    lines.push('', `ERROR: ${inputs.errorMessage}`);
  }
  lines.push('');
  lines.push(
    buildRow(
      'Click',
      inputs.click,
      inputs.clickWithSel,
      inputs.captureDefaults,
      inputs.clickHotkey,
    ),
  );
  lines.push(
    buildRow(
      'Double-click',
      inputs.doubleClick,
      inputs.dblWithSel,
      inputs.captureDefaults,
      inputs.dblHotkey,
    ),
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * Combined "Save X or Y" / "Save X" / "Save default items" title
 * for `save-defaults` menu entries. Mirrors the row collapse but
 * runs at action-title time (action-property-based, not
 * routing-based) — `actionMenuTitle` in `context-menu.ts` is the
 * single caller. Returned title still wears the optional `in Ns`
 * delay suffix.
 */
export function saveDefaultsMenuTitle(
  defaults: CaptureDetailsDefaults,
  delaySec: number,
  fallbackCatalogTitle: string,
): string {
  const noSel = singleSaveDefaultsItem(defaults, 'withoutSelection');
  const withSel = singleSaveDefaultsItem(defaults, 'withSelection');
  if (noSel === null || withSel === null) {
    return delaySec === 0 ? fallbackCatalogTitle : `${fallbackCatalogTitle} in ${delaySec}s`;
  }
  const base = noSel === withSel ? `Save ${noSel}` : `Save ${noSel} or ${withSel}`;
  return delaySec === 0 ? base : `${base} in ${delaySec}s`;
}
