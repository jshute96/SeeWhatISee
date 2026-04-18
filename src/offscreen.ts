// Offscreen document script — clipboard write target for the
// service worker. See `offscreen.html` for why this exists.
//
// The background SW posts `{ target: 'offscreen-copy', text }` via
// `chrome.runtime.sendMessage`; we copy the text and reply with
// `{ ok: true }` (or `{ ok: false, error }` on failure). The other
// onMessage listener (in background.ts) bails out for messages with
// no `sender.tab`, so they don't collide.
//
// We use a temporary <textarea> + `document.execCommand('copy')`
// rather than `navigator.clipboard.writeText()`. The async clipboard
// API requires the page to be focused; an offscreen document is
// never focused, so it would silently fail. The execCommand path
// works in any document context with a selection.

interface OffscreenCopyMessage {
  target: 'offscreen-copy';
  text: string;
}

function isCopyMessage(value: unknown): value is OffscreenCopyMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as { target?: unknown; text?: unknown };
  return m.target === 'offscreen-copy' && typeof m.text === 'string';
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isCopyMessage(msg)) return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = msg.text;
    // Off-screen positioning so the textarea doesn't briefly flash even
    // though the page itself is hidden — belt-and-suspenders for any
    // future use of this document with `display: ...` styling.
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    sendResponse({ ok });
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  // Synchronous response; no need to keep the channel open.
  return false;
});
