// ChatGPT-specific adapter for the Ask flow. Selectors target the
// chatgpt.com web UI:
//   - A hidden multi-file <input id="upload-files"> attached to the
//     composer's "Add files" menu but already present in the initial
//     DOM, so we can skip a preFileInputClicks chain.
//   - A ProseMirror contenteditable for the prompt body — same engine
//     Claude uses, so the existing typing pipeline is unchanged.
//   - A Send button with a stable data-testid.
//
// Each list is ordered most-specific → most-general. The runtime in
// `src/ask-inject.ts` is selector-driven and unchanged across
// providers — only this data file differs.

import type { AskProvider } from './providers.js';

export const chatgptProvider: AskProvider = {
  id: 'chatgpt',
  label: 'ChatGPT',
  urlPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  // Pages on chatgpt.com that aren't a valid chat target. Same `*`-glob
  // grammar as the other adapters (see jsdoc on
  // AskProvider.excludeUrlPatterns).
  excludeUrlPatterns: [
    // Index of custom GPTs ("Explore GPTs"). Individual GPT pages
    // under `/g/<id>/...` ARE valid chat targets — don't exclude
    // those.
    'https://chatgpt.com/gpts*',
    'https://chatgpt.com/library*',
    'https://chatgpt.com/settings*',
    'https://chatgpt.com/pricing*',
    // Read-only public share viewer; no composer.
    'https://chatgpt.com/share/*',
  ],
  newTabUrl: 'https://chatgpt.com/',
  enabled: true,
  selectors: {
    fileInput: [
      // The "Add photos & files" entry in the plus-button menu drives
      // this input; it's already in the DOM at first paint, hidden
      // inside a `.hidden` wrapper.
      'input#upload-files',
      // Generic fallbacks for ID renames; both filter out the
      // image-only `#upload-photos` / `#upload-camera` inputs that
      // sit alongside `#upload-files`.
      'input[type="file"][multiple]:not([accept="image/*"])',
      'input[type="file"]:not([accept="image/*"])',
    ],
    textInput: [
      'div#prompt-textarea[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ],
    submitButton: [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-submit-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="send" i]',
    ],
    // Verifies each attached file showed up as a chip after the
    // settle. Without this, a logged-out ChatGPT silently rejects
    // non-image uploads with a toast and we falsely report Sent.
    // Single canonical wrapper, one match per attachment — the same
    // selector the live test uses (`tests/e2e-live/chatgpt.live.spec.ts`).
    // Listing only the wrapper avoids double-counting (a chip also
    // contains a Remove button, an inner thumb, etc.) which would
    // mask partial-reject scenarios.
    attachmentPreview: ['div[class*="group/file-tile"]'],
  },
};
