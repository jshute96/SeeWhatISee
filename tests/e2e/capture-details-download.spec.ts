// E2E coverage for the "Save as…" download buttons on the capture
// page (per-row Save icons + the in-dialog Download button on the
// Edit dialogs).
//
// These buttons call `chrome.downloads.download({ saveAs: true })`
// directly from the Capture page. The native save dialog can't be
// driven from Playwright, so each test installs the page-side
// download spy from `details-helpers` to stub the call and record
// the requested filename, the `saveAs` flag, and the bytes the
// browser would have written.
//
// Three things we want to lock in:
//   1. Every Save button opens the dialog with the right default
//      filename (and the right MIME on the bytes).
//   2. A per-row Save reflects the *committed* edit state — once
//      the user has clicked Save in an Edit dialog, the new body
//      flows into the row's Save-as bytes.
//   3. The in-dialog Download button exports the *current editor
//      source* (un-Saved edits included). Cancelling the Edit
//      dialog discards those edits — they don't appear in either
//      a subsequent Copy-filename pre-download or the final
//      Capture-time write.

import fs from 'node:fs';
import { test, expect } from '../fixtures/extension';
import {
  configureAndCapture,
  findCapturedDownload,
  installClipboardSpy,
  installPageDownloadSpy,
  openDetailsFlow,
  readPageDownloads,
  seedSelection,
  setEditorCode,
  waitForClipboardWrites,
  waitForPageDownloads,
} from './details-helpers';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Each test in this file issues one capture via the Capture page flow;
// without a small cushion the suite occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

test('details: per-row Save buttons trigger saveAs dialog with correct default filenames', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Seed a selection on the opener so all three selection-format
  // rows enable (master + radios + per-row Save buttons).
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    undefined,
    seedSelection,
  );
  await installPageDownloadSpy(capturePage);

  await capturePage.locator('#download-screenshot-btn').click();
  await capturePage.locator('#download-html-btn').click();
  await capturePage.locator('#download-selection-html-btn').click();
  await capturePage.locator('#download-selection-text-btn').click();
  await capturePage.locator('#download-selection-markdown-btn').click();
  await waitForPageDownloads(capturePage, 5);

  const dls = await readPageDownloads(capturePage);
  expect(dls).toHaveLength(5);

  // Every call requested a save dialog.
  for (const d of dls) expect(d.saveAs).toBe(true);

  expect(dls[0].filename).toBe('screenshot.png');
  expect(dls[0].mime).toMatch(/^image\/png/);

  expect(dls[1].filename).toBe('contents.html');
  expect(dls[1].mime).toMatch(/^text\/html/);

  expect(dls[2].filename).toBe('selection.html');
  expect(dls[2].mime).toMatch(/^text\/html/);

  expect(dls[3].filename).toBe('selection.txt');
  expect(dls[3].mime).toMatch(/^text\/plain/);

  expect(dls[4].filename).toBe('selection.md');
  expect(dls[4].mime).toMatch(/^text\/markdown/);

  // Selection bodies are non-empty and end with a newline (the
  // page appends one before saving when the body doesn't already
  // have one).
  for (const d of dls.slice(2)) {
    expect(d.bytes.length).toBeGreaterThan(0);
    expect(d.bytes.endsWith('\n')).toBe(true);
  }

  await openerPage.close();
});

test('details: Save HTML reflects committed Edit-dialog edits', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installPageDownloadSpy(capturePage);

  // Save-as before any edit: should hold the original captured HTML.
  await capturePage.locator('#download-html-btn').click();
  await waitForPageDownloads(capturePage, 1);
  const before = (await readPageDownloads(capturePage))[0]!;
  expect(before.filename).toBe('contents.html');
  expect(before.bytes).not.toContain('committed-edit');

  // Open Edit HTML dialog, replace body, click Save → SW commits.
  await capturePage.locator('#edit-html').click();
  await setEditorCode(
    capturePage.locator('#edit-html-textarea'),
    '<p>committed-edit</p>',
  );
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toBeHidden();

  // Save-as now: bytes reflect the committed edit.
  await capturePage.locator('#download-html-btn').click();
  await waitForPageDownloads(capturePage, 2);
  const after = (await readPageDownloads(capturePage))[1]!;
  expect(after.filename).toBe('contents.html');
  expect(after.bytes).toBe('<p>committed-edit</p>\n');

  await openerPage.close();
});

test('details: in-dialog Download exports uncommitted edits; Cancel discards them', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installPageDownloadSpy(capturePage);
  await installClipboardSpy(capturePage);

  // Open Edit HTML dialog and read the original captured body — we
  // need it to assert the post-Cancel state matches "no edits".
  await capturePage.locator('#edit-html').click();
  const editor = capturePage.locator('#edit-html-textarea');
  const originalSource = (await editor.textContent()) ?? '';
  expect(originalSource.length).toBeGreaterThan(0);

  // Type new content but don't click Save.
  await setEditorCode(editor, '<p>uncommitted-experiment</p>');

  // The in-dialog Download exports what's in the editor right now,
  // including the un-Saved edit.
  await capturePage.locator('#edit-html-download').click();
  await waitForPageDownloads(capturePage, 1);
  const inDialog = (await readPageDownloads(capturePage))[0]!;
  expect(inDialog.filename).toBe('contents.html');
  expect(inDialog.saveAs).toBe(true);
  expect(inDialog.bytes).toBe('<p>uncommitted-experiment</p>\n');

  // Cancel the dialog — the edit must NOT be committed back to the
  // SW's authoritative copy.
  await capturePage.locator('#edit-html-cancel').click();
  await expect(capturePage.locator('#edit-html-dialog')).toBeHidden();

  // 1) Per-row Save-as after Cancel: bytes are the original.
  await capturePage.locator('#download-html-btn').click();
  await waitForPageDownloads(capturePage, 2);
  const postCancelSaveAs = (await readPageDownloads(capturePage))[1]!;
  expect(postCancelSaveAs.bytes).not.toContain('uncommitted-experiment');
  expect(postCancelSaveAs.bytes).toContain(originalSource);

  // 2) Copy-filename after Cancel: SW pre-downloads the original.
  //    The Copy click awaits the SW round-trip + file write, then
  //    writes the path to the clipboard, so the clipboard write is
  //    the "file is on disk" barrier.
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 1);

  const sw = await getServiceWorker();
  const copyPath = await findCapturedDownload(sw, '.html');
  const copyContents = fs.readFileSync(copyPath, 'utf8');
  expect(copyContents).not.toContain('uncommitted-experiment');
  expect(copyContents).toContain(originalSource);

  // 3) Capture-time write after Cancel: same final HTML.
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
  });
  const finalPath = await findCapturedDownload(sw, '.html');
  const finalContents = fs.readFileSync(finalPath, 'utf8');
  expect(finalContents).not.toContain('uncommitted-experiment');
  expect(finalContents).toContain(originalSource);

  // configureAndCapture closes the capturePage; opener remains.
  await openerPage.close();
});
