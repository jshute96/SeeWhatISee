// Capture functions. Each one corresponds to a user-visible action (toolbar
// click, future context-menu items, etc.) and is responsible for both
// grabbing the image and writing it to the standard download directory.

const DOWNLOAD_SUBDIR = 'SeeWhatISee';

export interface CaptureResult {
  downloadId: number;
  filename: string;
}

/**
 * Capture the currently visible region of the given window's active tab.
 * If `windowId` is omitted, the current window is used.
 */
export async function captureVisible(windowId?: number): Promise<CaptureResult> {
  const dataUrl = await chrome.tabs.captureVisibleTab(
    windowId ?? chrome.windows.WINDOW_ID_CURRENT,
    { format: 'png' },
  );
  return saveDataUrl(dataUrl);
}

async function saveDataUrl(dataUrl: string): Promise<CaptureResult> {
  const filename = `${DOWNLOAD_SUBDIR}/screenshot-${timestamp()}.png`;
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
  });
  return { downloadId, filename };
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
