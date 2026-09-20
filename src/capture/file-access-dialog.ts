// The "file access required" dialog every extension page opens when
// Chrome's "Allow access to file URLs" toggle is off.
//
// Built here rather than as markup in each page so the Capture page
// (and its `?error=` state) and the History page show one dialog and
// can't drift. Styles live in `shared-styles.css`.
//
// No OK / Cancel: the user either closes the tab or goes to the
// settings page and flips the toggle — and flipping it restarts the
// extension, which closes this page anyway. Esc is swallowed for the
// same reason: with the toggle off there is nothing usable behind the
// dialog, so dismissing it would only strand the user on a page whose
// actions fail.

import { canReadFiles } from './downloads.js';
import { wireFileAccessLink } from './file-access.js';

/** The dialog's element id — what tests and a repeat `show` look up. */
export const FILE_ACCESS_DIALOG_ID = 'file-access-dialog';

/**
 * Open the dialog if file reads are off. Safe to call more than once;
 * a second call while it's open is a no-op.
 *
 * Callers should wait until the page is visible before calling: a
 * modal opened over a `visibility: hidden` body is invisible but
 * still traps clicks and Esc.
 */
export async function showFileAccessDialogIfBlocked(): Promise<void> {
  if (await canReadFiles()) return;
  showFileAccessDialog();
}

/** Open the dialog unconditionally (the check is the caller's). */
export function showFileAccessDialog(): void {
  let dialog = document.getElementById(FILE_ACCESS_DIALOG_ID) as HTMLDialogElement | null;
  if (!dialog) {
    dialog = buildDialog();
    document.body.appendChild(dialog);
  }
  if (!dialog.open) dialog.showModal();
}

function buildDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.id = FILE_ACCESS_DIALOG_ID;
  dialog.className = 'file-access-dialog';
  dialog.setAttribute('aria-labelledby', 'file-access-title');
  dialog.innerHTML = `
    <h2 id="file-access-title">SeeWhatISee requires access to read file URLs</h2>
    <p class="file-access-step">
      Open
      <a id="file-access-settings" class="btn" href="">Extension settings</a>
      and enable <b>Allow access to file URLs</b>.
    </p>
    <p class="file-access-note">
      Changing settings restarts the extension, which closes this
      page.
    </p>
    <hr>
    <h3>Explanation</h3>
    <ul>
      <li>This setting enables read-only access to file URLs.</li>
      <li>SeeWhatISee uses this so it can read its own log
        (<code>log.json</code>) and append capture records.</li>
      <li>The History page needs file access to show previous
        screenshots and captured files.</li>
      <li>Files are written only using Chrome downloads (into
        <code>Downloads/SeeWhatISee</code>).</li>
    </ul>
  `;
  wireFileAccessLink(dialog.querySelector('#file-access-settings') as HTMLAnchorElement);
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  return dialog;
}
