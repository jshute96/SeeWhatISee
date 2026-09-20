// The extension's one hard requirement on the user: Chrome's
// per-extension "Allow access to file URLs" toggle.
//
// It grants read-only `fetch('file://…')`, and it is how the capture
// log on disk gets to be the log: without it `log.json` can't be read
// back before it is appended to, and the History page can't show the
// files it lists. The toggle is off by default for a Web Store install
// and can't be requested through the permissions API, so the user has
// to flip it by hand — which is what the dialog in
// `file-access-dialog.ts` walks them through.
//
// Every entry point checks before doing any work (`requireFileAccess`
// in the service worker, the dialog on the extension pages), so the
// rest of the code can assume reads are available.

import { canReadFiles } from './downloads.js';

/** What the error page says when the toggle is off. */
export const FILE_ACCESS_REQUIRED_MESSAGE =
  'SeeWhatISee needs "Allow access to file URLs" turned on in its extension settings.';

/**
 * Thrown by `requireFileAccess` when the toggle is off. Reported as a
 * plain capture failure: the error page it opens checks the toggle
 * itself and puts up the explanatory dialog, so nothing else needs
 * to ride on the error.
 */
export class FileAccessRequiredError extends Error {
  constructor() {
    super(FILE_ACCESS_REQUIRED_MESSAGE);
    this.name = 'FileAccessRequiredError';
  }
}

/** Throw `FileAccessRequiredError` unless file reads are allowed. */
export async function requireFileAccess(): Promise<void> {
  if (!(await canReadFiles())) throw new FileAccessRequiredError();
}

/** The extension's own details page — the toggle's home. */
export function fileAccessUrl(): string {
  return `chrome://extensions/?id=${chrome.runtime.id}`;
}

/**
 * Open the extension's details page, where the toggle lives. Chrome
 * refuses a page-initiated navigation to `chrome://`, so a link's
 * `href` is only good for hover and copy-link — the actual open has
 * to go through `chrome.tabs.create`.
 *
 * Opened in the foreground by default: the user is going there to
 * flip the toggle, and a tab that opens behind the page looks like
 * nothing happened. `active: false` is for the gestures that expect
 * a background tab (middle-click, ctrl/⌘-click).
 */
export function openFileAccessSettings(active = true): void {
  void chrome.tabs.create({ url: fileAccessUrl(), active });
}

/**
 * Turn an anchor into the "Extension settings" link: a real `href`
 * so hover and copy-link work, with the navigation intercepted (see
 * `openFileAccessSettings`).
 *
 * `click` alone isn't enough. Looking like a real link invites the
 * gestures people use on real links, and the ones that skip `click`
 * would fall through to the blocked `chrome://` href and silently do
 * nothing: middle-click fires `auxclick`, and ctrl/⌘-click expects a
 * *background* tab. Enter/Space do fire `click`, so keyboard is
 * covered by the first handler.
 */
export function wireFileAccessLink(link: HTMLAnchorElement): void {
  link.href = fileAccessUrl();
  link.addEventListener('click', (e) => {
    e.preventDefault();
    openFileAccessSettings(!(e.ctrlKey || e.metaKey));
  });
  link.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    openFileAccessSettings(false);
  });
}
