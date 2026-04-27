// Stored "Default items to save on Capture page" preferences. Owns the
// `capturePageDefaults` storage key + a getter / setter that
// normalizes the shape so callers can trust every field is present and
// well-typed even if storage holds a partial / legacy object.
//
// The Capture page (`capture-page.ts`) reads these to seed its Save
// checkboxes on first paint, and the options page reads / writes them
// via the SW message handlers in `background/options.ts`.

import type { SelectionFormat } from '../capture.js';

export interface CaptureDetailsWithoutSelectionDefaults {
  screenshot: boolean;
  html: boolean;
}

export interface CaptureDetailsWithSelectionDefaults {
  screenshot: boolean;
  html: boolean;
  selection: boolean;
  format: SelectionFormat;
}

export interface CaptureDetailsDefaults {
  withoutSelection: CaptureDetailsWithoutSelectionDefaults;
  withSelection: CaptureDetailsWithSelectionDefaults;
}

const CAPTURE_DETAILS_DEFAULTS_KEY = 'capturePageDefaults';

// Fresh-install defaults: a single artifact per branch — screenshot
// for no-selection, the selection-as-markdown for with-selection.
// Anything more aggressive (e.g. defaulting to Save HTML on every
// capture) inflates Downloads quickly; users can opt in via the
// Options page.
export const DEFAULT_CAPTURE_DETAILS_DEFAULTS: CaptureDetailsDefaults = {
  withoutSelection: { screenshot: true, html: false },
  withSelection: { screenshot: false, html: false, selection: true, format: 'markdown' },
};

const VALID_FORMATS: ReadonlySet<SelectionFormat> = new Set(['html', 'text', 'markdown']);

function normalize(raw: unknown): CaptureDetailsDefaults {
  if (!raw || typeof raw !== 'object') return DEFAULT_CAPTURE_DETAILS_DEFAULTS;
  const r = raw as {
    withoutSelection?: Partial<CaptureDetailsWithoutSelectionDefaults>;
    withSelection?: Partial<CaptureDetailsWithSelectionDefaults>;
  };
  const wos = r.withoutSelection ?? {};
  const ws = r.withSelection ?? {};
  return {
    withoutSelection: {
      screenshot: typeof wos.screenshot === 'boolean'
        ? wos.screenshot
        : DEFAULT_CAPTURE_DETAILS_DEFAULTS.withoutSelection.screenshot,
      html: typeof wos.html === 'boolean'
        ? wos.html
        : DEFAULT_CAPTURE_DETAILS_DEFAULTS.withoutSelection.html,
    },
    withSelection: {
      screenshot: typeof ws.screenshot === 'boolean'
        ? ws.screenshot
        : DEFAULT_CAPTURE_DETAILS_DEFAULTS.withSelection.screenshot,
      html: typeof ws.html === 'boolean'
        ? ws.html
        : DEFAULT_CAPTURE_DETAILS_DEFAULTS.withSelection.html,
      selection: typeof ws.selection === 'boolean'
        ? ws.selection
        : DEFAULT_CAPTURE_DETAILS_DEFAULTS.withSelection.selection,
      format: typeof ws.format === 'string' && VALID_FORMATS.has(ws.format as SelectionFormat)
        ? (ws.format as SelectionFormat)
        : DEFAULT_CAPTURE_DETAILS_DEFAULTS.withSelection.format,
    },
  };
}

export async function getCaptureDetailsDefaults(): Promise<CaptureDetailsDefaults> {
  const stored = await chrome.storage.local.get(CAPTURE_DETAILS_DEFAULTS_KEY);
  return normalize(stored[CAPTURE_DETAILS_DEFAULTS_KEY]);
}

export async function setCaptureDetailsDefaults(value: CaptureDetailsDefaults): Promise<void> {
  // Re-normalize on write so partial / dirty inputs from the options
  // page don't put a malformed object into storage.
  const clean = normalize(value);
  await chrome.storage.local.set({ [CAPTURE_DETAILS_DEFAULTS_KEY]: clean });
}
