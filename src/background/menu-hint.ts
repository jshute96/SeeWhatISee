// Pure helpers that compose the right-side hint string for a menu
// entry — `(𝘊𝘭𝘪𝘤𝘬 or Ctrl+Shift+X w/o sel, …)` and friends.
// Extracted from `context-menu.ts` so node:test can import them
// without dragging in the chrome.* surface that the rest of the
// SW module pulls (the ask/, capture-page-defaults/, default-
// action/ chain triggers a circular module-init order that fails
// at import time outside the extension bundle).

// `IGNORE_SELECTION_ID` lives in `default-action.ts`, but importing
// from there re-introduces the circular-init problem this module
// exists to dodge. Hard-code the sentinel here as a `const` and let
// `default-action.ts`'s declaration stand as the source-of-truth
// for the storage value; a unit test pins the two constants as
// equal so a rename of the sentinel is caught immediately.
const IGNORE_SELECTION_ID = 'ignore-selection';

const HINT_SEPARATOR = '  -  ';

// Faked italics via Unicode mathematical sans-serif italic letters —
// `chrome.contextMenus` titles are plain text with no markup
// support, so the hint reads `(𝘊𝘭𝘪𝘤𝘬)` as literal characters.
export const CLICK_ITALIC = '𝘊𝘭𝘪𝘤𝘬';
export const DOUBLE_CLICK_ITALIC = '𝘋𝘰𝘶𝘣𝘭𝘦-𝘤𝘭𝘪𝘤𝘬';

/**
 * Per-row scope of a menu action against one of the two click rows
 * (Click or Double-click). Captures whether the action runs for the
 * row's no-sel branch, with-sel branch, both, or neither.
 *
 *   - `'both'`: row's no-sel default and with-sel default both
 *     resolve to this action.
 *   - `'noSelOnly'` / `'withSelOnly'`: only one branch matches.
 *   - `'none'`: neither branch matches; no hint group emitted.
 *
 * `IGNORE_SELECTION_ID` on the with-sel slot is treated as
 * fall-through to the no-sel default (matching the runtime
 * dispatch in `default-action.ts`), so a row of `(noSel = A,
 * withSel = ignore-selection)` reports `'both'` for action `A`.
 */
export type RowScope = 'both' | 'noSelOnly' | 'withSelOnly' | 'none';

export function rowScope(
  action: { id: string },
  noSelId: string,
  withSelId: string,
): RowScope {
  const isNo = action.id === noSelId;
  const isWith = action.id === withSelId
    || (withSelId === IGNORE_SELECTION_ID && action.id === noSelId);
  if (isNo && isWith) return 'both';
  if (isNo) return 'noSelOnly';
  if (isWith) return 'withSelOnly';
  return 'none';
}

const SCOPE_SUFFIX: Record<Exclude<RowScope, 'none'>, string> = {
  both: '',
  noSelOnly: ' w/o sel',
  withSelOnly: ' w/ sel',
};

/**
 * Render one trigger group — the Click row or Double-click row —
 * inside the menu hint. The italic word and the meta-hotkey
 * (`_execute_action` for Click, `secondary-action` for Double-click)
 * are joined with " or " when both are present, since both fire the
 * same dispatch path against this action; the +sel/-sel scope
 * suffix sits at the end of the group as a single qualifier.
 *
 * Returns `null` when the action isn't this row's default in either
 * branch (the caller drops empty groups).
 */
export function buildRowGroup(
  italicWord: string,
  scope: RowScope,
  hotkey: string | undefined,
): string | null {
  if (scope === 'none') return null;
  const triggers: string[] = [italicWord];
  if (hotkey) triggers.push(hotkey);
  return `${triggers.join(' or ')}${SCOPE_SUFFIX[scope]}`;
}

/**
 * Build the right-side hint for a menu entry. Format:
 *
 *   `  -  (<click-group>[, <dbl-group>][, <action-hotkey>])`
 *
 * Each group is omitted when empty. Groups:
 *   - Click group — italic `𝘊𝘭𝘪𝘤𝘬` + the activate hotkey, joined
 *     by ` or `, with a +sel/-sel suffix when only one branch
 *     routes to this action.
 *   - Double-click group — italic `𝘋𝘰𝘶𝘣𝘭𝘦-𝘤𝘭𝘪𝘤𝘬` + the
 *     `secondary-action` hotkey, same shape.
 *   - Action-specific hotkey — the action's own bound command (e.g.
 *     `12-save-screenshot`). Always full-scope, so it sits as a
 *     bare group at the end.
 *
 * `_execute_action` and `secondary-action` are dispatch-level
 * meta-commands: pressing them runs whichever click / double-click
 * default the user has set. So they ride the Click / Double-click
 * group with the same scope as the italic word, rather than appearing
 * as their own bare group.
 *
 * Takes both no-sel and with-sel ids for each row because scope
 * detection depends on whether the action matches one branch or
 * both. `IGNORE_SELECTION_ID` on the with-sel slot is folded in by
 * `rowScope` (it falls through to the no-sel default), so the caller
 * doesn't have to special-case it.
 */
export function buildMenuHint(
  action: { id: string },
  clickNoSelId: string,
  clickWithSelId: string,
  dblNoSelId: string,
  dblWithSelId: string,
  shortcuts: Map<string, string>,
): string {
  const groups: string[] = [];
  const clickGroup = buildRowGroup(
    CLICK_ITALIC,
    rowScope(action, clickNoSelId, clickWithSelId),
    shortcuts.get('_execute_action'),
  );
  if (clickGroup) groups.push(clickGroup);
  const dblGroup = buildRowGroup(
    DOUBLE_CLICK_ITALIC,
    rowScope(action, dblNoSelId, dblWithSelId),
    shortcuts.get('secondary-action'),
  );
  if (dblGroup) groups.push(dblGroup);
  const ownHotkey = shortcuts.get(action.id);
  if (ownHotkey) groups.push(ownHotkey);
  if (groups.length === 0) return '';
  return `${HINT_SEPARATOR}(${groups.join(', ')})`;
}
