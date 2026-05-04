// Controller for src/options.html — the extension's options page.
//
// The page is split into four sections, each with its own table:
//   1. Default action hotkey — read-only display of the
//      `_execute_action` shortcut, plus a button that opens Chrome's
//      shortcut editor.
//   2. Default actions with no text selection — Click + Double-click
//      radios over every non-selection CAPTURE_ACTIONS entry.
//   3. Default actions with text selected — Click + Double-click
//      radios over the four WITH_SELECTION_CHOICES action ids plus
//      the `ignore-selection` sentinel.
//   4. Default items to save on Capture page — two fieldsets
//      mirroring the capture.html Save-checkbox layout, persisted
//      under the `capturePageDefaults` storage key and read by
//      capture.html on first paint.
//
// Loaded as a classic <script> (no `type="module"`) so it can't
// `import` from background.ts / capture.ts. The catalog of actions
// + the current defaults + bound hotkeys all come over the wire via
// a `getOptionsData` runtime message handled in background.ts;
// keeping that one round-trip means we don't have to duplicate the
// CAPTURE_ACTIONS / WITH_SELECTION_CHOICES tables here.

interface OptionsActionRow {
  id: string;
  title: string;
  baseId: string;
  delaySec: number;
  isSelection: boolean;
}
type OptionsSelectionFormat = 'html' | 'text' | 'markdown';
type OptionsCapturePageDefaultButton = 'capture' | 'ask';
type OptionsCapturePagePromptEnter = 'send' | 'newline';

interface CaptureDetailsDefaults {
  withoutSelection: { screenshot: boolean; html: boolean };
  withSelection: {
    screenshot: boolean;
    html: boolean;
    selection: boolean;
    format: OptionsSelectionFormat;
  };
  defaultButton: OptionsCapturePageDefaultButton;
  promptEnter: OptionsCapturePagePromptEnter;
}

interface OptionsAskProvider {
  id: string;
  label: string;
}
interface OptionsAskProviderSettings {
  enabled: Record<string, boolean>;
  default: string | null;
}

interface OptionsFactoryDefaults {
  clickWithoutId: string;
  clickWithId: string;
  dblWithoutId: string;
  dblWithId: string;
  capturePageDefaults: CaptureDetailsDefaults;
  askProviderSettings: OptionsAskProviderSettings;
}
interface OptionsData {
  actions: OptionsActionRow[];
  withSelectionChoiceIds: string[];
  ignoreSelectionId: string;
  clickWithoutId: string;
  clickWithId: string;
  dblWithoutId: string;
  dblWithId: string;
  capturePageDefaults: CaptureDetailsDefaults;
  askProviders: OptionsAskProvider[];
  askProviderSettings: OptionsAskProviderSettings;
  shortcuts: Record<string, string>;
  executeActionShortcut: string | null;
  factoryDefaults: OptionsFactoryDefaults;
}

// Radio group names. All radios in a column share a name so the
// browser's native mutual-exclusivity logic gives us "exactly one
// pick per column" for free.
const COL_WITHOUT_CLICK = 'without-click';
const COL_WITHOUT_DBL = 'without-dbl';
const COL_WITH_CLICK = 'with-click';
const COL_WITH_DBL = 'with-dbl';
const ASK_DEFAULT_GROUP = 'ask-default';

const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

// Display label for the with-selection sentinel — the catalog title
// includes a parenthetical ("…use default below") that's tied to the
// old single-table layout. With the section heading already saying
// "with text selected", the bare label reads cleaner here.
const IGNORE_SELECTION_TITLE = 'Ignore selection';

// Keep a reference to the latest server data so radio-click /
// focus-driven hotkey refreshes can re-render labels without
// blowing away the user's in-progress radio picks.
let latest: OptionsData | null = null;

function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing required element: ${sel}`);
  return el as HTMLElement;
}

// Status messages auto-clear after this many ms. Each setStatus call
// resets the timer, so clicking Save/Undo/Defaults in sequence simply
// replaces the previous message and restarts the countdown. Pass
// `sticky: true` for messages that should persist (in-flight
// "Saving…", terminal init-load errors) — those rely on the next
// setStatus call to replace them, not the timer.
const STATUS_TIMEOUT_MS = 5000;
let statusTimer: number | null = null;

function setStatus(
  text: string,
  opts: { isError?: boolean; sticky?: boolean } = {},
): void {
  if (statusTimer !== null) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  const status = $('#status');
  status.textContent = text;
  status.classList.toggle('error', opts.isError ?? false);
  if (text && !opts.sticky) {
    statusTimer = window.setTimeout(() => {
      status.textContent = '';
      status.classList.remove('error');
      statusTimer = null;
    }, STATUS_TIMEOUT_MS);
  }
}

async function getOptionsData(): Promise<OptionsData> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'getOptionsData' }, (resp: unknown) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp) {
        reject(new Error('No response from background service worker'));
        return;
      }
      resolve(resp as OptionsData);
    });
  });
}

async function sendSetOptions(payload: {
  clickWithId: string;
  clickWithoutId: string;
  dblWithId: string;
  dblWithoutId: string;
  capturePageDefaults: CaptureDetailsDefaults;
  askProviderSettings: OptionsAskProviderSettings;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'setOptions', ...payload },
      (resp: unknown) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const r = resp as { ok?: boolean; error?: string } | undefined;
        if (r?.error) reject(new Error(r.error));
        else resolve();
      },
    );
  });
}

/** Cell helper — append a `<td>` with optional class names. */
function td(parent: HTMLElement, ...classes: string[]): HTMLTableCellElement {
  const cell = document.createElement('td');
  for (const c of classes) cell.classList.add(c);
  parent.appendChild(cell);
  return cell;
}

/**
 * Build a radio for a given (group, value) pair. `checked` seeds
 * the initial selection. The radio is wired to refresh hotkeys on
 * every click — Chrome doesn't fire an event when the user edits a
 * keyboard shortcut at chrome://extensions/shortcuts, so any
 * interaction is a chance to resync.
 */
function radio(
  group: string,
  value: string,
  checked: boolean,
): HTMLInputElement {
  const r = document.createElement('input');
  r.type = 'radio';
  r.name = group;
  r.value = value;
  r.checked = checked;
  r.addEventListener('change', () => {
    // Immediate visual update: re-paint the hotkey cells so the
    // Default-action / Secondary-action hotkey lands on the just-
    // picked row without waiting for chrome.commands.getAll.
    recomputeHotkeyCells();
    void refreshHotkeys();
  });
  // Belt-and-suspenders: stop a Click / Double-click radio click from
  // bubbling. The toggle for the surrounding delay-group section is
  // attached to its own button only — *not* the section row or any
  // ancestor — so a radio click can't fold the group today; this
  // guard keeps that invariant if a future change ever wires a
  // row-level or tbody-level click handler.
  r.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  return r;
}

/** Build a section divider row used to fence delay groups. */
function sectionRow(label: string, colspan: number): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'section';
  const cell = document.createElement('td');
  cell.colSpan = colspan;
  cell.textContent = label;
  tr.appendChild(cell);
  return tr;
}

/**
 * Per-page record of delay-group expand decisions the user has made
 * via the section-row toggle. Used so a re-render (Save / Undo /
 * Defaults / radio-driven `refreshHotkeys` re-runs) doesn't flip a
 * group the user just expanded/collapsed back to its auto-computed
 * default. Cleared on full page reload.
 */
const userDelayGroupState = new Map<string, boolean>();

/** Resolve the actual expand state for a delay group: user's explicit
 *  toggle if they've made one this session, otherwise the auto-
 *  computed default ("any default or hotkey lands in this group?"). */
function resolveDelayGroupExpanded(
  delayGroup: string,
  autoExpanded: boolean,
): boolean {
  return userDelayGroupState.get(delayGroup) ?? autoExpanded;
}

/**
 * Build a collapsible section divider row for a delay group. Adds a
 * caret toggle next to the label that hides/shows every following row
 * in the same `data-delay-group`. The caller has already resolved the
 * expand state via `resolveDelayGroupExpanded` — pass it here as
 * `initiallyExpanded` and pass `!initiallyExpanded` to each
 * `appendWithoutRow` so the section header and data rows agree.
 */
function expandableSectionRow(
  label: string,
  colspan: number,
  delayGroup: string,
  initiallyExpanded: boolean,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'section section-expandable';
  tr.dataset.delayGroup = delayGroup;
  const cell = document.createElement('td');
  cell.colSpan = colspan;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'expand-toggle';
  toggle.setAttribute('aria-expanded', String(initiallyExpanded));
  toggle.setAttribute(
    'aria-label',
    initiallyExpanded ? `Collapse ${label}` : `Expand ${label}`,
  );
  // The caret glyph is set via CSS (::before) so it stays in sync
  // with `aria-expanded` without the click handler having to swap
  // text content. The button itself just carries the state.
  toggle.addEventListener('click', () => toggleDelayGroup(tr, toggle, label));

  cell.appendChild(toggle);
  cell.appendChild(document.createTextNode(' ' + label));
  tr.appendChild(cell);
  return tr;
}

/**
 * Toggle the collapsed/expanded state of a delay group. Flips
 * `aria-expanded` on the toggle, updates its `aria-label`, and
 * adds/removes the `is-collapsed` class on every data row tagged
 * with the same `delayGroup` (the section row itself stays visible).
 */
function toggleDelayGroup(
  sectionTr: HTMLTableRowElement,
  toggle: HTMLButtonElement,
  label: string,
): void {
  const delayGroup = sectionTr.dataset.delayGroup;
  if (!delayGroup) return;
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  const next = !expanded;
  toggle.setAttribute('aria-expanded', String(next));
  toggle.setAttribute('aria-label', next ? `Collapse ${label}` : `Expand ${label}`);
  // Persist the user's pick so a subsequent re-render (Save / Undo /
  // Defaults) doesn't snap the section back to its auto-computed
  // default state.
  userDelayGroupState.set(delayGroup, next);
  const tbody = sectionTr.parentElement;
  if (!tbody) return;
  const rows = tbody.querySelectorAll(
    `tr[data-delay-group="${delayGroup}"]:not(.section)`,
  );
  for (const row of Array.from(rows)) {
    row.classList.toggle('is-collapsed', !next);
  }
}

const WITHOUT_TABLE_COLS = 4;

/**
 * Compose the hotkey-cell display for one row in either the
 * with-selection or without-selection table.
 *
 * Up to three lines, top-to-bottom:
 *   1. The Default-action hotkey (`_execute_action`) if this row's id
 *      is the currently-picked Click action.
 *   2. The Secondary-action hotkey if this row's id is the
 *      currently-picked Double-click action.
 *   3. The action's own bound keyboard shortcut, if any.
 *
 * "Currently-picked" means the live DOM radio state, so the cell
 * updates in real time as the user clicks Click/Double-click radios
 * — without needing to wait for Save. The hotkey-cell CSS uses
 * `white-space: pre-line` to render the joined string as separate
 * visual lines.
 */
function composeRowHotkey(
  rowId: string,
  clickPick: string | null,
  dblPick: string | null,
  data: OptionsData,
): string {
  const lines: string[] = [];
  if (rowId === clickPick && data.executeActionShortcut) {
    lines.push(data.executeActionShortcut);
  }
  if (rowId === dblPick) {
    const sec = data.shortcuts['secondary-action'];
    if (sec) lines.push(sec);
  }
  const own = data.shortcuts[rowId];
  if (own) lines.push(own);
  return lines.join('\n');
}

/**
 * Build one body row for the no-selection table: action title,
 * hotkey, Click radio, Double-click radio. `delayGroup` (when
 * provided) stamps a `data-delay-group` attribute so
 * `expandableSectionRow`'s toggle can find this row; `collapsed`
 * applies the initial collapsed state.
 */
function appendWithoutRow(
  tbody: HTMLElement,
  a: OptionsActionRow,
  data: OptionsData,
  delayGroup?: string,
  collapsed?: boolean,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (delayGroup !== undefined) tr.dataset.delayGroup = delayGroup;
  if (collapsed) tr.classList.add('is-collapsed');
  const click = td(tr, 'radio-cell');
  click.appendChild(radio(COL_WITHOUT_CLICK, a.id, a.id === data.clickWithoutId));
  const dbl = td(tr, 'radio-cell');
  dbl.appendChild(radio(COL_WITHOUT_DBL, a.id, a.id === data.dblWithoutId));
  td(tr, 'action-cell').textContent = a.title;
  // Initial render uses the saved click/dbl ids; refreshHotkeys
  // recomputes from live DOM picks on every radio change.
  td(tr, 'hotkey-cell').textContent = composeRowHotkey(
    a.id,
    data.clickWithoutId,
    data.dblWithoutId,
    data,
  );
  tbody.appendChild(tr);
  return tr;
}

/**
 * Build one body row for the with-selection table: action / sentinel
 * title, hotkey, Click radio, Double-click radio.
 *
 * `displayTitle` overrides the catalog title so we can render the
 * `ignore-selection` sentinel as just "Ignore selection" — its catalog
 * title carries a parenthetical that read better in the old combined
 * table layout but is redundant under this section's heading.
 */
function appendWithRow(
  tbody: HTMLElement,
  id: string,
  displayTitle: string,
  data: OptionsData,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const click = td(tr, 'radio-cell');
  click.appendChild(radio(COL_WITH_CLICK, id, id === data.clickWithId));
  const dbl = td(tr, 'radio-cell');
  dbl.appendChild(radio(COL_WITH_DBL, id, id === data.dblWithId));
  td(tr, 'action-cell').textContent = displayTitle;
  td(tr, 'hotkey-cell').textContent = composeRowHotkey(
    id,
    data.clickWithId,
    data.dblWithId,
    data,
  );
  tbody.appendChild(tr);
  return tr;
}

function renderHotkeySection(data: OptionsData): void {
  $('#default-action-hotkey-cell').textContent = data.executeActionShortcut ?? '';
  $('#secondary-action-hotkey-cell').textContent =
    data.shortcuts['secondary-action'] ?? '';
}

function renderWithoutTable(data: OptionsData): void {
  const tbody = $('#without-rows');
  tbody.innerHTML = '';

  // Bucket non-selection actions for top-to-bottom rendering:
  //   1. Undelayed primary actions (the everyday picks).
  //   2. One section per distinct delay value, headed by a
  //      "Capture after N second delay" label.
  const immediate: OptionsActionRow[] = [];
  const byDelay = new Map<number, OptionsActionRow[]>();
  for (const a of data.actions) {
    if (a.isSelection) continue;
    if (a.delaySec > 0) {
      const list = byDelay.get(a.delaySec) ?? [];
      list.push(a);
      byDelay.set(a.delaySec, list);
    } else {
      immediate.push(a);
    }
  }

  if (immediate.length) {
    tbody.appendChild(sectionRow('Capture immediately', WITHOUT_TABLE_COLS));
    for (const a of immediate) appendWithoutRow(tbody, a, data);
  }

  for (const [delaySec, rows] of byDelay) {
    // A delay group auto-expands if anything in it would draw the
    // user's eye: a Click / Double-click default points at one of
    // its rows, OR any of its rows has a bound keyboard hotkey.
    // Otherwise it auto-collapses so the page isn't dominated by
    // rarely-used delayed actions. The user's manual toggle (if any)
    // overrides this via `resolveDelayGroupExpanded`.
    const autoExpanded = rows.some(
      (a) =>
        a.id === data.clickWithoutId
        || a.id === data.dblWithoutId
        || (data.shortcuts[a.id]?.length ?? 0) > 0,
    );
    const delayGroup = `delay-${delaySec}`;
    const expanded = resolveDelayGroupExpanded(delayGroup, autoExpanded);
    tbody.appendChild(
      expandableSectionRow(
        `Capture after ${delaySec} second delay`,
        WITHOUT_TABLE_COLS,
        delayGroup,
        expanded,
      ),
    );
    for (const a of rows) {
      appendWithoutRow(tbody, a, data, delayGroup, !expanded);
    }
  }
}

function renderWithTable(data: OptionsData): void {
  const tbody = $('#with-rows');
  tbody.innerHTML = '';

  // `withSelectionChoiceIds` is ordered by the SW (`capture` first,
  // then the three `save-selection-*` shortcuts, then the
  // `ignore-selection` sentinel last). The sentinel has no
  // `CAPTURE_ACTIONS` entry, so we render it with the local
  // `IGNORE_SELECTION_TITLE` label rather than going through the
  // catalog lookup.
  const byId = new Map(data.actions.map((a) => [a.id, a]));
  for (const id of data.withSelectionChoiceIds) {
    if (id === data.ignoreSelectionId) {
      appendWithRow(tbody, id, IGNORE_SELECTION_TITLE, data);
      continue;
    }
    const action = byId.get(id);
    if (!action) continue;
    appendWithRow(tbody, id, action.title, data);
  }
}

function renderCaptureDetailsDefaults(data: OptionsData): void {
  const cdd = data.capturePageDefaults;
  ($('#cd-wos-screenshot') as HTMLInputElement).checked =
    cdd.withoutSelection.screenshot;
  ($('#cd-wos-html') as HTMLInputElement).checked = cdd.withoutSelection.html;
  ($('#cd-ws-screenshot') as HTMLInputElement).checked =
    cdd.withSelection.screenshot;
  ($('#cd-ws-html') as HTMLInputElement).checked = cdd.withSelection.html;
  ($('#cd-ws-selection') as HTMLInputElement).checked =
    cdd.withSelection.selection;
  for (const fmt of ['html', 'text', 'markdown'] as const) {
    ($(`#cd-ws-fmt-${fmt}`) as HTMLInputElement).checked =
      cdd.withSelection.format === fmt;
  }
  for (const btn of ['capture', 'ask'] as const) {
    ($(`#cp-default-button-${btn}`) as HTMLInputElement).checked =
      cdd.defaultButton === btn;
  }
  for (const v of ['send', 'newline'] as const) {
    ($(`#cp-enter-key-${v}`) as HTMLInputElement).checked =
      cdd.promptEnter === v;
  }
}

function readCaptureDetailsDefaults(): CaptureDetailsDefaults {
  const checked = (sel: string): boolean =>
    ($(sel) as HTMLInputElement).checked;
  const fmtRadio = document.querySelector(
    'input[name="cd-ws-fmt"]:checked',
  ) as HTMLInputElement | null;
  const format =
    (fmtRadio?.value as OptionsSelectionFormat | undefined) ?? 'markdown';
  const defaultButtonRadio = document.querySelector(
    'input[name="cp-default-button"]:checked',
  ) as HTMLInputElement | null;
  const defaultButton =
    (defaultButtonRadio?.value as OptionsCapturePageDefaultButton | undefined)
    ?? 'capture';
  const enterRadio = document.querySelector(
    'input[name="cp-enter-key"]:checked',
  ) as HTMLInputElement | null;
  const promptEnter =
    (enterRadio?.value as OptionsCapturePagePromptEnter | undefined) ?? 'send';
  return {
    withoutSelection: {
      screenshot: checked('#cd-wos-screenshot'),
      html: checked('#cd-wos-html'),
    },
    withSelection: {
      screenshot: checked('#cd-ws-screenshot'),
      html: checked('#cd-ws-html'),
      selection: checked('#cd-ws-selection'),
      format,
    },
    defaultButton,
    promptEnter,
  };
}

/**
 * Pick the next enabled provider in the rendered (alphabetical-by-
 * label) order, starting one slot after `from` and wrapping. Returns
 * null when no provider is enabled. Mirrors `pickNextEnabledDefault`
 * in `src/background/ask/settings.ts` so the page's local default-
 * shifting matches what the SW normalizer would do on save.
 *
 * Drift hazard: the page sorts by label, the SW uses a hard-coded
 * id rotation. They match today because the labels happen to be
 * alphabetical-by-id (ChatGPT, Claude, Gemini, Google). Renaming a provider
 * to something that re-orders alphabetically would split the two —
 * the page would shift one way visually and the SW would re-shift
 * to a different default on save. If we add provider labels that
 * don't match alphabetical id order, both sides need to converge
 * (e.g. SW returns the rotation order in `OptionsData`).
 */
function pickNextEnabledAskDefault(
  from: string | null,
  orderedIds: string[],
  enabled: Record<string, boolean>,
): string | null {
  const startIdx =
    from === null ? 0 : Math.max(0, orderedIds.indexOf(from) + 1);
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[(startIdx + i) % orderedIds.length];
    if (enabled[id]) return id;
  }
  return null;
}

function sortedAskProviders(
  providers: OptionsAskProvider[],
): OptionsAskProvider[] {
  return [...providers].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Build the rows of the Ask AI providers table from `data`. Stamps
 * each row with `data-provider="<id>"` so `readOptionsAskProviderSettings`
 * can read the current state straight off the DOM. Wires checkbox
 * changes to the page-local default-shift logic — disabling the
 * current default rotates to the next enabled provider; enabling
 * any provider when none was enabled re-elects it as default.
 */
function renderAskProvidersTable(data: OptionsData): void {
  const tbody = $('#ask-providers-rows');
  tbody.innerHTML = '';
  const providers = sortedAskProviders(data.askProviders);
  for (const provider of providers) {
    const tr = document.createElement('tr');
    tr.dataset.provider = provider.id;
    td(tr, 'action-cell').textContent = provider.label;

    const enabledCell = td(tr, 'checkbox-cell');
    const enabledBox = document.createElement('input');
    enabledBox.type = 'checkbox';
    enabledBox.dataset.askEnabled = provider.id;
    // The SW's normalizer guarantees every PROVIDER_IDS entry is
    // present in `enabled`, so a missing key here means the page got
    // a provider id the SW's settings module hasn't been taught about
    // yet — log it so the drift is visible in the SW console rather
    // than silently rendering the row as unchecked.
    if (!(provider.id in data.askProviderSettings.enabled)) {
      console.warn(
        `[SeeWhatISee] options: provider "${provider.id}" missing from askProviderSettings.enabled — defaulting to unchecked. Update PROVIDER_IDS in src/background/ask/settings.ts.`,
      );
    }
    enabledBox.checked = data.askProviderSettings.enabled[provider.id] ?? false;
    enabledBox.addEventListener('change', () => {
      onAskEnabledChange(provider.id);
    });
    enabledCell.appendChild(enabledBox);

    const defaultCell = td(tr, 'radio-cell');
    const defaultRadio = document.createElement('input');
    defaultRadio.type = 'radio';
    defaultRadio.name = ASK_DEFAULT_GROUP;
    defaultRadio.value = provider.id;
    defaultRadio.dataset.askDefault = provider.id;
    defaultRadio.checked = data.askProviderSettings.default === provider.id;
    defaultRadio.disabled = !enabledBox.checked;
    defaultCell.appendChild(defaultRadio);

    tbody.appendChild(tr);
  }
}

function readAskProvidersFromDom(): {
  orderedIds: string[];
  enabled: Record<string, boolean>;
  defaultId: string | null;
} {
  const rows = Array.from(
    document.querySelectorAll('#ask-providers-rows tr'),
  ) as HTMLTableRowElement[];
  const orderedIds: string[] = [];
  const enabled: Record<string, boolean> = {};
  let defaultId: string | null = null;
  for (const tr of rows) {
    const id = tr.dataset.provider;
    if (!id) continue;
    orderedIds.push(id);
    const box = tr.querySelector(
      'input[type=checkbox][data-ask-enabled]',
    ) as HTMLInputElement | null;
    enabled[id] = !!box?.checked;
    const radio = tr.querySelector(
      'input[type=radio][data-ask-default]',
    ) as HTMLInputElement | null;
    if (radio?.checked) defaultId = id;
  }
  return { orderedIds, enabled, defaultId };
}

/**
 * Sync the Default-radio column with the current Enabled-checkbox
 * column. Called whenever the user toggles a row's checkbox:
 *
 *   - If the toggled row is the default and was just disabled,
 *     advance the default to the next enabled row (wrapping).
 *   - If no provider was the default (all-disabled state) and the
 *     user just enabled this one, elect it as the new default.
 *   - In any case, every radio's `disabled` flag is set to match its
 *     row's checkbox so disabled providers can't be picked.
 */
function onAskEnabledChange(toggledId: string): void {
  const { orderedIds, enabled, defaultId } = readAskProvidersFromDom();
  let newDefault = defaultId;
  if (!enabled[toggledId] && toggledId === defaultId) {
    newDefault = pickNextEnabledAskDefault(toggledId, orderedIds, enabled);
  } else if (enabled[toggledId] && defaultId === null) {
    newDefault = toggledId;
  }
  applyAskRadioState(orderedIds, enabled, newDefault);
}

function applyAskRadioState(
  orderedIds: string[],
  enabled: Record<string, boolean>,
  defaultId: string | null,
): void {
  for (const id of orderedIds) {
    const row = document.querySelector(
      `#ask-providers-rows tr[data-provider="${id}"]`,
    );
    if (!row) continue;
    const radio = row.querySelector(
      'input[type=radio][data-ask-default]',
    ) as HTMLInputElement | null;
    if (!radio) continue;
    radio.disabled = !enabled[id];
    radio.checked = id === defaultId;
  }
}

function readOptionsAskProviderSettings(): OptionsAskProviderSettings {
  const { enabled, defaultId } = readAskProvidersFromDom();
  return { enabled, default: defaultId };
}

function renderForm(data: OptionsData): void {
  renderHotkeySection(data);
  renderWithoutTable(data);
  renderWithTable(data);
  renderCaptureDetailsDefaults(data);
  renderAskProvidersTable(data);
}

function renderAll(data: OptionsData): void {
  latest = data;
  renderForm(data);
  document.body.style.visibility = 'visible';
}

/**
 * Recompute every hotkey cell in the without-selection and with-
 * selection tables from the live DOM radio picks (falling back to
 * the saved ids when no radio is checked yet — typically only at
 * first paint). Used by the radio `change` handler for an immediate
 * sync repaint, and by `refreshHotkeys` after a chrome.commands
 * fetch.
 */
function recomputeHotkeyCells(): void {
  if (!latest) return;
  const data = latest;
  const withoutClickPick = pickedValue(COL_WITHOUT_CLICK) ?? data.clickWithoutId;
  const withoutDblPick = pickedValue(COL_WITHOUT_DBL) ?? data.dblWithoutId;
  const withClickPick = pickedValue(COL_WITH_CLICK) ?? data.clickWithId;
  const withDblPick = pickedValue(COL_WITH_DBL) ?? data.dblWithId;

  const updateRows = (
    sel: string,
    clickPick: string,
    dblPick: string,
  ): void => {
    const rows = Array.from(
      document.querySelectorAll(sel),
    ) as HTMLTableRowElement[];
    for (const tr of rows) {
      if (tr.classList.contains('section')) continue;
      const radioInput = tr.querySelector(
        'input[type=radio]',
      ) as HTMLInputElement | null;
      const id = radioInput?.value;
      if (!id) continue;
      const hotkeyCell = tr.querySelector(
        '.hotkey-cell',
      ) as HTMLTableCellElement | null;
      if (hotkeyCell) {
        hotkeyCell.textContent = composeRowHotkey(
          id,
          clickPick,
          dblPick,
          data,
        );
      }
    }
  };
  updateRows('#without-rows tr', withoutClickPick, withoutDblPick);
  updateRows('#with-rows tr', withClickPick, withDblPick);
}

/**
 * Re-fetch shortcut bindings and update just the hotkey cells. Does
 * not blow away the user's radio picks. Triggered by:
 *   - window focus / blur — covers tabbing back from the
 *     chrome://extensions/shortcuts editor without us having to
 *     subscribe to a (non-existent) "shortcut changed" event.
 *   - any radio click — the change handler routes here so editing
 *     a hotkey in another tab and immediately picking a radio here
 *     resyncs the hotkey column too.
 */
async function refreshHotkeys(): Promise<void> {
  if (!latest) return;
  try {
    const commands = await chrome.commands.getAll();
    const map: Record<string, string> = {};
    for (const c of commands) {
      if (!c.name || !c.shortcut) continue;
      // Strip the `NN-` prefix used in the manifest so the keys
      // match the `CaptureAction.id` values (capture.ts /
      // background.ts use the same stripping convention).
      map[c.name.replace(/^\d+-/, '')] = c.shortcut;
    }
    latest.shortcuts = map;
    latest.executeActionShortcut = map['_execute_action'] ?? null;

    // Section 1: refresh the single hotkey cell.
    renderHotkeySection(latest);

    // Sections 2 + 3: recompute each hotkey cell from the live DOM
    // radio picks so the Default-action / Secondary-action hotkey
    // shows up next to the row the user just selected — without
    // waiting for a Save round-trip. The radio column DOM stays
    // intact so any in-progress (unsaved) radio picks survive.
    recomputeHotkeyCells();

    // Tell the SW about the refresh so the toolbar tooltip +
    // context-menu labels resync too. Chrome fires no event for
    // shortcut edits at chrome://extensions/shortcuts, so any time
    // we notice (window focus / radio click) is the SW's chance
    // to catch up. Fire-and-forget — the page UI is already up to
    // date from the local `chrome.commands.getAll()` call above.
    chrome.runtime.sendMessage({ action: 'refreshHotkeys' }).catch(() => {
      // SW may be napping; the next user interaction will
      // re-trigger refreshMenusIfHotkeysChanged via the toolbar
      // path, so a dropped message here just means the tooltip
      // updates one click later than ideal.
    });
  } catch (err) {
    console.warn('[SeeWhatISee] options: failed to refresh hotkeys:', err);
  }
}

/**
 * Read the currently-checked radio value for a given column.
 * Returns `null` if the column has no checked radio (shouldn't
 * happen for the persisted columns under normal interaction; the
 * caller treats `null` as "no change requested").
 */
function pickedValue(group: string): string | null {
  const checked = document.querySelector(
    `input[type=radio][name="${group}"]:checked`,
  ) as HTMLInputElement | null;
  return checked?.value ?? null;
}

// Footer buttons are disabled while a save is in flight so a stray
// Undo / Defaults / Save click can't race the post-save re-render
// (which would silently overwrite whatever the user just clicked) or
// fire a second concurrent save.
function setFooterButtonsDisabled(disabled: boolean): void {
  for (const id of ['save', 'undo', 'defaults']) {
    ($(`#${id}`) as HTMLButtonElement).disabled = disabled;
  }
}

async function onSave(): Promise<void> {
  if (!latest) return;
  const clickWithoutId = pickedValue(COL_WITHOUT_CLICK);
  const clickWithId = pickedValue(COL_WITH_CLICK);
  const dblWithoutId = pickedValue(COL_WITHOUT_DBL);
  const dblWithId = pickedValue(COL_WITH_DBL);
  if (!clickWithoutId || !clickWithId || !dblWithoutId || !dblWithId) {
    setStatus(
      'Pick a Click and Double-click action in each section before saving.',
      { isError: true },
    );
    return;
  }

  setStatus('Saving…', { sticky: true });
  setFooterButtonsDisabled(true);
  try {
    await sendSetOptions({
      clickWithoutId,
      clickWithId,
      dblWithoutId,
      dblWithId,
      capturePageDefaults: readCaptureDetailsDefaults(),
      askProviderSettings: readOptionsAskProviderSettings(),
    });
    // Re-fetch so the page reflects any normalization the SW applied
    // (e.g. capture-page-defaults format snapped back to a valid
    // value).
    const fresh = await getOptionsData();
    renderAll(fresh);
    setStatus('Settings saved.');
  } catch (err) {
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, { isError: true });
  } finally {
    setFooterButtonsDisabled(false);
  }
}

function onUndo(): void {
  if (!latest) return;
  // `latest` reflects the most recently saved state (re-fetched after
  // each successful Save), so re-rendering from it discards any
  // unsaved radio / checkbox changes.
  renderForm(latest);
  setStatus('Restored saved settings.');
}

function onDefaults(): void {
  if (!latest) return;
  const fd = latest.factoryDefaults;
  renderForm({
    ...latest,
    clickWithoutId: fd.clickWithoutId,
    clickWithId: fd.clickWithId,
    dblWithoutId: fd.dblWithoutId,
    dblWithId: fd.dblWithId,
    capturePageDefaults: fd.capturePageDefaults,
    askProviderSettings: fd.askProviderSettings,
  });
  setStatus('Default options applied above but not saved.');
}

// `.pressed` flash for every `.btn` — same convention as
// capture-page.ts. `:active` is too brief on a fast click; the
// 140ms class extends the pressed look. Document-level capture-phase
// so future buttons that pick up `.btn` are covered automatically.
const PRESS_FLASH_MS = 140;
document.addEventListener('click', (e) => {
  const target = (e.target as Element | null)?.closest<HTMLButtonElement>('button.btn');
  if (!target || target.disabled) return;
  target.classList.add('pressed');
  setTimeout(() => target.classList.remove('pressed'), PRESS_FLASH_MS);
}, true);

async function init(): Promise<void> {
  const editBtn = $('#edit-shortcuts');
  editBtn.addEventListener('click', () => {
    void chrome.tabs.create({ url: SHORTCUTS_URL });
  });
  $('#save').addEventListener('click', () => {
    void onSave();
  });
  $('#undo').addEventListener('click', () => {
    onUndo();
  });
  $('#defaults').addEventListener('click', () => {
    onDefaults();
  });
  // Window focus / blur as the "shortcut may have been edited
  // elsewhere" signal — see `refreshHotkeys` docstring for context.
  window.addEventListener('focus', () => {
    void refreshHotkeys();
  });
  window.addEventListener('blur', () => {
    void refreshHotkeys();
  });

  try {
    const data = await getOptionsData();
    renderAll(data);
  } catch (err) {
    setStatus(
      `Failed to load options: ${err instanceof Error ? err.message : String(err)}`,
      { isError: true, sticky: true },
    );
    document.body.style.visibility = 'visible';
  }
}

void init();
