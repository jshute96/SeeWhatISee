// MV3 service worker entrypoint. Wires Chrome event listeners
// (action click, commands, install/startup, storage, contextMenus)
// to the implementation modules under `src/background/`, and exposes
// the `self.SeeWhatISee` test-harness surface. Substantive logic
// lives in the sub-modules — this file stays thin on purpose.

import {
  captureBothToMemory,
  captureSelection,
  captureVisible,
  clearCaptureLog,
  downloadHtml,
  downloadScreenshot,
  downloadSelection,
  LOG_STORAGE_KEY,
  recordDetailedCapture,
  savePageContents,
} from './capture.js';
import {
  clearCaptureError,
  installUnhandledRejectionHandler,
  reportCaptureError,
  runWithErrorReporting,
} from './background/error-reporting.js';
import {
  captureAll,
  captureUrlOnly,
  saveDefaults,
} from './background/capture-actions.js';
import {
  findCaptureAction,
  getDefaultDblWithSelectionId,
  getDefaultDblWithoutSelectionId,
  getDefaultWithSelectionId,
  getDefaultWithoutSelectionId,
  handleActionClick,
  runDblDefault,
  setDefaultDblWithSelectionId,
  setDefaultDblWithoutSelectionId,
  setDefaultWithSelectionId,
  setDefaultWithoutSelectionId,
} from './background/default-action.js';
import {
  CLEAR_LOG_MENU_ID,
  COMMAND_PREFIX_PATTERN,
  COPY_LAST_HTML_MENU_ID,
  COPY_LAST_SCREENSHOT_MENU_ID,
  COPY_LAST_SELECTION_MENU_ID,
  SNAPSHOTS_DIR_MENU_ID,
  copyLastHtmlFilename,
  copyLastScreenshotFilename,
  copyLastSelectionFilename,
  installContextMenu,
  openSnapshotsDirectory,
  refreshActionTooltip,
  refreshCopyMenuState,
  refreshMenusIfHotkeysChanged,
} from './background/context-menu.js';
import {
  ensureHtmlDownloaded,
  ensureScreenshotDownloaded,
  ensureSelectionDownloaded,
  installDetailsMessageHandlers,
  startCaptureWithDetails,
} from './background/capture-details.js';
import { installOptionsMessageHandlers } from './background/options.js';

// Install side-effect listeners that were previously declared at
// module top level. Each module exposes an explicit `install*`
// function so load-order coupling is visible here rather than
// buried in imports.
installUnhandledRejectionHandler();
installDetailsMessageHandlers();
installOptionsMessageHandlers();

chrome.action.onClicked.addListener(() => {
  // Fire-and-forget refresh so any hotkey edit since our last
  // render propagates before the next menu open. The click itself
  // runs immediately on the current menu state — stale hints are
  // cosmetic, and the next right-click will show the fresh ones.
  void refreshMenusIfHotkeysChanged();
  void handleActionClick();
});

// Keyboard shortcuts declared in manifest.json's `commands` block.
// The `NN-` prefix is stripped here before dispatch so the rest of
// the code keeps using bare action ids. The stripped name matches a
// delay-0 CAPTURE_ACTIONS id (which equals its baseId), so the
// dispatch is a direct lookup — no separate command → action table.
//
// Each command routes through runWithErrorReporting so a failed
// active-tab lookup or restricted-URL scrape surfaces on the
// toolbar icon the same way a toolbar click would.
chrome.commands.onCommand.addListener((command) => {
  void refreshMenusIfHotkeysChanged();
  const actionId = command.replace(COMMAND_PREFIX_PATTERN, '');
  // Meta-command: run whatever the user has stored as their
  // double-click default. Selection-aware via the same probe
  // `handleActionClick` uses on its second-click branch.
  if (actionId === 'secondary-action') {
    void runWithErrorReporting(() => runDblDefault());
    return;
  }
  const action = findCaptureAction(actionId);
  if (!action) {
    console.warn('[SeeWhatISee] unhandled keyboard command:', command);
    return;
  }
  void runWithErrorReporting(() => action.run());
});

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first because onInstalled fires on `install`, `update`,
  // and `chrome_update`. On the update paths the previously-created
  // menu entries are still in Chrome's persisted extension state, and
  // calling `create` with the same id would throw "Cannot create item
  // with duplicate id". `removeAll` is a clean wipe that handles all
  // three cases identically.
  chrome.contextMenus.removeAll(() => {
    void installContextMenu();
  });
  // Also make sure the icon tooltip reflects the stored default
  // after an update — the old build may have written a title that's
  // no longer accurate.
  void refreshActionTooltip();
});

// Browser restart: onInstalled doesn't fire, but we still want the
// tooltip to match the stored preference. Chrome persists the
// `chrome.action.setTitle` value across restarts, so this is a
// belt-and-suspenders refresh in case anything has fallen out of
// sync (e.g. a storage write that raced the previous shutdown).
chrome.runtime.onStartup.addListener(() => {
  void refreshActionTooltip();
  void refreshCopyMenuState();
});

// React to capture-log changes so the Copy-last-… menu entries
// flip enabled state without explicit plumbing from capture.ts.
// Covers every code path that mutates the log: each capture's
// `appendToLog`, and `clearCaptureLog` (which removes the key).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LOG_STORAGE_KEY]) {
    void refreshCopyMenuState();
  }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  // Fire-and-forget refresh so any hotkey edit the user made since
  // our last render propagates to the menu before the next open.
  // Not awaited: the click itself shouldn't block on a menu-title
  // sweep.
  void refreshMenusIfHotkeysChanged();

  const id = String(info.menuItemId);

  // Top-level capture entry: run its action.
  const action = findCaptureAction(id);
  if (action) {
    await runWithErrorReporting(() => action.run());
    return;
  }

  // Clear history. Routed through runWithErrorReporting for
  // consistency with the capture paths: on success the error
  // state is cleared, and on failure the same icon/tooltip
  // channels tell the user something went wrong.
  if (id === CLEAR_LOG_MENU_ID) {
    await runWithErrorReporting(() => clearCaptureLog());
    return;
  }

  // Open the on-disk capture directory in a new tab. Same
  // error-reporting rationale as the Clear log path: the
  // "no captures yet" failure surfaces via the icon swap +
  // tooltip line so the user actually sees it.
  if (id === SNAPSHOTS_DIR_MENU_ID) {
    await runWithErrorReporting(() => openSnapshotsDirectory());
    return;
  }

  // Copy the latest screenshot / HTML filename to the clipboard. The
  // menu entries are greyed when the latest record doesn't carry the
  // matching field, so under normal operation these calls always have
  // something to copy.
  if (id === COPY_LAST_SCREENSHOT_MENU_ID) {
    await runWithErrorReporting(() => copyLastScreenshotFilename());
    return;
  }
  if (id === COPY_LAST_HTML_MENU_ID) {
    await runWithErrorReporting(() => copyLastHtmlFilename());
    return;
  }
  if (id === COPY_LAST_SELECTION_MENU_ID) {
    await runWithErrorReporting(() => copyLastSelectionFilename());
    return;
  }

  // Fallthrough: a click on a menu item we don't recognize.
  // Shouldn't happen in the current menu, but if a future
  // contextMenus.create call adds an id without a matching branch
  // above, this warning makes the drop visible in the SW console
  // instead of silently doing nothing.
  console.warn('[SeeWhatISee] unhandled context menu id:', id);
});

// Expose capture functions on the service worker global so they can be
// invoked from:
//   - Playwright tests via `serviceWorker.evaluate(() => self.SeeWhatISee.captureVisible())`
//   - the service worker devtools console for manual debugging
//
// Each future menu variation (full page, element, etc.) should be added here
// as a new entry so it stays callable from tests without additional plumbing.
(self as unknown as { SeeWhatISee: Record<string, unknown> }).SeeWhatISee = {
  captureVisible,
  savePageContents,
  captureBothToMemory,
  captureUrlOnly,
  captureAll,
  saveDefaults,
  captureSelection,
  downloadScreenshot,
  downloadHtml,
  downloadSelection,
  recordDetailedCapture,
  ensureScreenshotDownloaded,
  ensureHtmlDownloaded,
  ensureSelectionDownloaded,
  startCaptureWithDetails,
  clearCaptureLog,
  openSnapshotsDirectory,
  copyLastScreenshotFilename,
  copyLastHtmlFilename,
  copyLastSelectionFilename,
  reportCaptureError,
  clearCaptureError,
  runWithErrorReporting,
  handleActionClick,
  runDblDefault,
  getDefaultWithSelectionId,
  getDefaultWithoutSelectionId,
  getDefaultDblWithSelectionId,
  getDefaultDblWithoutSelectionId,
  setDefaultWithSelectionId,
  setDefaultWithoutSelectionId,
  setDefaultDblWithSelectionId,
  setDefaultDblWithoutSelectionId,
  refreshActionTooltip,
};
