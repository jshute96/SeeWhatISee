// Right-click action menu: builds the menu tree (`installContextMenu`),
// keeps every row's title in sync with the current defaults + bound
// hotkeys (`refreshMenusAndTooltip`, `refreshMenusIfHotkeysChanged`),
// and hosts the More-submenu utilities (Copy-last-filename via an
// offscreen clipboard doc, Snapshots directory, Clear log). Menu-item
// ids are exported so `background.ts`'s `onClicked` dispatch can
// route each click to the right action.

import {
  findProviderForTab,
  getAskPin,
} from '../ask/index.js';
import { type CaptureRecord } from '../capture/types.js';
import { DOWNLOAD_SUBDIR } from '../capture/downloads.js';
import { LOG_STORAGE_KEY } from '../capture/log-store.js';
import { getLastCapture } from './last-capture.js';
import {
  CAPTURE_ACTIONS,
  captureActionsWithDelay,
  type CaptureAction,
} from './capture-actions.js';
import {
  getCaptureDetailsDefaults,
  type CaptureDetailsDefaults,
} from './capture-page-defaults.js';
import {
  findCaptureAction,
  getDefaultActionTooltip,
  getDefaultDblWithSelectionId,
  getDefaultDblWithoutSelectionId,
  getDefaultWithSelectionId,
  getDefaultWithoutSelectionId,
  isSelectionBaseId,
} from './default-action.js';
import { buildMenuHint } from './menu-hint.js';
import { saveDefaultsMenuTitle } from './tooltip.js';

export const MORE_PARENT_ID = 'more-parent';
// Suffix appended to the menu-item id of the top-level "shortcut"
// entries so they don't collide with the same-baseId entry surfaced
// inside the More submenu (chrome.contextMenus rejects a second
// `create()` with a duplicate id — this was the bug fixed by PR #17).
// The onClicked dispatcher in `background.ts` strips this suffix
// before looking up the action — no real CAPTURE_ACTIONS id ends in
// `-shortcut`, so the strip is unambiguous.
export const SHORTCUT_SUFFIX = '-shortcut';

// Id used by the "Clear log history" entry under the More submenu.
export const CLEAR_LOG_MENU_ID = 'clear-log';
// Id used by the "Snapshots directory" entry under the More submenu.
export const SNAPSHOTS_DIR_MENU_ID = 'snapshots-directory';
// Id used by the "Upload image to Capture..." entry under the More
// submenu. Unlike the other More entries (which act on existing
// captures), this one *creates* a Capture-page session from a local
// image — opens `capture.html?upload=true` so the page shows an
// upload-landing card before falling into the normal flow.
export const UPLOAD_IMAGE_MENU_ID = 'upload-image-to-capture';
// Id used by the "Restore last capture" entry under the More submenu.
// Re-opens a Capture page seeded from the saved `lastCapture` slot —
// preserving prompt / save checkbox state / drawing edits + undo
// stack / selected tool from the most recently closed Capture page.
// Enabled state mirrors whether a `lastCapture` record exists;
// see `refreshRestoreLastCaptureMenuState`.
export const RESTORE_LAST_CAPTURE_MENU_ID = 'restore-last-capture';
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

// Toolbar entry that pins (or unpins) the current tab as the Ask
// target. Title flips between the Set / Unset variants below
// depending on whether the active tab is already the pin; greyed
// out when the tab isn't on an enabled AI provider. Sync is driven
// by `refreshPinAskTargetMenu` from background.ts's tab/window
// listeners so the entry reflects the current page by the time the
// user opens the menu.
export const PIN_ASK_TARGET_MENU_ID = 'pin-ask-target';
// Title strings for the Set / Unset states. Pulled into constants
// so the static install title and `refreshPinAskTargetMenu`'s
// dynamic flips don't drift from each other (and so an editor
// rewording the visible text only has to touch one place per
// state). The leading glyph is a *text-default* ballot box (not
// the colored 📌 emoji) — native menu rendering on Linux GTK
// falls back to a thin grey symbol-font glyph for emoji-default
// codepoints, while ☐ / ☑ render as designed for monochrome text
// across every platform. Two spaces after the glyph for breathing
// room next to the label.
export const PIN_ASK_TARGET_SET_TITLE =
  '☐  Set this tab as Ask button target';
export const PIN_ASK_TARGET_UNSET_TITLE =
  '☑  Unset this tab as Ask button target';

// Image right-click context entries. Live in `contexts: ['image']` so
// they only surface when the user right-clicks an `<img>` (or any
// element Chrome treats as an image), and they read `info.srcUrl` for
// the image URL. Two entries:
//   - IMAGE_CAPTURE_MENU_ID: opens the Capture page using the image
//     bytes as the screenshot (same flow as the toolbar Capture...
//     entry, but with an arbitrary image instead of `captureVisibleTab`).
//   - IMAGE_SAVE_SCREENSHOT_MENU_ID: writes the image bytes directly
//     under `screenshot-<ts>.<ext>` and a matching `log.json` record —
//     the Save-screenshot equivalent for an image that's already
//     visible on the page.
//
// Chrome auto-groups multi-item page context menus under a submenu
// labelled with the extension name, so the user sees them as
// "SeeWhatISee › Capture... (this image)" /
// "SeeWhatISee › Save screenshot (this image)".
export const IMAGE_CAPTURE_MENU_ID = 'image-capture';
export const IMAGE_SAVE_SCREENSHOT_MENU_ID = 'image-save-screenshot';

// Keyboard shortcuts declared in manifest.json's `commands` block.
// Command names carry a two-digit ordering prefix (`NN-`) because
// chrome://extensions/shortcuts lists commands in raw string-sort
// order on the command *name* rather than our preferred order. The
// prefix is stripped here before dispatch so the rest of the code
// keeps using bare action ids.
export const COMMAND_PREFIX_PATTERN = /^\d{2}-/;

// Hint composition (italic markers, scope suffixes, group joining)
// lives in `menu-hint.ts` — extracted there so it can be unit-tested
// without dragging in the chrome.* surface that the rest of this
// module pulls.

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
 *   - Every `CAPTURE_ACTIONS` row in the top-level / `Capture with
 *     delay` / `More` menus — hotkey plus `(Click)` / `(Double-click)`
 *     hint as applicable.
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
  const dblId = await getDefaultDblWithoutSelectionId();
  // The `actionMenuTitle` save-defaults override depends on the
  // *with-selection* routing too, so fetch both with-sel ids up front.
  // Fresh-install / non-save-defaults values fall through cleanly —
  // the override only fires when the no-sel slot is save-defaults.
  const clickWithSelId = await getDefaultWithSelectionId();
  const dblWithSelId = await getDefaultDblWithSelectionId();
  const defaults = await getCaptureDetailsDefaults();
  const commands = preloadedCommands ?? (await chrome.commands.getAll());
  const shortcuts = commandsToShortcutMap(commands);
  cachedShortcutFingerprint = shortcutFingerprint(commands);

  // Action rows — top-level + More submenu. They share CAPTURE_ACTIONS
  // ids, so updating by id hits whichever surface each action is
  // currently on.
  await Promise.all(
    CAPTURE_ACTIONS.map(async (a) => {
      try {
        await chrome.contextMenus.update(a.id, {
          title: actionMenuTitle(a, defaultId, clickWithSelId, dblId, dblWithSelId, shortcuts, defaults),
        });
      } catch {
        /* menu not installed yet */
      }
    }),
  );

  // Update top-level shortcut items. They live alongside the
  // `CAPTURE_ACTIONS` rows on the menu but use `-shortcut`-suffixed
  // ids (see SHORTCUT_SUFFIX), so the loop above doesn't reach them.
  await Promise.all(
    TOP_LEVEL_SHORTCUT_ACTION_IDS.map((actionId) =>
      updateShortcutMenu(
        `${actionId}${SHORTCUT_SUFFIX}`,
        actionId,
        defaultId,
        dblId,
        clickWithSelId,
        dblWithSelId,
        shortcuts,
        defaults,
      ),
    ),
  );

  // Tooltip's `Click:` line also folds in the `_execute_action`
  // hotkey when bound, so it has to be rebuilt anytime the menus
  // are. Putting it here (rather than at the two setter callsites)
  // means `refreshMenusIfHotkeysChanged` picks it up for free.
  await refreshActionTooltip();
}

/**
 * Update one `-shortcut`-suffixed top-level row's title to match
 * `actionId`'s current state. Looks up the action in the catalog
 * and silently no-ops if it (or the menu row) is missing — the
 * same defensive pattern the per-row `chrome.contextMenus.update`
 * loop above uses, so this helper composes cleanly into the
 * `Promise.all` sweep in `refreshMenusAndTooltip`.
 */
async function updateShortcutMenu(
  menuId: string,
  actionId: string,
  defaultId: string,
  dblId: string,
  clickWithSelId: string,
  dblWithSelId: string,
  shortcuts: Map<string, string>,
  defaults: CaptureDetailsDefaults,
) {
  const action = findCaptureAction(actionId);
  if (action) {
    try {
      await chrome.contextMenus.update(menuId, {
        title: actionMenuTitle(action, defaultId, clickWithSelId, dblId, dblWithSelId, shortcuts, defaults),
      });
    } catch {
      /* menu not installed yet */
    }
  }
}

/**
 * Run `refreshMenusAndTooltip` only when `chrome.commands.getAll()`
 * returns a different binding set than last time we rendered.
 * Called from every user-interaction path (toolbar click, menu
 * item click, keyboard command) and on Options-page load so
 * shortcut edits made at `chrome://extensions/shortcuts` propagate
 * to menu labels and the toolbar tooltip — Chrome has no event for
 * those edits.
 *
 * Fire-and-forget at callsites: the current interaction runs at
 * full speed against the pre-click state, and any out-of-sync
 * labels get fixed before the user opens the menu again. The diff
 * is cheap (one `getAll()` + string compare) and, in the common
 * no-change case, skips the whole update sweep.
 *
 * `preloadedCommands` lets a caller that already has a
 * `chrome.commands.getAll()` snapshot (e.g. the Options-page
 * `getOptionsData` handler) avoid a redundant API call.
 */
export async function refreshMenusIfHotkeysChanged(
  preloadedCommands?: chrome.commands.Command[],
): Promise<void> {
  const commands = preloadedCommands ?? (await chrome.commands.getAll());
  const fingerprint = shortcutFingerprint(commands);
  if (cachedShortcutFingerprint === fingerprint) return;
  await refreshMenusAndTooltip(commands);
}


// Hint composition (`rowScope`, `buildRowGroup`, `buildMenuHint`)
// lives in `./menu-hint.js` — see that module's header for why.

// CAPTURE_ACTIONS ids surfaced as top-level "shortcut" entries on the
// toolbar context menu. Each is recreated with a `-shortcut`-suffixed
// menu id (see SHORTCUT_SUFFIX) because the same action also appears
// inside More and chrome.contextMenus rejects duplicate ids. Single
// source of truth for both `installContextMenu` (creates the rows) and
// `refreshMenusAndTooltip` (updates titles).
const TOP_LEVEL_SHORTCUT_ACTION_IDS = ['capture', 'save-defaults', 'capture-3s'] as const;

// CAPTURE_ACTIONS ids of the delayed-shortcut block inside the More
// submenu. Order is user-visible: Capture... then Save screenshot.
// Today these are the only delayed entries we surface anywhere —
// every other base is `supportsDelayed: false`, and there's only the
// single 3s delay variant per base.
const MORE_DELAYED_ACTION_IDS = [
  'capture-3s',
  'save-screenshot-3s',
] as const;

/**
 * Render the title for one menu row. For non-`save-defaults`
 * actions the catalog title (`action.title`) is used as-is. For
 * `save-defaults` the title is rewritten only when *both* branches
 * of `capturePageDefaults` simplify to a single artifact each:
 *
 *   - Both branches save the same single item → `Save <X>`.
 *   - Both branches save a different single item →
 *     `Save <X> or <Y>` (selection format dropped — the row needs
 *     a one-word noun on each side).
 *   - Either branch is empty or saves multiple items → catalog
 *     `Save default items`. The `or`-form requires single-word nouns
 *     on each side, so anything richer falls back rather than
 *     introducing comma-and joins.
 *
 * The rewrite is purely action-property-based — it doesn't look at
 * which click / double-click rows route through `save-defaults`. The
 * `(Click)` / `(Double-click)` hint scope (built by
 * `buildMenuHint`) carries the routing story; the title carries
 * "what does this menu entry save when clicked directly".
 */
function actionMenuTitle(
  action: CaptureAction,
  clickNoSelId: string,
  clickWithSelId: string,
  dblNoSelId: string,
  dblWithSelId: string,
  shortcuts: Map<string, string>,
  defaults: CaptureDetailsDefaults,
): string {
  const title = action.baseId === 'save-defaults'
    ? saveDefaultsMenuTitle(defaults, action.delaySec, action.title)
    : action.title;
  return title + buildMenuHint(action, clickNoSelId, clickWithSelId, dblNoSelId, dblWithSelId, shortcuts);
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

/**
 * Toggle `enabled` on the Restore-last-capture entry to match
 * whether a `lastCapture` slot exists. Driven by
 * `chrome.storage.onChanged` so every promote (capture-page close)
 * or clear (new capture, restore, quota relief) refreshes the
 * state without explicit plumbing.
 */
export async function refreshRestoreLastCaptureMenuState(): Promise<void> {
  const record = await getLastCapture();
  try {
    await chrome.contextMenus.update(RESTORE_LAST_CAPTURE_MENU_ID, {
      enabled: !!record,
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
 * Open `capture.html?upload=true` in a tab adjacent to `opener`. The
 * landing card lets the user pick a local image; selecting one
 * dispatches `initializeUploadSession` to the SW, which seeds the
 * per-tab session, and the page falls into the normal Capture-page
 * flow.
 *
 * Tab-placement mirrors `openCapturePageWithSession` (right of the
 * opener, `openerTabId` linked) so the new tab visually groups with
 * the page the user was on. Pulled out of the inline menu-click
 * handler in `background.ts` so e2e tests can drive the same logic
 * without going through `chrome.contextMenus.onClicked` (which
 * Chrome's API doesn't expose a programmatic dispatch for).
 */
export async function openUploadCapturePage(
  opener: chrome.tabs.Tab | undefined,
): Promise<void> {
  const createProps: chrome.tabs.CreateProperties = {
    url: chrome.runtime.getURL('capture.html?upload=true'),
  };
  if (opener?.index !== undefined) createProps.index = opener.index + 1;
  if (opener?.id !== undefined) createProps.openerTabId = opener.id;
  await chrome.tabs.create(createProps);
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
//   Capture...                         (top-level shortcut row, id = capture-shortcut)
//   Save default items                 (top-level shortcut row, id = save-defaults-shortcut)
//   Capture... in 3s                   (top-level shortcut row, id = capture-3s-shortcut)
//   More  ▸                         (submenu — full action catalog + utilities)
//       • Capture...                     (same as the top-level shortcut)
//       • Save default items             (runs Capture-page Save with stored defaults, no dialog)
//       ─────────
//       • Save screenshot
//       • Save HTML contents
//       • Save URL
//       • Save everything
//       ─────────
//       • Capture... in 3s               (delayed-shortcut block)
//       • Save screenshot in 3s
//       ─────────
//       • Save selection as HTML         (saves the selected HTML fragment)
//       • Save selection as text         (saves selection.toString())
//       • Save selection as markdown     (saves HTML → markdown)
//       ─────────
//       • Copy last screenshot filename   (greyed unless latest record has a screenshot)
//       • Copy last HTML filename         (greyed unless latest record has HTML)
//       • Copy last selection filename    (greyed unless latest record has a selection)
//       ─────────
//       • Upload image to Capture...
//       • Restore last capture            (greyed unless a closed Capture page state is saved)
//       • Snapshots directory
//       ─────────
//       • Clear log history
//   Set this tab as Ask button target  (greyed unless current tab is a provider;
//                                        flips to "Unset…" when the tab is
//                                        already the pin)
//
// Chrome caps each extension at
// `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level
// items in the action context menu. Overflow fails silently via
// `chrome.runtime.lastError`, so a careless addition silently drops
// a previously-working entry. The menu above currently uses 5 of the
// 6 slots (three shortcut rows, the More submenu parent, plus the Pin
// Ask target row), leaving one free slot — but adding a sixth row
// puts the menu back at the cap, so be deliberate about what to
// promote.
//
// In-submenu separators are free (they don't count against the
// top-level cap) so we use them to group the "More" submenu into
// undelayed-shortcut, delayed-shortcut, selection-shortcut, and
// utility clusters.
//
// Top-level shortcut rows duplicate actions that also appear inside
// More — to avoid Chrome's duplicate-id rejection their menu ids
// carry the SHORTCUT_SUFFIX, which the onClicked dispatcher strips
// before looking up the action. See SHORTCUT_SUFFIX's doc comment.
//
// Every More-submenu action row is built from the same CAPTURE_ACTIONS
// array, so ids / titles / run functions can't drift. The top-level
// shortcut rows are driven from TOP_LEVEL_SHORTCUT_ACTION_IDS, and the
// More-submenu delayed-shortcut block from MORE_DELAYED_ACTION_IDS —
// both pull from CAPTURE_ACTIONS via findCaptureAction so titles,
// hints, and run() bodies stay in lockstep with the catalog.
//
// The registration runs on `chrome.runtime.onInstalled`; Chrome
// persists the entries across service-worker restarts so we don't
// have to recreate them on every wakeup.
//
// Image right-click entries are also installed below — see the
// IMAGE_CAPTURE_MENU_ID / IMAGE_SAVE_SCREENSHOT_MENU_ID doc-comment
// near the constants for their contract.

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

  // Read defaults up front so each row's `(Click)` / `(Double-click)`
  // hint reflects the current state — `removeAll` wipes Chrome's
  // per-item state along with the entries, so we can't rely on
  // persisted state. Menu hints track the without-selection
  // Click / Double-click defaults only.
  const defaultId = await getDefaultWithoutSelectionId();
  const dblId = await getDefaultDblWithoutSelectionId();
  // See `refreshMenusAndTooltip` for why `actionMenuTitle` needs the
  // with-sel routing ids even though the install-time menu hint
  // itself only references no-sel ids.
  const clickWithSelId = await getDefaultWithSelectionId();
  const dblWithSelId = await getDefaultDblWithSelectionId();
  const defaults = await getCaptureDetailsDefaults();
  const commands = await chrome.commands.getAll();
  const shortcuts = commandsToShortcutMap(commands);
  // Seed the fingerprint so the first post-install call to
  // refreshMenusIfHotkeysChanged doesn't trigger an immediate
  // redundant rebuild. The first actual user interaction only
  // re-renders if a shortcut has actually changed since now.
  cachedShortcutFingerprint = shortcutFingerprint(commands);

  // ── Top-level shortcut entries ─────────────────────────────
  // Surface the most common capture actions at the top level, with
  // `-shortcut`-suffixed ids so they don't collide with the same
  // baseId rows inside the More submenu. See
  // TOP_LEVEL_SHORTCUT_ACTION_IDS for the source of truth.
  for (const actionId of TOP_LEVEL_SHORTCUT_ACTION_IDS) {
    const action = findCaptureAction(actionId);
    if (!action) {
      // Surface a clear error rather than the silent
      // chrome.runtime.lastError that a missing-id `create()` would
      // produce — a regression in CAPTURE_ACTIONS shouldn't quietly
      // drop a top-level entry.
      throw new Error(`installContextMenu: missing CAPTURE_ACTIONS entry "${actionId}"`);
    }
    chrome.contextMenus.create({
      id: `${actionId}${SHORTCUT_SUFFIX}`,
      title: actionMenuTitle(action, defaultId, clickWithSelId, dblId, dblWithSelId, shortcuts, defaults),
      contexts: ['action'],
    });
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

  // Insert Capture... at the top of the More menu using the bare
  // CAPTURE_ACTIONS id ('capture'). The top-level shortcut row uses
  // 'capture-shortcut', so 'capture' is free here. Listing it in
  // both places is intentional: it keeps the More submenu a complete
  // catalog of every action while still promoting it to the top
  // level for discoverability.
  const moreCaptureAction = findCaptureAction('capture');
  if (!moreCaptureAction) {
    throw new Error('installContextMenu: missing CAPTURE_ACTIONS entry "capture"');
  }
  chrome.contextMenus.create({
    id: moreCaptureAction.id,
    parentId: MORE_PARENT_ID,
    title: actionMenuTitle(moreCaptureAction, defaultId, clickWithSelId, dblId, dblWithSelId, shortcuts, defaults),
    contexts: ['action'],
  });

  // More-group capture actions (delay 0). They use the bare
  // CAPTURE_ACTIONS id like the primary top-level entries, so the
  // onClicked dispatcher's `findCaptureAction(id)` branch handles them
  // without a special case, and `refreshMenusAndTooltip` updates their
  // titles in the same single sweep.
  //
  // Separators split the More-group entries into four clusters:
  //   1. `save-defaults` (the everyday Save-defaults shortcut), then
  //   2. the non-selection capture-page shortcuts (screenshot, html, url, all), then
  //   3. the delayed-shortcut block (Capture... / Save screenshot, both at 3s), then
  //   4. the `save-selection-*` format shortcuts.
  // Group (1) sits at the top with its own divider (after the
  // manually added Capture...). Group (3) is bracketed by dividers
  // because the delayed labels read as a distinct sub-set ("…in Ns").
  // The (3)/(4) split keeps the always-applicable shortcuts visually
  // distinct from the ones that only work when text is selected.
  let moreDefaultsSeparatorInserted = false;
  let moreDelayedBlockInserted = false;
  for (const action of captureActionsWithDelay(0, 'more')) {
    if (action.baseId !== 'save-defaults' && !moreDefaultsSeparatorInserted) {
      createSeparator(`${MORE_PARENT_ID}-sep-defaults`, MORE_PARENT_ID);
      moreDefaultsSeparatorInserted = true;
    }
    if (isSelectionBaseId(action.baseId) && !moreDelayedBlockInserted) {
      // Insert the delayed-shortcut block (with separators above and
      // below) in the slot between `save-all` and the first
      // `save-selection-*`. The trailing separator does double duty
      // as the divider between the always-applicable shortcuts above
      // and the selection-only shortcuts below.
      createSeparator(`${MORE_PARENT_ID}-sep-delayed-above`, MORE_PARENT_ID);
      for (const id of MORE_DELAYED_ACTION_IDS) {
        const delayedAction = findCaptureAction(id);
        if (!delayedAction) {
          throw new Error(`installContextMenu: missing CAPTURE_ACTIONS entry "${id}"`);
        }
        chrome.contextMenus.create({
          id: delayedAction.id,
          parentId: MORE_PARENT_ID,
          title: actionMenuTitle(delayedAction, defaultId, clickWithSelId, dblId, dblWithSelId, shortcuts, defaults),
          contexts: ['action'],
        });
      }
      createSeparator(`${MORE_PARENT_ID}-sep-delayed-below`, MORE_PARENT_ID);
      moreDelayedBlockInserted = true;
    }
    chrome.contextMenus.create({
      id: action.id,
      parentId: MORE_PARENT_ID,
      title: actionMenuTitle(action, defaultId, clickWithSelId, dblId, dblWithSelId, shortcuts, defaults),
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
    id: UPLOAD_IMAGE_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Upload image to Capture...',
    contexts: ['action'],
  });
  // Re-open the last Capture page's in-flight state. Created
  // `enabled: false` and flipped on by `refreshRestoreLastCaptureMenuState`
  // when a `lastCapture` slot exists — same first-paint policy as
  // the Copy-last-… entries.
  chrome.contextMenus.create({
    id: RESTORE_LAST_CAPTURE_MENU_ID,
    parentId: MORE_PARENT_ID,
    title: 'Restore last capture',
    enabled: false,
    contexts: ['action'],
  });
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

  // ── "Set this tab as Ask button target" entry ─────────────
  // Last top-level row, after the More submenu parent. Title and
  // enabled state are kept in sync by `refreshPinAskTargetMenu` from
  // background.ts whenever the active tab changes — so by the time
  // the user opens this menu, the entry reflects the current tab.
  // Defaults are set here as the safe pre-refresh state ("Set",
  // disabled): users on a non-provider tab will see the disabled
  // state during the momentary gap between install and the first
  // refresh.
  // Initial title is the disabled "Set" wording — the safe
  // pre-refresh state for users on a non-provider tab. See
  // `PIN_ASK_TARGET_SET_TITLE` for why we use a ballot-box prefix
  // instead of the 📌 emoji here. `refreshPinAskTargetMenu` flips
  // the title between Set / Unset on every tab/window event.
  chrome.contextMenus.create({
    id: PIN_ASK_TARGET_MENU_ID,
    title: PIN_ASK_TARGET_SET_TITLE,
    enabled: false,
    contexts: ['action'],
  });

  // ── Image right-click entries ───────────────────────────────
  // Separate context root from the toolbar `action` entries above.
  // Order here is the order Chrome renders them inside the
  // auto-generated extension submenu: Capture... first (matches the
  // toolbar's primary entry), then Save screenshot.
  chrome.contextMenus.create({
    id: IMAGE_CAPTURE_MENU_ID,
    title: 'Capture... (this image)',
    contexts: ['image'],
  });
  chrome.contextMenus.create({
    id: IMAGE_SAVE_SCREENSHOT_MENU_ID,
    title: 'Save screenshot (this image)',
    contexts: ['image'],
  });

  // After all entries exist, sync the Copy-last-… enable state to
  // whatever the most recent capture record looks like.
  await refreshCopyMenuState();
  // Restore-last-capture state — same first-paint sync as the
  // Copy-last entries; toggled live thereafter by the
  // `lastCapture`-keyed storage listener.
  await refreshRestoreLastCaptureMenuState();
  // Same for the Pin Ask target entry's title + enabled state —
  // there's no point waiting for a tab event to arrive before the
  // menu reflects the current page.
  await refreshPinAskTargetMenu();
}

/**
 * Sync the Set/Unset entry to the active tab. Three states:
 *
 *   1. Tab *is* the current pin → "Unset this tab as Ask button
 *      target", enabled. We allow this even when the tab's URL is no
 *      longer a valid Ask target (e.g. user pinned a Claude
 *      conversation then navigated to /settings) — otherwise the
 *      user would be stranded with no way to clear the stale pin
 *      from the page they're on.
 *   2. Tab is *not* the pin and is on an enabled provider (and not
 *      excluded) → "Set this tab as Ask button target", enabled.
 *   3. Tab is *not* the pin and isn't a valid target → "Set this
 *      tab as Ask button target", disabled.
 *
 * Best-effort: missing active tab leaves the entry in state 3.
 * `chrome.contextMenus.update` silently drops updates against
 * unknown ids, so a call before `installContextMenu` finishes is
 * harmless.
 */
export async function refreshPinAskTargetMenu(): Promise<void> {
  // Default to the Set wording (state 3); the Unset branch below
  // flips it for state 1.
  let title = PIN_ASK_TARGET_SET_TITLE;
  let enabled = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id !== undefined) {
      const pin = await getAskPin();
      if (pin && pin.tabId === tab.id) {
        // State 1: this tab is the pin. Always offer Unpin.
        title = PIN_ASK_TARGET_UNSET_TITLE;
        enabled = true;
      } else if (await findProviderForTab(tab.id, tab.url ?? '')) {
        // State 2: not the pin but a valid target — offer Pin.
        enabled = true;
      }
      // State 3: defaults already match (Pin, disabled).
    }
  } catch {
    // Permission errors / restricted URLs leave the entry disabled
    // with the Pin wording — same effect as "no eligible tab".
  }
  try {
    await chrome.contextMenus.update(PIN_ASK_TARGET_MENU_ID, { title, enabled });
  } catch {
    // The entry might not exist yet (e.g. refresh fired before
    // install finished). Subsequent refreshes will pick it up.
  }
}
