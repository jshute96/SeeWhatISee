// Google-specific adapter for the Ask flow. Targets the google.com
// homepage:
//   - A hidden image-only file <input> already present in the initial
//     DOM (driven by the "+" composer's "Upload image" menu item).
//   - The main search `<textarea name="q">` for the prompt.
//   - The "Google Search" submit button (`input[name="btnK"]`).
//
// Marked `newTabOnly: true` because Google Search isn't a chat
// surface — submitting navigates to `/search?q=...` and reusing that
// tab would clobber prior results. Plain Ask always opens a fresh
// google.com tab. The Ask menu hides the "Existing window in Google"
// section, the toolbar Pin/Unpin entry doesn't engage on google.com
// tabs, and a successful Google send doesn't write `askPin`.
//
// Restricted to `acceptedAttachmentKinds: ['image']` because the file
// input only accepts `image/*`. HTML / selection attachments are
// blocked by the Capture page's pre-send guard before they reach
// the SW (same path Claude Code uses).

import type { AskProvider } from './providers.js';

export const googleProvider: AskProvider = {
  id: 'google',
  label: 'Google',
  // Limit to the bare google.com homepage. /search and friends don't
  // expose the same image-upload composer, so even though the user
  // could be on them, we wouldn't have anywhere to drop the image.
  // The provider is `newTabOnly` anyway, so we never actually query
  // existing tabs — these patterns only shape `findProviderForTab`,
  // which is itself short-circuited by `newTabOnly`. They're listed
  // for completeness in case the flag is ever relaxed.
  urlPatterns: ['https://www.google.com/'],
  newTabUrl: 'https://www.google.com/',
  enabled: true,
  newTabOnly: true,
  // Google's "Upload image" file input is `image/*` only; "Upload
  // file" accepts `application/pdf,image/*`. We don't generate PDFs,
  // and the wider input would silently drop HTML / selection too —
  // surface that up front via the same pre-send-refusal path Claude
  // Code uses.
  acceptedAttachmentKinds: ['image'],
  selectors: {
    // Both file inputs are already in the DOM at first paint (just
    // `hidden=""`), wired via Google's delegated `jsaction` so the
    // change event reaches its handlers without us opening the menu.
    // Prefer the image-only input since `acceptedAttachmentKinds`
    // already restricts the payload to images.
    fileInput: [
      'input[jsname="wcaWdc"]',
      'input[type="file"][accept^="image"]',
    ],
    // The visible search field is a single-line `<textarea>` (Google
    // styles a real textarea with `rows="1"`). `execCommand('insertText')`
    // works on textareas the same way it does on contenteditables, so
    // single-line prompts type cleanly. Multi-line prompts get
    // flattened: `insertParagraphBreak` uses `execCommand('insertParagraph')`
    // which is a no-op on textareas, so newlines between segments are
    // silently dropped. That matches Google Search semantics — a query
    // string can't carry newlines anyway — but it diverges from the
    // chat providers and is worth knowing if a future caller passes
    // structured prompts here.
    textInput: [
      'textarea#APjFqb',
      'textarea[name="q"]',
    ],
    // The page renders two submit inputs (one inside the visible form
    // and a duplicate that shows once the user starts typing). Both
    // share `name="btnK"`; the runtime's `findEnabledSubmit` picks
    // whichever is currently enabled.
    submitButton: [
      'input[name="btnK"][type="submit"]',
      'button[aria-label="Google Search"]',
    ],
  },
};
