// Unit tests for the toolbar-icon tooltip builder in
// `src/background/tooltip.ts`. The function is pure (no chrome.*
// calls) precisely so we can pin the new collapse rules here without
// spinning up Playwright.
//
// Layout: each row (Click / Double-click) is a single line. The
// row's no-sel and with-sel fragments collapse via three rules
// (equal → that fragment; both `Save <single-word>` → "Save X or Y";
// otherwise → "..."). See `tooltip.ts` header for the full algorithm.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTooltip,
  buildRow,
  combineFragments,
  expandFragment,
  saveDefaultsMenuTitle,
} from '../../dist/background/tooltip.js';

// ── Action shape helpers ──────────────────────────────────────────
//
// Hand-written to mirror the CAPTURE_ACTIONS table so tests don't
// depend on the SW-side action builder. Edit alongside that table if
// fragments change.

function action(baseId, fragment, delaySec = 0) {
  const id = delaySec === 0 ? baseId : `${baseId}-${delaySec}s`;
  return { id, baseId, delaySec, tooltipFragment: fragment };
}

const CAPTURE = action('capture', 'Capture...');
const SAVE_DEFAULTS = action('save-defaults', 'Save default items');
const SAVE_DEFAULTS_3S = action('save-defaults', 'Save default items in 3s', 3);
const SAVE_SCREENSHOT = action('save-screenshot', 'Save screenshot');
const SAVE_SCREENSHOT_3S = action('save-screenshot', 'Save screenshot in 3s', 3);
const SAVE_HTML = action('save-page-contents', 'Save HTML contents');
const SAVE_URL = action('save-url', 'Save URL');
const SAVE_ALL = action('save-all', 'Save everything');
const SAVE_SEL_HTML = action('save-selection-html', 'Save as HTML');
const SAVE_SEL_TEXT = action('save-selection-text', 'Save as text');
const SAVE_SEL_MD = action('save-selection-markdown', 'Save as markdown');

// ── capturePageDefaults presets ───────────────────────────────────

const STOCK_DEFAULTS = {
  withoutSelection: { screenshot: true, html: false },
  withSelection: { screenshot: false, html: false, selection: true, format: 'markdown' },
  defaultButton: 'capture',
  promptEnter: 'send',
};

const HTML_ONLY_NOSEL = {
  ...STOCK_DEFAULTS,
  withoutSelection: { screenshot: false, html: true },
};

const SCREENSHOT_BOTH_BRANCHES = {
  ...STOCK_DEFAULTS,
  withoutSelection: { screenshot: true, html: false },
  withSelection: { screenshot: true, html: false, selection: false, format: 'markdown' },
};

const MULTI_NOSEL = {
  ...STOCK_DEFAULTS,
  withoutSelection: { screenshot: true, html: true },
};

const ALL_OFF_DEFAULTS = {
  withoutSelection: { screenshot: false, html: false },
  withSelection: { screenshot: false, html: false, selection: false, format: 'markdown' },
  defaultButton: 'capture',
  promptEnter: 'send',
};

// ── expandFragment ────────────────────────────────────────────────

test('expandFragment: non-save-defaults action returns its tooltipFragment unchanged', () => {
  assert.equal(expandFragment(SAVE_SCREENSHOT, STOCK_DEFAULTS, 'withoutSelection'), 'Save screenshot');
  assert.equal(expandFragment(SAVE_SEL_MD, STOCK_DEFAULTS, 'withSelection'), 'Save as markdown');
  assert.equal(expandFragment(CAPTURE, STOCK_DEFAULTS, 'withoutSelection'), 'Capture...');
});

test('expandFragment: save-defaults under stock defaults — strictly per-branch', () => {
  // Regression: an earlier version short-circuited to "Save screenshot
  // or selection" regardless of branch, which contradicted the with-sel
  // continuation when the row had a non-save-defaults with-sel slot.
  assert.equal(expandFragment(SAVE_DEFAULTS, STOCK_DEFAULTS, 'withoutSelection'), 'Save screenshot');
  assert.equal(expandFragment(SAVE_DEFAULTS, STOCK_DEFAULTS, 'withSelection'), 'Save selection');
});

test('expandFragment: save-defaults drops the format from selection', () => {
  // The combined "Save X or Y" form needs a one-word noun, so the
  // format suffix is dropped at expansion time. The Capture-page
  // checkbox state still stores it; only the menu / tooltip label
  // omits it.
  const textFmt = {
    ...STOCK_DEFAULTS,
    withSelection: { screenshot: false, html: false, selection: true, format: 'text' },
  };
  assert.equal(expandFragment(SAVE_DEFAULTS, textFmt, 'withSelection'), 'Save selection');
  const htmlFmt = {
    ...STOCK_DEFAULTS,
    withSelection: { screenshot: false, html: false, selection: true, format: 'html' },
  };
  assert.equal(expandFragment(SAVE_DEFAULTS, htmlFmt, 'withSelection'), 'Save selection');
});

test('expandFragment: save-defaults branch with multiple items falls back to placeholder', () => {
  // The `Save X or Y` collapse rule needs a single-word noun on each
  // side, so anything richer than one item per branch falls back to
  // the catalog title rather than a comma-and join.
  assert.equal(expandFragment(SAVE_DEFAULTS, MULTI_NOSEL, 'withoutSelection'), 'Save default items');
});

test('expandFragment: save-defaults empty branch falls back to placeholder', () => {
  assert.equal(expandFragment(SAVE_DEFAULTS, ALL_OFF_DEFAULTS, 'withoutSelection'), 'Save default items');
  assert.equal(expandFragment(SAVE_DEFAULTS, ALL_OFF_DEFAULTS, 'withSelection'), 'Save default items');
});

test('expandFragment: delayed save-defaults preserves the "in Ns" suffix', () => {
  assert.equal(
    expandFragment(SAVE_DEFAULTS_3S, STOCK_DEFAULTS, 'withoutSelection'),
    'Save screenshot in 3s',
  );
});

// ── combineFragments ──────────────────────────────────────────────

test('combineFragments: equal fragments collapse to the single fragment', () => {
  assert.equal(combineFragments('Save screenshot', 'Save screenshot'), 'Save screenshot');
  assert.equal(combineFragments('Capture...', 'Capture...'), 'Capture...');
});

test('combineFragments: stock save-defaults pair → "Save screenshot or selection"', () => {
  assert.equal(combineFragments('Save screenshot', 'Save selection'), 'Save screenshot or selection');
});

test('combineFragments: any pair of "Save <word>" fragments combines', () => {
  assert.equal(combineFragments('Save HTML', 'Save selection'), 'Save HTML or selection');
  assert.equal(combineFragments('Save URL', 'Save screenshot'), 'Save URL or screenshot');
});

test('combineFragments: matching delay suffixes carry through', () => {
  assert.equal(
    combineFragments('Save screenshot in 3s', 'Save selection in 3s'),
    'Save screenshot or selection in 3s',
  );
});

test('combineFragments: mismatched delay falls through to ellipsis', () => {
  assert.equal(combineFragments('Save screenshot in 3s', 'Save screenshot'), '...');
});

test('combineFragments: multi-word "Save X" fragments fall through', () => {
  // "Save HTML contents" doesn't fit "Save W" with a one-word W, so
  // a row mixing it with anything else collapses to "...".
  assert.equal(combineFragments('Save HTML contents', 'Save selection'), '...');
  assert.equal(combineFragments('Save HTML contents', 'Save HTML contents'), 'Save HTML contents');
});

test('combineFragments: non-Save fragments fall through', () => {
  assert.equal(combineFragments('Capture...', 'Save screenshot'), '...');
  assert.equal(combineFragments('Save screenshot', 'Capture...'), '...');
});

// ── buildRow ──────────────────────────────────────────────────────

test('buildRow: identical action both branches collapses to one fragment', () => {
  assert.equal(
    buildRow('Click', CAPTURE, CAPTURE, STOCK_DEFAULTS, undefined),
    'Click: Capture...',
  );
});

test('buildRow: ignore-selection (withSel undefined) falls through to no-sel action', () => {
  assert.equal(
    buildRow('Click', SAVE_SCREENSHOT, undefined, STOCK_DEFAULTS, undefined),
    'Click: Save screenshot',
  );
});

test('buildRow: stock save-defaults / save-defaults pair → "Save screenshot or selection"', () => {
  assert.equal(
    buildRow('Double-click', SAVE_DEFAULTS, SAVE_DEFAULTS, STOCK_DEFAULTS, undefined),
    'Double-click: Save screenshot or selection',
  );
});

test('buildRow: ignore-selection (withSel undefined) on save-defaults expands the with-sel branch', () => {
  // ignore-selection short-circuits the dispatch to the no-sel default
  // — but for `save-defaults` that no-sel default's own internal
  // selection probe still picks the with-sel branch when a selection
  // is on the page. Tooltip should reflect that.
  assert.equal(
    buildRow('Click', SAVE_DEFAULTS, undefined, STOCK_DEFAULTS, undefined),
    'Click: Save screenshot or selection',
  );
});

test('buildRow: save-defaults / capture pair under stock → "..." (no Save W match for capture)', () => {
  // Regression: the row used to read "Save screenshot or selection"
  // on the no-sel slot with "With selection: Capture..." on a
  // continuation line. Both halves contradicted each other (the no-sel
  // slot doesn't run save-selection). New rule: bail to "...".
  assert.equal(
    buildRow('Double-click', SAVE_DEFAULTS, CAPTURE, STOCK_DEFAULTS, undefined),
    'Double-click: ...',
  );
});

test('buildRow: save-defaults under stock paired with explicit save-screenshot collapses', () => {
  // No-sel = "Save screenshot" (save-defaults expansion under stock),
  // with-sel = "Save screenshot" (save-screenshot's tooltipFragment).
  // Equal fragments → single fragment.
  assert.equal(
    buildRow('Click', SAVE_DEFAULTS, SAVE_SCREENSHOT, STOCK_DEFAULTS, undefined),
    'Click: Save screenshot',
  );
});

test('buildRow: hotkey trails the fragment with double-space separator', () => {
  assert.equal(
    buildRow('Click', CAPTURE, CAPTURE, STOCK_DEFAULTS, 'Ctrl+Shift+Y'),
    'Click: Capture...  [Ctrl+Shift+Y]',
  );
});

test('buildRow: hotkey trails a combined "Save X or Y" fragment', () => {
  assert.equal(
    buildRow('Double-click', SAVE_DEFAULTS, SAVE_DEFAULTS, STOCK_DEFAULTS, 'Alt+Shift+X'),
    'Double-click: Save screenshot or selection  [Alt+Shift+X]',
  );
});

test('buildRow: differing delay fragments fall through to ellipsis', () => {
  assert.equal(
    buildRow('Click', SAVE_SCREENSHOT_3S, SAVE_SCREENSHOT, STOCK_DEFAULTS, undefined),
    'Click: ...',
  );
});

test('buildRow: differing non-selection actions fall through to ellipsis', () => {
  // `Save HTML contents` doesn't match `Save <word>` (multi-word noun),
  // so the row can't combine and falls to "...".
  assert.equal(
    buildRow('Click', SAVE_HTML, CAPTURE, STOCK_DEFAULTS, undefined),
    'Click: ...',
  );
});

// ── saveDefaultsMenuTitle ─────────────────────────────────────────

test('saveDefaultsMenuTitle: stock defaults → "Save screenshot or selection"', () => {
  assert.equal(
    saveDefaultsMenuTitle(STOCK_DEFAULTS, 0, 'Save default items'),
    'Save screenshot or selection',
  );
});

test('saveDefaultsMenuTitle: both branches save the same single item → "Save X"', () => {
  assert.equal(
    saveDefaultsMenuTitle(SCREENSHOT_BOTH_BRANCHES, 0, 'Save default items'),
    'Save screenshot',
  );
});

test('saveDefaultsMenuTitle: HTML no-sel + selection with-sel → "Save HTML or selection"', () => {
  assert.equal(
    saveDefaultsMenuTitle(HTML_ONLY_NOSEL, 0, 'Save default items'),
    'Save HTML or selection',
  );
});

test('saveDefaultsMenuTitle: empty branch falls back to catalog', () => {
  assert.equal(
    saveDefaultsMenuTitle(ALL_OFF_DEFAULTS, 0, 'Save default items'),
    'Save default items',
  );
});

test('saveDefaultsMenuTitle: only one branch simplifies → catalog (not "Save X")', () => {
  // No-sel = empty, with-sel = single selection. The rule needs
  // *both* branches to produce a one-word noun before rewriting,
  // otherwise the title would misrepresent the empty branch.
  const oneSideOnly = {
    ...STOCK_DEFAULTS,
    withoutSelection: { screenshot: false, html: false },
    withSelection: { screenshot: false, html: false, selection: true, format: 'markdown' },
  };
  assert.equal(
    saveDefaultsMenuTitle(oneSideOnly, 0, 'Save default items'),
    'Save default items',
  );
});

test('saveDefaultsMenuTitle: multi-item branch falls back to catalog', () => {
  assert.equal(
    saveDefaultsMenuTitle(MULTI_NOSEL, 0, 'Save default items'),
    'Save default items',
  );
});

test('saveDefaultsMenuTitle: delay suffix preserved on rewritten title', () => {
  assert.equal(
    saveDefaultsMenuTitle(STOCK_DEFAULTS, 3, 'Save default items'),
    'Save screenshot or selection in 3s',
  );
});

test('saveDefaultsMenuTitle: delay suffix preserved on catalog fallback', () => {
  assert.equal(
    saveDefaultsMenuTitle(MULTI_NOSEL, 3, 'Save default items'),
    'Save default items in 3s',
  );
});

// ── buildTooltip: full-render integration cases ───────────────────

test('buildTooltip: stock defaults — Click collapses, Double-click renders combined phrase', () => {
  const out = buildTooltip({
    click: CAPTURE,
    clickWithSel: CAPTURE,
    doubleClick: SAVE_DEFAULTS,
    dblWithSel: SAVE_DEFAULTS,
    captureDefaults: STOCK_DEFAULTS,
    clickHotkey: undefined,
    dblHotkey: undefined,
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click: Capture...',
      'Double-click: Save screenshot or selection',
      '',
    ].join('\n'),
  );
});

test('buildTooltip: split dbl (no-sel = save-defaults, with-sel = capture) renders "..."', () => {
  // The user's reported regression: split routing used to produce
  // "Save screenshot or selection / With selection: Capture..." on
  // two lines, contradicting itself. Single-line "..." is the new
  // bail-out.
  const out = buildTooltip({
    click: CAPTURE,
    clickWithSel: CAPTURE,
    doubleClick: SAVE_DEFAULTS,
    dblWithSel: CAPTURE,
    captureDefaults: STOCK_DEFAULTS,
    clickHotkey: undefined,
    dblHotkey: undefined,
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click: Capture...',
      'Double-click: ...',
      '',
    ].join('\n'),
  );
});

test('buildTooltip: hotkeys trail their respective rows', () => {
  const out = buildTooltip({
    click: CAPTURE,
    clickWithSel: CAPTURE,
    doubleClick: SAVE_DEFAULTS,
    dblWithSel: SAVE_DEFAULTS,
    captureDefaults: STOCK_DEFAULTS,
    clickHotkey: 'Ctrl+Shift+X',
    dblHotkey: 'Alt+Shift+X',
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click: Capture...  [Ctrl+Shift+X]',
      'Double-click: Save screenshot or selection  [Alt+Shift+X]',
      '',
    ].join('\n'),
  );
});

test('buildTooltip: error message slots above the action block', () => {
  const out = buildTooltip({
    click: CAPTURE,
    clickWithSel: CAPTURE,
    doubleClick: CAPTURE,
    dblWithSel: CAPTURE,
    captureDefaults: STOCK_DEFAULTS,
    clickHotkey: undefined,
    dblHotkey: undefined,
    errorMessage: 'No active tab found to capture',
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'ERROR: No active tab found to capture',
      '',
      'Click: Capture...',
      'Double-click: Capture...',
      '',
    ].join('\n'),
  );
});

test('buildTooltip: undefined withSel (ignore-selection sentinel) on save-defaults expands the with-sel branch', () => {
  // Pins the runtime path: `getDefaultActionTooltip` resolves a
  // stored `IGNORE_SELECTION_ID` (or any unrecognized id) to
  // `undefined` via `findCaptureAction`. The Click row's effective
  // with-sel becomes the no-sel action — for save-defaults under
  // stock defaults, that still expands the with-sel branch
  // ("Save selection") via `expandFragment`.
  const out = buildTooltip({
    click: SAVE_DEFAULTS,
    clickWithSel: undefined,
    doubleClick: SAVE_DEFAULTS,
    dblWithSel: undefined,
    captureDefaults: STOCK_DEFAULTS,
    clickHotkey: 'Ctrl+Shift+X',
    dblHotkey: 'Alt+Shift+X',
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click: Save screenshot or selection  [Ctrl+Shift+X]',
      'Double-click: Save screenshot or selection  [Alt+Shift+X]',
      '',
    ].join('\n'),
  );
});

test('buildTooltip: ignore-selection on both rows leaves single-line rows', () => {
  const out = buildTooltip({
    click: SAVE_SCREENSHOT,
    clickWithSel: undefined,
    doubleClick: SAVE_HTML,
    dblWithSel: undefined,
    captureDefaults: STOCK_DEFAULTS,
    clickHotkey: undefined,
    dblHotkey: undefined,
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click: Save screenshot',
      'Double-click: Save HTML contents',
      '',
    ].join('\n'),
  );
});

test('buildTooltip: mix of "Save W"-form actions combines per-row, multi-word fall through', () => {
  // Click: Save screenshot / Save HTML contents — `Save HTML contents`
  // is multi-word, so combine bails to "...".
  // Double-click: Save URL / Save everything — both fit `Save <word>`
  // and collapse cleanly to "Save URL or everything".
  const out = buildTooltip({
    click: SAVE_SCREENSHOT,
    clickWithSel: SAVE_HTML,
    doubleClick: SAVE_URL,
    dblWithSel: SAVE_ALL,
    captureDefaults: STOCK_DEFAULTS,
    clickHotkey: 'Ctrl+Shift+X',
    dblHotkey: 'Alt+Shift+X',
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click: ...  [Ctrl+Shift+X]',
      'Double-click: Save URL or everything  [Alt+Shift+X]',
      '',
    ].join('\n'),
  );
});
