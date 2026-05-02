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
    'https://claude.ai/recents*',
  ],
  newTabUrl: 'https://claude.ai/new',
  enabled: true,
  // Claude Code (`claude.ai/code`) shares the host but its composer
  // is image-only and requires repo-selection setup, so we don't
  // offer a "New window in" entry for it. Existing /code tabs still
  // surface in the Ask menu under Claude — the page title
  // ("Claude Code") already disambiguates the row from regular
  // Claude conversations, so no extra marking is needed.
  // HTML / selection attachments are blocked by the Capture page's
  // pre-send guard before they reach the SW.
  urlVariants: [
    {
      pattern: 'https://claude.ai/code*',
      label: 'Claude Code',
      acceptedAttachmentKinds: ['image'],
    },
  ],
  selectors: {
    fileInput: [
      'input[data-testid="file-upload"]',
      // Claude Code's input is hidden and has no testid; the accept
      // attribute enumerates image MIME types.
      'input[type="file"][accept*="image/"]',
      'input[type="file"]',
    ],
    textInput: [
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][data-testid]',
      'div[contenteditable="true"]',
    ],
    // Claude uses `aria-label="Send Message"`; Claude Code uses just
    // `aria-label="Send"`. Both are listed first so we never fall
    // through to the loose substring matcher and accidentally click
    // an unrelated chrome button like "More options for Sending…".
    submitButton: [
      'button[aria-label="Send"]',
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[aria-label^="Send" i]',
    ],
  },
};
