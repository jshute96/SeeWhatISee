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
interface AskPin {
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
 * Decide what plain Ask (button click without opening the menu)
 * should target right now. Order:
 *
 * 1. Pinned tab if it still exists, the pinned provider is enabled,
 *    and the tab's URL still matches one of that provider's
 *    `urlPatterns` (so a navigated-away tab doesn't get hijacked).
 * 2. First enabled provider's "newTab" entry as the fallback.
 * 3. `null` if no provider is enabled.
 *
 * Pin verification clears a stale pin in passing.
 */
export async function resolveDefaultDestination(): Promise<AskDestination | null> {
  const pin = await readPin();
  if (pin) {
    const provider = ASK_PROVIDERS.find((p) => p.id === pin.provider);
    if (provider && provider.enabled) {
      try {
        const tab = await chrome.tabs.get(pin.tabId);
        if (tab.id !== undefined && tab.url) {
          const matches = await chrome.tabs.query({ url: provider.urlPatterns });
          const stillProvider = matches.some((t) => t.id === pin.tabId);
          const excluded = matchesAny(tab.url, provider.excludeUrlPatterns ?? []);
          if (stillProvider && !excluded) {
            return { kind: 'existingTab', provider: pin.provider, tabId: pin.tabId };
          }
        }
      } catch {
        // Tab gone or inaccessible — fall through to clear + fallback.
      }
    }
    await writePin(null);
  }
  const fallback = ASK_PROVIDERS.find((p) => p.enabled);
  if (!fallback) return null;
  return { kind: 'newTab', provider: fallback.id };
}

export async function listAskProviders(): Promise<AskProviderListing[]> {
  const out: AskProviderListing[] = [];
  for (const provider of ASK_PROVIDERS) {
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
        // Drop tabs whose URL matches any exclusion (settings,
        // projects index, etc.) — `chrome.tabs.query` only takes
        // positive match patterns, so we filter post-query.
        .filter((t) => !matchesAny(t.url ?? '', excludes))
        .map((t) => ({
          tabId: t.id,
          title: t.title ?? t.url ?? `Tab ${t.id}`,
          url: t.url ?? '',
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
 *   Response includes `defaultDestination` so the page can render a
 *   check next to whichever item plain-Ask will currently target,
 *   and refresh the Ask button label.
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
        void Promise.all([listAskProviders(), resolveDefaultDestination()]).then(
          ([providers, defaultDestination]) =>
            sendResponse({ providers, defaultDestination }),
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
        void resolveDefaultDestination()
          .then((destination) => {
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
