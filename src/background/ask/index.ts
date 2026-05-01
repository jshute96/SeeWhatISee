// Ask flow orchestration: resolve target tab, focus it, and run the
// injected runtime to attach files + fill the prompt + submit.
//
// Wire layout (see also src/ask-inject.ts and src/capture-page.ts):
//
//   capture-page.ts ──{action: 'askAi', destination, payload}──▶
//     installAskMessageHandler() (this file) ──▶
//       sendToAi() ──▶ chrome.scripting.executeScript(MAIN world) ──▶
//         dist/ask-inject.js's window.__seeWhatISeeAsk(selectors, payload)
//
// One Ask call may open a new tab on the AI provider (waiting for it
// to finish loading before injecting), or reuse an existing tab the
// user picked from the menu. Either way we focus it before injecting
// so the user sees the result land.

import {
  ASK_PROVIDERS,
  getAskProvider,
  type AskProvider,
  type AskProviderId,
} from './providers.js';
import { getAskProviderSettings } from './settings.js';

export type AskDestination =
  | { kind: 'newTab'; provider: AskProviderId }
  | { kind: 'existingTab'; provider: AskProviderId; tabId: number };

/** What the injected runtime needs for one upload. */
export interface AskAttachment {
  data: string;            // data URL for kind: 'image', raw text otherwise
  kind: 'image' | 'text';
  mimeType: string;
  filename: string;
}

export interface AskPayload {
  attachments: AskAttachment[];
  promptText: string;
  autoSubmit: boolean;
}

export interface AskResult {
  ok: boolean;
  error?: string;
  tabId?: number;
}

/** Tab listing item used to render the "Existing window in <provider>" group. */
export interface AskTabSummary {
  tabId: number;
  title: string;
  url: string;
  /**
   * `true` when the tab matches one of the provider's
   * `excludeUrlPatterns` (settings, library, recents, etc.). The
   * page renders these as a disabled menu item with a "(Not on
   * prompt page)" suffix so the user sees the tab is on the
   * provider but isn't a valid Ask target.
   */
  excluded?: boolean;
}

export interface AskProviderListing {
  id: AskProviderId;
  label: string;
  enabled: boolean;
  /** Empty when no tabs match the provider's URL patterns. */
  existingTabs: AskTabSummary[];
}

/**
 * Pin record persisted across menu opens. Stored in
 * `chrome.storage.session` (cleared on browser restart) since `tabId`
 * is only meaningful inside a single Chrome session anyway. Updated
 * automatically by `sendToAi` on every successful send so the next
 * plain-Ask click reuses the same destination tab.
 */
export interface AskPin {
  provider: AskProviderId;
  tabId: number;
}

const PIN_KEY = 'askPin';

const NEW_TAB_LOAD_TIMEOUT_MS = 15000;

async function readPin(): Promise<AskPin | null> {
  try {
    const got = await chrome.storage.session.get(PIN_KEY);
    const pin = got[PIN_KEY] as AskPin | undefined;
    if (!pin || typeof pin.tabId !== 'number' || typeof pin.provider !== 'string') {
      return null;
    }
    return pin;
  } catch {
    return null;
  }
}

async function writePin(pin: AskPin | null): Promise<void> {
  try {
    if (pin === null) await chrome.storage.session.remove(PIN_KEY);
    else await chrome.storage.session.set({ [PIN_KEY]: pin });
  } catch {
    // Session storage may be unavailable in unusual MV3 states.
    // Pinning is a UX nicety — drop the write rather than fail Ask.
  }
}

/**
 * Read the current pin. Used by the toolbar context menu to decide
 * whether the active tab is already pinned (and the entry should
 * read "Unpin…" instead of "Pin…"). Returns null when no pin is
 * set or session storage is unreadable.
 */
export async function getAskPin(): Promise<AskPin | null> {
  return readPin();
}

/**
 * Manually set or clear the pin. Used by the toolbar context-menu
 * Pin/Unpin entry; the regular Ask flow updates the pin via
 * `sendToAi` on a successful send and doesn't go through here.
 */
export async function setAskPin(pin: AskPin | null): Promise<void> {
  await writePin(pin);
}

/**
 * Find the Ask provider that the given (tabId, url) belongs to —
 * one whose `urlPatterns` Chrome's match-pattern engine accepts
 * for this tab and whose `excludeUrlPatterns` glob doesn't reject
 * it. Returns null if no enabled provider claims the tab. Used by
 * the toolbar Pin/Unpin entry to decide whether the entry should
 * be enabled.
 */
export async function findProviderForTab(
  tabId: number,
  url: string,
): Promise<AskProvider | null> {
  if (!url) return null;
  const settings = await getAskProviderSettings();
  for (const provider of ASK_PROVIDERS) {
    if (!provider.enabled) continue;
    if (!settings.enabled[provider.id]) continue;
    // Delegate `urlPatterns` matching to Chrome (its match-pattern
    // grammar isn't a simple glob — see the AskProvider jsdoc) by
    // scoping a `tabs.query` to this provider's patterns and
    // checking whether our tab is in the result.
    const matches = await chrome.tabs.query({ url: provider.urlPatterns });
    if (!matches.some((t) => t.id === tabId)) continue;
    if (matchesAny(url, provider.excludeUrlPatterns ?? [])) continue;
    return provider;
  }
  return null;
}

/**
 * Result of resolving plain Ask's target. `destination` is what
 * the next click should hit; `staleTabPin`, when set, names a
 * still-alive pinned tab whose URL is now on the provider's
 * exclude list — the menu surfaces those rows with a greyed-out
 * check so the user can see "this used to be the default" alongside
 * the new fallback's regular check.
 */
export interface AskResolution {
  destination: AskDestination | null;
  staleTabPin?: { provider: AskProviderId; tabId: number };
}

/**
 * Resolve plain Ask's target right now. Order:
 *
 * 1. Pinned tab if it still exists, the pinned provider is enabled,
 *    its URL matches `urlPatterns`, and isn't excluded.
 * 2. First enabled provider's "newTab" entry as the fallback.
 * 3. `null` if no provider is enabled.
 *
 * Stale-pin handling:
 *
 * - Tab closed or navigated off the provider's host → clear the
 *   pin in passing; nothing to surface.
 * - Tab still on the provider's host but on an excluded URL
 *   (settings, library, recents, etc.) → keep the pin (user might
 *   navigate back) and report it as `staleTabPin` so the menu can
 *   render a greyed check on that row.
 */
export async function resolveAsk(): Promise<AskResolution> {
  const settings = await getAskProviderSettings();
  // Fallback target: the user's configured default if it's still an
  // effective-enabled provider (adapter built AND user-enabled). The
  // settings normalizer guarantees `settings.default` either points
  // at a user-enabled provider or is null, so we only need to verify
  // the static `provider.enabled` here.
  let fallbackProvider: AskProvider | null = null;
  if (settings.default) {
    const candidate = ASK_PROVIDERS.find((p) => p.id === settings.default);
    if (candidate && candidate.enabled) fallbackProvider = candidate;
  }
  const fallbackResolution: AskResolution = {
    destination: fallbackProvider
      ? { kind: 'newTab', provider: fallbackProvider.id }
      : null,
  };

  const pin = await readPin();
  if (!pin) return fallbackResolution;

  const provider = ASK_PROVIDERS.find((p) => p.id === pin.provider);
  if (!provider || !provider.enabled || !settings.enabled[provider.id]) {
    // Pinned provider is gone, statically disabled, or has been
    // user-disabled. Drop the pin so the next resolve uses the
    // configured default cleanly.
    await writePin(null);
    return fallbackResolution;
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(pin.tabId);
  } catch {
    // Tab closed.
    await writePin(null);
    return fallbackResolution;
  }
  if (tab.id === undefined || !tab.url) {
    await writePin(null);
    return fallbackResolution;
  }

  const matches = await chrome.tabs.query({ url: provider.urlPatterns });
  const stillProvider = matches.some((t) => t.id === pin.tabId);
  if (!stillProvider) {
    // Tab is no longer on the provider's host — either navigated
    // off it, or closed in the small window between `tabs.get`
    // (above) and `tabs.query` (just now). Either way, drop the
    // pin and let the fallback take over.
    await writePin(null);
    return fallbackResolution;
  }

  const excluded = matchesAny(tab.url, provider.excludeUrlPatterns ?? []);
  if (excluded) {
    // Same host, wrong page. Keep the pin so a navigation back
    // restores the default; surface the row as stale in the menu.
    // Self-correcting race: the menu render is fed by a separate
    // `chrome.tabs.query` in `listAskProviders`, so if the pinned
    // tab closes between the two queries the page won't have an
    // existing-tab row to mark — visually fine, and the next menu
    // open's `tabs.get` will throw and clear the pin properly.
    return {
      destination: fallbackResolution.destination,
      staleTabPin: { provider: pin.provider, tabId: pin.tabId },
    };
  }

  return {
    destination: { kind: 'existingTab', provider: pin.provider, tabId: pin.tabId },
  };
}

export async function listAskProviders(): Promise<AskProviderListing[]> {
  const settings = await getAskProviderSettings();
  const out: AskProviderListing[] = [];
  for (const provider of ASK_PROVIDERS) {
    // User-disabled providers are dropped entirely from the listing —
    // the Ask menu treats them as if they weren't registered, so no
    // "New window in <X>" row, no existing tabs surfaced. Static
    // disabled-but-registered providers (no adapter built yet) still
    // appear here with `enabled: false` so the menu can render the
    // "(coming soon)" row — that decision is the page's, not ours.
    if (!settings.enabled[provider.id]) continue;
    const tabs = provider.enabled
      ? await chrome.tabs.query({ url: provider.urlPatterns })
      : [];
    const excludes = provider.excludeUrlPatterns ?? [];
    out.push({
      id: provider.id,
      label: provider.label,
      enabled: provider.enabled,
      existingTabs: tabs
        .filter((t): t is chrome.tabs.Tab & { id: number } => t.id !== undefined)
        // Tabs on excluded URLs (settings, library, recents, etc.)
        // still appear in the menu but flagged so the page renders
        // them disabled with a "(Wrong page)" suffix —
        // `chrome.tabs.query` only takes positive match patterns,
        // so we evaluate excludes post-query.
        .map((t) => ({
          tabId: t.id,
          title: t.title ?? t.url ?? `Tab ${t.id}`,
          url: t.url ?? '',
          excluded: matchesAny(t.url ?? '', excludes),
        })),
    });
  }
  return out;
}

/**
 * Tests `url` against a list of patterns where each pattern is a
 * literal string with `*` wildcards (anywhere in the string).
 * Returns true on the first match. Used by `listAskProviders` for
 * `AskProvider.excludeUrlPatterns`.
 *
 * Not a full Chrome match-pattern implementation — schemes and
 * hosts aren't given any special treatment, `*` just means "any
 * sequence of characters." That's enough for path-suffix excludes
 * like `https://claude.ai/settings*` and keeps the matcher
 * dependency-free. Matching is case-insensitive so authors don't
 * have to worry about whether Chrome happened to lowercase the
 * host on a given platform.
 */
export function matchesAny(url: string, patterns: string[]): boolean {
  if (!url) return false;
  for (const pattern of patterns) {
    if (globMatch(url, pattern)) return true;
  }
  return false;
}

export function globMatch(url: string, pattern: string): boolean {
  // Collapse runs of `*` to a single `*` before regex construction.
  // Without this, a pattern like `***foo` produces `.*.*.*foo` —
  // when `foo` is not present in the URL the regex backtracks
  // exponentially and can stall the service worker. Author-supplied
  // patterns only, but `listAskProviders` runs on every menu open.
  const collapsed = pattern.replace(/\*+/g, '*');
  const re = new RegExp(
    '^' +
      collapsed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
      '$',
    'i',
  );
  return re.test(url);
}

export async function sendToAi(
  destination: AskDestination,
  payload: AskPayload,
): Promise<AskResult> {
  const provider = getAskProvider(destination.provider);
  if (!provider.enabled) {
    return { ok: false, error: `${provider.label} is not yet supported` };
  }
  const settings = await getAskProviderSettings();
  if (!settings.enabled[provider.id]) {
    return {
      ok: false,
      error: `${provider.label} is disabled; enable it on the Options page`,
    };
  }

  let tabId: number;
  try {
    tabId = await resolveTab(provider, destination);
  } catch (err) {
    return { ok: false, error: `Could not open ${provider.label}: ${describe(err)}` };
  }

  // Best-effort focus. If this fails we still try to inject — the
  // user just won't see the AI tab pop forward.
  try {
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // Swallow — see comment above.
  }

  try {
    // Two-step injection: load the runtime once (registers
    // window.__seeWhatISeeAsk), then call it. Splitting the steps
    // keeps the function payload small (no inline closure carrying
    // the data URL) and lets us re-invoke for retries without
    // reloading the file.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['ask-inject.js'],
    });

    const [callResult] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: invokeRuntime,
      args: [provider.selectors, payload],
    });

    const result = callResult?.result as { ok: boolean; error?: string } | undefined;
    if (!result) {
      return { ok: false, error: 'No response from injected runtime', tabId };
    }
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Unknown injection failure', tabId };
    }
    // Pin this destination so the next plain-Ask click reuses the
    // same tab. Includes both new-tab opens (so the freshly-created
    // tab gets reused) and existing-tab picks.
    await writePin({ provider: provider.id, tabId });
    return { ok: true, tabId };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to inject into ${provider.label}: ${describe(err)}`,
      tabId,
    };
  }
}

// Runs in MAIN world via executeScript({ func }). Kept as a named
// outer function (instead of an inline arrow at the call site) so
// TypeScript type-checks it against the runtime's expected shape and
// the serialized form stays small.
function invokeRuntime(selectors: unknown, payload: unknown): unknown {
  const fn = (window as unknown as { __seeWhatISeeAsk?: Function }).__seeWhatISeeAsk;
  if (!fn) return { ok: false, error: 'Ask runtime not loaded' };
  return fn(selectors, payload);
}

async function resolveTab(
  provider: AskProvider,
  destination: AskDestination,
): Promise<number> {
  if (destination.kind === 'existingTab') {
    // Verify the tab still exists; throws if it's been closed.
    const tab = await chrome.tabs.get(destination.tabId);
    if (tab.id === undefined) throw new Error('Tab has no id');
    return tab.id;
  }
  const created = await chrome.tabs.create({
    url: provider.newTabUrl,
    active: true,
  });
  if (created.id === undefined) {
    throw new Error('Could not create new tab');
  }
  await waitForTabComplete(created.id, NEW_TAB_LOAD_TIMEOUT_MS);
  return created.id;
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const onRemoved = (id: number): void => {
      // User closed the tab during load — fail fast instead of
      // waiting out the full timeout.
      if (id === tabId) finish(new Error('Tab was closed during load'));
    };
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(
      () => finish(new Error('Tab load timed out')),
      timeoutMs,
    );
    // Race condition: the tab may already be 'complete' (or already
    // gone) by the time we attached the listener. Probe and resolve
    // / reject immediately based on what we find.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish();
      })
      .catch((err: unknown) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface AskMessage {
  action: 'askAi' | 'askAiDefault' | 'askListProviders';
  destination?: AskDestination;
  payload?: AskPayload;
}

/**
 * Routes Ask-related runtime messages:
 *
 * - `askListProviders` — provider + open-tab listing for the menu.
 *   Response includes `defaultDestination` (the row plain-Ask
 *   will hit, gets a green check) and `staleTabPin` (a still-alive
 *   pinned tab that's now on a wrong page, gets a greyed check).
 * - `askAi` — send to a specific destination (menu pick).
 * - `askAiDefault` — resolve + send to the current default. Lets
 *   the page invoke pin-or-fallback in one round-trip.
 *
 * Installed once from background.ts.
 */
export function installAskMessageHandler(): void {
  chrome.runtime.onMessage.addListener(
    (msg: AskMessage, _sender, sendResponse) => {
      if (msg?.action === 'askListProviders') {
        void Promise.all([listAskProviders(), resolveAsk()]).then(
          ([providers, resolution]) =>
            sendResponse({
              providers,
              defaultDestination: resolution.destination,
              staleTabPin: resolution.staleTabPin,
            }),
        );
        return true;
      }
      if (msg?.action === 'askAi') {
        if (!msg.destination || !msg.payload) {
          sendResponse({ ok: false, error: 'Missing destination or payload' });
          return false;
        }
        void sendToAi(msg.destination, msg.payload).then(sendResponse);
        return true;
      }
      if (msg?.action === 'askAiDefault') {
        if (!msg.payload) {
          sendResponse({ ok: false, error: 'Missing payload' });
          return false;
        }
        const payload = msg.payload;
        void resolveAsk()
          .then(({ destination }) => {
            if (!destination) {
              return { ok: false, error: 'No Ask provider available' };
            }
            return sendToAi(destination, payload);
          })
          .then(sendResponse);
        return true;
      }
      return false;
    },
  );
}
