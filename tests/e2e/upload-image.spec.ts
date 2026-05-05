import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/extension';
import {
  findCapturedDownload,
  installClipboardSpy,
  readClipboardSpy,
  readLatestRecord,
  waitForClipboardWrites,
} from './details-helpers';
import { type CaptureRecord } from '../fixtures/files';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../fixtures/pages');

function isPngFile(filePath: string): boolean {
  const buffer = fs.readFileSync(filePath);
  return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
}

function isJpgFile(filePath: string): boolean {
  const buffer = fs.readFileSync(filePath);
  return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
}
const RED_PNG = path.join(FIXTURES_DIR, 'red-pixel.png');
const RED_JPG = path.join(FIXTURES_DIR, 'red-pixel.jpg');
const TEXT_HTML = path.join(FIXTURES_DIR, 'purple.html');

test.beforeEach(async ({ getServiceWorker }) => {
  await new Promise((r) => setTimeout(r, 600));
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    
    interface SpyState { __seeDl?: { id: number; name: string }[]; __seeDlOrig?: typeof chrome.downloads.download }
    const g = self as unknown as SpyState;
    g.__seeDl = [];
    if (!g.__seeDlOrig) {
      g.__seeDlOrig = chrome.downloads.download.bind(chrome.downloads);
      (chrome.downloads as { download: typeof chrome.downloads.download }).download =
        (async (opts: chrome.downloads.DownloadOptions) => {
          const id = await g.__seeDlOrig!(opts);
          if (typeof id === 'number') g.__seeDl!.push({ id, name: opts.filename ?? '' });
          return id;
        }) as typeof chrome.downloads.download;
    }
  });
});

test('upload: direct load ?upload=true shows upload landing and triggers file picker click', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  // Verify upload landing is visible
  const landing = page.locator('#upload-landing');
  await expect(landing).toBeVisible();

  // Verify main content is hidden
  const mainBlocks = page.locator('[data-capture-main]');
  const count = await mainBlocks.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(mainBlocks.nth(i)).toBeHidden();
  }

  // Verify file input is present
  const fileInput = page.locator('#upload-file-input');
  await expect(fileInput).not.toBeVisible(); // It is display: none

  await page.close();
});

test('upload: selecting non-image triggers validation alert', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  // Listen for alert dialog
  let alertTriggered = false;
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toBe('Uploaded file is not in a supported image format');
    alertTriggered = true;
    await dialog.accept();
  });

  // Upload HTML file
  await page.locator('#upload-file-input').setInputFiles(TEXT_HTML);

  // Wait for dialog handler to finish
  await page.waitForTimeout(500);
  expect(alertTriggered).toBe(true);

  // Verify landing is still visible
  await expect(page.locator('#upload-landing')).toBeVisible();

  await page.close();
});

test('upload: PNG upload without edits saves as PNG with file: URL', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  // Upload valid PNG image
  await page.locator('#upload-file-input').setInputFiles(RED_PNG);

  // Verify transition to normal capture page
  await expect(page.locator('#upload-landing')).toBeHidden();
  await expect(page.locator('#preview')).toBeVisible();
  await expect(page.locator('#captured-title')).toHaveText('red-pixel.png');
  
  // HTML Save should be disabled (unavailable)
  await expect(page.locator('#cap-html')).toBeDisabled();
  await expect(page.locator('#cap-html')).not.toBeChecked();

  // Click Capture (default closeAfter is true)
  await Promise.all([
    page.waitForEvent('close'),
    page.locator('#capture').click(),
  ]);

  // Read record from sidecar
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(record.url).toBe('file:red-pixel.png');
  expect(record.title).toBe('red-pixel.png');
  expect(record.contents).toBeUndefined();

  // File should exist
  const pngPath = await findCapturedDownload(sw, '.png');
  expect(fs.statSync(pngPath).size).toBeGreaterThan(0);
});

test('upload: JPG upload without edits saves as JPG with file: URL', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  // Upload valid JPG image
  await page.locator('#upload-file-input').setInputFiles(RED_JPG);

  // Verify transition
  await expect(page.locator('#upload-landing')).toBeHidden();
  await expect(page.locator('#preview')).toBeVisible();
  await expect(page.locator('#captured-title')).toHaveText('red-pixel.jpg');

  // Click Capture
  await Promise.all([
    page.waitForEvent('close'),
    page.locator('#capture').click(),
  ]);

  // Read record from sidecar
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.jpg$/);
  expect(record.url).toBe('file:red-pixel.jpg');
  expect(record.title).toBe('red-pixel.jpg');
  expect(record.contents).toBeUndefined();

  // JPG file should exist
  const jpgPath = await findCapturedDownload(sw, '.jpg');
  expect(fs.statSync(jpgPath).size).toBeGreaterThan(0);
});

test('upload: JPG upload with edits converts and saves as PNG but retains original JPG file: URL', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  // Upload valid JPG image
  await page.locator('#upload-file-input').setInputFiles(RED_JPG);

  // Verify transition
  await expect(page.locator('#upload-landing')).toBeHidden();
  await expect(page.locator('#preview')).toBeVisible();

  // Wait for preview overlay coordinates to settle
  await page.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  // Add an edit: Draw a box to trigger canvas bake (which always outputs PNG)
  const overlay = page.locator('#overlay');
  const box = await overlay.boundingBox();
  expect(box).not.toBeNull();
  
  // Drag inside overlay (30% to 70% of dimensions)
  const x1 = box!.x + box!.width * 0.3;
  const y1 = box!.y + box!.height * 0.3;
  const x2 = box!.x + box!.width * 0.7;
  const y2 = box!.y + box!.height * 0.7;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1+x2)/2, (y1+y2)/2);
  await page.mouse.move(x2, y2);
  await page.mouse.up();

  // Click Capture
  await Promise.all([
    page.waitForEvent('close'),
    page.locator('#capture').click(),
  ]);

  // Read record from sidecar
  const record = await readLatestRecord(sw);
  // Saved screenshot must be .png because of highlight bake
  expect(record.screenshot?.filename).toMatch(/^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
  expect(record.screenshot?.hasHighlights).toBe(true);
  // original url must stay .jpg
  expect(record.url).toBe('file:red-pixel.jpg');
  expect(record.title).toBe('red-pixel.jpg');
  expect(record.contents).toBeUndefined();

  // PNG file should exist on disk
  const pngPath = await findCapturedDownload(sw, '.png');
  expect(fs.statSync(pngPath).size).toBeGreaterThan(0);
});

test('upload: comprehensive JPG/PNG extension switching and multi-capture bump copy lifecycle', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  const sw = await getServiceWorker();

  await page.goto(`chrome-extension://${extensionId}/capture.html?upload=true`);

  // 1. Upload valid JPG image
  await page.locator('#upload-file-input').setInputFiles(RED_JPG);
  await expect(page.locator('#upload-landing')).toBeHidden();
  await expect(page.locator('#preview')).toBeVisible();

  // Wait for preview overlay coordinates to settle
  await page.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  // Setup clipboard spy
  await installClipboardSpy(sw);

  // 2. Copy (expect JPG)
  await page.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(sw, 1);
  let clipboard = await readClipboardSpy(sw);
  let path = clipboard[clipboard.length - 1];
  expect(fs.existsSync(path)).toBe(true);
  expect(isJpgFile(path)).toBe(true);

  // 3. Draw a highlight box
  const overlay = page.locator('#overlay');
  const box = await overlay.boundingBox();
  expect(box).not.toBeNull();
  const x1 = box!.x + box!.width * 0.3;
  const y1 = box!.y + box!.height * 0.3;
  const x2 = box!.x + box!.width * 0.7;
  const y2 = box!.y + box!.height * 0.7;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1+x2)/2, (y1+y2)/2);
  await page.mouse.move(x2, y2);
  await page.mouse.up();

  // 4. Copy again (expect PNG due to highlights)
  await page.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(sw, 2);
  clipboard = await readClipboardSpy(sw);
  path = clipboard[clipboard.length - 1];
  expect(fs.existsSync(path)).toBe(true);
  expect(isPngFile(path)).toBe(true);

  // 5. Clear edits
  await page.locator('#clear').click();
  
  // 6. Copy again (expect reverted to JPG)
  await page.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(sw, 3);
  clipboard = await readClipboardSpy(sw);
  path = clipboard[clipboard.length - 1];
  expect(fs.existsSync(path)).toBe(true);
  expect(isJpgFile(path)).toBe(true);

  // 7. Capture (Save current JPG, lock is created)
  // Shift-click to keep Capture page open
  await page.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(page.locator('#ask-status')).toHaveText('Saved.', { timeout: 10_000 });

  // 8. Draw a highlight box again
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1+x2)/2, (y1+y2)/2);
  await page.mouse.move(x2, y2);
  await page.mouse.up();

  // 9. Copy (expect PNG with -1 bump)
  await page.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(sw, 4);
  clipboard = await readClipboardSpy(sw);
  path = clipboard[clipboard.length - 1];
  expect(fs.existsSync(path)).toBe(true);
  expect(isPngFile(path)).toBe(true);

  // 10. Clear edits
  await page.locator('#clear').click();

  // 11. Copy again (expect reverted to JPG with -1 bump)
  await page.locator('#copy-screenshot-name').click();
  await waitForClipboardWrites(sw, 5);
  clipboard = await readClipboardSpy(sw);
  path = clipboard[clipboard.length - 1];
  expect(fs.existsSync(path)).toBe(true);
  expect(isJpgFile(path)).toBe(true);

  await page.close();
});

