// Registry of AI web UIs we can post a capture to via the Ask flow.
//
// Each provider declares the URL patterns we use to find existing
// tabs (chrome.tabs.query), the URL to open for "New window in <X>",
// and the selectors the injected runtime will use to attach files,
// fill the prompt, and submit.
//
// Selectors are plain data so they can be passed across the
// `chrome.scripting.executeScript` boundary as `args` — see
// background/ask/index.ts.

import { claudeProvider } from './claude.js';
import { geminiProvider } from './gemini.js';

export type AskProviderId = 'claude' | 'gemini';

/**
 * One ranked list per role. The injected runtime tries each entry
 * in order and uses the first match. Multiple selectors per role
 * absorb minor DOM changes on the AI site without requiring an
 * extension update.
 */
export interface AskInjectSelectors {
  /**
   * Buttons the runtime should click in sequence (in this exact
   * order) before searching for the file input. Used by providers
   * that don't expose a file input in the initial DOM — e.g. Gemini,
   * which only creates one when the user opens its upload menu and
   * picks "Upload files". For each entry the runtime waits up to a
   * short timeout for the selector to appear, clicks it, then moves
   * on. While these clicks run, `HTMLInputElement.prototype.click`
   * is patched to a no-op for `type=file` inputs so the OS file
   * picker doesn't surface mid-flow.
   *
   * Empty / omitted (Claude) means the file input is in the page
   * already and the runtime can skip straight to setting `files`.
   */
  preFileInputClicks?: string[];
  fileInput: string[];
  textInput: string[];
  submitButton: string[];
  /**
   * Element that appears once an attached file has been accepted by
   * the AI's UI. Reserved for future DOM-based upload confirmation
   * — currently unused: the submit-enable poll in `ask-inject.ts`
   * is the authoritative "uploads finished" gate. Optional so
   * provider data files don't need to write `attachmentPreview: []`
   * boilerplate while it's vestigial.
   */
  attachmentPreview?: string[];
}

export interface AskProvider {
  id: AskProviderId;
  /** Human label shown in the Ask menu. */
  label: string;
  /**
   * Inclusion patterns. Passed verbatim to `chrome.tabs.query({ url })`
   * and so MUST be **Chrome extension match patterns**, not simple
   * globs:
   *
   *   `<scheme>://<host><path>`
   *
   * - scheme: `*` | `http` | `https` | `file` | `ftp` | `urn`
   * - host:   `*` | `*.<dns-name>` | `<dns-name>`. The bare `*` is
   *   only valid in scheme-only patterns; `*.` is only valid at
   *   the start of the host. Things like `https://*.ai/*` are
   *   *rejected* — the `*.` has to attach to a concrete suffix
   *   (e.g. `https://*.claude.ai/*`).
   * - path:   any string. `*` matches any sequence of characters,
   *   including empty. Fragments are stripped before matching.
   *
   * See https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
   * for the full grammar. Examples:
   *
   *   `https://claude.ai/*`     — every URL on claude.ai over https
   *   `https://*.claude.ai/*`   — any subdomain of claude.ai
   *   `*://claude.ai/chat/*`    — any scheme, /chat path
   *
   * Anything else (`?` wildcards, regex, query-string predicates,
   * `*.` mid-host) is rejected by `chrome.tabs.query` at runtime.
   */
  urlPatterns: string[];
  /**
   * Exclusion patterns. Applied in JS post-query (see `matchesAny()`
   * in `index.ts`) because `chrome.tabs.query` doesn't accept
   * negative patterns.
   *
   * Syntax is a simpler **glob with `*` wildcards** — NOT the Chrome
   * match-pattern grammar. `*` matches any sequence of characters
   * anywhere in the string; the rest of the pattern is treated as a
   * literal. Matching is case-insensitive (so authors don't have to
   * worry about whether Chrome lowercased the host). Unlike
   * `urlPatterns`, this glob does *not* strip fragments — a pattern
   * ending in `*` will catch `#hash` and `?query` too.
   *
   *   `https://claude.ai/settings*`  — `/settings` and `/settings/...`
   *   `*://*.example.com/admin/*`    — any scheme/subdomain admin path
   *
   * Pitfalls:
   *
   * - A pattern of just `*` matches every URL (including the empty
   *   string), so it would silently exclude every tab. Don't.
   * - The matcher is intentionally not Chrome's match-pattern engine
   *   — `*.foo.com` here matches the literal substring `*.foo.com`
   *   anywhere in the URL, which isn't what you want. Spell out
   *   the prefix: `https://*.foo.com/*` or similar.
   *
   * Optional; missing means no exclusions. Used for pages on the
   * provider's domain that aren't valid chat targets — settings,
   * projects index, login.
   */
  excludeUrlPatterns?: string[];
  /** URL we open for "New window in <provider>". */
  newTabUrl: string;
  selectors: AskInjectSelectors;
  /**
   * `true` once the adapter has been validated end-to-end. The Ask
   * menu greys out providers with `enabled: false` and labels them
   * "(coming soon)". Lets us land Gemini/ChatGPT scaffolding without
   * the menu offering broken paths.
   */
  enabled: boolean;
}

export const ASK_PROVIDERS: AskProvider[] = [claudeProvider, geminiProvider];

export function getAskProvider(id: AskProviderId): AskProvider {
  const p = ASK_PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown Ask provider: ${id}`);
  return p;
}

/**
 * Test-only seam that swaps the registry contents in place. Used by
 * the Ask e2e specs to point Claude's `urlPatterns` / `newTabUrl` at
 * a fixture page so tests don't have to talk to claude.ai. The
 * pre-existing array binding is preserved (only the contents
 * change), so importers see the swap without re-importing. Pass an
 * empty array to clear; pass the real provider data to restore
 * (tests should snapshot the original first).
 */
export function _setAskProvidersForTest(providers: AskProvider[]): void {
  ASK_PROVIDERS.splice(0, ASK_PROVIDERS.length, ...providers);
}
