// Service-worker side of the extension's options page (`src/options.html` /
// `src/options.ts`). Owns the two `runtime.onMessage` round-trips the page
// uses to read the catalog + current defaults and to persist them. Kept on
// its own listener so the message-type union doesn't have to share a
// discriminator with the unrelated Capture-page traffic in
// `capture-details.ts` — Chrome dispatches to all registered listeners.
import { ASK_PROVIDERS } from './ask/providers.js';
import {
  DEFAULT_ASK_PROVIDER_SETTINGS,
  getAskProviderSettings,
  setAskProviderSettings,
  type AskProviderSettings,
} from './ask/settings.js';
import { CAPTURE_ACTIONS } from './capture-actions.js';
import {
  DEFAULT_CAPTURE_DETAILS_DEFAULTS,
  getCaptureDetailsDefaults,
  setCaptureDetailsDefaults,
  type CaptureDetailsDefaults,
} from './capture-page-defaults.js';
import { commandsToShortcutMap } from './context-menu.js';
import {
  DEFAULT_CLICK_WITH_SELECTION_ID,
  DEFAULT_CLICK_WITHOUT_SELECTION_ID,
  DEFAULT_DBL_WITH_SELECTION_ID,
  DEFAULT_DBL_WITHOUT_SELECTION_ID,
  getDefaultDblWithSelectionId,
  getDefaultDblWithoutSelectionId,
  getDefaultWithSelectionId,
  getDefaultWithoutSelectionId,
  IGNORE_SELECTION_ID,
  isSelectionBaseId,
  setDefaultDblWithSelectionId,
  setDefaultDblWithoutSelectionId,
  setDefaultWithSelectionId,
  setDefaultWithoutSelectionId,
  WITH_SELECTION_CHOICES,
} from './default-action.js';

// Wire-shape returned to options.html so it can render the radio
// tables without duplicating the CAPTURE_ACTIONS /
// WITH_SELECTION_CHOICES catalog. Kept narrow: the page only needs
// ids + display titles + which slots each id is valid for, plus the
// currently-selected defaults, the bound hotkeys, the stored
// "Default items to save" preferences, and a `factoryDefaults`
// block consumed by the Options page's "Defaults" button. See
// `src/options.ts` for the consumer.
interface OptionsActionRow {
  id: string;
  title: string;
  baseId: string;
  delaySec: number;
  isSelection: boolean;
}
/** Provider entry exposed to the Options page. */
interface OptionsAskProvider {
  id: string;
  label: string;
}
interface OptionsFactoryDefaults {
  clickWithoutId: string;
  clickWithId: string;
  dblWithoutId: string;
  dblWithId: string;
  capturePageDefaults: CaptureDetailsDefaults;
  askProviderSettings: AskProviderSettings;
}
interface OptionsData {
  actions: OptionsActionRow[];
  withSelectionChoiceIds: string[];
  ignoreSelectionId: string;
  clickWithoutId: string;
  clickWithId: string;
  dblWithoutId: string;
  dblWithId: string;
  capturePageDefaults: CaptureDetailsDefaults;
  /** Registered Ask providers — Options page filters by static
   *  `provider.enabled` separately if it ever needs to. */
  askProviders: OptionsAskProvider[];
  askProviderSettings: AskProviderSettings;
  shortcuts: Record<string, string>;
  executeActionShortcut: string | null;
  factoryDefaults: OptionsFactoryDefaults;
}

export function installOptionsMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || !('action' in msg)) return false;
    const action = (msg as { action: unknown }).action;

    if (action === 'getOptionsData') {
      void (async () => {
        const [
          clickWithId,
          clickWithoutId,
          dblWithId,
          dblWithoutId,
          capturePageDefaults,
          askProviderSettings,
          commands,
        ] = await Promise.all([
          getDefaultWithSelectionId(),
          getDefaultWithoutSelectionId(),
          getDefaultDblWithSelectionId(),
          getDefaultDblWithoutSelectionId(),
          getCaptureDetailsDefaults(),
          getAskProviderSettings(),
          chrome.commands.getAll(),
        ]);
        const shortcutMap = commandsToShortcutMap(commands);
        const shortcuts: Record<string, string> = {};
        for (const [id, sc] of shortcutMap) shortcuts[id] = sc;
        const data: OptionsData = {
          actions: CAPTURE_ACTIONS.map((a) => ({
            id: a.id,
            title: a.title,
            baseId: a.baseId,
            delaySec: a.delaySec,
            isSelection: isSelectionBaseId(a.baseId),
          })),
          withSelectionChoiceIds: WITH_SELECTION_CHOICES.map((c) => c.id),
          ignoreSelectionId: IGNORE_SELECTION_ID,
          clickWithoutId,
          clickWithId,
          dblWithoutId,
          dblWithId,
          capturePageDefaults,
          askProviders: ASK_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
          askProviderSettings,
          shortcuts,
          executeActionShortcut: shortcutMap.get('_execute_action') ?? null,
          factoryDefaults: {
            clickWithoutId: DEFAULT_CLICK_WITHOUT_SELECTION_ID,
            clickWithId: DEFAULT_CLICK_WITH_SELECTION_ID,
            dblWithoutId: DEFAULT_DBL_WITHOUT_SELECTION_ID,
            dblWithId: DEFAULT_DBL_WITH_SELECTION_ID,
            capturePageDefaults: DEFAULT_CAPTURE_DETAILS_DEFAULTS,
            askProviderSettings: DEFAULT_ASK_PROVIDER_SETTINGS,
          },
        };
        sendResponse(data);
      })();
      return true;
    }

    if (action === 'setOptions') {
      void (async () => {
        // Each setter is wrapped in its own try/catch so a stale
        // value in one slot doesn't block the other slots from being
        // saved. The action setters call refreshMenusAndTooltip, so
        // menu labels resync on success.
        const m = msg as {
          clickWithId?: unknown;
          clickWithoutId?: unknown;
          dblWithId?: unknown;
          dblWithoutId?: unknown;
          capturePageDefaults?: unknown;
          askProviderSettings?: unknown;
        };
        const errors: string[] = [];
        const trySetString = async (
          v: unknown,
          set: (id: string) => Promise<void>,
        ): Promise<void> => {
          if (typeof v !== 'string') return;
          try {
            await set(v);
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        };
        await trySetString(m.clickWithoutId, setDefaultWithoutSelectionId);
        await trySetString(m.clickWithId, setDefaultWithSelectionId);
        await trySetString(m.dblWithoutId, setDefaultDblWithoutSelectionId);
        await trySetString(m.dblWithId, setDefaultDblWithSelectionId);
        if (m.capturePageDefaults && typeof m.capturePageDefaults === 'object') {
          try {
            await setCaptureDetailsDefaults(
              m.capturePageDefaults as CaptureDetailsDefaults,
            );
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        }
        if (
          m.askProviderSettings
          && typeof m.askProviderSettings === 'object'
        ) {
          try {
            await setAskProviderSettings(
              m.askProviderSettings as AskProviderSettings,
            );
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        }
        if (errors.length) {
          sendResponse({ error: errors.join('; ') });
        } else {
          sendResponse({ ok: true });
        }
      })();
      return true;
    }

    return false;
  });
}
