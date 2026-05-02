// Toolbar-icon tooltip layout. Pure logic — no chrome.* calls — so the
// algorithm is unit-testable from node:test. `getDefaultActionTooltip`
// in `default-action.ts` reads the live storage state and shortcut map
// and feeds the resulting snapshot into `buildTooltip` here.
//
// Per-row algorithm (Click row, Double-click row each go through it
// once). Inputs: a no-selection `CaptureAction` and an optional
// with-selection choice (an action id, possibly the `ignore-selection`
// sentinel). The row's primary fragment is the no-sel action's
// fragment, with `save-defaults` expanded to its actual artifact list
// against the matching `capturePageDefaults` branch.
//
// The with-selection slot then renders one of four ways (Case 1–4):
//
//   1. Same effective behaviour (action ids match AND, for
//      save-defaults, the expanded artifact set matches), or the slot
//      is `ignore-selection`. → single-line row.
//   2. With-sel saves only a selection (literal `save-selection-<fmt>`
//      OR `save-defaults` configured selection-only). → continuation
//      `  (or selection <fmt>)`.
//   3. Both slots are `save-defaults` and with-sel's expansion equals
//      no-sel's expansion plus exactly one `selection-<fmt>` item. →
//      continuation `  (plus selection <fmt>)`.
//   4. Anything else. → continuation `  With selection: <frag(W)>`.
//
// Row shapes:
//   - Case 1 (single line):  `<Label>: <frag>  [<key>]`
//   - Cases 2–4 (three lines, each action indented so they line up):
//       <Label> [<key>]:
//         <no-sel frag>
//         <continuation>
//
// The 3-line shape on multi-line rows keeps the two action
// descriptions visually aligned at a single 2-space indent, so the
// reader can scan them as a list. The hotkey sits next to the label
// (inside `[]`, before the colon) on multi-line rows since there's no
// trailing fragment on the label line to attach it to.

import type { CaptureDetailsDefaults } from './capture-page-defaults.js';

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
   * which the builder replaces with the expanded artifact list. */
  tooltipFragment: string;
}

export interface TooltipInputs {
  click: TooltipAction;
  /** With-selection click choice. `undefined` covers both
   *  `ignore-selection` (sentinel resolves to no `CaptureAction`) and
   *  any unrecognized id — both are rendered as a single-line row
   *  with no with-selection continuation. */
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
 * Effective artifact set for an action under a given branch. `null`
 * means "not a fixed-artifact action" (today, only `capture` — it
 * opens the Capture page so the artifacts depend on user clicks
 * inside the dialog). Sets are compared with `setsEqual`; the strings
 * are stable identifiers, not user-visible text.
 */
function effectiveItems(
  action: TooltipAction,
  defaults: CaptureDetailsDefaults,
  branch: Branch,
): Set<string> | null {
  switch (action.baseId) {
    case 'capture':
      return null;
    case 'save-screenshot':
      return new Set(['screenshot']);
    case 'save-page-contents':
      return new Set(['html']);
    case 'save-url':
      return new Set(['url']);
    // `save-all` writes screenshot + HTML, plus selection if one
    // happens to be present at capture time. The no-sel slot only
    // fires when there is no selection, and `save-all` isn't a valid
    // with-sel choice (it's not in WITH_SELECTION_CHOICES), so the
    // selection branch never matters here.
    case 'save-all':
      return new Set(['screenshot', 'html']);
    case 'save-selection-html':
      return new Set(['selection-html']);
    case 'save-selection-text':
      return new Set(['selection-text']);
    case 'save-selection-markdown':
      return new Set(['selection-markdown']);
    case 'save-defaults': {
      const items = new Set<string>();
      if (branch === 'withoutSelection') {
        if (defaults.withoutSelection.screenshot) items.add('screenshot');
        if (defaults.withoutSelection.html) items.add('html');
      } else {
        if (defaults.withSelection.screenshot) items.add('screenshot');
        if (defaults.withSelection.html) items.add('html');
        if (defaults.withSelection.selection) {
          items.add(`selection-${defaults.withSelection.format}`);
        }
      }
      return items;
    }
    default:
      return null;
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Display form for a selection format — `html` → `HTML` (acronym
 *  uppercased to match the tooltip's existing capitalisation
 *  convention, see `Save HTML contents`). */
function formatDisplay(fmt: string): string {
  return fmt === 'html' ? 'HTML' : fmt;
}

/** If `items` is exactly one `selection-<fmt>` element, return the
 *  display form of that format; otherwise null. */
function selectionFormatOnly(items: Set<string>): string | null {
  if (items.size !== 1) return null;
  const [only] = items;
  const m = only!.match(/^selection-(html|text|markdown)$/);
  return m ? formatDisplay(m[1]!) : null;
}

/** If `withSel` equals `noSel` plus exactly one `selection-<fmt>`,
 *  return the display form of that format; otherwise null. */
function selectionFormatAdded(
  noSel: Set<string>,
  withSel: Set<string>,
): string | null {
  if (withSel.size !== noSel.size + 1) return null;
  for (const x of noSel) if (!withSel.has(x)) return null;
  const extras: string[] = [];
  for (const x of withSel) if (!noSel.has(x)) extras.push(x);
  if (extras.length !== 1) return null;
  const m = extras[0]!.match(/^selection-(html|text|markdown)$/);
  return m ? formatDisplay(m[1]!) : null;
}

/**
 * Render an action's tooltip fragment, expanding `save-defaults` to
 * the actual artifact list under the given branch. A `save-defaults`
 * action with no items checked falls back to its placeholder
 * (`Save default items[ in Ns]`) — that's the literal name shown on
 * the Options page, and a bare `Save ` would read worse than the
 * action name.
 */
export function expandFragment(
  action: TooltipAction,
  defaults: CaptureDetailsDefaults,
  branch: Branch,
): string {
  if (action.baseId !== 'save-defaults') return action.tooltipFragment;
  const items: string[] = [];
  if (branch === 'withoutSelection') {
    if (defaults.withoutSelection.screenshot) items.push('screenshot');
    if (defaults.withoutSelection.html) items.push('HTML');
  } else {
    if (defaults.withSelection.screenshot) items.push('screenshot');
    if (defaults.withSelection.html) items.push('HTML');
    if (defaults.withSelection.selection) {
      items.push(`selection ${formatDisplay(defaults.withSelection.format)}`);
    }
  }
  if (items.length === 0) return action.tooltipFragment;
  const base = `Save ${items.join(', ')}`;
  return action.delaySec === 0 ? base : `${base} in ${action.delaySec}s`;
}

/**
 * Build the 1-or-2 lines for one row (Click or Double-click). See the
 * file header for the four cases. Hotkey suffix always goes on the
 * first line.
 */
export function buildRow(
  label: string,
  noSel: TooltipAction,
  withSel: TooltipAction | undefined,
  defaults: CaptureDetailsDefaults,
  hotkey: string | undefined,
): string[] {
  const noSelFrag = expandFragment(noSel, defaults, 'withoutSelection');

  // Decide on the continuation string (or null = single-line row).
  let continuation: string | null = null;
  if (withSel) {
    const noSelItems = effectiveItems(noSel, defaults, 'withoutSelection');
    const withSelItems = effectiveItems(withSel, defaults, 'withSelection');

    // Case 1 check: same effective behaviour. Strict id equality is
    // required so a delayed no-sel `save-defaults-2s` paired with a
    // 0s with-sel `save-defaults` (different actions, same artifact
    // set) doesn't collapse and silently hide the delay mismatch.
    // `null` items mean "unknown artifact set" (today only `capture`);
    // those still match when both ids are equal.
    const sameItems = noSel.id === withSel.id
      && (
        (noSelItems === null && withSelItems === null)
        || (noSelItems !== null
          && withSelItems !== null
          && setsEqual(noSelItems, withSelItems))
      );

    if (!sameItems) {
      // Case 2: with-sel saves only a selection.
      let fmt = withSelItems ? selectionFormatOnly(withSelItems) : null;
      if (fmt) {
        continuation = `(or selection ${fmt})`;
      } else {
        // Case 3: with-sel = no-sel + one selection.
        if (noSelItems && withSelItems) {
          fmt = selectionFormatAdded(noSelItems, withSelItems);
        }
        if (fmt) {
          continuation = `(plus selection ${fmt})`;
        } else {
          // Case 4: full description.
          continuation = `With selection: ${expandFragment(withSel, defaults, 'withSelection')}`;
        }
      }
    }
  }

  // Single-line row (Case 1 / ignore-selection): hotkey at end.
  if (continuation === null) {
    const hkSuffix = hotkey ? `  [${hotkey}]` : '';
    return [`${label}: ${noSelFrag}${hkSuffix}`];
  }

  // Three-line row: hotkey next to label so the two action lines
  // line up under a clean header line.
  const hkInLabel = hotkey ? ` [${hotkey}]` : '';
  return [
    `${label}${hkInLabel}:`,
    `  ${noSelFrag}`,
    `  ${continuation}`,
  ];
}

/**
 * Assemble the complete tooltip text. Layout:
 *
 *   SeeWhatISee
 *   [blank]
 *   [ERROR: <msg>]            (only when errorMessage is set)
 *   [blank]
 *   <Click row, 1 or 2 lines>
 *   <Double-click row, 1 or 2 lines>
 *   [blank trailing line]
 *
 * Trailing blank gives the action block breathing room from whatever
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
    ...buildRow(
      'Click',
      inputs.click,
      inputs.clickWithSel,
      inputs.captureDefaults,
      inputs.clickHotkey,
    ),
  );
  lines.push(
    ...buildRow(
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
