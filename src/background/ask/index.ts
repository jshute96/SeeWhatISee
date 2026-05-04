// Ask flow orchestration: resolve target tab, focus it, and load the
// injected runtime + widget so the widget can walk attach + prompt +
// submit one item at a time.
//
// Wire layout (see also src/ask-inject.ts, src/ask-widget.ts, and
// src/capture-page.ts):
//
//   capture-page.ts ──{action: 'askAiDefault' | 'askAi', payload}──▶
//     installAskMessageHandler() (this file) ──▶
//       resolveAsk() (default path) + sendToAi() ──▶
//         writeWidgetRecord + executeScript:
//         - dist/ask-inject.js (MAIN world) installs the postMessage
//           bridge listener on window
//         - dist/ask-widget.js (ISOLATED world) mounts the status
//           widget, which drives the bridge ops one at a time
//
// One Ask call may open a new tab on the AI provider (waiting for it
// to finish loading before injecting), or reuse an existing tab the
// user picked from the menu. Either way we focus it before injecting
// so the user sees the result land.

import {
  ASK_PROVIDERS,
  getAskProvider,
  type AskAttachmentKind,
  type AskProvider,
  type AskProviderId,
} from './providers.js';
import { getAskProviderSettings } from './settings.js';
import {
  patchWidgetRecord,
  readWidgetRecord,
  writeWidgetRecord,
  type AskWidgetRecord,
} from './widget-store.js';

/**
 * Effective accepted attachment kinds for a destination (provider +
 * URL). Walks `provider.urlVariants` in declaration order, returning
 * the first match; falls back to `provider.acceptedAttachmentKinds`,
 * and finally to `null` meaning "no restriction — accept everything."
 *
 * Used both at send time (to filter the payload) and at resolve time
 * (so the Capture page can pre-validate the user's checkbox state
 * before round-tripping to the SW).
 */
export function resolveAcceptedKinds(
  provider: AskProvider,
  url: string,
): AskAttachmentKind[] | null {
  for (const variant of provider.urlVariants ?? []) {
    if (globMatch(url, variant.pattern)) return variant.acceptedAttachmentKinds;
  }
  return provider.acceptedAttachmentKinds ?? null;
}

/**
 * User-facing destination name. Returns the matching variant's
 * `label` when one applies (e.g. "Claude Code" on `claude.ai/code`),
 * otherwise the provider's own `label`. Used in pre-send error text
 * so a refused payload reads "Claude Code only accepts images" rather
 * than the less specific "Claude only accepts images."
 */
export function resolveDestinationLabel(
  provider: AskProvider,
  url: string,
): string {
  for (const variant of provider.urlVariants ?? []) {
    if (globMatch(url, variant.pattern) && variant.label) return variant.label;
  }
  return provider.label;
}

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
  /**
   * Source page metadata — the page the user captured from, NOT the
   * destination AI tab. Used by the in-page status widget to render
   * its Page section so the user always knows what was captured even
   * after the Capture page closes. Optional for forward-compat with
   * older callers; the widget falls back to "(no URL)" when absent.
   */
  sourceUrl?: string;
  sourceTitle?: string;
}

export interface AskResult {
  ok: boolean;
  error?: string;
  tabId?: number;
  /**
   * Filenames that didn't match the destination's accepted-kinds
   * list (e.g. `contents.html`, `selection.md` when sending to
   * Claude Code). Only set when `ok: false` — we refuse outright
   * rather than silently filtering, so successful sends never
   * carry a skipped list. The Capture-page toast appends these to
   * the error message so the user sees which files were the
   * problem.
   */
  skipped?: string[];
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
  /**
   * Effective accepted attachment kinds at this URL. `undefined`
   * means "no restriction — provider accepts everything." Set when
   * the URL hits one of the provider's `urlVariants` (e.g. Claude on
   * `/code` returns `['image']`). Used by the Capture page to
   * pre-validate the user's checkbox state before sending.
   */
  acceptedAttachmentKinds?: AskAttachmentKind[];
  /**
   * Display name for this tab in pre-send error text — variant label
   * when one applies (e.g. "Claude Code"), provider label otherwise.
   * The Capture page uses this so the refusal reads "Claude Code only
   * accepts images" instead of the less specific "Claude only…".
   */
  destinationDisplayName: string;
}

export interface AskProviderListing {
  id: AskProviderId;
  label: string;
  enabled: boolean;
  /**
   * Filename (under the extension's `icons/` dir) of the
   * provider's logo. The Capture page resolves it via
   * `chrome.runtime.getURL('icons/' + iconFilename)` and uses the
   * resulting URL as the `<img>` src on the per-provider Ask
   * button — those buttons carry no text label, so the bundled
   * logo is what visually identifies them.
   */
  iconFilename: string;
  /**
   * Provider-default accepted kinds for "New window in <X>" rows.
   * `undefined` means "no restriction." Mirrors the per-tab
   * `acceptedAttachmentKinds` so the page-side check is the same
   * shape regardless of menu row type.
   */
  newTabAcceptedAttachmentKinds?: AskAttachmentKind[];
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

/**
 * Session-scoped override for the "new window in" provider that the
 * fallback resolves to when no live pin exists. Set when the user
 * picks a "New window in <X>" row from the Ask menu — the menu now
 * acts as a default-picker rather than a sender, and this is how
 * that pick survives until the next plain-Ask click. Cleared on
 * browser restart so the user's Options-page default reasserts
 * itself for fresh sessions.
 *
 * Lower priority than `askPin`: a still-alive pin always wins.
 * Higher priority than `settings.default`: an in-session pick beats
 * the persistent option.
 */
const PREFERRED_NEW_TAB_PROVIDER_KEY = 'askPreferredNewTabProvider';

const NEW_TAB_LOAD_TIMEOUT_MS = 15000;

async function readPreferredNewTabProvider(): Promise<AskProviderId | null> {
  try {
    const got = await chrome.storage.session.get(PREFERRED_NEW_TAB_PROVIDER_KEY);
    const v = got[PREFERRED_NEW_TAB_PROVIDER_KEY];
    return typeof v === 'string' ? (v as AskProviderId) : null;
  } catch {
    return null;
  }
}

async function writePreferredNewTabProvider(
  provider: AskProviderId | null,
): Promise<void> {
  try {
    if (provider === null) {
      await chrome.storage.session.remove(PREFERRED_NEW_TAB_PROVIDER_KEY);
    } else {
      await chrome.storage.session.set({
        [PREFERRED_NEW_TAB_PROVIDER_KEY]: provider,
      });
    }
  } catch {
    // Same rationale as writePin — session storage is best-effort.
  }
}

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
 * Apply an Ask-menu default pick without sending. The menu's own
 * onClick handlers route here so the user can shift the default
 * destination (and the button label updates to match) without firing
 * an Ask. The actual send happens on the next click of `#ask-btn`.
 *
 * - `existingTab`: writes `askPin` to that tab. Leaves the
 *   preferred-new-tab override alone so unpinning later restores
 *   the user's previous new-tab pick.
 * - `newTab`: clears `askPin` (so the new pick takes precedence)
 *   and writes the preferred-new-tab override. The persistent
 *   Options-page default is untouched — this is a session-scoped
 *   override only.
 */
export async function setAskDefault(destination: AskDestination): Promise<void> {
  if (destination.kind === 'existingTab') {
    await writePin({ provider: destination.provider, tabId: destination.tabId });
  } else {
    await writePin(null);
    await writePreferredNewTabProvider(destination.provider);
  }
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
    // `newTabOnly` providers (Google) opt out of pinning entirely —
    // skip them so the toolbar Pin/Unpin entry stays disabled on
    // their pages.
    if (provider.newTabOnly) continue;
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
  /**
   * Accepted attachment kinds at the resolved destination (provider
   * default for `newTab`, URL-variant aware for `existingTab`).
   * `undefined` means "no restriction." Used by the Capture page to
   * pre-validate the user's checkbox state before sending so the
   * "image-only Claude Code" path can refuse to send a payload that
   * has HTML / selection checked.
   */
  destinationAcceptedAttachmentKinds?: AskAttachmentKind[];
  /** Display name (variant label or provider label) for the resolved
   *  default destination. Set whenever `destination` is non-null. */
  destinationDisplayName?: string;
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
  // Fallback target priority for the "no live pin" path:
  //   1. Session-scoped preferred new-tab provider (set by the Ask
  //      menu's "New window in <X>" pick) — wins so an in-session
  //      override beats the persistent setting.
  //   2. The user's Options-page default if it's still an
  //      effective-enabled provider (adapter built AND user-enabled).
  //      The settings normalizer guarantees `settings.default` either
  //      points at a user-enabled provider or is null, so we only
  //      need to verify the static `provider.enabled` here.
  let fallbackProvider: AskProvider | null = null;
  const preferred = await readPreferredNewTabProvider();
  if (preferred) {
    const candidate = ASK_PROVIDERS.find((p) => p.id === preferred);
    if (candidate && candidate.enabled && settings.enabled[candidate.id]) {
      fallbackProvider = candidate;
    } else {
      // Preferred provider has been disabled (Options) or removed
      // since the pick — drop the override so the next resolve uses
      // the persistent default cleanly.
      await writePreferredNewTabProvider(null);
    }
  }
  if (!fallbackProvider && settings.default) {
    const candidate = ASK_PROVIDERS.find((p) => p.id === settings.default);
    if (candidate && candidate.enabled) fallbackProvider = candidate;
  }
  const fallbackResolution: AskResolution = {
    destination: fallbackProvider
      ? { kind: 'newTab', provider: fallbackProvider.id }
      : null,
    destinationAcceptedAttachmentKinds: fallbackProvider
      ? resolveAcceptedKinds(fallbackProvider, fallbackProvider.newTabUrl)
        ?? undefined
      : undefined,
    destinationDisplayName: fallbackProvider
      ? resolveDestinationLabel(fallbackProvider, fallbackProvider.newTabUrl)
      : undefined,
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
      // Spread `fallbackResolution` (rather than rebuilding) so the
      // pre-computed `destinationAcceptedAttachmentKinds` /
      // `destinationDisplayName` for the fallback newTab destination
      // ride along — without this the page-side pre-send guard goes
      // dark on the stale-pin path.
      ...fallbackResolution,
      staleTabPin: { provider: pin.provider, tabId: pin.tabId },
    };
  }

  return {
    destination: { kind: 'existingTab', provider: pin.provider, tabId: pin.tabId },
    destinationAcceptedAttachmentKinds:
      resolveAcceptedKinds(provider, tab.url) ?? undefined,
    destinationDisplayName: resolveDestinationLabel(provider, tab.url),
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
    // `newTabOnly` providers (Google) never reuse existing tabs —
    // skip the query entirely so the menu doesn't render an
    // "Existing window in <X>" section for them.
    const tabs = provider.enabled && !provider.newTabOnly
      ? await chrome.tabs.query({ url: provider.urlPatterns })
      : [];
    const excludes = provider.excludeUrlPatterns ?? [];
    out.push({
      id: provider.id,
      label: provider.label,
      enabled: provider.enabled,
      iconFilename: provider.iconFilename,
      newTabAcceptedAttachmentKinds:
        resolveAcceptedKinds(provider, provider.newTabUrl) ?? undefined,
      existingTabs: tabs
        .filter((t): t is chrome.tabs.Tab & { id: number } => t.id !== undefined)
        .map((t) => {
          const url = t.url ?? '';
          const kinds = resolveAcceptedKinds(provider, url);
          return {
            tabId: t.id,
            title: t.title ?? url ?? `Tab ${t.id}`,
            url,
            excluded: matchesAny(url, excludes),
            acceptedAttachmentKinds: kinds ?? undefined,
            destinationDisplayName: resolveDestinationLabel(provider, url),
          };
        }),
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

  // Resolve the effective accepted kinds at the destination URL —
  // for `existingTab`, we look up the live tab's URL so a Claude
  // `/code` tab gets the image-only variant; for `newTab` we use the
  // provider's `newTabUrl` (so e.g. claude.ai/new gets the full
  // provider-level kinds, even though /code on the same provider
  // would be image-only).
  //
  // For `existingTab` we also verify the tab is still on the
  // provider's domain and not on an excluded page — without this we'd
  // happily inject Claude selectors into whatever the user navigated
  // to since the menu was opened, surfacing as a confusing "Could not
  // find file-upload input" error from `ask-inject.ts`. A pre-send
  // refusal with a clear message is friendlier.
  let destinationUrl = provider.newTabUrl;
  if (destination.kind === 'existingTab') {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(destination.tabId);
    } catch {
      return {
        ok: false,
        error: `${provider.label} tab is no longer open; pick a different destination`,
      };
    }
    const url = tab.url ?? '';
    const matches = await chrome.tabs.query({ url: provider.urlPatterns });
    const stillProvider = matches.some((t) => t.id === destination.tabId);
    if (!stillProvider) {
      return {
        ok: false,
        error: `Tab is no longer on ${provider.label}; pick a different destination`,
      };
    }
    const excluded = matchesAny(url, provider.excludeUrlPatterns ?? []);
    if (excluded) {
      return {
        ok: false,
        error: `Tab is no longer on a ${provider.label} chat page; navigate back or pick a different destination`,
      };
    }
    destinationUrl = url || provider.newTabUrl;
  }
  const acceptedKinds = resolveAcceptedKinds(provider, destinationUrl);
  const destinationLabel = resolveDestinationLabel(provider, destinationUrl);

  // Refuse outright if any attachment doesn't match the destination's
  // accepted kinds. The Capture page's pre-send guard already catches
  // this in normal flow, so reaching here means the page's cached
  // accepted-kinds was stale (Pin/Unpin from the toolbar, a tab
  // navigation, or an Options-page change between cache load and
  // click). Treating it as an error rather than silently filtering
  // matches the user's expectation: the payload they checked is what
  // gets sent, full stop. The page-side error suffix names which
  // files would have been dropped so the user can act.
  const filtered = filterAttachmentsByKinds(payload.attachments, acceptedKinds);
  if (filtered.skipped.length > 0) {
    return {
      ok: false,
      error: `${destinationLabel} only accepts ${formatKindList(acceptedKinds)} attachments; uncheck other items`,
      skipped: filtered.skipped.map((a) => a.filename),
    };
  }

  // For `existingTab` the pre-send guard above already confirmed the
  // tab exists, is on the provider, and isn't excluded — skip the
  // redundant `chrome.tabs.get` so a tab close in the intervening
  // microseconds still surfaces our clean guard message rather than
  // a legacy "Could not open <Provider>: …" path.
  // Build the record once — same shape regardless of path. The
  // newTab path writes it as `placeholder` early (before the page
  // has loaded) so the widget can mount and show "Waiting for
  // <provider> to load…", then re-writes with status `injecting`
  // and a fresh runId once the page is ready (which the widget's
  // storage listener picks up as the orchestration trigger).
  // The existingTab path skips the placeholder phase — the page
  // is already loaded — and writes `injecting` directly.
  const items = buildItems(payload);
  const recordTemplate: Omit<AskWidgetRecord, 'status' | 'runId' | 'updatedAt'> = {
    destinationLabel,
    sourceUrl: payload.sourceUrl ?? '',
    sourceTitle: payload.sourceTitle ?? '',
    attachments: payload.attachments.map((a) => ({
      kind: a.kind,
      mimeType: a.mimeType,
      filename: a.filename,
      data: a.data,
    })),
    promptText: payload.promptText,
    items,
    autoSubmit: payload.autoSubmit,
    selectors: provider.selectors,
  };

  let tabId: number;
  if (destination.kind === 'existingTab') {
    tabId = destination.tabId;
  } else {
    try {
      tabId = await openNewProviderTabWithPlaceholder(provider, recordTemplate);
    } catch (err) {
      return {
        ok: false,
        error: `Could not open ${provider.label}: ${describe(err)}`,
      };
    }
  }

  // Cancel detection (newTab path only). The widget's × handler
  // clears its storage record on dismiss, so a missing record
  // here means the user dismissed the placeholder widget during
  // the page-load wait. Bail before the real widget / bridge ever
  // mount; the tab stays open so the user can interact with the
  // page themselves. Storage-based rather than a runtime message
  // so the cancel is fully ordered with the SW's read — a runtime
  // sendMessage can land *after* the SW's check, which would let
  // the widget re-pop on the user.
  if (destination.kind === 'newTab') {
    const stillStaged = await readWidgetRecord(tabId);
    if (!stillStaged) return { ok: false, error: 'Cancelled' };
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

  // Promote the placeholder record (or write afresh on the
  // existing-tab path) to status `injecting` with a new runId.
  // The fresh runId is what the widget's storage listener latches
  // onto to fire `tryStartRun` and walk the items.
  const widgetRecord: AskWidgetRecord = {
    ...recordTemplate,
    status: 'injecting',
    runId: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    await writeWidgetRecord(tabId, widgetRecord);
  } catch (err) {
    // Most likely cause: chrome.storage.session quota exceeded for a
    // large attachment payload. Surface it immediately rather than
    // waiting 60 s for the generic completion timeout.
    return {
      ok: false,
      error: `Couldn't stage payload for the in-page widget: ${describe(err)}`,
      tabId,
    };
  }

  try {
    // Load the MAIN-world helper file once before the widget walks
    // its first item — the bridge needs to be listening when the
    // widget posts its first request. Re-loads are no-ops via the
    // IIFE's `__seeWhatISeeAskBridgeInstalled` flag.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['ask-inject.js'],
    });
    // Re-mount the widget. Idempotent — if the early placeholder
    // mount survived the navigation, this is a no-op refresh; if
    // it died on a transient document, this is the first real
    // mount and reads the now-`injecting` record straight away.
    await mountAskWidget(tabId);
  } catch (err) {
    const message = `Failed to inject into ${provider.label}: ${friendlyInjectError(err)}`;
    await patchWidgetRecord(tabId, { status: 'error', error: message });
    return { ok: false, error: message, tabId };
  }

  // Wait for the widget to finish walking the items.
  let final: AskWidgetRecord;
  try {
    final = await waitForWidgetCompletion(tabId);
  } catch (err) {
    const message = describe(err);
    await patchWidgetRecord(tabId, { status: 'error', error: message });
    return { ok: false, error: message, tabId };
  }

  if (final.status !== 'success') {
    return { ok: false, error: final.error ?? 'Inject failed', tabId };
  }

  // Pin this destination so the next plain-Ask click reuses the same
  // tab. `newTabOnly` providers opt out — Google Search isn't a chat
  // surface to reuse.
  if (!provider.newTabOnly) {
    await writePin({ provider: provider.id, tabId });
  }
  return { ok: true, tabId };
}

/**
 * Convert a payload into the ordered item list the widget walks.
 * One item per attachment, then a `prompt` item if the user typed
 * one, then a `submit` item (only when `autoSubmit` is on AND the
 * prompt is non-empty — empty prompt means "set up the conversation,
 * let me think").
 *
 * Labels match what the widget renders in the Content section, so
 * the per-item rows and the orchestration items line up 1:1.
 */
function buildItems(payload: AskPayload) {
  const items: AskWidgetRecord['items'] = [];
  payload.attachments.forEach((att, i) => {
    items.push({
      kind: 'attachment',
      attachmentIndex: i,
      label: labelForAttachment(att),
      status: 'pending',
    });
  });
  const promptHasText = payload.promptText.trim().length > 0;
  if (promptHasText) {
    items.push({ kind: 'prompt', label: 'Prompt', status: 'pending' });
  }
  if (payload.autoSubmit && promptHasText) {
    items.push({ kind: 'submit', label: 'Submit', status: 'pending' });
  }
  return items;
}

function labelForAttachment(att: AskAttachment): string {
  if (att.kind === 'image') return 'Screenshot';
  if (att.filename.endsWith('.html')) return 'HTML';
  if (att.filename.endsWith('.md') || att.mimeType.includes('markdown')) {
    return 'Selection (markdown)';
  }
  if (att.mimeType.includes('html')) return 'Selection (HTML)';
  return 'Selection (text)';
}

/**
 * Resolve when the widget's overall status flips out of 'injecting'.
 * Listens to `chrome.storage.onChanged`. Times out after 60 s — most
 * inject flows finish in seconds; a 60 s ceiling is generous for
 * slow uploads while keeping the SW from leaking listeners forever.
 */
function waitForWidgetCompletion(
  tabId: number,
  timeoutMs = 60000,
): Promise<AskWidgetRecord> {
  const storageKey = `askWidget:${tabId}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      kind: 'resolve' | 'reject',
      payload: AskWidgetRecord | Error,
    ): void => {
      if (settled) return;
      settled = true;
      chrome.storage.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      if (kind === 'resolve') resolve(payload as AskWidgetRecord);
      else reject(payload as Error);
    };
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ): void => {
      if (area !== 'session' || !(storageKey in changes)) return;
      const v = changes[storageKey].newValue as AskWidgetRecord | undefined;
      if (v && v.status !== 'injecting') finish('resolve', v);
    };
    chrome.storage.onChanged.addListener(onChanged);
    const timer = setTimeout(
      () => finish('reject', new Error('Inject timed out (widget never reported)')),
      timeoutMs,
    );
    // Self-resolve race: if the widget already finished before we
    // installed the listener (e.g. an extremely fast happy path), the
    // current record will already be terminal. Probe and resolve
    // immediately if so.
    void chrome.storage.session.get(storageKey).then((got) => {
      const v = got[storageKey] as AskWidgetRecord | undefined;
      if (v && v.status !== 'injecting') finish('resolve', v);
    });
  });
}

/**
 * Inject the status widget into `tabId`. Two-step ISOLATED-world
 * call: first stash the tabId on `window` (the file-load form of
 * `executeScript` doesn't accept `args`), then load `ask-widget.js`
 * which reads it and mounts/refreshes itself.
 *
 * Idempotent — re-injecting on a tab that already has a mounted
 * widget is a no-op (the script's IIFE detects the existing handle
 * and just calls `refresh()`). Safe to call before every Ask.
 */
async function mountAskWidget(tabId: number): Promise<void> {
  // `injectImmediately: true` runs the script as soon as the
  // document exists rather than waiting for `document_idle`
  // (post-DOMContentLoaded). On the new-tab placeholder path this
  // is the difference between the widget appearing within a few
  // hundred ms vs. only after the provider's framework has parsed
  // and started rendering. On the post-load mount path the page is
  // already loaded so the flag is a no-op. The widget itself
  // attaches to `documentElement` (which exists almost
  // immediately) so an early mount is safe.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    injectImmediately: true,
    func: (tid: number) => {
      (window as unknown as { __seeWhatISeeWidgetTabId?: number })
        .__seeWhatISeeWidgetTabId = tid;
    },
    args: [tabId],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    injectImmediately: true,
    files: ['ask-widget.js'],
  });
}

/**
 * Friendly join of accepted-kind tokens for an error message — turns
 * `['image']` into `"image"` and `['image', 'text']` into
 * `"image and text"`. Caller adds the trailing word "attachments" so
 * the result reads naturally in the surrounding sentence.
 */
export function formatKindList(kinds: AskAttachmentKind[] | null): string {
  if (!kinds || kinds.length === 0) return '';
  if (kinds.length === 1) return kinds[0];
  if (kinds.length === 2) return `${kinds[0]} and ${kinds[1]}`;
  return `${kinds.slice(0, -1).join(', ')}, and ${kinds[kinds.length - 1]}`;
}

/**
 * Split `attachments` into kept vs. skipped according to the
 * provided accepted-kinds list. `null` means "no restriction" — every
 * attachment is kept. Used by `sendToAi`'s refusal check; an empty
 * `skipped` array means the payload is clean for this destination.
 */
function filterAttachmentsByKinds(
  attachments: AskAttachment[],
  acceptedKinds: AskAttachmentKind[] | null,
): { kept: AskAttachment[]; skipped: AskAttachment[] } {
  if (!acceptedKinds || acceptedKinds.length === 0) {
    return { kept: attachments, skipped: [] };
  }
  const allow = new Set<AskAttachmentKind>(acceptedKinds);
  const kept: AskAttachment[] = [];
  const skipped: AskAttachment[] = [];
  for (const a of attachments) {
    if (allow.has(a.kind)) kept.push(a);
    else skipped.push(a);
  }
  return { kept, skipped };
}


/**
 * Open a new tab on `provider.newTabUrl`, write a `placeholder`
 * widget record so the in-page widget can render "Waiting for
 * `<provider>` to load…" the moment it mounts, fire a best-effort
 * early widget mount on the first `'loading'` event, and then
 * wait for the page to fully load before returning. The early
 * mount is a UX win when it lands on the committed-but-still-
 * loading provider document; if it lands on a transient about:blank
 * / chrome://newtab document the navigation tears down, the
 * widget dies with it and we fall back to today's "delay before
 * widget appears" behaviour. The caller's bridge + re-mount call
 * after `waitForTabComplete` covers that case — `mountAskWidget`
 * is idempotent and the second mount sees the same record.
 */
async function openNewProviderTabWithPlaceholder(
  provider: AskProvider,
  recordTemplate: Omit<AskWidgetRecord, 'status' | 'runId' | 'updatedAt'>,
): Promise<number> {
  const created = await chrome.tabs.create({
    url: provider.newTabUrl,
    active: true,
  });
  if (created.id === undefined) {
    throw new Error('Could not create new tab');
  }
  const tabId = created.id;
  // Write the placeholder record before the early widget mount so
  // the widget reads `status: 'placeholder'` on its first paint
  // (status section reads "Waiting for <provider> to load…", no
  // orchestration walk).
  void writeWidgetRecord(tabId, {
    ...recordTemplate,
    status: 'placeholder',
    runId: Date.now(),
    updatedAt: Date.now(),
  }).catch(() => {
    // Best-effort placeholder. The promote-to-injecting write below
    // re-creates the record if this fails.
  });
  void mountAskWidgetOnFirstLoading(tabId);
  await waitForTabComplete(tabId, NEW_TAB_LOAD_TIMEOUT_MS);
  return tabId;
}

/**
 * Best-effort early widget mount: listen for the new tab's first
 * `'loading'` event and run `mountAskWidget` against it. The
 * widget reads the `placeholder` record the SW just wrote and
 * paints the placeholder UI. No bridge yet — the placeholder
 * doesn't post bridge requests; the bridge is loaded in the
 * caller after `waitForTabComplete`.
 *
 * Failures are swallowed: if the script never fires (tab closed,
 * executeScript races the navigation), we just fall back to the
 * post-load mount. The mount is idempotent so doing it twice is
 * harmless.
 */
function mountAskWidgetOnFirstLoading(tabId: number): void {
  const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
    if (id !== tabId) return;
    if (info.status !== 'loading' && info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    void mountAskWidget(tabId).catch(() => {
      // Swallow — see comment above.
    });
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  // Self-clean: if no 'loading' event ever fires (e.g. the tab
  // closes before navigation starts), drop the listener after the
  // load timeout so it doesn't accumulate.
  setTimeout(
    () => chrome.tabs.onUpdated.removeListener(onUpdated),
    NEW_TAB_LOAD_TIMEOUT_MS,
  );
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

/**
 * User-facing message for any failure of the
 * `chrome.scripting.executeScript` calls that load the bridge and
 * mount the widget. Every error reaching this point is Chrome's
 * own — not ours — and they're all implementation-leaking AND
 * locale-translated. The known cases all share the same
 * user-actionable resolution (verify the tab is on a real prompt
 * page) so we collapse them into one message.
 *
 * Known underlying messages from Chrome (English; other locales
 * differ):
 *   - "Cannot access contents of the page. Extension manifest must
 *      request permission to access the respective host."
 *      → restricted URL (chrome://, Web Store) or crashed/error page.
 *   - "The tab was closed." / "No frame with id X in tab Y."
 *      → tab closed or frame gone.
 *   - "Frame with ID 0 was removed."
 *      → SPA navigation tore down the frame.
 *
 * The raw error is logged for debugging via the SW console (open
 * via chrome://extensions → the extension's "service worker" link).
 * Errors from our own MAIN-world helpers don't reach this path —
 * they come back over the bridge, get marked as per-item failures,
 * and surface through `summarizeErrors`.
 */
function friendlyInjectError(err: unknown): string {
  // `console.log` rather than `console.warn` to match the
  // convention in `ask-inject.ts` / `ask-widget.ts`: warnings
  // surface as actionable items at chrome://extensions and
  // crowd out user-facing problems with internal noise. The
  // `[warn]` prefix keeps the bad-path lines visually distinct
  // when reading the SW console.
  console.log('[SeeWhatISee] [warn] Inject error:', describe(err));
  return 'Check if the tab is on a prompt screen.';
}

interface AskMessage {
  action:
    | 'askAi'
    | 'askAiDefault'
    | 'askListProviders'
    | 'askSetDefault';
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
 * - `askSetDefault` — apply a menu pick as the new default
 *   destination (writes the pin or the preferred-new-tab provider).
 *   Doesn't send; the page fires the actual Ask on the next click
 *   of `#ask-btn`.
 * - `askAi` — send to a specific destination, bypassing the
 *   resolved default. Used by the per-provider Ask <X> buttons.
 *   `sendToAi` still pins the destination on success, so a
 *   per-provider send shifts the default for the next plain-Ask.
 * - `askAiDefault` — resolve + send to the current default. Lets
 *   the page invoke pin-or-fallback in one round-trip.
 *
 * Installed once from background.ts.
 *
 * Placeholder-dismiss cancellation doesn't go through here — the
 * widget's × handler simply clears its storage record, which the
 * SW reads after the new-tab page-load wait. Storage-based rather
 * than runtime messages so the cancel is fully ordered against
 * the SW's read.
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
              defaultAcceptedAttachmentKinds:
                resolution.destinationAcceptedAttachmentKinds,
              defaultDestinationDisplayName: resolution.destinationDisplayName,
            }),
        );
        return true;
      }
      if (msg?.action === 'askSetDefault') {
        if (!msg.destination) {
          sendResponse({ ok: false, error: 'Missing destination' });
          return false;
        }
        void setAskDefault(msg.destination)
          .then(() => sendResponse({ ok: true }))
          .catch((err: unknown) => {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });
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
