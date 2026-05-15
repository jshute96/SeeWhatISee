// User-facing Ask provider preferences: which providers are enabled
// and which one is the default destination when there's no pinned tab.
//
// Stored under the `askProviderSettings` key in `chrome.storage.local`.
// Read on every menu render / Ask resolution; written from the Options
// page.
//
// Two invariants are maintained on every read AND write via `normalize`:
//
//   1. `enabled` has a boolean entry for every registered provider id
//      (missing entries fall back to the factory default).
//   2. `default` is either null or the id of an enabled provider. If
//      the stored default points at a now-disabled provider, normalize
//      auto-shifts it to the next enabled provider in label-order
//      (wrapping); if no provider is enabled, default becomes null.
//
// Keeping the auto-shift on the SW side means a stale settings object
// (e.g. from an old build, or one written by a buggy options page)
// can't put the Ask flow into "the default points at a disabled
// provider" purgatory.

import type { AskProviderId } from './providers.js';

export interface AskProviderSettings {
  enabled: Record<AskProviderId, boolean>;
  /**
   * Provider used by plain Ask when no pinned tab applies. Null only
   * when every provider is disabled. The Options page renders the
   * Default radios as greyed-out in that state and re-elects the next
   * provider the user enables.
   */
  default: AskProviderId | null;
}

const PROVIDER_IDS: AskProviderId[] = ['claude', 'gemini', 'chatgpt', 'google'];

/**
 * Provider id order used for "next enabled" default-shifting.
 * Matches the alphabetical-by-label order the Options page renders
 * (ChatGPT, Claude, Gemini, Google). Hard-coded rather than derived
 * from `ASK_PROVIDERS` so e2e tests that swap the registry to a
 * single fake provider don't change the rotation order.
 *
 * Kept in sync with the page-side rotation in `src/options.ts`
 * (`pickNextEnabledAskDefault`), which sorts by label. Today both
 * routes resolve to `[chatgpt, claude, gemini, google]` because the
 * labels happen to be alphabetical-by-id; if we ever add a provider
 * whose label breaks that property, both sides need to converge —
 * see the matching note on the page-side helper.
 */
const DEFAULT_ROTATION: AskProviderId[] = ['chatgpt', 'claude', 'gemini', 'google'];

const STORAGE_KEY = 'askProviderSettings';

export const DEFAULT_ASK_PROVIDER_SETTINGS: AskProviderSettings = {
  enabled: { claude: true, gemini: true, chatgpt: true, google: true },
  default: 'claude',
};

/**
 * Pick the next enabled provider in `DEFAULT_ROTATION` order, starting
 * one slot after `from` and wrapping around. Returns null if no
 * provider is enabled. Pass `from = null` to start from the top of
 * the rotation (used when the previous default was already null).
 */
export function pickNextEnabledDefault(
  from: AskProviderId | null,
  enabled: Record<AskProviderId, boolean>,
): AskProviderId | null {
  const list = DEFAULT_ROTATION;
  const startIdx =
    from === null ? 0 : Math.max(0, list.indexOf(from) + 1);
  for (let i = 0; i < list.length; i++) {
    const id = list[(startIdx + i) % list.length];
    if (enabled[id]) return id;
  }
  return null;
}

function freshDefaults(): AskProviderSettings {
  return {
    enabled: { ...DEFAULT_ASK_PROVIDER_SETTINGS.enabled },
    default: DEFAULT_ASK_PROVIDER_SETTINGS.default,
  };
}

export function normalizeAskProviderSettings(raw: unknown): AskProviderSettings {
  if (!raw || typeof raw !== 'object') return freshDefaults();
  const r = raw as {
    enabled?: Partial<Record<AskProviderId, unknown>>;
    default?: unknown;
  };
  const enabled = { ...DEFAULT_ASK_PROVIDER_SETTINGS.enabled };
  for (const id of PROVIDER_IDS) {
    const v = r.enabled?.[id];
    if (typeof v === 'boolean') enabled[id] = v;
  }
  // When the stored default is missing/invalid, seed with the factory
  // default before validation so a partial / never-saved settings
  // object lands on Claude (the factory pick) rather than the first
  // entry in alphabetical rotation. If the factory default is itself
  // disabled in the stored `enabled` map, the rotation step below
  // shifts past it.
  let def: AskProviderId | null = DEFAULT_ASK_PROVIDER_SETTINGS.default;
  if (
    typeof r.default === 'string'
    && PROVIDER_IDS.includes(r.default as AskProviderId)
  ) {
    def = r.default as AskProviderId;
  }
  // Default must point at an enabled provider; fall through to the
  // rotation if not. Passing `def` (rather than null) when the stored
  // default is disabled keeps the shift "after where the default
  // used to be" — matches what the Options page does on disable.
  if (def === null || !enabled[def]) {
    def = pickNextEnabledDefault(def, enabled);
  }
  return { enabled, default: def };
}

export async function getAskProviderSettings(): Promise<AskProviderSettings> {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeAskProviderSettings(got[STORAGE_KEY]);
}

export async function setAskProviderSettings(
  value: AskProviderSettings,
): Promise<void> {
  // Re-normalize on write so a partial / dirty payload from the
  // Options page can't poison storage.
  const clean = normalizeAskProviderSettings(value);
  await chrome.storage.local.set({ [STORAGE_KEY]: clean });
}
