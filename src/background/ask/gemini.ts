// Gemini-specific adapter for the Ask flow. Selectors target the
// Gemini web UI on gemini.google.com:
//   - A hidden file <input> behind the "+" attach button.
//   - A Quill (`.ql-editor`) contenteditable for the prompt body.
//   - A "Send" mat-icon-button that's disabled while uploads / model
//     state are still resolving.
//
// Like the Claude adapter, each list is ordered most-specific →
// most-general. The runtime in `src/ask-inject.ts` is selector-driven
// and unchanged across providers — only this data file differs.

import type { AskProvider } from './providers.js';

export const geminiProvider: AskProvider = {
  id: 'gemini',
  label: 'Gemini',
  urlPatterns: ['https://gemini.google.com/*'],
  // Pages on gemini.google.com that aren't a valid chat target.
  // Same `*`-glob grammar as Claude's excludes (see jsdoc on
  // AskProvider.excludeUrlPatterns).
  excludeUrlPatterns: [
    'https://gemini.google.com/gem*',
    'https://gemini.google.com/saved-info*',
    'https://gemini.google.com/settings*',
  ],
  newTabUrl: 'https://gemini.google.com/app',
  iconFilename: 'gemini.svg',
  enabled: true,
  selectors: {
    // Gemini doesn't put a file input in the page until the user
    // opens its upload menu and picks "Upload files". We click those
    // two buttons ourselves; the runtime patches `input.click()` to
    // a no-op for the duration so the OS picker doesn't surface.
    preFileInputClicks: [
      // Matches different versions of the labels we've seen.
      'button[aria-label="Open upload file menu"], button[aria-label^="Open input area menu"], button[aria-label="Upload & tools"], button[aria-label="Upload and tools"]',
      // Matches old "Upload files" (starts with) and new alternative "Files" labels (exact).
      'button[aria-label="Files"], button[aria-label^="Upload files"]',
    ],
    fileInput: [
      // The dynamically-created input has `name="Filedata"`; the
      // generic fallback covers a future rename.
      'input[type="file"][name="Filedata"]',
      'input[type="file"][multiple]',
      'input[type="file"]',
    ],
    textInput: [
      'div.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][aria-label]',
    ],
    submitButton: [
      'button.send-button',
      'button[aria-label="Send message"]',
      'button[mat-icon-button][aria-label*="send" i]',
      'button[aria-label*="send" i]',
    ],
  },
};
