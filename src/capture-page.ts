// Controller script for the capture.html extension page.
//
// Flow:
//   1. background.ts captures a screenshot + page HTML into
//      chrome.storage.session (keyed by the new tab id), then opens
//      capture.html in that tab.
//   2. On load we ask background for our pre-captured data via a
//      runtime message. background reads it from session storage and
//      sends it back; we show the screenshot.
//   3. User picks which artifacts to save (checkboxes), types an
//      optional prompt, and clicks Capture. We send the options back
//      to background, which runs saveDetailedCapture and closes the
//      tab once the files are on disk.
//
// Must live in a separate .js file (not inline in capture.html)
// because the default extension-page CSP forbids inline scripts.

interface DetailsData {
  screenshotDataUrl: string;
  html: string;
  url: string;
}

const screenshotBox = document.getElementById('cap-screenshot') as HTMLInputElement;
const htmlBox = document.getElementById('cap-html') as HTMLInputElement;
const captureBtn = document.getElementById('capture') as HTMLButtonElement;
const promptInput = document.getElementById('prompt-text') as HTMLInputElement;
const previewImg = document.getElementById('preview') as HTMLImageElement;

function updateCaptureState(): void {
  captureBtn.disabled = !screenshotBox.checked && !htmlBox.checked;
}

screenshotBox.addEventListener('change', updateCaptureState);
htmlBox.addEventListener('change', updateCaptureState);
updateCaptureState();

promptInput.focus();

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !captureBtn.disabled) {
    e.preventDefault();
    captureBtn.click();
  }
});

document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 's') {
    e.preventDefault();
    screenshotBox.checked = !screenshotBox.checked;
    updateCaptureState();
  } else if (key === 'h') {
    e.preventDefault();
    htmlBox.checked = !htmlBox.checked;
    updateCaptureState();
  }
});

async function loadData(): Promise<void> {
  const response: DetailsData | undefined = await chrome.runtime.sendMessage({
    action: 'getDetailsData',
  });
  if (!response) return;
  previewImg.src = response.screenshotDataUrl;
}

captureBtn.addEventListener('click', () => {
  // Disable the button so double-clicks can't re-submit. The
  // background handler returns false from the onMessage listener
  // (no response expected), so `sendMessage` would resolve with
  // `undefined` as soon as the message is dispatched — *not* when
  // the save completes. We fire-and-forget instead of awaiting so
  // it's obvious that nothing here is waiting on the save; the
  // background closes this tab itself when saveDetailedCapture
  // resolves (or fails and the finally block fires).
  captureBtn.disabled = true;
  void chrome.runtime.sendMessage({
    action: 'saveDetails',
    screenshot: screenshotBox.checked,
    html: htmlBox.checked,
    prompt: promptInput.value.trim(),
  });
});

void loadData();
