// Claude-specific adapter for the Ask flow. Selectors are based on
// what claude.ai exposes in its prompt composer:
//   - A hidden file <input> the file-attach button drives.
//   - A ProseMirror contenteditable for the prompt body.
//   - A Send button that's disabled while uploads are in flight.
//
// Each selector list is ordered most-specific → most-general so a
// stable test id wins over a generic role match. Adding a new
// selector here is the lightest-touch fix when Claude renames a DOM
// hook.

import type { AskProvider } from './providers.js';

export const claudeProvider: AskProvider = {
  id: 'claude',
  label: 'Claude',
  urlPatterns: ['https://claude.ai/*'],
  // Pages on claude.ai that aren't a valid chat target. Patterns use
  // `*` wildcards; trailing `*` covers both the bare path and any
  // sub-paths (e.g. `/settings` and `/settings/profile`).
  excludeUrlPatterns: [
    'https://claude.ai/settings*',
    'https://claude.ai/projects*',
    'https://claude.ai/customize*',
    'https://claude.ai/design*',
    'https://claude.ai/downloads*',
  ],
  newTabUrl: 'https://claude.ai/new',
  enabled: true,
  selectors: {
    fileInput: [
      'input[data-testid="file-upload"]',
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ],
    textInput: [
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][data-testid]',
      'div[contenteditable="true"]',
    ],
    submitButton: [
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="send" i]',
    ],
  },
};
