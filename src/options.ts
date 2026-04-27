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

interface CaptureDetailsDefaults {
  withoutSelection: { screenshot: boolean; html: boolean };
  withSelection: {
    screenshot: boolean;
    html: boolean;
    selection: boolean;
    format: OptionsSelectionFormat;
  };
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
  shortcuts: Record<string, string>;
  executeActionShortcut: string | null;
}

// Radio group names. All radios in a column share a name so the
// browser's native mutual-exclusivity logic gives us "exactly one
// pick per column" for free.
const COL_WITHOUT_CLICK = 'without-click';
const COL_WITHOUT_DBL = 'without-dbl';
const COL_WITH_CLICK = 'with-click';
const COL_WITH_DBL = 'with-dbl';

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

function setStatus(text: string, isError = false): void {
  const status = $('#status');
  status.textContent = text;
  status.classList.toggle('error', isError);
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
    void refreshHotkeys();
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

const WITHOUT_TABLE_COLS = 4;

/**
 * Build one body row for the no-selection table: action title,
 * hotkey, Click radio, Double-click radio.
 */
function appendWithoutRow(
  tbody: HTMLElement,
  a: OptionsActionRow,
  data: OptionsData,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const click = td(tr, 'radio-cell');
  click.appendChild(radio(COL_WITHOUT_CLICK, a.id, a.id === data.clickWithoutId));
  const dbl = td(tr, 'radio-cell');
  dbl.appendChild(radio(COL_WITHOUT_DBL, a.id, a.id === data.dblWithoutId));
  td(tr, 'action-cell').textContent = a.title;
  td(tr, 'hotkey-cell').textContent = data.shortcuts[a.id] ?? '';
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
  td(tr, 'hotkey-cell').textContent = data.shortcuts[id] ?? '';
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
    tbody.appendChild(
      sectionRow(`Capture after ${delaySec} second delay`, WITHOUT_TABLE_COLS),
    );
    for (const a of rows) appendWithoutRow(tbody, a, data);
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
}

function readCaptureDetailsDefaults(): CaptureDetailsDefaults {
  const checked = (sel: string): boolean =>
    ($(sel) as HTMLInputElement).checked;
  const fmtRadio = document.querySelector(
    'input[name="cd-ws-fmt"]:checked',
  ) as HTMLInputElement | null;
  const format =
    (fmtRadio?.value as OptionsSelectionFormat | undefined) ?? 'markdown';
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
  };
}

function renderAll(data: OptionsData): void {
  latest = data;
  renderHotkeySection(data);
  renderWithoutTable(data);
  renderWithTable(data);
  renderCaptureDetailsDefaults(data);
  document.body.style.visibility = 'visible';
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

    // Sections 2 + 3: update each hotkey cell in place; the radio
    // column DOM stays intact so any in-progress (unsaved) radio
    // picks survive.
    const rows = Array.from(
      document.querySelectorAll('#without-rows tr, #with-rows tr'),
    ) as HTMLTableRowElement[];
    for (const tr of rows) {
      if (tr.classList.contains('section')) continue;
      const radioInput = tr.querySelector('input[type=radio]') as HTMLInputElement | null;
      const id = radioInput?.value;
      if (!id) continue;
      const hotkeyCell = tr.querySelector('.hotkey-cell') as HTMLTableCellElement | null;
      if (hotkeyCell) hotkeyCell.textContent = map[id] ?? '';
    }
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

async function onSave(): Promise<void> {
  if (!latest) return;
  const clickWithoutId = pickedValue(COL_WITHOUT_CLICK);
  const clickWithId = pickedValue(COL_WITH_CLICK);
  const dblWithoutId = pickedValue(COL_WITHOUT_DBL);
  const dblWithId = pickedValue(COL_WITH_DBL);
  if (!clickWithoutId || !clickWithId || !dblWithoutId || !dblWithId) {
    setStatus(
      'Pick a Click and Double-click action in each section before saving.',
      true,
    );
    return;
  }

  setStatus('Saving…');
  try {
    await sendSetOptions({
      clickWithoutId,
      clickWithId,
      dblWithoutId,
      dblWithId,
      capturePageDefaults: readCaptureDetailsDefaults(),
    });
    setStatus('Saved.');
    // Re-fetch so the page reflects any normalization the SW applied
    // (e.g. capture-page-defaults format snapped back to a valid
    // value).
    const fresh = await getOptionsData();
    renderAll(fresh);
  } catch (err) {
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function init(): Promise<void> {
  const editBtn = $('#edit-shortcuts');
  editBtn.addEventListener('click', () => {
    void chrome.tabs.create({ url: SHORTCUTS_URL });
  });
  $('#save').addEventListener('click', () => {
    void onSave();
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
      true,
    );
    document.body.style.visibility = 'visible';
  }
}

void init();
