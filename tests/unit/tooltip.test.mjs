// Unit tests for the toolbar-icon tooltip builder in
// `src/background/tooltip.ts`. The function is pure (no chrome.*
// calls) precisely so we can pin every Case 1–4 path here without
// spinning up Playwright.
//
// Each test names the action shape rather than the user-visible
// fragment so the tests survive copy edits to fragment text — only
// the assertion strings carry the rendered text. Action shapes
// match what `CAPTURE_ACTIONS` produces: `{id, baseId, delaySec,
// tooltipFragment}`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTooltip,
  buildRow,
  expandFragment,
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
const SAVE_DEFAULTS_5S = action('save-defaults', 'Save default items in 5s', 5);
const SAVE_SCREENSHOT = action('save-screenshot', 'Save screenshot');
const SAVE_SCREENSHOT_2S = action('save-screenshot', 'Save screenshot in 2s', 2);
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

// As above but with-sel saves the no-sel set (screenshot) plus the
// selection — the "same plus selection" pattern.
const PLUS_SELECTION_DEFAULTS = {
  withoutSelection: { screenshot: true, html: false },
  withSelection: { screenshot: true, html: false, selection: true, format: 'markdown' },
  defaultButton: 'capture',
  promptEnter: 'send',
};

const ALL_OFF_DEFAULTS = {
  withoutSelection: { screenshot: false, html: false },
  withSelection: { screenshot: false, html: false, selection: false, format: 'markdown' },
  defaultButton: 'capture',
  promptEnter: 'send',
};

// ── expandFragment ────────────────────────────────────────────────

test('expandFragment: non-save-defaults action is unchanged', () => {
  assert.equal(
    expandFragment(SAVE_SCREENSHOT, STOCK_DEFAULTS, 'withoutSelection'),
    'Save screenshot',
  );
  assert.equal(
    expandFragment(SAVE_SEL_MD, STOCK_DEFAULTS, 'withSelection'),
    'Save as markdown',
  );
  assert.equal(
    expandFragment(CAPTURE, STOCK_DEFAULTS, 'withoutSelection'),
    'Capture...',
  );
});

test('expandFragment: save-defaults expands to checked items, no-sel branch', () => {
  assert.equal(
    expandFragment(SAVE_DEFAULTS, STOCK_DEFAULTS, 'withoutSelection'),
    'Save screenshot',
  );
  assert.equal(
    expandFragment(
      SAVE_DEFAULTS,
      {
        ...STOCK_DEFAULTS,
        withoutSelection: { screenshot: true, html: true },
      },
      'withoutSelection',
    ),
    'Save screenshot, HTML',
  );
});

test('expandFragment: save-defaults expands with selection format', () => {
  assert.equal(
    expandFragment(SAVE_DEFAULTS, STOCK_DEFAULTS, 'withSelection'),
    'Save selection markdown',
  );
  assert.equal(
    expandFragment(SAVE_DEFAULTS, PLUS_SELECTION_DEFAULTS, 'withSelection'),
    'Save screenshot, selection markdown',
  );
});

test('expandFragment: empty branch falls back to placeholder', () => {
  assert.equal(
    expandFragment(SAVE_DEFAULTS, ALL_OFF_DEFAULTS, 'withoutSelection'),
    'Save default items',
  );
  assert.equal(
    expandFragment(SAVE_DEFAULTS, ALL_OFF_DEFAULTS, 'withSelection'),
    'Save default items',
  );
});

test('expandFragment: delayed save-defaults preserves the "in Ns" suffix', () => {
  assert.equal(
    expandFragment(SAVE_DEFAULTS_5S, STOCK_DEFAULTS, 'withoutSelection'),
    'Save screenshot in 5s',
  );
});

// ── buildRow: Case 1 (same effective behaviour) ───────────────────

test('buildRow Case 1: identical capture/capture collapses to one line', () => {
  assert.deepEqual(
    buildRow('Click', CAPTURE, CAPTURE, STOCK_DEFAULTS, undefined),
    ['Click: Capture...'],
  );
});

test('buildRow Case 1: ignore-selection collapses', () => {
  assert.deepEqual(
    buildRow('Click', SAVE_SCREENSHOT, undefined, STOCK_DEFAULTS, undefined),
    ['Click: Save screenshot'],
  );
});

test('buildRow Case 1: matching save-defaults expansions collapse', () => {
  // Both branches checked = {screenshot}, so save-defaults vs
  // save-defaults render identically and Case 1 fires.
  const flat = {
    ...STOCK_DEFAULTS,
    withSelection: {
      screenshot: true, html: false, selection: false, format: 'markdown',
    },
  };
  assert.deepEqual(
    buildRow('Double-click', SAVE_DEFAULTS, SAVE_DEFAULTS, flat, undefined),
    ['Double-click: Save screenshot'],
  );
});

test('buildRow Case 1: differing delaySec on save-defaults does NOT collapse', () => {
  // Regression: a delayed no-sel `save-defaults-2s` paired with a 0s
  // with-sel `save-defaults` (same checkbox state) used to Case-1
  // collapse to a single-line row that reported only the `in 2s`
  // suffix — silently hiding that the with-sel branch fires at 0s.
  // The Case 1 check now requires strict id equality.
  const flat = {
    ...STOCK_DEFAULTS,
    withSelection: {
      screenshot: true, html: false, selection: false, format: 'markdown',
    },
  };
  assert.deepEqual(
    buildRow(
      'Double-click',
      // No-sel: 5s variant.
      action('save-defaults', 'Save default items in 5s', 5),
      // With-sel: 0s variant.
      SAVE_DEFAULTS,
      flat,
      undefined,
    ),
    [
      'Double-click:',
      '  Save screenshot in 5s',
      '  With selection: Save screenshot',
    ],
  );
});

// ── buildRow: Case 2 (with-sel is selection-only) ─────────────────

test('buildRow Case 2: literal save-selection-* renders "(or selection <fmt>)" on a continuation line', () => {
  assert.deepEqual(
    buildRow('Click', CAPTURE, SAVE_SEL_MD, STOCK_DEFAULTS, undefined),
    [
      'Click:',
      '  Capture...',
      '  (or selection markdown)',
    ],
  );
  assert.deepEqual(
    buildRow('Click', CAPTURE, SAVE_SEL_HTML, STOCK_DEFAULTS, undefined),
    [
      'Click:',
      '  Capture...',
      '  (or selection HTML)',
    ],
  );
  assert.deepEqual(
    buildRow('Click', CAPTURE, SAVE_SEL_TEXT, STOCK_DEFAULTS, undefined),
    [
      'Click:',
      '  Capture...',
      '  (or selection text)',
    ],
  );
});

test('buildRow Case 2: save-defaults configured selection-only also renders Case 2', () => {
  // Effective with-sel artifacts = {selection-markdown}, regardless of
  // which action delivers it.
  assert.deepEqual(
    buildRow(
      'Click',
      CAPTURE,
      SAVE_DEFAULTS,
      STOCK_DEFAULTS, // with-sel = {selection: true, format: markdown}, no other items
      undefined,
    ),
    [
      'Click:',
      '  Capture...',
      '  (or selection markdown)',
    ],
  );
});

// ── buildRow: Case 3 (with-sel = no-sel + selection) ──────────────

test('buildRow Case 3: save-defaults adds exactly one selection on top of no-sel', () => {
  assert.deepEqual(
    buildRow(
      'Double-click',
      SAVE_DEFAULTS,
      SAVE_DEFAULTS,
      PLUS_SELECTION_DEFAULTS,
      undefined,
    ),
    [
      'Double-click:',
      '  Save screenshot',
      '  (plus selection markdown)',
    ],
  );
});

test('buildRow Case 3: save-defaults plus-selection with multiple no-sel items', () => {
  const d = {
    ...STOCK_DEFAULTS,
    withoutSelection: { screenshot: true, html: true },
    withSelection: { screenshot: true, html: true, selection: true, format: 'text' },
  };
  assert.deepEqual(
    buildRow('Double-click', SAVE_DEFAULTS, SAVE_DEFAULTS, d, undefined),
    [
      'Double-click:',
      '  Save screenshot, HTML',
      '  (plus selection text)',
    ],
  );
});

// ── buildRow: Case 4 (separate continuation line) ─────────────────

test('buildRow Case 4: differing non-selection actions get a continuation line', () => {
  assert.deepEqual(
    buildRow('Click', SAVE_SCREENSHOT, CAPTURE, STOCK_DEFAULTS, undefined),
    [
      'Click:',
      '  Save screenshot',
      '  With selection: Capture...',
    ],
  );
});

test('buildRow Case 4: save-defaults branches that differ in non-selection items', () => {
  // No-sel = {screenshot}, with-sel = {html, selection-text} —
  // toggles a no-sel item off, so neither Case 1, 2, nor 3 fits.
  const d = {
    ...STOCK_DEFAULTS,
    withoutSelection: { screenshot: true, html: false },
    withSelection: { screenshot: false, html: true, selection: true, format: 'text' },
  };
  assert.deepEqual(
    buildRow('Double-click', SAVE_DEFAULTS, SAVE_DEFAULTS, d, undefined),
    [
      'Double-click:',
      '  Save screenshot',
      '  With selection: Save HTML, selection text',
    ],
  );
});

test('buildRow Case 4: save-all and save-url paired against save-defaults selection-only', () => {
  // `save-all` and `save-url` aren't valid with-selection choices,
  // but they are valid no-sel defaults. Pin their effectiveItems
  // mapping so a future regression that breaks `save-all` →
  // `{screenshot, html}` or `save-url` → `{url}` shows up here.
  assert.deepEqual(
    buildRow('Click', SAVE_ALL, SAVE_SEL_HTML, STOCK_DEFAULTS, undefined),
    [
      'Click:',
      '  Save everything',
      '  (or selection HTML)',
    ],
  );
  assert.deepEqual(
    buildRow('Click', SAVE_URL, SAVE_SEL_TEXT, STOCK_DEFAULTS, undefined),
    [
      'Click:',
      '  Save URL',
      '  (or selection text)',
    ],
  );
});

// ── buildRow: hotkey placement ─────────────────────────────────────

test('buildRow: hotkey on a multi-line row sits in the label, before the colon', () => {
  assert.deepEqual(
    buildRow('Click', SAVE_SCREENSHOT, CAPTURE, STOCK_DEFAULTS, 'Ctrl+Shift+Y'),
    [
      'Click [Ctrl+Shift+Y]:',
      '  Save screenshot',
      '  With selection: Capture...',
    ],
  );
});

test('buildRow: hotkey suffix on a single-line (Case 1) row sits at end of line', () => {
  assert.deepEqual(
    buildRow('Click', CAPTURE, CAPTURE, STOCK_DEFAULTS, 'Ctrl+Shift+Y'),
    ['Click: Capture...  [Ctrl+Shift+Y]'],
  );
});

test('buildRow: no hotkey when unbound', () => {
  assert.deepEqual(
    buildRow('Click', CAPTURE, CAPTURE, STOCK_DEFAULTS, undefined),
    ['Click: Capture...'],
  );
});

// ── buildRow: delayed action handling ─────────────────────────────

test('buildRow: delayed no-sel action keeps "in Ns" in the primary fragment', () => {
  assert.deepEqual(
    buildRow('Click', SAVE_SCREENSHOT_2S, CAPTURE, STOCK_DEFAULTS, undefined),
    [
      'Click:',
      '  Save screenshot in 2s',
      '  With selection: Capture...',
    ],
  );
});

// ── buildTooltip: full-render integration cases ───────────────────

test('buildTooltip: stock defaults — Click collapses, Dbl renders Case 3', () => {
  const out = buildTooltip({
    click: CAPTURE,
    clickWithSel: CAPTURE,
    doubleClick: SAVE_DEFAULTS,
    dblWithSel: SAVE_DEFAULTS,
    captureDefaults: PLUS_SELECTION_DEFAULTS,
    clickHotkey: undefined,
    dblHotkey: undefined,
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click: Capture...',
      'Double-click:',
      '  Save screenshot',
      '  (plus selection markdown)',
      '',
    ].join('\n'),
  );
});

test('buildTooltip: stock defaults exactly as shipped (Case 2 on Dbl)', () => {
  // STOCK_DEFAULTS: with-sel = {selection: true, format: markdown},
  // nothing else. So save-defaults with-sel resolves to selection-only,
  // which is Case 2 against the no-sel `Save screenshot`.
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
      'Double-click:',
      '  Save screenshot',
      '  (or selection markdown)',
      '',
    ].join('\n'),
  );
});

test('buildTooltip: both hotkeys bound — Click stays single-line with end suffix, Dbl puts hotkey in label', () => {
  const out = buildTooltip({
    click: CAPTURE,
    clickWithSel: CAPTURE,
    doubleClick: SAVE_DEFAULTS,
    dblWithSel: SAVE_DEFAULTS,
    captureDefaults: PLUS_SELECTION_DEFAULTS,
    clickHotkey: 'Ctrl+Shift+Y',
    dblHotkey: 'Ctrl+Shift+S',
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click: Capture...  [Ctrl+Shift+Y]',
      'Double-click [Ctrl+Shift+S]:',
      '  Save screenshot',
      '  (plus selection markdown)',
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

test('buildTooltip: Case 4 on both rows — three lines per row, hotkeys in the labels', () => {
  const out = buildTooltip({
    click: SAVE_SCREENSHOT,
    clickWithSel: SAVE_HTML,
    doubleClick: SAVE_URL,
    dblWithSel: SAVE_ALL,
    captureDefaults: STOCK_DEFAULTS,
    clickHotkey: 'Ctrl+Shift+Y',
    dblHotkey: 'Ctrl+Shift+S',
  });
  assert.equal(
    out,
    [
      'SeeWhatISee',
      '',
      'Click [Ctrl+Shift+Y]:',
      '  Save screenshot',
      '  With selection: Save HTML contents',
      'Double-click [Ctrl+Shift+S]:',
      '  Save URL',
      '  With selection: Save everything',
      '',
    ].join('\n'),
  );
});
