// Right-click action menu: builds the menu tree (`installContextMenu`),
// keeps every row's title in sync with the current defaults + bound
// hotkeys (`refreshMenusAndTooltip`, `refreshMenusIfHotkeysChanged`),
// and hosts the More-submenu utilities (Copy-last-filename via an
// offscreen clipboard doc, Snapshots directory, Clear log). Menu-item
// ids are exported so `background.ts`'s `onClicked` dispatch can
// route each click to the right action.

import {
  DOWNLOAD_SUBDIR,
  LOG_STORAGE_KEY,
  type CaptureRecord,
} from '../capture.js';
import {
  CAPTURE_ACTIONS,
  CAPTURE_DELAYS_SEC,
  captureActionsWithDelay,
  isDefaultableDelay,
  type CaptureAction,
} from './capture-actions.js';
import {
  WITH_SELECTION_CHOICES,
  getDefaultActionTooltip,
  getDefaultDblWithoutSelectionId,
  getDefaultWithSelectionId,
  getDefaultWithoutSelectionId,
  isSelectionBaseId,
} from './default-action.js';

export const DEFAULT_CLICK_PARENT_ID = 'default-click-parent';
export const DELAYED_PARENT_ID = 'delayed-capture-parent';
export const MORE_PARENT_ID = 'more-parent';
// Child items under "Set default click action" use these prefixes on
// their ids so the onClicked handler can tell "pick this with-selection
// default" / "pick this without-selection default" clicks apart from
// the top-level / Delayed-capture "run this now" entries, which share
// the CAPTURE_ACTIONS ids verbatim.
export const DEFAULT_CLICK_WITH_SEL_PREFIX = 'set-default-with-sel-';
export const DEFAULT_CLICK_WITHOUT_SEL_PREFIX = 'set-default-without-sel-';
// Grayed-out subheadings that visually split the submenu into its two
// sections. Built as `enabled: false` normal items because
// `chrome.contextMenus` has no "label" / "group header" type.
const WITH_SEL_HEADER_ID = 'default-with-sel-header';
const WITHOUT_SEL_HEADER_ID = 'default-without-sel-header';

// Id used by the "Clear log history" entry under the More submenu.
export const CLEAR_LOG_MENU_ID = 'clear-log';
// Id used by the "Snapshots directory" entry under the More submenu.
export const SNAPSHOTS_DIR_MENU_ID = 'snapshots-directory';
// Ids for the "Copy last …" entries at the top of the More submenu.
// Their enabled state mirrors whether the most recent capture record
// carries the matching field (`screenshot` / `contents` / `selection`);
// see `refreshCopyMenuState`. A single `Copy last selection filename`
// entry covers all three serialization formats — a capture only ever
// writes one selection file, so there's no ambiguity about which one
// the user means.
export const COPY_LAST_SCREENSHOT_MENU_ID = 'copy-last-screenshot';
export const COPY_LAST_HTML_MENU_ID = 'copy-last-html';
export const COPY_LAST_SELECTION_MENU_ID = 'copy-last-selection';

// Keyboard shortcuts declared in manifest.json's `commands` block.
// Command names carry a two-digit ordering prefix (`NN-`) because
// chrome://extensions/shortcuts lists commands in raw string-sort
// order on the command *name* rather than our preferred order. The
// prefix is stripped here before dispatch so the rest of the code
// keeps using bare action ids.
export const COMMAND_PREFIX_PATTERN = /^\d{2}-/;

const DEFAULT_SELECTED_PREFIX = '✓ ';
const DEFAULT_UNSELECTED_PREFIX = '    ';

function defaultMenuTitle(title: string, selected: boolean, shortcut?: string): string {
  const prefix = selected ? DEFAULT_SELECTED_PREFIX : DEFAULT_UNSELECTED_PREFIX;
  // Rows in "Set default click action" show only the bound keyboard
  // shortcut (no Click / Double-click italic segment) — those tags
  // belong on the action rows elsewhere in the menu; here the ✓
  // prefix is already the "this is the default" signal.
  const hint = shortcut ? `${HINT_SEPARATOR}(${shortcut})` : '';
  return prefix + title + hint;
}

// Hints marking which top-level / "Capture with delay" entries will
// run on toolbar click vs. double-click.
//   - Faked italics via Unicode mathematical sans-serif italic
//     letters — `chrome.contextMenus` titles are plain text, no
//     markup support.
//   - No column alignment — the API has no accelerator / secondary-
//     label slot, and menu rendering uses the platform UI font
//     (Segoe UI / GTK / NSMenu), so space-padding only approximates
//     a column on one machine. An inline dash reads as intentional
//     on every platform.
const HINT_SEPARATOR = '  -  ';
const CLICK_ITALIC = '𝘊𝘭𝘪𝘤𝘬';
const DOUBLE_CLICK_ITALIC = '𝘋𝘰𝘶𝘣𝘭𝘦-𝘤𝘭𝘪𝘤𝘬';

/**
 * Fetch the current keyboard shortcut for each command declared in
 * the manifest, keyed by the bare action id (`NN-` prefix stripped).
 * Commands with no binding are omitted so callers can check
 * `has(id)` directly. See the `chrome.commands` listener for why
 * the prefix exists.
 *
 * `_execute_action` has no `NN-` prefix and is left as-is in the
 * map, so callers look it up by that literal string — that's how
 * the tooltip's `Click, <key>:` label and the `Set hotkeys
 * (Default <key>)` row read it.
 *
 * Shortcut change detection / refresh is driven by
 * `refreshMenusIfHotkeysChanged` on user interaction; see its
 * docstring for the SW-lifetime / `onInstalled` caveats.
 */
export function commandsToShortcutMap(
  commands: chrome.commands.Command[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of commands) {
    if (!c.name || !c.shortcut) continue;
    out.set(c.name.replace(COMMAND_PREFIX_PATTERN, ''), c.shortcut);
  }
  return out;
}

/**
 * Fingerprint used to detect whether any keyboard shortcut binding
 * changed since the last menu refresh. A stable, canonicalized
 * string over every command's `(name, shortcut)` pair — sort makes
 * it independent of Chrome's response order, and including every
 * command (not just bound ones) catches "command was unbound"
 * transitions, not just "command was just bound."
 */
function shortcutFingerprint(commands: chrome.commands.Command[]): string {
  return commands
    .map((c) => `${c.name ?? ''}=${c.shortcut ?? ''}`)
    .sort()
    .join('\n');
}

// Last fingerprint we rendered the menu against. `undefined` before
// the first refresh (including every fresh SW wake), so the first
// call after a cold start always rebuilds — that's the cheap way to
// resync with any shortcut edit that happened while the SW was
// sleeping. After that, only genuine changes trigger a rebuild.
let cachedShortcutFingerprint: string | undefined;

/**
 * Re-render every user-visible surface that depends on a keyboard
 * shortcut binding or a click default:
 *
 *   - "Set hotkeys" status row at the top of the `Set default click
 *     action` submenu.
 *   - Every `CAPTURE_ACTIONS` row in the top-level / `Capture with
 *     delay` / `More` menus — hotkey plus `(Click)` / `(Double-click)`
 *     hint as applicable.
 *   - Every ✓-prefixed row inside `Set default click action`, both
 *     sections (with-selection + without-selection).
 *   - The toolbar-icon tooltip (`chrome.action.setTitle`) — its
 *     `Click:` line folds in the `_execute_action` hotkey when bound.
 *
 * Called from both default-click setters and (via
 * `refreshMenusIfHotkeysChanged`) on every user interaction, so a
 * binding edit the user made at `chrome://extensions/shortcuts`
 * propagates to labels on the very next click. Chrome fires no
 * event for shortcut edits, so a coarse full sweep here is simpler
 * than threading which subset each caller is responsible for.
 *
 * Fetches the current storage state + shortcut map up front so
 * every surface sees a consistent snapshot. Also writes
 * `cachedShortcutFingerprint` so subsequent
 * `refreshMenusIfHotkeysChanged` calls know this run is the
 * current baseline. `chrome.contextMenus.update` swallows "No item
 * with id …" so the same helper works during first install (when
 * some rows don't exist yet) and at runtime.
 */
export async function refreshMenusAndTooltip(
  preloadedCommands?: chrome.commands.Command[],
): Promise<void> {
  const defaultId = await getDefaultWithoutSelectionId();
  const withId = await getDefaultWithSelectionId();
  const dblId = await getDefaultDblWithoutSelectionId();
  const commands = preloadedCommands ?? (await chrome.commands.getAll());
  const shortcuts = commandsToShortcutMap(commands);
  cachedShortcutFingerprint = shortcutFingerprint(commands);

  // Action rows — top-level + delay submenu + More submenu. They
  // share CAPTURE_ACTIONS ids, so updating by id hits whichever
  // surface each action is currently on.
  await Promise.all(
    CAPTURE_ACTIONS.map(async (a) => {
      try {
        await chrome.contextMenus.update(a.id, {
          title: actionMenuTitle(a, defaultId, dblId, shortcuts),
        });
      } catch {
        /* menu not installed yet */
      }
    }),
  );

  // Without-selection ✓ rows in the "Set default click action"
  // submenu. The `save-selection-*` bases are filtered out in
  // the menu install, so we filter them here too to avoid a
  // no-op update on a never-created id.
  const withoutDefaultables = CAPTURE_ACTIONS.filter(
    (a) => isDefaultableDelay(a.delaySec) && !isSelectionBaseId(a.baseId),
  );
  await Promise.all(
    withoutDefaultables.map(async (a) => {
      try {
        await chrome.contextMenus.update(DEFAULT_CLICK_WITHOUT_SEL_PREFIX + a.id, {
          title: defaultMenuTitle(a.title, a.id === defaultId, shortcuts.get(a.id)),
        });
      } catch {
        /* menu not installed yet */
      }
    }),
  );

  // With-selection ✓ rows. `ignore-selection` has no command entry
  // so its hotkey hint always collapses.
  await Promise.all(
    WITH_SELECTION_CHOICES.map(async (c) => {
      try {
        await chrome.contextMenus.update(DEFAULT_CLICK_WITH_SEL_PREFIX + c.id, {
          title: defaultMenuTitle(c.title, c.id === withId, shortcuts.get(c.id)),
        });
      } catch {
        /* menu not installed yet */
      }
    }),
  );

  // Tooltip's `Click:` line also folds in the `_execute_action`
  // hotkey when bound, so it has to be rebuilt anytime the menus
  // are. Putting it here (rather than at the two setter callsites)
  // means `refreshMenusIfHotkeysChanged` picks it up for free.
  await refreshActionTooltip();
}

/**
 * Run `refreshMenusAndTooltip` only when `chrome.commands.getAll()`
 * returns a different binding set than last time we rendered.
 * Called from every user-interaction path (toolbar click, menu
 * item click, keyboard command) so shortcut edits made at
 * `chrome://extensions/shortcuts` propagate to menu labels and the
 * toolbar tooltip at the next click — Chrome has no event for
 * those edits.
 *
 * Fire-and-forget at callsites: the current interaction runs at
 * full speed against the pre-click state, and any out-of-sync
 * labels get fixed before the user opens the menu again. The diff
 * is cheap (one `getAll()` + string compare) and, in the common
 * no-change case, skips the whole update sweep.
 */
export async function refreshMenusIfHotkeysChanged(): Promise<void> {
  const commands = await chrome.commands.getAll();
  const fingerprint = shortcutFingerprint(commands);
  if (cachedShortcutFingerprint === fingerprint) return;
  await refreshMenusAndTooltip(commands);
}


/**
 * Build the right-side hint for a menu entry. Assembles up to two
 * segments inside a single `(…)` group:
 *   - `Click` / `Double-click` (italic) when this action matches
 *     the matching default.
 *   - The bound keyboard shortcut (literal, upright) when the
 *     command is bound — only meaningful for delay-0 entries,
 *     since delayed variants have no command.
 *
 * Combinations render as `(Click, Ctrl+Shift+Y)` etc. Returns an
 * empty string when neither applies, so the caller can concat
 * unconditionally.
 */
function buildMenuHint(
  action: CaptureAction,
  clickId: string,
  doubleClickId: string,
  shortcuts: Map<string, string>,
): string {
  const parts: string[] = [];
  if (action.id === clickId) parts.push(CLICK_ITALIC);
  else if (action.id === doubleClickId) parts.push(DOUBLE_CLICK_ITALIC);
  const hk = shortcuts.get(action.id);
  if (hk) parts.push(hk);
  if (parts.length === 0) return '';
  return `${HINT_SEPARATOR}(${parts.join(', ')})`;
}

function actionMenuTitle(
  action: CaptureAction,
  clickId: string,
  doubleClickId: string,
  shortcuts: Map<string, string>,
): string {
  return action.title + buildMenuHint(action, clickId, doubleClickId, shortcuts);
}

/**
 * Update `chrome.action.setTitle` to match the currently selected
 * default click action. Called after the preference changes and on
 * service-worker install/startup so a stale title from a previous
 * session doesn't linger.
 */
export async function refreshActionTooltip(): Promise<void> {
  try {
    await chrome.action.setTitle({ title: await getDefaultActionTooltip() });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to refresh action tooltip:', err);
  }
}

// ───────────────────── More-submenu item helpers ─────────────────────

/**
 * Read the most recent capture record from chrome.storage.local. Used
 * to drive both the Copy-last-… menu enable state and the actual copy
 * action when one is clicked.
 */
async function getLatestCaptureRecord(): Promise<CaptureRecord | undefined> {
  const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
  const log = (data[LOG_STORAGE_KEY] as CaptureRecord[] | undefined) ?? [];
  return log[log.length - 1];
}

/**
 * Toggle `enabled` on the two Copy-last-… menu entries to match the
 * most recent capture record. Called on install/startup, and from a
 * `chrome.storage.onChanged` listener so every capture (and the Clear
 * log history action) refreshes the state without explicit plumbing
 * between capture.ts and background.ts.
 *
 * `chrome.contextMenus.update` rejects if the menu isn't installed yet
 * — harmless during the first install pass before the items have been
 * created — so we swallow the error.
 */
export async function refreshCopyMenuState(): Promise<void> {
  const r = await getLatestCaptureRecord();
  // Same suppression pattern as the default-setter helpers: updating a
  // not-yet-created menu id throws `No item with id "…"`; harmless
  // during first install before the items exist.
  try {
    await chrome.contextMenus.update(COPY_LAST_SCREENSHOT_MENU_ID, {
      enabled: !!r?.screenshot,
    });
  } catch {
    /* menu not installed yet */
  }
  try {
    await chrome.contextMenus.update(COPY_LAST_HTML_MENU_ID, {
      enabled: !!r?.contents,
    });
  } catch {
    /* menu not installed yet */
  }
  try {
    await chrome.contextMenus.update(COPY_LAST_SELECTION_MENU_ID, {
      enabled: !!r?.selection,
    });
  } catch {
    /* menu not installed yet */
  }
}

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/**
 * Copy `text` to the system clipboard via an offscreen document.
 *
 * MV3 service workers have no DOM and don't expose `navigator.clipboard`,
 * so we host a hidden offscreen page (`offscreen.html` + `offscreen.ts`)
 * whose only job is to do the copy via `document.execCommand('copy')`
 * on a temporary <textarea>.
 *
 * The document is created on demand and **kept alive** for the SW
 * lifetime. We deliberately don't close it after each copy:
 *   - Closing creates a race against a second concurrent copy — the
 *     teardown from call A would tear out the document call B is
 *     still mid-message on, and B sees `undefined` (no listener).
 *   - The page is hidden and holds only a single message listener,
 *     so the resource cost is negligible.
 *   - When the SW idles out, Chrome tears down the document with it,
 *     so we don't leak past an SW lifetime either.
 *
 * `createDocument` rejects if the document already exists; we
 * try-catch and reuse rather than calling `hasDocument()` first to
 * keep the *creation* step race-free against a second concurrent
 * copy that arrives while creation is in flight.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Copy capture filename to the clipboard.',
    });
  } catch (err) {
    // "Only a single offscreen document may be created" — fine, reuse.
    if (!(err instanceof Error) || !err.message.includes('Only a single offscreen document')) {
      throw err;
    }
  }
  const response = (await chrome.runtime.sendMessage({
    target: 'offscreen-copy',
    text,
  })) as { ok?: boolean; error?: string } | undefined;
  // Distinguish "no listener responded" from "listener responded but
  // execCommand returned false" — the two failure modes have very
  // different fixes (loader timing vs. browser policy / focus).
  if (response === undefined) {
    throw new Error('Offscreen document did not respond (listener not registered yet?)');
  }
  if (!response.ok) {
    throw new Error(`Clipboard copy rejected${response.error ? `: ${response.error}` : ''}`);
  }
}

/**
 * Resolve the absolute on-disk directory where this extension writes
 * its captures (`<downloads>/SeeWhatISee/`). The user's downloads root
 * is OS- and config-dependent and not exposed by any Chrome API, so we
 * derive it by searching `chrome.downloads.search` for our `log.json`
 * record (every capture overwrites it, so the most recent match points
 * at the live directory — even on a fresh SW load where in-memory
 * state is empty).
 *
 * - Pinning the search to `log.json` rather than any file under a
 *   `SeeWhatISee/` folder avoids false matches in same-named
 *   directories the user happens to use (e.g. `/tmp/SeeWhatISee/`).
 * - `byExtensionId` is checked client-side (the `DownloadQuery` type
 *   doesn't accept it as a filter — it's a result-only field) as a
 *   second guard against an unrelated `log.json` in such a folder.
 *
 * Throws when no capture has happened yet so the caller can surface
 * a "capture once first" message via the icon/tooltip error channel.
 */
async function getCaptureDirectory(): Promise<string> {
  const candidates = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\]log\\.json$`,
    orderBy: ['-startTime'],
  });
  const ours = candidates.find((it) => it.byExtensionId === chrome.runtime.id);
  const fullPath = ours?.filename;
  if (!fullPath) {
    throw new Error(
      `No captures yet — capture something first to create the ${DOWNLOAD_SUBDIR} directory.`,
    );
  }
  // Strip the basename. `chrome.downloads.search().filename` is
  // documented to be the absolute path to a file (never ends in a
  // separator), so this always trims one segment.
  return fullPath.replace(/[/\\][^/\\]+$/, '');
}

/**
 * Join `dir` and `name` using whichever separator `dir` already uses.
 * `chrome.downloads.search` returns OS-native paths — backslashes on
 * Windows, forward slashes elsewhere — so reusing the existing
 * separator keeps the result paste-ready in the user's OS shell /
 * file manager.
 */
function joinCapturePath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${name}`;
}

// The `if (!r) ...` / `if (!r.screenshot) ...` branches below are
// defensive — under normal use the menu items are greyed out (so the
// click can't fire), but the user can still hit a small race window
// if they Clear log history (or it gets cleared) between the
// `refreshCopyMenuState` storage callback firing and Chrome rendering
// the new enabled state. Splitting the two messages keeps the
// "ERROR: …" tooltip line legible in either case.
export async function copyLastScreenshotFilename(): Promise<void> {
  const r = await getLatestCaptureRecord();
  if (!r) throw new Error('No captures in the log to copy from');
  if (!r.screenshot) throw new Error('Latest capture has no screenshot to copy');
  const dir = await getCaptureDirectory();
  await copyToClipboard(joinCapturePath(dir, r.screenshot.filename));
}

export async function copyLastHtmlFilename(): Promise<void> {
  const r = await getLatestCaptureRecord();
  if (!r) throw new Error('No captures in the log to copy from');
  if (!r.contents) throw new Error('Latest capture has no HTML snapshot to copy');
  const dir = await getCaptureDirectory();
  await copyToClipboard(joinCapturePath(dir, r.contents.filename));
}

export async function copyLastSelectionFilename(): Promise<void> {
  const r = await getLatestCaptureRecord();
  if (!r) throw new Error('No captures in the log to copy from');
  if (!r.selection) throw new Error('Latest capture has no selection to copy');
  const dir = await getCaptureDirectory();
  await copyToClipboard(joinCapturePath(dir, r.selection.filename));
}

/**
 * Open the on-disk capture directory in a new tab as a `file://` URL
 * so the user can browse the saved screenshots / HTML / `log.json`.
 */
export async function openSnapshotsDirectory(): Promise<void> {
  const dir = await getCaptureDirectory();
  // Build a properly-encoded file:// URL. Normalize Windows backslashes
  // to forward slashes, prepend a leading `/` for Windows paths like
  // `C:/Users/…` so the URL parser sees an absolute path, and let
  // `new URL` percent-encode anything weird (spaces in user names,
  // `#`, `?`, non-ASCII characters).
  const normalized = dir.replace(/\\/g, '/');
  const fileUrl = new URL(`file://${normalized.startsWith('/') ? '' : '/'}${normalized}`).href;
  await chrome.tabs.create({ url: fileUrl });
}

// ───────────────────────── installContextMenu ────────────────────────
//
// Right-click context menu on the toolbar action. Structure:
//
//   Capture...
//   Save screenshot
//   Save HTML contents
//   Capture with delay  ▸              (submenu, bases with showInDelayedSubmenu)
//       • Capture... in 2s
//       • Save default items in 2s
//       • Save screenshot in 2s
//       • Save HTML contents in 2s
//       • Save everything in 2s
//       ─────────
//       • Capture... in 5s
//       • Save default items in 5s
//       • Save screenshot in 5s
//       • Save HTML contents in 5s
//       • Save everything in 5s
//   Set default click action  ▸     (submenu; ✓ on selected in each section)
//         ──  When text is selected  ──      (disabled header)
//       ✓ Capture...
//         Save default items
//         Save selection as HTML
//         Save selection as text
//         Save selection as markdown
//         Ignore selection (use default below)
//       ─────────
//         ──  When no text is selected  ──   (disabled header)
//       ✓ Capture...
//         Save default items
//         Save screenshot
//         Save HTML contents
//         Save URL                         (no delayed variants)
//         Save everything
//       ─────────
//         Capture... in 2s
//         Save default items in 2s
//         Save screenshot in 2s
//         Save HTML contents in 2s
//         Save everything in 2s
//       ─────────
//         Capture... in 5s
//         Save default items in 5s
//         Save screenshot in 5s
//         Save HTML contents in 5s
//         Save everything in 5s
//   More  ▸                         (submenu)
//       • Save default items             (runs Capture-page Save with stored defaults, no dialog)
//       ─────────
//       • Save URL
//       • Save everything
//       ─────────
//       • Save selection as HTML         (saves the selected HTML fragment)
//       • Save selection as text         (saves selection.toString())
//       • Save selection as markdown     (saves HTML → markdown)
//       ─────────
//       • Copy last screenshot filename   (greyed unless latest record has a screenshot)
//       • Copy last HTML filename         (greyed unless latest record has HTML)
//       • Copy last selection filename    (greyed unless latest record has a selection)
//       ─────────
//       • Snapshots directory
//       ─────────
//       • Clear log history
//
// Chrome caps each extension at
// `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level
// items in the action context menu. Overflow fails silently via
// `chrome.runtime.lastError`, so a careless addition silently drops
// a previously-working entry. The menu above has 6 top-level
// entries (3 undelayed + 3 submenu parents) — **at the cap**. Do
// not add another top-level entry — nest new items under an
// existing submenu (the `More` submenu is a natural home for
// infrequent utilities).
//
// In-submenu separators are free (they don't count against the
// top-level cap) so we use them to group the submenu contents by
// delay.
//
// Every top-level entry, every "Capture with delay" child, and every
// "Set default click action" entry is built from the same
// CAPTURE_ACTIONS array, so ids / titles / run functions can't
// drift. `handleActionClick` looks up the current default out of
// the same array.
//
// The registration runs on `chrome.runtime.onInstalled`; Chrome
// persists the entries across service-worker restarts so we don't
// have to recreate them on every wakeup.
//
// Note: "Save screenshot" is functionally identical to a plain
// left-click when `save-screenshot` is the default — listed in the
// menu for discoverability so users don't have to know the toolbar
// click also captures.

export async function installContextMenu(): Promise<void> {
  const platform = await chrome.runtime.getPlatformInfo();
  // ChromeOS rendering of `type: 'separator'` in extension menus is
  // sometimes broken/invisible; on that platform we fall back to a
  // disabled normal item titled with U+2500 box-drawing chars.
  //
  // A11y trade-off: `chrome.contextMenus` has no API to mark an item
  // non-focusable or aria-hidden, so the fake separator is still
  // reachable via keyboard and screen readers announce it as a row
  // of dashes (dimmed). Native `type: 'separator'` entries skip
  // focus. We accept this because the native path is already broken
  // on ChromeOS — invisible grouping is worse than a dimmed dash row.
  const useFakeSeparator = platform.os === 'cros';

  // Chrome menus use the OS's proportional system font, so character
  // count only approximates pixel width. 30 U+2500 chars was chosen
  // empirically to look like a full-width rule against the current
  // submenu entries; revisit if noticeably wider entries are added.
  const FAKE_SEPARATOR_TITLE = '─'.repeat(30);

  const createSeparator = (id: string, parentId: string) => {
    if (useFakeSeparator) {
      chrome.contextMenus.create({
        id,
        parentId,
        title: FAKE_SEPARATOR_TITLE,
        enabled: false,
        contexts: ['action'],
      });
    } else {
      chrome.contextMenus.create({
        id,
        parentId,
        type: 'separator',
        contexts: ['action'],
      });
    }
  };

  // Read both defaults up front so each submenu child can be
  // created with the correct title prefix — `removeAll` wipes
  // Chrome's per-item state along with the entries themselves, so
  // we can't rely on persisted state. Menu hints (Click /
  // Double-click) track the without-selection default only.
  const defaultId = await getDefaultWithoutSelectionId();
  const withId = await getDefaultWithSelectionId();
  const dblId = await getDefaultDblWithoutSelectionId();
  const commands = await chrome.commands.getAll();
  const shortcuts = commandsToShortcutMap(commands);
  // Seed the fingerprint so the first post-install call to
  // refreshMenusIfHotkeysChanged doesn't trigger an immediate
  // redundant rebuild. The first actual user interaction only
  // re-renders if a shortcut has actually changed since now.
  cachedShortcutFingerprint = shortcutFingerprint(commands);

  // ── Top-level entries (delay 0, primary group only) ────────
  // The three undelayed primary capture actions, one per base action.
  // Titles carry a right-side (Click) / (Double-click) / hotkey hint
  // when they match the current defaults or have a bound command —
  // see actionMenuTitle. More-group base actions (save-defaults,
  // save-url, save-all) live in the More submenu and don't get a
  // top-level slot.
  for (const action of captureActionsWithDelay(0, 'primary')) {
    chrome.contextMenus.create({
      id: action.id,
      title: actionMenuTitle(action, defaultId, dblId, shortcuts),
      contexts: ['action'],
    });
  }

  // ── "Capture with delay" submenu ──────────────────────────────
  // One parent row; Chrome renders the ▸ because it has children
  // (set via parentId below).
  chrome.contextMenus.create({
    id: DELAYED_PARENT_ID,
    title: 'Capture with delay',
    contexts: ['action'],
  });
  const delayedDelays = CAPTURE_DELAYS_SEC.filter((d) => d !== 0);
  for (let i = 0; i < delayedDelays.length; i++) {
    const delaySec = delayedDelays[i]!;
    if (i > 0) {
      // Visual separator between delay groups. Separators inside a
      // submenu don't count against the top-level cap.
      createSeparator(
        `${DELAYED_PARENT_ID}-sep-${delaySec}`,
        DELAYED_PARENT_ID,
      );
    }
    const entries = CAPTURE_ACTIONS.filter(
      (a) => a.delaySec === delaySec && a.showInDelayedSubmenu,
    );
    for (const action of entries) {
      chrome.contextMenus.create({
        id: action.id,
        parentId: DELAYED_PARENT_ID,
        title: actionMenuTitle(action, defaultId, dblId, shortcuts),
        contexts: ['action'],
      });
    }
  }

  // ── "Set default click action" submenu ──────────────────────
  // See header layout above. Uses normal items with a ✓ prefix on
  // the selected entry rather than radio items: Chrome's radio
  // mutual-exclusion only covers a contiguous run, so a separator
  // would let two items appear selected. The `save-selection-*`
  // format shortcuts are deliberately not offered in the
  // without-selection section (they would just error on every
  // click with no selection on the page).
  chrome.contextMenus.create({
    id: DEFAULT_CLICK_PARENT_ID,
    title: 'Set default click action',
    contexts: ['action'],
  });

  chrome.contextMenus.create({
    id: WITH_SEL_HEADER_ID,
    parentId: DEFAULT_CLICK_PARENT_ID,
    title: `${DEFAULT_UNSELECTED_PREFIX}──  When text is selected  ──`,
    enabled: false,
    contexts: ['action'],
  });
  for (const choice of WITH_SELECTION_CHOICES) {
    chrome.contextMenus.create({
      id: DEFAULT_CLICK_WITH_SEL_PREFIX + choice.id,
      parentId: DEFAULT_CLICK_PARENT_ID,
      title: defaultMenuTitle(choice.title, choice.id === withId, shortcuts.get(choice.id)),
      contexts: ['action'],
    });
  }

  createSeparator(`${DEFAULT_CLICK_PARENT_ID}-sep-sections`, DEFAULT_CLICK_PARENT_ID);

  chrome.contextMenus.create({
    id: WITHOUT_SEL_HEADER_ID,
    parentId: DEFAULT_CLICK_PARENT_ID,
    title: `${DEFAULT_UNSELECTED_PREFIX}──  When no text is selected  ──`,
    enabled: false,
    contexts: ['action'],
  });
  for (let i = 0; i < CAPTURE_DELAYS_SEC.length; i++) {
    const delaySec = CAPTURE_DELAYS_SEC[i]!;
    if (i > 0) {
      createSeparator(
        `${DEFAULT_CLICK_PARENT_ID}-sep-delay-${delaySec}`,
        DEFAULT_CLICK_PARENT_ID,
      );
    }
    for (const action of captureActionsWithDelay(delaySec)) {
      if (isSelectionBaseId(action.baseId)) continue;
      chrome.contextMenus.create({
        id: DEFAULT_CLICK_WITHOUT_SEL_PREFIX + action.id,
        parentId: DEFAULT_CLICK_PARENT_ID,
        title: defaultMenuTitle(action.title, action.id === defaultId, shortcuts.get(action.id)),
        contexts: ['action'],
      });
    }
  }

  // ── "More" submenu ──────────────────────────────────────────
  // Home for:
  //   - capture actions that don't earn a top-level slot (the
  //     "neither / both files" shortcuts for the Capture page flow —
  //     equivalent to opening the Capture page and ticking neither
  //     or both checkboxes, minus the dialog round-trip)
  //   - infrequent utilities that would otherwise compete for a
  //     top-level slot against the primary capture entries
  chrome.contextMenus.create({
    id: MORE_PARENT_ID,
    title: 'More',
    contexts: ['action'],
  });
  // More-group capture actions (delay 0 only — delayed variants are
  // reachable via "Set default click action"). They use the bare
  // CAPTURE_ACTIONS id like the primary top-level entries, so the
  // onClicked dispatcher's `findCaptureAction(id)` branch handles them
  // without a special case, and `setDefaultWithoutSelectionId`'s
  // hint-refresh loop can update their titles too.
  //
  // Two separators split the More-group entries into three groups:
  //   1. `save-defaults` (the everyday Save-defaults shortcut), then
  //   2. the non-selection capture-page shortcuts (`save-url`,
  //      `save-all`), then
  //   3. the `save-selection-*` format shortcuts.
  // Group (1) is the user's most likely Save-without-dialog pick, so
  // it sits at the top with its own divider. The (2)/(3) split keeps
  // the always-applicable shortcuts visually distinct from the ones
  // that only work when text is selected.
  let moreDefaultsSeparatorInserted = false;
  let moreSelectionSeparatorInserted = false;
  for (const action of captureActionsWithDelay(0, 'more')) {
    if (action.baseId !== 'save-defaults' && !moreDefaultsSeparatorInserted) {
      createSeparator(`${MORE_PARENT_ID}-sep-defaults`, MORE_PARENT_ID);
      moreDefaultsSeparatorInserted = true;
    }
    if (isSelectionBaseId(action.baseId) && !moreSelectionSeparatorInserted) {
      createSeparator(`${MORE_PARENT_ID}-sep-selection`, MORE_PARENT_ID);
      moreSelectionSeparatorInserted = true;
    }
    chrome.contextMenus.create({
      id: action.id,
      parentId: MORE_PARENT_ID,
      title: actionMenuTitle(action, defaultId, dblId, shortcuts),
      contexts: ['action'],
    });
  }
  createSeparator(`${MORE_PARENT_ID}-sep-capture`, MORE_PARENT_ID);
  // The Copy-last-… entries are created `enabled: false` and flipped
  // on by `refreshCopyMenuState()` once we've checked the latest
  // record. That avoids a brief flash of "enabled but does nothing"
  // on the first install / after a Clear log history.
  chrome.contextMenus.create({
    id: COPY_LAST_SCREENSHOT_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Copy last screenshot filename',
    enabled: false,
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: COPY_LAST_HTML_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Copy last HTML filename',
    enabled: false,
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: COPY_LAST_SELECTION_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Copy last selection filename',
    enabled: false,
    contexts: ['action'],
  });
  createSeparator(`${MORE_PARENT_ID}-sep-copy`, MORE_PARENT_ID);
  chrome.contextMenus.create({
    id: SNAPSHOTS_DIR_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Snapshots directory',
    contexts: ['action'],
  });
  createSeparator(`${MORE_PARENT_ID}-sep-snapshots`, MORE_PARENT_ID);
  chrome.contextMenus.create({
    id: CLEAR_LOG_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Clear log history',
    contexts: ['action'],
  });

  // After all entries exist, sync the Copy-last-… enable state to
  // whatever the most recent capture record looks like.
  await refreshCopyMenuState();
}
