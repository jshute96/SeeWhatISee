// Unit tests for the right-click menu-hint helpers in
// `src/background/context-menu.ts`. The helpers are pure (no
// chrome.* calls, no storage reads — they take ids and a shortcut
// map directly) so node:test can drive them without spinning up the
// extension.
//
// Coverage target:
//   - rowScope: every (no-sel match × with-sel match × ignore-selection)
//     combination resolves to one of the four `RowScope` outcomes.
//   - buildRowGroup: italic word, optional hotkey, scope suffix.
//   - buildMenuHint: composes the two row groups + the
//     action-specific hotkey into one parens block, dropping empty
//     groups.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMenuHint,
  buildRowGroup,
  CLICK_ITALIC,
  DOUBLE_CLICK_ITALIC,
  rowScope,
} from '../../dist/background/menu-hint.js';

import { readFileSync } from 'node:fs';

// Mirror of the `menu-hint.ts` private sentinel (also
// `'ignore-selection'`). We can't import `IGNORE_SELECTION_ID` from
// `default-action.js` here because that module triggers the
// circular-init chain (`WITH_SELECTION_CHOICES` reads `CAPTURE_ACTIONS`
// at top level) — the very chain `menu-hint.ts` was extracted to
// avoid. The grep test below pins the two literal strings against
// each other instead.
const IGNORE = 'ignore-selection';

test('menu-hint sentinel matches default-action.ts IGNORE_SELECTION_ID source declaration', () => {
  // Tree-grep the source so a rename of `'ignore-selection'` in
  // either file fails this test loudly. Reads the .ts source rather
  // than the .js build because the two `export const` lines are
  // adjacent in source and the grep is exact.
  const defaultActionSrc = readFileSync(
    new URL('../../src/background/default-action.ts', import.meta.url),
    'utf8',
  );
  const menuHintSrc = readFileSync(
    new URL('../../src/background/menu-hint.ts', import.meta.url),
    'utf8',
  );
  assert.match(defaultActionSrc, /IGNORE_SELECTION_ID = 'ignore-selection'/);
  assert.match(menuHintSrc, /IGNORE_SELECTION_ID = 'ignore-selection'/);
});

const A = { id: 'save-screenshot' };
const B = { id: 'capture' };

// ── rowScope ──────────────────────────────────────────────────────

test('rowScope: action matches both no-sel and with-sel → "both"', () => {
  assert.equal(rowScope(A, A.id, A.id), 'both');
});

test('rowScope: action matches only no-sel → "noSelOnly"', () => {
  assert.equal(rowScope(A, A.id, B.id), 'noSelOnly');
});

test('rowScope: action matches only with-sel → "withSelOnly"', () => {
  assert.equal(rowScope(A, B.id, A.id), 'withSelOnly');
});

test('rowScope: action matches neither → "none"', () => {
  assert.equal(rowScope(A, B.id, B.id), 'none');
});

test('rowScope: ignore-selection on with-sel falls through to no-sel default', () => {
  // User has "Click w/o sel = save-screenshot, Click w/ sel =
  // ignore-selection". Pressing Click with a selection runs
  // save-screenshot too — the dispatch ignores the selection. So
  // save-screenshot's row scope is "both", not "noSelOnly".
  assert.equal(rowScope(A, A.id, IGNORE), 'both');
});

test('rowScope: ignore-selection on with-sel does NOT promote a non-no-sel-default action', () => {
  // Action B isn't the no-sel default, so ignore-selection on
  // with-sel doesn't make B match either branch.
  assert.equal(rowScope(B, A.id, IGNORE), 'none');
});

// ── buildRowGroup ─────────────────────────────────────────────────

test('buildRowGroup: scope=none returns null regardless of hotkey', () => {
  assert.equal(buildRowGroup(CLICK_ITALIC, 'none', undefined), null);
  assert.equal(buildRowGroup(CLICK_ITALIC, 'none', 'Ctrl+Shift+X'), null);
});

test('buildRowGroup: scope=both, no hotkey → just the italic word', () => {
  assert.equal(buildRowGroup(CLICK_ITALIC, 'both', undefined), CLICK_ITALIC);
});

test('buildRowGroup: scope=both, with hotkey → italic " or " hotkey', () => {
  assert.equal(
    buildRowGroup(CLICK_ITALIC, 'both', 'Ctrl+Shift+X'),
    `${CLICK_ITALIC} or Ctrl+Shift+X`,
  );
});

test('buildRowGroup: scope=noSelOnly appends " w/o sel" suffix', () => {
  assert.equal(
    buildRowGroup(CLICK_ITALIC, 'noSelOnly', 'Ctrl+Shift+X'),
    `${CLICK_ITALIC} or Ctrl+Shift+X w/o sel`,
  );
  assert.equal(
    buildRowGroup(CLICK_ITALIC, 'noSelOnly', undefined),
    `${CLICK_ITALIC} w/o sel`,
  );
});

test('buildRowGroup: scope=withSelOnly appends " w/ sel" suffix', () => {
  assert.equal(
    buildRowGroup(DOUBLE_CLICK_ITALIC, 'withSelOnly', 'Alt+Shift+X'),
    `${DOUBLE_CLICK_ITALIC} or Alt+Shift+X w/ sel`,
  );
  assert.equal(
    buildRowGroup(DOUBLE_CLICK_ITALIC, 'withSelOnly', undefined),
    `${DOUBLE_CLICK_ITALIC} w/ sel`,
  );
});

// ── buildMenuHint ─────────────────────────────────────────────────

const HINT_SEPARATOR = '  -  ';

function hint(...groups) {
  return groups.length === 0 ? '' : `${HINT_SEPARATOR}(${groups.join(', ')})`;
}

test('buildMenuHint: action is no one\'s default and has no own hotkey → empty string', () => {
  // No groups at all → no leading "  -  (".
  assert.equal(
    buildMenuHint(A, B.id, B.id, B.id, B.id, new Map()),
    '',
  );
});

test('buildMenuHint: full Click coverage with activate hotkey', () => {
  const shortcuts = new Map([['_execute_action', 'Ctrl+Shift+X']]);
  assert.equal(
    buildMenuHint(A, A.id, A.id, B.id, B.id, shortcuts),
    hint(`${CLICK_ITALIC} or Ctrl+Shift+X`),
  );
});

test('buildMenuHint: split click (no-sel only) with activate hotkey', () => {
  const shortcuts = new Map([['_execute_action', 'Ctrl+Shift+X']]);
  assert.equal(
    buildMenuHint(A, A.id, B.id, B.id, B.id, shortcuts),
    hint(`${CLICK_ITALIC} or Ctrl+Shift+X w/o sel`),
  );
});

test('buildMenuHint: split click (with-sel only) with activate hotkey', () => {
  const shortcuts = new Map([['_execute_action', 'Ctrl+Shift+X']]);
  assert.equal(
    buildMenuHint(A, B.id, A.id, B.id, B.id, shortcuts),
    hint(`${CLICK_ITALIC} or Ctrl+Shift+X w/ sel`),
  );
});

test('buildMenuHint: full Click + full Double-click + both meta-hotkeys', () => {
  const shortcuts = new Map([
    ['_execute_action', 'Ctrl+Shift+X'],
    ['secondary-action', 'Alt+Shift+X'],
  ]);
  assert.equal(
    buildMenuHint(A, A.id, A.id, A.id, A.id, shortcuts),
    hint(
      `${CLICK_ITALIC} or Ctrl+Shift+X`,
      `${DOUBLE_CLICK_ITALIC} or Alt+Shift+X`,
    ),
  );
});

test('buildMenuHint: split click no-sel + split dbl with-sel + both meta-hotkeys', () => {
  // The user's reported scenario: dbl-no-sel = save-defaults,
  // dbl-with-sel = capture (= action B). Action B (capture) is the
  // click default for both branches AND the dbl with-sel default.
  // Hint should read: Click full + Double-click w/ sel.
  const shortcuts = new Map([
    ['_execute_action', 'Ctrl+Shift+X'],
    ['secondary-action', 'Alt+Shift+X'],
  ]);
  assert.equal(
    buildMenuHint(B, B.id, B.id, A.id, B.id, shortcuts),
    hint(
      `${CLICK_ITALIC} or Ctrl+Shift+X`,
      `${DOUBLE_CLICK_ITALIC} or Alt+Shift+X w/ sel`,
    ),
  );
});

test('buildMenuHint: action-specific hotkey appears as bare full-scope group at the end', () => {
  // Action B isn't anyone's click/dbl default, but its own command
  // is bound. Hint shows just the bare hotkey — no italic word, no
  // scope suffix.
  const shortcuts = new Map([[B.id, 'F8']]);
  assert.equal(
    buildMenuHint(B, A.id, A.id, A.id, A.id, shortcuts),
    hint('F8'),
  );
});

test('buildMenuHint: action-specific hotkey alongside Click coverage stacks both groups', () => {
  // Click default + action-specific hotkey both bound on the same
  // action. Hint reads "(Click or <metaHk>, <ownHk>)".
  const shortcuts = new Map([
    ['_execute_action', 'Ctrl+Shift+X'],
    [A.id, 'F8'],
  ]);
  assert.equal(
    buildMenuHint(A, A.id, A.id, B.id, B.id, shortcuts),
    hint(`${CLICK_ITALIC} or Ctrl+Shift+X`, 'F8'),
  );
});

test('buildMenuHint: Click default with no activate hotkey bound shows just the italic', () => {
  // The activate hotkey (`_execute_action`) is unbound but the
  // action is still the click default. The italic word stands alone
  // in the group.
  assert.equal(
    buildMenuHint(A, A.id, A.id, B.id, B.id, new Map()),
    hint(CLICK_ITALIC),
  );
});

test('buildMenuHint: ignore-selection on with-sel slot promotes the no-sel default to "both"', () => {
  // User has Click w/o sel = save-screenshot, Click w/ sel =
  // ignore-selection. Save-screenshot is effectively the click
  // default for both branches, so its hint reads "(Click)" without
  // a scope suffix.
  assert.equal(
    buildMenuHint(A, A.id, IGNORE, B.id, B.id, new Map()),
    hint(CLICK_ITALIC),
  );
});
