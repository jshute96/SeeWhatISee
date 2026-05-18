// Ask flow on the Capture page — the "send the staged capture to an
// AI on the web" half of the page. Wires the horizontal Ask button
// row (`.button-row`, wraps to multiple lines on a narrow viewport),
// the destination-picker menu, the cross-tab storage listener, and
// the send + pre-send-guard pipeline. `initAsk(ctx)` is the only
// entry point; everything else closes over the ctx binding at
// module scope.
//
// Three button kinds in source order after `#capture`:
//   - `#ask-btn`   ("Ask <provider>") resolves the default
//                    destination via the SW (pinned tab if alive,
//                    else preferred-new-tab provider, else the
//                    user's Options-page default) and sends to
//                    it. Carries Alt+A. Sits inside `.ask-split`
//                    paired with #ask-menu-btn — they share a
//                    visual chrome (split button).
//   - `#ask-menu-btn` chevron-only sliver attached to #ask-btn.
//                    Opens the destination-picker menu. Picking
//                    a row updates the default (pin / preferred
//                    new-tab provider) and refreshes the labels —
//                    does NOT send.
//   - `.ask-provider-btn` favicon-only squares appended into
//                    `.button-row` by `refreshAskTargetLabel`,
//                    one per enabled provider. Each click sends
//                    straight to a new tab on that provider —
//                    quick override that doesn't first walk
//                    through the menu's "set default"
//                    intermediate. Identified by the bundled
//                    brand logo (`AskProvider.iconFilename` →
//                    `chrome.runtime.getURL('icons/<file>')`).
//
// Every button kind honours the shift/ctrl modifier semantics:
// shift-click keeps the page open, ctrl-click closes it on success
// (Ask-side close leaves focus on the destination provider tab).
//
// The payload is built from the Capture-page state the Capture
// button reads. The SW handles tab focus + script injection, and
// pins the chosen destination on every successful send so the next
// plain-Ask reuses the same tab.

import type { AskProviderId } from '../ask/providers.js';
import { excludedSuffix } from '../url-helpers.js';

// `SelectionFormat` and `EditableArtifactKind` are inlined here for
// the same reason capture-page.ts inlines them: keeping the page's
// payload contract independent of the SW module. Must stay in sync
// with the canonical declarations in `src/capture.ts` and
// `src/background.ts`.
type SelectionFormat = 'html' | 'text' | 'markdown';
type EditableArtifactKind =
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

/**
 * Everything the Ask module needs from the rest of the Capture page.
 * Passed once at init time; all internal Ask functions close over
 * `ctx` from module scope.
 */
export interface AskContext {
  // DOM refs read at send / pre-send time.
  screenshotBox: HTMLInputElement;
  htmlBox: HTMLInputElement;
  promptInput: HTMLTextAreaElement;
  /** Page-card title anchor — its text is sent as `sourceTitle`. */
  capturedTitleLink: HTMLAnchorElement;

  /** Live mirror of the SW's captured bodies, keyed by artifact kind.
   *  Reference is stable; contents mutate as the user edits. */
  captured: Record<EditableArtifactKind, string>;
  /** Captured page URL. Getter because it's a `let` that loadData()
   *  populates after the SW round-trip. */
  getCapturedUrl(): string;

  /** Returns the selection format to save right now, or null when no
   *  selection is being saved. Reads the master checkbox + radios. */
  selectedSelectionFormat(): SelectionFormat | null;

  /** Page-wide status slot — shared with the Capture flow. */
  setStatusMessage(text: string, kind: 'ok' | 'error' | 'info'): void;

  /** Bake helpers — see `renderHighlightedImage` / `bakeMime` /
   *  `bakeExt` docstrings in capture-page.ts. */
  renderHighlightedImage(forceMime?: 'image/png' | 'image/jpeg'): string;
  bakeMime(): 'image/png' | 'image/jpeg';
  bakeExt(): 'png' | 'jpg';

  /** Shared modifier semantics for Capture and Ask buttons. */
  closeAfterFromModifiers(e: MouseEvent, defaultClose: boolean): boolean;

  /** Apply the "default action" highlight ring to one of the two
   *  main buttons (used by the cross-tab capturePageDefaults
   *  listener below). */
  applyDefaultButtonHighlight(which: 'capture' | 'ask'): void;

  /** Update the prompt's Enter-key behaviour (used by the same
   *  cross-tab listener as above). */
  setPromptEnter(value: 'send' | 'newline'): void;

  /** Map from `SelectionFormat` to its wire kind. Const reference,
   *  passed once. */
  selectionWireKind: Record<SelectionFormat, EditableArtifactKind>;

  /** Flush any pending debounced last-capture `pushUiState` so the
   *  SW promotes the freshest UI state when the Ask close path
   *  fires. Called right before the askAi `sendMessage` so the
   *  promote inside `closeCapturePage` (ctrl-click only) carries
   *  the same prompt / drawing the user just sent. Plain Ask
   *  (stay-open) doesn't strictly need this but the call is cheap
   *  enough that both paths share one branch. */
  flushLastCapturePush(): void;
}

interface AskTabSummary {
  tabId: number;
  title: string;
  url: string;
  /** Tab is on the provider's host but on a non-chat page (settings,
   *  library, recents, etc.) — rendered disabled with a "(Wrong
   *  page)" suffix. */
  excluded?: boolean;
  /** URL-aware accepted-kinds list. `undefined` = no restriction. */
  acceptedAttachmentKinds?: ('image' | 'text')[];
  /** Per-turn attachment cap. `undefined` = no cap. */
  maxAttachmentCount?: number;
  /** Display name used in pre-send error text (variant label or the
   *  provider's own label). Always set by the SW. */
  destinationDisplayName: string;
}
interface AskProviderListing {
  id: AskProviderId;
  label: string;
  enabled: boolean;
  /** Bundled logo filename under the extension's `icons/` dir
   *  (e.g. `claude.svg`). The page resolves it via
   *  `chrome.runtime.getURL` and uses the result as the `<img>`
   *  src on the per-provider Ask button — those buttons carry
   *  no text label, so the bundled logo is what identifies
   *  each one visually. */
  iconFilename: string;
  existingTabs: AskTabSummary[];
  newTabAcceptedAttachmentKinds?: ('image' | 'text')[];
  /** Provider-default attachment cap for the "New tab in <X>" row.
   *  `undefined` = no cap. */
  newTabMaxAttachmentCount?: number;
}
type AskDestination =
  | { kind: 'newTab'; provider: AskProviderId }
  | { kind: 'existingTab'; provider: AskProviderId; tabId: number };

interface AskStatePin {
  provider: AskProviderId;
  tabId: number;
}

interface AskAttachment {
  data: string;
  kind: 'image' | 'text';
  mimeType: string;
  filename: string;
}

const SELECTION_FILE_META: Record<
  SelectionFormat,
  { filename: string; mimeType: string }
> = {
  html: { filename: 'selection.html', mimeType: 'text/html' },
  text: { filename: 'selection.txt', mimeType: 'text/plain' },
  markdown: { filename: 'selection.md', mimeType: 'text/markdown' },
};

// Module-level state. Populated in `initAsk` and read by every
// internal function. Holding ctx in a single binding (rather than
// destructuring at init) keeps callsites self-documenting
// (`ctx.setStatusMessage(...)`) and avoids the
// rebind-on-every-function cost.
let ctx: AskContext;

// DOM refs are resolved in `initAsk` so the module loads before the
// DOM is queried — keeps `await import(...)`-driven test wiring
// simple if it ever becomes useful.
let askBtn: HTMLButtonElement;
let askMenuBtn: HTMLButtonElement;
let askMenu: HTMLDivElement;
let askMenuList: HTMLUListElement;
let askTargetLabel: HTMLSpanElement;
let askBtnIcon: HTMLSpanElement;
// Per-provider Ask buttons are appended directly into `.button-row`
// (not a wrapper div) so they're real flex children of the row —
// `display: contents` wrappers can perturb the row's `gap` math
// and visually unbalance the spacing between buttons.
let askButtonRow: HTMLDivElement;

/**
 * Cached accepted-kinds list + display name for the default
 * destination. Populated by `refreshAskTargetLabel` and consulted by
 * `runAskDefault` so we can pre-validate the user's checkbox state
 * before round-tripping to the SW. `undefined` kinds means "no
 * restriction" (the common case); the only restricted destination
 * today is Claude on `/code`.
 */
let currentDefaultAcceptedKinds: ('image' | 'text')[] | undefined;
let currentDefaultMaxAttachmentCount: number | undefined;
let currentDefaultDisplayName: string | undefined;

// Tracks the deferred-listener-attach `setTimeout` (see openAskMenu).
// closeAskMenu() clears it so a close that happens *before* the timer
// fires doesn't leak listener attaches against an already-hidden menu.
let askListenerAttachTimer: ReturnType<typeof setTimeout> | null = null;

// Swap the trailing glyph on #ask-btn between the pin (existing
// pinned tab) and new-window glyphs so the user sees at a glance
// which path plain-Ask is about to take. Falls back to the
// new-window glyph when no destination has resolved yet — that's
// what plain-Ask will do once a provider is enabled.
//
// The pin state renders the 📌 emoji directly (text node). The
// page's web font stack picks up the system color-emoji font so
// it renders red/colorful here; the toolbar context-menu uses
// ☐ / ☑ ballot-box glyphs instead because native menu rendering
// on Linux falls back to a monochrome thin glyph for 📌. The
// new-window state uses the bare `↗` codepoint (U+2197, no
// variation selector) — that's the *text* presentation, so it
// inherits `.ask-row-icon`'s `color: #060` and renders as a green
// arrow matching the green indicators in the Ask dropdown menu.
// The emoji-presentation form (`↗️`) would render as a fixed
// blue glyph the page can't restyle.
function setAskBtnIcon(kind: 'pin' | 'new-window'): void {
  askBtnIcon.textContent = kind === 'pin' ? '📌' : '↗';
}

/**
 * Read the providers + the resolved default destination from the
 * SW. The default is what plain-Ask will target right now (pinned
 * tab if alive, else the first enabled provider's new tab). One
 * round-trip serves both menu rendering and label refreshes; the
 * menu open path keeps the providers and the simpler refreshes
 * just look at `defaultDestination`.
 */
async function fetchAskState(): Promise<{
  providers: AskProviderListing[];
  defaultDestination: AskDestination | null;
  /** Pin landed on a tab that's still alive on the provider's host
   *  but on a wrong (excluded) page. The menu greys-out the check
   *  on that row alongside the regular green check on whatever
   *  `defaultDestination` resolved to instead. */
  staleTabPin: AskStatePin | null;
  /** Effective accepted attachment kinds at the resolved default
   *  destination, or `undefined` for "no restriction." Used by plain
   *  Ask's pre-send check. */
  defaultAcceptedKinds: ('image' | 'text')[] | undefined;
  /** Per-turn attachment cap at the resolved default destination, or
   *  `undefined` for "no cap." Used by plain Ask's pre-send count
   *  check (refuses sends that would exceed e.g. ChatGPT's max of 2). */
  defaultMaxAttachmentCount: number | undefined;
  /** Display name (variant label or provider label) of the resolved
   *  default destination — used in the pre-send refusal message. */
  defaultDestinationDisplayName: string | undefined;
}> {
  try {
    const response = (await chrome.runtime.sendMessage({
      action: 'askListProviders',
    })) as
      | {
          providers: AskProviderListing[];
          defaultDestination: AskDestination | null;
          staleTabPin?: AskStatePin;
          defaultAcceptedAttachmentKinds?: ('image' | 'text')[];
          defaultMaxAttachmentCount?: number;
          defaultDestinationDisplayName?: string;
        }
      | undefined;
    return {
      providers: response?.providers ?? [],
      defaultDestination: response?.defaultDestination ?? null,
      staleTabPin: response?.staleTabPin ?? null,
      defaultAcceptedKinds: response?.defaultAcceptedAttachmentKinds,
      defaultMaxAttachmentCount: response?.defaultMaxAttachmentCount,
      defaultDestinationDisplayName: response?.defaultDestinationDisplayName,
    };
  } catch {
    return {
      providers: [],
      defaultDestination: null,
      staleTabPin: null,
      defaultAcceptedKinds: undefined,
      defaultMaxAttachmentCount: undefined,
      defaultDestinationDisplayName: undefined,
    };
  }
}

// Sync the "Ask <provider>" button label + tooltip to the resolved
// default destination. Called at page load and after every Ask
// (since pin-on-success can swap the active provider). Failures
// here are silent — the static HTML default ("Ask Claude") is a
// safe fallback.
async function refreshAskTargetLabel(): Promise<void> {
  const {
    providers,
    defaultDestination,
    defaultAcceptedKinds,
    defaultMaxAttachmentCount,
    defaultDestinationDisplayName,
  } = await fetchAskState();
  currentDefaultAcceptedKinds = defaultAcceptedKinds;
  currentDefaultMaxAttachmentCount = defaultMaxAttachmentCount;
  currentDefaultDisplayName = defaultDestinationDisplayName;
  // `listAskProviders` already filters out user-disabled providers,
  // so an empty (or all-statically-disabled) listing means the user
  // has nothing to Ask. Block every Ask row (menu opener, default,
  // per-provider) until they re-enable a provider on the Options
  // page. Drop the per-provider buttons too — they're built fresh
  // from the enabled-provider list right after.
  const enabled = providers.filter((p) => p.enabled);
  const noProvidersTooltip = 'No Ask providers enabled; Update in Options';
  renderAskProviderButtons(enabled);
  if (enabled.length === 0) {
    askBtn.disabled = true;
    askMenuBtn.disabled = true;
    askBtn.title = noProvidersTooltip;
    askMenuBtn.title = noProvidersTooltip;
    askTargetLabel.textContent = 'AI';
    setAskBtnIcon('new-window');
    return;
  }
  // At least one provider is available — re-enable the rows (a
  // previous "all disabled" render may have disabled them) and pick
  // a label/tooltip from the resolved default.
  askBtn.disabled = false;
  askMenuBtn.disabled = false;
  askMenuBtn.title = 'Choose Ask target tab';
  if (defaultDestination) {
    const provider = providers.find((p) => p.id === defaultDestination.provider);
    if (provider) {
      askTargetLabel.textContent = provider.label;
      const verb = defaultDestination.kind === 'existingTab'
        ? 'Send to existing'
        : 'Send to new';
      askBtn.title = `${verb} ${provider.label} tab`;
      setAskBtnIcon(defaultDestination.kind === 'existingTab' ? 'pin' : 'new-window');
      return;
    }
  }
  // No default available — fall back to a generic label. Plain-Ask
  // will open a new tab in this state, so the new-window glyph
  // matches what's about to happen.
  setAskBtnIcon('new-window');
  if (enabled.length === 1) {
    askTargetLabel.textContent = enabled[0].label;
    askBtn.title = `Send to ${enabled[0].label} on web`;
  } else {
    askTargetLabel.textContent = 'AI';
    askBtn.title = 'Send to an AI on web';
  }
}

/**
 * Rebuild the per-provider Ask button rows under the default Ask
 * button — one "Ask <Label>" button per enabled provider, each
 * sending straight to a new tab on that provider. Modifier keys
 * follow the same shift/ctrl rules as the default Ask row.
 *
 * Re-rendered on every `refreshAskTargetLabel` so the row set
 * tracks the live `askProviderSettings` (Options-page enable
 * toggles, cross-tab storage events). For an empty list the
 * container is left empty and CSS collapses it to zero height.
 *
 * Rebuild during an in-flight Ask is safe: the click handler
 * captures `dest` / `acceptedKinds` / `provider.label` from the
 * closure of the *outgoing* button, so a click that lands on the
 * about-to-be-replaced button still fires `runAskFor` correctly,
 * and `runAskFor` immediately disables every button via
 * `setAskProviderButtonsDisabled` on entry. Subsequent
 * `replaceChildren` removes the now-detached old button without
 * affecting the in-flight async call.
 */
function renderAskProviderButtons(enabled: AskProviderListing[]): void {
  // Wipe the previous render's per-provider buttons (identified by
  // class) without disturbing the static `#capture` / `.ask-split`
  // children. Then append the fresh set into `.button-row` so each
  // new button is a direct flex child of the row.
  askButtonRow
    .querySelectorAll('.ask-provider-btn')
    .forEach((el) => el.remove());
  for (const provider of enabled) {
    const dest: AskDestination = { kind: 'newTab', provider: provider.id };
    const btn = document.createElement('button');
    btn.type = 'button';
    // Compact square button — no text label, just the destination
    // site's favicon. Visual identification of each provider via
    // the favicon people already recognise from the address bar
    // beats spelling out "Ask Claude / Ask Gemini / …" alongside
    // the existing default-Ask row that already says it.
    btn.className = 'btn ask-provider-btn';
    btn.title = `Ask ${provider.label} in new tab`;
    btn.setAttribute('aria-label', `Ask ${provider.label} in new tab`);
    const favicon = document.createElement('img');
    // Bundled logo from `src/icons/` (built into `dist/icons/`
    // by `scripts/build.mjs`). We download these once at
    // build-time rather than fetching `${origin}/favicon.ico`
    // because some providers' favicons require auth, redirect,
    // or 404 from a fresh extension context.
    favicon.src = chrome.runtime.getURL(`icons/${provider.iconFilename}`);
    favicon.alt = '';
    // Width/height attributes match the rendered size set by the
    // `.ask-provider-btn img` CSS rule, so layout is stable even
    // before the stylesheet has applied (e.g. on the very first
    // paint of a fresh tab). Update both together if either drifts.
    favicon.width = 20;
    favicon.height = 20;
    btn.appendChild(favicon);
    btn.addEventListener('click', (e) => {
      void runAskFor(
        dest,
        provider.newTabAcceptedAttachmentKinds,
        provider.newTabMaxAttachmentCount,
        provider.label,
        ctx.closeAfterFromModifiers(e, false),
      );
    });
    askButtonRow.appendChild(btn);
  }
}

function closeAskMenu(): void {
  askMenu.hidden = true;
  askMenuBtn.setAttribute('aria-expanded', 'false');
  if (askListenerAttachTimer !== null) {
    clearTimeout(askListenerAttachTimer);
    askListenerAttachTimer = null;
  }
  document.removeEventListener('click', onDocumentClickWhileAskOpen, true);
  document.removeEventListener('keydown', onKeydownWhileAskOpen, true);
}

function onDocumentClickWhileAskOpen(e: MouseEvent): void {
  // Outside-click dismiss. Clicks inside the menu still bubble through
  // to their item-handler (registered on each <li>) — closeAskMenu()
  // there happens *after* the click handler runs. The main Ask
  // button is *not* an outside-click here either: clicking it is a
  // direct send (which closes the menu via the explicit handler).
  const target = e.target as Node | null;
  if (
    askMenu.contains(target) ||
    askMenuBtn.contains(target) ||
    askBtn.contains(target)
  ) return;
  closeAskMenu();
}

function onKeydownWhileAskOpen(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAskMenu();
    askMenuBtn.focus();
  }
}

/**
 * Render a `<li>` for one menu pick. The first column is a fixed-
 * width check slot — `is-default` toggles whether the check glyph
 * is visible. Putting the slot on every item (rather than only on
 * the default one) keeps labels vertically aligned across the menu.
 */
function renderAskMenuItem(opts: {
  label: string;
  /** Italic text appended after the label — used to annotate why a
   *  disabled item is disabled (e.g. "(Wrong page)"). */
  suffix?: string;
  title?: string;
  /** Indicator-slot glyph for the active-default states. `'pin'`
   *  (default) for an existing pinned-tab row → 📌; `'new-window'`
   *  for the "New tab in <provider>" row → ↗. Ignored when
   *  `isStale` is true (stale rows always render ❗). */
  glyph?: 'pin' | 'new-window';
  isDefault: boolean;
  /** Marks a row whose tab used to be the pin but has since
   *  navigated to a wrong page. Renders ❗ (red) in the indicator
   *  slot, so the user sees where the pin *was* alongside where
   *  Ask is going *now*. Mutually exclusive with `isDefault` in
   *  practice (a stale pin can't also be the resolved default). */
  isStale?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'ask-menu-item';
  if (opts.isDefault) li.classList.add('is-default');
  if (opts.isStale) li.classList.add('is-stale');
  li.setAttribute('role', 'menuitem');
  if (opts.title) li.title = opts.title;
  const check = document.createElement('span');
  check.className = 'ask-menu-check';
  check.setAttribute('aria-hidden', 'true');
  // Glyph picked by row kind: existing-tab "default" rows show a
  // 📌 emoji (the tab is pinned); "stale" rows show a red ❗
  // (the row used to be the pin but has wandered onto a wrong
  // page — emoji-default red signals "something's off here" more
  // legibly than a faded crossed-out pin); new-window default
  // rows show a bare `↗` (U+2197) — the text-presentation arrow
  // inherits the slot's green `currentColor` so it visually pairs
  // with the green pin without clashing. `glyph` defaults to
  // `'pin'` so call sites that don't care (the check is hidden via
  // CSS unless is-default or is-stale anyway) can omit it.
  if (opts.isStale) {
    check.textContent = '❗';
  } else if ((opts.glyph ?? 'pin') === 'pin') {
    check.textContent = '📌';
  } else {
    check.textContent = '↗';
  }
  const labelEl = document.createElement('span');
  labelEl.className = 'ask-menu-label';
  labelEl.textContent = opts.label;
  li.append(check, labelEl);
  if (opts.suffix) {
    const suffixEl = document.createElement('span');
    suffixEl.className = 'ask-menu-suffix';
    suffixEl.textContent = ` ${opts.suffix}`;
    li.appendChild(suffixEl);
  }
  if (opts.disabled) {
    li.setAttribute('aria-disabled', 'true');
  } else {
    li.tabIndex = 0;
    if (opts.onClick) li.addEventListener('click', opts.onClick);
  }
  return li;
}

function isSameDestination(
  a: AskDestination | null,
  b: AskDestination,
): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.provider !== b.provider) return false;
  if (a.kind === 'existingTab' && b.kind === 'existingTab') {
    return a.tabId === b.tabId;
  }
  return true;
}

async function openAskMenu(): Promise<void> {
  if (!askMenu.hidden) {
    closeAskMenu();
    return;
  }
  askMenuList.replaceChildren();
  const loading = document.createElement('li');
  loading.className = 'ask-menu-heading';
  loading.textContent = 'Loading…';
  askMenuList.appendChild(loading);
  askMenu.hidden = false;
  askMenuBtn.setAttribute('aria-expanded', 'true');
  // Defer listener attach so the click that opened the menu doesn't
  // immediately close it on the same event-loop tick. Track the timer
  // and check `askMenu.hidden` at fire time so a close-before-fire
  // (Escape, programmatic toggle, etc.) doesn't leave dangling
  // listeners — closeAskMenu() also clears the pending timer.
  askListenerAttachTimer = setTimeout(() => {
    askListenerAttachTimer = null;
    if (askMenu.hidden) return;
    document.addEventListener('click', onDocumentClickWhileAskOpen, true);
    document.addEventListener('keydown', onKeydownWhileAskOpen, true);
  }, 0);

  const { providers, defaultDestination, staleTabPin } = await fetchAskState();
  // Bail if the user already closed the menu while we were waiting.
  if (askMenu.hidden) return;

  askMenuList.replaceChildren();
  if (providers.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'ask-menu-heading';
    empty.textContent = 'No providers configured';
    askMenuList.appendChild(empty);
    return;
  }

  // Section 1: "New tab in <provider>" — one entry per registered
  // provider, including disabled ones (rendered as "coming soon").
  const newHeading = document.createElement('li');
  newHeading.className = 'ask-menu-heading';
  newHeading.textContent = 'New tab in';
  askMenuList.appendChild(newHeading);
  for (const provider of providers) {
    const dest: AskDestination = { kind: 'newTab', provider: provider.id };
    askMenuList.appendChild(
      renderAskMenuItem({
        label: provider.enabled
          ? provider.label
          : `${provider.label} (coming soon)`,
        glyph: 'new-window',
        isDefault: provider.enabled
          ? isSameDestination(defaultDestination, dest)
          : false,
        disabled: !provider.enabled,
        onClick: provider.enabled
          ? () => {
              closeAskMenu();
              void setAskDefaultDestination(dest);
            }
          : undefined,
      }),
    );
  }

  // Section 2..N: "Existing tab in <provider>" — only rendered for
  // providers with at least one matching tab open. Each section gets
  // a horizontal separator before its heading so the menu visually
  // segments into "new tabs" vs. each "existing tabs" group.
  //
  // If no provider has any existing tabs, fall through to a single
  // "Existing tabs" heading with a disabled "No existing tabs" row,
  // so the menu always reflects both axes (new vs. existing) and
  // doesn't make the user wonder whether the section is missing or
  // simply empty.
  const anyExistingTabs = providers.some(
    (p) => p.enabled && p.existingTabs.length > 0,
  );
  if (!anyExistingTabs) {
    const sep = document.createElement('li');
    sep.className = 'ask-menu-separator';
    sep.setAttribute('role', 'separator');
    askMenuList.appendChild(sep);
    const heading = document.createElement('li');
    heading.className = 'ask-menu-heading';
    heading.textContent = 'Existing tabs';
    askMenuList.appendChild(heading);
    askMenuList.appendChild(
      renderAskMenuItem({
        label: 'No existing tabs',
        isDefault: false,
        disabled: true,
      }),
    );
  }
  for (const provider of providers) {
    if (!provider.enabled || provider.existingTabs.length === 0) continue;
    const sep = document.createElement('li');
    sep.className = 'ask-menu-separator';
    sep.setAttribute('role', 'separator');
    askMenuList.appendChild(sep);
    const heading = document.createElement('li');
    heading.className = 'ask-menu-heading';
    heading.textContent = `Existing tab in ${provider.label}`;
    askMenuList.appendChild(heading);
    for (const tab of provider.existingTabs) {
      const dest: AskDestination = {
        kind: 'existingTab',
        provider: provider.id,
        tabId: tab.tabId,
      };
      askMenuList.appendChild(
        renderAskMenuItem({
          label: tab.title || tab.url || `Tab ${tab.tabId}`,
          // Excluded tabs (settings, library, recents, etc.) live on
          // the provider's host but aren't a valid Ask target. Show
          // them disabled so the user can see the tab is recognised
          // — just not pickable — and explain why with the suffix.
          // For valid targets we leave the suffix off; the page
          // title already disambiguates sub-products like Claude
          // Code, which sets `<title>Claude Code</title>`.
          suffix: tab.excluded ? excludedSuffix(tab.url) : undefined,
          title: tab.url,
          isDefault: !tab.excluded
            && isSameDestination(defaultDestination, dest),
          // Pin used to point here but the tab navigated to a wrong
          // page. Both checks (greyed-here, fresh-on-the-fallback)
          // appear together so the user can see what just happened.
          isStale: staleTabPin?.provider === provider.id
            && staleTabPin.tabId === tab.tabId,
          disabled: tab.excluded,
          onClick: tab.excluded
            ? undefined
            : () => {
                closeAskMenu();
                void setAskDefaultDestination(dest);
              },
        }),
      );
    }
  }
}

/**
 * Apply a menu pick as the new Ask default and refresh the button
 * label to match. Doesn't send — the menu is a default-picker, not
 * a sender. The next click on `#ask-btn` (or Alt+A) does the send
 * against this newly-set default.
 *
 * Disables both Ask buttons for the duration of the SW round-trip
 * so a fast follow-up click on `#ask-btn` can't fire an
 * `askAiDefault` message that arrives at the SW before the
 * `askSetDefault` write lands — the page-side disable forces the
 * second click to wait for the first to settle.
 * `refreshAskTargetLabel` re-enables the buttons in the finally
 * block based on the now-resolved state.
 *
 * Failures are surfaced in the ask-status line; the button label
 * still gets a refresh attempt either way so a partial write
 * (pin set, label fetch failed) doesn't lie about the resolved
 * default.
 */
async function setAskDefaultDestination(destination: AskDestination): Promise<void> {
  askBtn.disabled = true;
  askMenuBtn.disabled = true;
  setAskProviderButtonsDisabled(true);
  try {
    const response = (await chrome.runtime.sendMessage({
      action: 'askSetDefault',
      destination,
    })) as { ok?: boolean; error?: string } | undefined;
    if (!response?.ok) {
      ctx.setStatusMessage(response?.error ?? 'Failed to set default.', 'error');
    } else {
      // Clear any lingering error from a previous Ask so the new
      // default-set isn't visually shouted at by stale red text.
      ctx.setStatusMessage('', 'info');
    }
  } catch (err) {
    ctx.setStatusMessage(
      `Failed to set default: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  } finally {
    await refreshAskTargetLabel();
  }
}

function buildAskAttachments(): AskAttachment[] {
  const out: AskAttachment[] = [];
  if (ctx.screenshotBox.checked && !ctx.screenshotBox.disabled) {
    // Bake current edits into the image when there are any — Ask uses
    // the same on-screen state the user is looking at, mirroring the
    // Capture button's bake-on-save policy. `renderHighlightedImage`
    // short-circuits to the original capture's data URL when no edits
    // need baking and the source format already matches `bakeMime`.
    // Mime + extension stay in sync via `bakeMime`/`bakeExt` so a JPG
    // source stays JPG end-to-end (sticky output format).
    const data = ctx.renderHighlightedImage();
    const mime = ctx.bakeMime();
    out.push({
      data,
      kind: 'image',
      mimeType: mime,
      filename: `screenshot.${ctx.bakeExt()}`,
    });
  }
  if (ctx.htmlBox.checked && !ctx.htmlBox.disabled && ctx.captured.html) {
    out.push({
      data: ctx.captured.html,
      kind: 'text',
      mimeType: 'text/html',
      // `contents.html` matches the Save-to-disk filename prefix
      // (`contents-<timestamp>.html`) so the HTML attachment in
      // the AI tab and the saved-on-disk file share a name.
      filename: 'contents.html',
    });
  }
  const fmt = ctx.selectedSelectionFormat();
  if (fmt) {
    const body = ctx.captured[ctx.selectionWireKind[fmt]];
    if (body && body.trim().length > 0) {
      const meta = SELECTION_FILE_META[fmt];
      out.push({
        data: body,
        kind: 'text',
        mimeType: meta.mimeType,
        filename: meta.filename,
      });
    }
  }
  return out;
}

/**
 * Build the Ask payload from current Capture-page state. Returns
 * `null` (with a status message already shown) when the user has
 * neither a prompt nor any checked Save row to send — guards against
 * silently focusing the AI tab and doing nothing. The caller skips
 * the SW round-trip in that case.
 */
function buildAskPayload(): {
  attachments: AskAttachment[];
  promptText: string;
  autoSubmit: boolean;
  sourceUrl: string;
  sourceTitle: string;
} | null {
  const promptText = ctx.promptInput.value.trim();
  const attachments = buildAskAttachments();
  if (attachments.length === 0 && promptText.length === 0) {
    ctx.setStatusMessage(
      'Nothing to send — check at least one box or type a prompt.',
      'error',
    );
    return null;
  }
  const url = ctx.getCapturedUrl();
  return {
    attachments,
    promptText,
    // Empty prompt → user wants to set up the conversation and keep
    // typing on the AI side. Non-empty → fire it off.
    autoSubmit: promptText.length > 0,
    // Source-page metadata for the in-page widget's Page section.
    // The widget needs both URL and title to mirror the Capture-page
    // card; the widget falls back gracefully if either is empty.
    sourceUrl: url,
    sourceTitle: ctx.capturedTitleLink.textContent ?? url,
  };
}

/**
 * Send the assembled payload via the SW and reflect the outcome
 * in the Ask status line. Disables both halves of the split button
 * while in flight so a double-press can't queue a second send. On
 * success, refresh the button label since the SW may have just
 * pinned a different destination.
 */
async function runAskWithMessage(
  message: ({
    action: 'askAiDefault';
  } | {
    action: 'askAi';
    destination: AskDestination;
  }) & {
    payload: NonNullable<ReturnType<typeof buildAskPayload>>;
  },
  closeAfter: boolean,
): Promise<void> {
  askBtn.disabled = true;
  askMenuBtn.disabled = true;
  setAskProviderButtonsDisabled(true);
  ctx.setStatusMessage('Sending…', 'info');
  // Push the freshest UI state to the SW before the round-trip so a
  // ctrl-click close — which fires `closeCapturePage` and promotes
  // the session to `lastCapture` — picks up the latest prompt /
  // drawing without waiting for the page-side debounce to flush.
  ctx.flushLastCapturePush();
  try {
    const response = (await chrome.runtime.sendMessage(message)) as
      | { ok: boolean; error?: string; skipped?: string[] }
      | undefined;
    if (!response) {
      ctx.setStatusMessage('No response from background.', 'error');
      return;
    }
    if (!response.ok) {
      // The SW refuses payloads with attachments the destination
      // doesn't accept and reports them in `skipped` — append them
      // to the error so the user sees which files were the problem.
      // Normal flow catches this upstream in the page-side guard;
      // this path fires only when the page's cached accepted-kinds
      // was stale (toolbar Set/Unset or tab-navigation race).
      const skippedSuffix =
        response.skipped && response.skipped.length > 0
          ? ` Skipped: ${response.skipped.join(', ')}.`
          : '';
      ctx.setStatusMessage((response.error ?? 'Ask failed.') + skippedSuffix, 'error');
      return;
    }
    ctx.setStatusMessage('Sent.', 'ok');
    // Refresh after success: a successful Ask may have updated the
    // pin (sendToAi pins the destination on success), so the label
    // needs to reflect that.
    void refreshAskTargetLabel();
    // ctrl-click → close the Capture page now that the Ask landed.
    // Skipped on failure (the user keeps the page open as a
    // recovery surface — Copy/Download buttons are still here).
    if (closeAfter) {
      void chrome.runtime.sendMessage({ action: 'closeCapturePage' });
    }
  } catch (err) {
    ctx.setStatusMessage(
      `Ask failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  } finally {
    askBtn.disabled = false;
    askMenuBtn.disabled = false;
    setAskProviderButtonsDisabled(false);
    // Re-resolve the disabled state from the latest provider settings
    // so a mid-Ask Options-page change (e.g. user disabled every
    // provider while we were waiting on the SW) doesn't leave the
    // buttons re-enabled. The `chrome.storage.onChanged` listener
    // would also catch this on the next tick, but doing it here
    // closes the brief "buttons clickable but no providers" window.
    // refreshAskTargetLabel also re-renders the per-provider rows.
    void refreshAskTargetLabel();
  }
}

/** Toggle the disabled state of every per-provider button as a
 *  group. Used to gate the dynamic Ask <Provider> rows during an
 *  in-flight send / setDefault round-trip — same protection the
 *  static `#ask-btn` / `#ask-menu-btn` get. */
function setAskProviderButtonsDisabled(disabled: boolean): void {
  askButtonRow.querySelectorAll('.ask-provider-btn').forEach((btn) => {
    (btn as HTMLButtonElement).disabled = disabled;
  });
}

async function runAskDefault(closeAfter: boolean): Promise<void> {
  if (
    !checkDestinationAcceptsCheckedBoxes(
      currentDefaultAcceptedKinds,
      currentDefaultDisplayName,
    )
  ) return;
  if (
    !checkDestinationAttachmentCount(
      currentDefaultMaxAttachmentCount,
      currentDefaultDisplayName,
    )
  ) return;
  const payload = buildAskPayload();
  if (!payload) return;
  await runAskWithMessage({ action: 'askAiDefault', payload }, closeAfter);
}

/**
 * Send the staged payload to a specific destination. Used by the
 * per-provider Ask buttons (each one targets a new tab on a
 * specific provider) and any future caller that needs to override
 * the resolved default for a single send. Honours the same modifier
 * semantics as `runAskDefault` via the `closeAfter` parameter.
 */
async function runAskFor(
  destination: AskDestination,
  acceptedKinds: ('image' | 'text')[] | undefined,
  maxAttachmentCount: number | undefined,
  displayName: string | undefined,
  closeAfter: boolean,
): Promise<void> {
  if (!checkDestinationAcceptsCheckedBoxes(acceptedKinds, displayName)) return;
  if (!checkDestinationAttachmentCount(maxAttachmentCount, displayName)) return;
  const payload = buildAskPayload();
  if (!payload) return;
  await runAskWithMessage({ action: 'askAi', destination, payload }, closeAfter);
}

/**
 * Pre-send guard: refuse to send when the destination's composer
 * doesn't accept one of the kinds the user has checked. Today this
 * only fires for Claude on `/code` (image-only), but the check is
 * generic — any future image-only or text-only sub-page will benefit.
 *
 * On a mismatch we display an error naming the destination by its
 * variant label (e.g. "Claude Code") and the specific Save rows the
 * user needs to uncheck, and return false so the caller bails. The
 * SW runs the same check at send time and refuses outright (with
 * `Skipped: …` in the error) if anything slips through — covers
 * stale-cache races (toolbar Set/Unset or tab navigation between
 * cache load and click). `displayName` falls back to a generic
 * "Destination" if the SW didn't provide one (defensive — in
 * practice the listing always fills it in alongside any non-null
 * `acceptedKinds`).
 */
function checkDestinationAcceptsCheckedBoxes(
  acceptedKinds: ('image' | 'text')[] | undefined,
  displayName: string | undefined,
): boolean {
  if (!acceptedKinds || acceptedKinds.length === 0) return true;
  const allow = new Set(acceptedKinds);
  const offending: string[] = [];
  if (
    ctx.htmlBox.checked
    && !ctx.htmlBox.disabled
    && ctx.captured.html
    && !allow.has('text')
  ) {
    offending.push('Save HTML');
  }
  // Mirror buildAskAttachments's `body.trim().length > 0` gate — if
  // the selection radio is checked but the captured body is empty,
  // no attachment would be sent, so don't flag it as offending.
  const fmt = ctx.selectedSelectionFormat();
  if (fmt && !allow.has('text')) {
    const body = ctx.captured[ctx.selectionWireKind[fmt]];
    if (body && body.trim().length > 0) offending.push('Save selection');
  }
  if (
    ctx.screenshotBox.checked
    && !ctx.screenshotBox.disabled
    && !allow.has('image')
  ) {
    offending.push('Save screenshot');
  }
  if (offending.length === 0) return true;
  const list = offending.length === 1
    ? offending[0]
    : `${offending.slice(0, -1).join(', ')} and ${offending[offending.length - 1]}`;
  const kindList = formatAcceptedKinds(acceptedKinds);
  const name = displayName ?? 'Destination';
  ctx.setStatusMessage(
    `${name} only accepts ${kindList} attachments; uncheck ${list}.`,
    'error',
  );
  return false;
}

/**
 * Pre-send count guard: refuse when the user has checked more Save
 * rows than the destination's composer accepts per turn (ChatGPT
 * caps at 2). The SW runs the same check at send time, so reaching
 * here only matters for the up-front UX win — the user sees a
 * specific "uncheck a Save row" message before clicking through.
 *
 * Mirrors `buildAskAttachments`'s rules so the count matches what
 * would actually be sent: each checked Save row produces exactly one
 * attachment, and the selection row only counts when its captured
 * body is non-empty (empty selection becomes a no-op attachment).
 */
function checkDestinationAttachmentCount(
  max: number | undefined,
  displayName: string | undefined,
): boolean {
  if (max === undefined) return true;
  let count = 0;
  if (ctx.screenshotBox.checked && !ctx.screenshotBox.disabled) count += 1;
  if (ctx.htmlBox.checked && !ctx.htmlBox.disabled && ctx.captured.html) {
    count += 1;
  }
  const fmt = ctx.selectedSelectionFormat();
  if (fmt) {
    const body = ctx.captured[ctx.selectionWireKind[fmt]];
    if (body && body.trim().length > 0) count += 1;
  }
  if (count <= max) return true;
  const name = displayName ?? 'Destination';
  ctx.setStatusMessage(
    `${name} accepts at most ${max} attachment${max === 1 ? '' : 's'} `
      + `per turn; you have ${count}. Uncheck a Save row.`,
    'error',
  );
  return false;
}

/** Friendly join of accepted-kind tokens for the pre-send error
 *  ("image" / "image and text" / "image, text, and …"). Mirrors the
 *  SW's `formatKindList` so the page-side and SW-side wording match. */
function formatAcceptedKinds(kinds: ('image' | 'text')[]): string {
  if (kinds.length === 1) return kinds[0];
  if (kinds.length === 2) return `${kinds[0]} and ${kinds[1]}`;
  return `${kinds.slice(0, -1).join(', ')}, and ${kinds[kinds.length - 1]}`;
}

/**
 * Wire the Ask flow's DOM handlers and storage listeners and trigger
 * the initial label refresh. The caller (capture-page.ts) invokes
 * this once at module init, after the static DOM has loaded.
 */
export function initAsk(context: AskContext): void {
  ctx = context;
  askBtn = document.getElementById('ask-btn') as HTMLButtonElement;
  askMenuBtn = document.getElementById('ask-menu-btn') as HTMLButtonElement;
  askMenu = document.getElementById('ask-menu') as HTMLDivElement;
  askMenuList = askMenu.querySelector('ul') as HTMLUListElement;
  askTargetLabel = document.getElementById('ask-target-label') as HTMLSpanElement;
  askBtnIcon = document.getElementById('ask-btn-icon') as HTMLSpanElement;
  askButtonRow = document.querySelector('.button-row') as HTMLDivElement;

  // Re-render parts of the page on external state changes from other
  // tabs / the SW:
  //
  // - `local.askProviderSettings` — flipped from the Options page in
  //   another tab. Refreshes the Ask label + disabled state.
  // - `session.askPin` — the toolbar context-menu Set/Unset entry
  //   writes here (without going through `runAskWithMessage`), so
  //   without this listener the cached `currentDefaultAcceptedKinds`
  //   would go stale and the page-side pre-send guard would miss the
  //   newly-restricted destination (e.g. a freshly-pinned `/code`
  //   tab). Post-Ask refreshes are still handled inline by
  //   `runAskWithMessage`.
  // - `local.capturePageDefaults` — flipped from the Options page in
  //   another tab. Live-applies `defaultButton` (highlight ring +
  //   Enter / triggerCapture routing) and `promptEnter`. The
  //   Save-checkbox state in the same blob is intentionally NOT
  //   re-applied — those are seeded once on first paint; clobbering
  //   the user's in-progress checkbox edits mid-session would be
  //   jarring. `defaultButton` and `promptEnter` have no equivalent
  //   in-page edit surface, so live-updating them has no conflict.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['askProviderSettings']) {
      void refreshAskTargetLabel();
      return;
    }
    if (area === 'session' && changes['askPin']) {
      void refreshAskTargetLabel();
      return;
    }
    if (area === 'session' && changes['askPreferredNewTabProvider']) {
      // A menu pick in another Capture-page tab (or this one's last
      // pick once the SW finishes writing) just shifted which
      // provider the fallback resolves to. Refresh so the button
      // label and trailing icon match the new resolution.
      void refreshAskTargetLabel();
      return;
    }
    if (area === 'local' && changes['capturePageDefaults']) {
      const next = changes['capturePageDefaults'].newValue as
        | { defaultButton?: 'capture' | 'ask'; promptEnter?: 'send' | 'newline' }
        | undefined;
      if (next?.defaultButton === 'capture' || next?.defaultButton === 'ask') {
        ctx.applyDefaultButtonHighlight(next.defaultButton);
      }
      if (next?.promptEnter === 'send' || next?.promptEnter === 'newline') {
        ctx.setPromptEnter(next.promptEnter);
      }
    }
  });

  askMenuBtn.addEventListener('click', () => {
    void openAskMenu();
  });

  askBtn.addEventListener('click', (e) => {
    // Close the menu if it happens to be open (e.g. user opened via
    // the caret then changed their mind and hit the main button).
    if (!askMenu.hidden) closeAskMenu();
    // Modifier semantics mirror the Capture button:
    //   - shift-click → keep the page open after the Ask (also the
    //     default — Ask doesn't close on plain click since the user
    //     usually wants to glance at the destination tab and return).
    //   - ctrl-click  → close the Capture page once the SW reports
    //     a successful send. Useful when the user is done with this
    //     capture and the tab is just clutter.
    void runAskDefault(ctx.closeAfterFromModifiers(e, false));
  });

  void refreshAskTargetLabel();
}
