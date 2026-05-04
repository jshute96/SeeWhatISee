// E2E coverage for the Capture-page Prompt-Enter behaviour and the
// Capture/Ask "Default submit button" setting (`capturePageDefaults.
// defaultButton` + `capturePageDefaults.promptEnter`):
//
//   - `defaultButton` decides which of the two main buttons gets the
//     `.is-default` highlight ring, which one fires when the user
//     presses Enter on the prompt, and which one fires on the SW's
//     `triggerCapture` toolbar-icon hand-off.
//   - `promptEnter` decides what plain Enter does in the Prompt
//     textarea — `'send'` fires the default button, `'newline'`
//     inserts a newline. Shift+Enter is always newline, Ctrl+Enter
//     is always send.
//
// The Ask-as-default tests don't drive the full Ask round-trip
// (which would need a fake-Claude tab + provider plumbing) — they
// install a capture-phase click spy on `#capture` / `#ask-btn` and
// assert against the recorded ids, so we only verify *which* button
// the user's keystroke routed to.

import { test, expect } from '../fixtures/extension';
import {
  installButtonClickSpy,
  openDetailsFlow,
  readButtonClickSpy,
} from './details-helpers';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Mirrors the cushion in capture-with-details.spec.ts so the suite
// doesn't trip the quota when run alongside other capture specs.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// Storage seed shape matching `capturePageDefaults`. Only the fields
// these tests vary are listed; the SW's normalize() backfills the
// rest (Save-checkbox defaults) from `DEFAULT_CAPTURE_DETAILS_DEFAULTS`.
function seed(overrides: {
  defaultButton?: 'capture' | 'ask';
  promptEnter?: 'send' | 'newline';
}): Record<string, unknown> {
  return {
    capturePageDefaults: {
      withoutSelection: { screenshot: true, html: false },
      withSelection: { screenshot: false, html: false, selection: true, format: 'markdown' },
      ...overrides,
    },
  };
}

// ─── Default-submit-button highlight ─────────────────────────────

test('default settings: highlight ring is on #capture, not on #ask-btn', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await expect(capturePage.locator('#capture')).toHaveClass(/\bis-default\b/);
  await expect(capturePage.locator('.ask-split')).not.toHaveClass(
    /\bis-default\b/,
  );
  await capturePage.close();
  await openerPage.close();
});

test('defaultButton=ask: highlight ring moves to #ask-btn, off #capture', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    undefined,
    seed({ defaultButton: 'ask' }),
  );
  await expect(capturePage.locator('.ask-split')).toHaveClass(/\bis-default\b/);
  await expect(capturePage.locator('#capture')).not.toHaveClass(
    /\bis-default\b/,
  );
  await capturePage.close();
  await openerPage.close();
});

// ─── Plain-Enter routing ─────────────────────────────────────────

test('Enter on prompt with promptEnter=send fires the default Capture button', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installButtonClickSpy(capturePage);
  await capturePage.locator('#prompt-text').focus();
  await capturePage.keyboard.press('Enter');
  expect(await readButtonClickSpy(capturePage)).toEqual(['capture']);
  await capturePage.close();
  await openerPage.close();
});

test('Enter on prompt with defaultButton=ask fires #ask-btn, not #capture', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    undefined,
    seed({ defaultButton: 'ask' }),
  );
  await installButtonClickSpy(capturePage);
  await capturePage.locator('#prompt-text').focus();
  await capturePage.keyboard.press('Enter');
  expect(await readButtonClickSpy(capturePage)).toEqual(['ask-btn']);
  await capturePage.close();
  await openerPage.close();
});

test('Enter on prompt with promptEnter=newline inserts a newline and does not submit', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    undefined,
    seed({ promptEnter: 'newline' }),
  );
  await installButtonClickSpy(capturePage);
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  await capturePage.keyboard.type('hello');
  await capturePage.keyboard.press('Enter');
  await capturePage.keyboard.type('world');
  await expect(prompt).toHaveValue('hello\nworld');
  expect(await readButtonClickSpy(capturePage)).toEqual([]);
  await capturePage.close();
  await openerPage.close();
});

// ─── Modified-Enter overrides ────────────────────────────────────

test('Shift+Enter on prompt always inserts a newline (promptEnter=send)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Default seed → promptEnter=send. Shift+Enter must STILL insert a
  // newline rather than submitting; the listener only treats plain
  // Enter as a submit.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installButtonClickSpy(capturePage);
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  await capturePage.keyboard.type('hello');
  await capturePage.keyboard.press('Shift+Enter');
  await capturePage.keyboard.type('world');
  await expect(prompt).toHaveValue('hello\nworld');
  expect(await readButtonClickSpy(capturePage)).toEqual([]);
  await capturePage.close();
  await openerPage.close();
});

test('Ctrl+Enter on prompt always submits, even when promptEnter=newline', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    undefined,
    seed({ promptEnter: 'newline' }),
  );
  await installButtonClickSpy(capturePage);
  await capturePage.locator('#prompt-text').focus();
  await capturePage.keyboard.press('Control+Enter');
  expect(await readButtonClickSpy(capturePage)).toEqual(['capture']);
  await capturePage.close();
  await openerPage.close();
});

// ─── Backslash + Enter (CLI-agent-style line continuation) ────────

test('\\+Enter on prompt (promptEnter=send) erases the backslash and inserts a newline', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installButtonClickSpy(capturePage);
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  await capturePage.keyboard.type('abc\\');
  await capturePage.keyboard.press('Enter');
  await capturePage.keyboard.type('def');
  await expect(prompt).toHaveValue('abc\ndef');
  expect(await readButtonClickSpy(capturePage)).toEqual([]);
  await capturePage.close();
  await openerPage.close();
});

test('\\+Enter triggers mid-string when the caret is between `\\` and following text', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Intentional: the trigger is "`\` immediately to the left of the
  // caret", not "trailing `\` at end of text". A user editing in the
  // middle of a buffer should still get the line-continuation shortcut.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installButtonClickSpy(capturePage);
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  // Type `ab\cd`, then move the caret two left so it sits between `\`
  // and `c` (i.e. `ab\|cd`).
  await capturePage.keyboard.type('ab\\cd');
  await capturePage.keyboard.press('ArrowLeft');
  await capturePage.keyboard.press('ArrowLeft');
  await capturePage.keyboard.press('Enter');
  await expect(prompt).toHaveValue('ab\ncd');
  expect(await readButtonClickSpy(capturePage)).toEqual([]);
  await capturePage.close();
  await openerPage.close();
});

test('\\+Enter swap is undoable (Ctrl+Z restores the backslash)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // The implementation uses execCommand('insertText') so the swap lands
  // on the textarea's native undo stack — Ctrl+Z must give the `\` back.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  await capturePage.keyboard.type('abc\\');
  await capturePage.keyboard.press('Enter');
  await expect(prompt).toHaveValue('abc\n');
  await capturePage.keyboard.press('Control+Z');
  await expect(prompt).toHaveValue('abc\\');
  await capturePage.close();
  await openerPage.close();
});

test('Ctrl+Enter on text ending in `\\` always submits (does not eat the backslash)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Regression guard: a previous version put the `\`-eating branch
  // inside `if (sendIntent)`, so Ctrl+Enter on `foo\` would silently
  // insert a newline instead of submitting. Ctrl+Enter must always
  // submit, regardless of trailing-backslash state.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    undefined,
    seed({ promptEnter: 'newline' }),
  );
  await installButtonClickSpy(capturePage);
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  await capturePage.keyboard.type('foo\\');
  await capturePage.keyboard.press('Control+Enter');
  expect(await readButtonClickSpy(capturePage)).toEqual(['capture']);
  // Backslash is preserved — Ctrl+Enter just submits.
  await expect(prompt).toHaveValue('foo\\');
  await capturePage.close();
  await openerPage.close();
});

test('Shift+Enter on text ending in `\\` keeps the backslash and inserts a literal newline', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Shift+Enter is the native-newline override and runs before the
  // `\`-eating branch — the backslash must survive.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  await capturePage.keyboard.type('abc\\');
  await capturePage.keyboard.press('Shift+Enter');
  await capturePage.keyboard.type('d');
  await expect(prompt).toHaveValue('abc\\\nd');
  await capturePage.close();
  await openerPage.close();
});

test('Plain Enter on text ending in `\\` with promptEnter=newline inserts native newline (keeps the backslash)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // In 'newline' mode, plain Enter is already a newline — the
  // `\`-eating branch is skipped (it's only useful in 'send' mode
  // where it gives users an escape hatch around the submit).
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    undefined,
    seed({ promptEnter: 'newline' }),
  );
  await installButtonClickSpy(capturePage);
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  await capturePage.keyboard.type('abc\\');
  await capturePage.keyboard.press('Enter');
  await capturePage.keyboard.type('d');
  await expect(prompt).toHaveValue('abc\\\nd');
  expect(await readButtonClickSpy(capturePage)).toEqual([]);
  await capturePage.close();
  await openerPage.close();
});

// ─── triggerCapture toolbar-icon hand-off ─────────────────────────
//
// The SW sends a `triggerCapture` runtime message to the Capture
// page's tab when the user clicks the toolbar icon while the Capture
// page is already open. Pre-defaultButton this always fired
// #capture; now it must fire whichever button the user picked as
// default. We simulate the SW's hand-off by sending the same message
// from the SW directly to the Capture tab.

async function sendTriggerCaptureToCaptureTab(
  capturePage: import('@playwright/test').Page,
  getServiceWorker: () => Promise<import('@playwright/test').Worker>,
): Promise<void> {
  // Mirror production: the SW finds its target via
  // `chrome.tabs.query({ active: true, lastFocusedWindow: true })`
  // (the manifest has no `tabs` permission, so URL-based lookup
  // returns no URL for chrome-extension:// pages). Bring the
  // Capture tab to front first so that query returns it.
  await capturePage.bringToFront();
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!activeTab?.id) throw new Error('No active tab found');
    await chrome.tabs.sendMessage(activeTab.id, { action: 'triggerCapture' });
  });
}

test('triggerCapture message fires #capture by default', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installButtonClickSpy(capturePage);
  await sendTriggerCaptureToCaptureTab(capturePage, getServiceWorker);
  // Wait briefly for the runtime message to deliver and the spy to record.
  await capturePage.waitForFunction(
    () =>
      ((self as unknown as { __seeBtnClicks?: string[] }).__seeBtnClicks?.length
        ?? 0) > 0,
    null,
    { timeout: 2000 },
  );
  expect(await readButtonClickSpy(capturePage)).toEqual(['capture']);
  await capturePage.close();
  await openerPage.close();
});

test('triggerCapture message fires #ask-btn when defaultButton=ask', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    undefined,
    seed({ defaultButton: 'ask' }),
  );
  await installButtonClickSpy(capturePage);
  await sendTriggerCaptureToCaptureTab(capturePage, getServiceWorker);
  await capturePage.waitForFunction(
    () =>
      ((self as unknown as { __seeBtnClicks?: string[] }).__seeBtnClicks?.length
        ?? 0) > 0,
    null,
    { timeout: 2000 },
  );
  expect(await readButtonClickSpy(capturePage)).toEqual(['ask-btn']);
  await capturePage.close();
  await openerPage.close();
});

// ─── Live updates ────────────────────────────────────────────────
//
// `chrome.storage.onChanged` fires on every Capture page in any
// open tab when the Options page Saves. Verify that flipping
// `capturePageDefaults.defaultButton` and `.promptEnter` while the
// Capture page is already open immediately moves the highlight ring
// and re-routes Enter — without needing a page reload.

test('flipping defaultButton via storage live-updates the highlight ring + Enter routing', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Sanity: starts on capture.
  await expect(capturePage.locator('#capture')).toHaveClass(/\bis-default\b/);

  // Flip the storage as the Options page would on Save.
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      capturePageDefaults: {
        withoutSelection: { screenshot: true, html: false },
        withSelection: { screenshot: false, html: false, selection: true, format: 'markdown' },
        defaultButton: 'ask',
        promptEnter: 'send',
      },
    });
  });

  // Highlight ring should move within a frame or two of the storage event.
  await expect(capturePage.locator('.ask-split')).toHaveClass(/\bis-default\b/);
  await expect(capturePage.locator('#capture')).not.toHaveClass(
    /\bis-default\b/,
  );

  // Enter should now hit #ask-btn rather than #capture, also live.
  await installButtonClickSpy(capturePage);
  await capturePage.locator('#prompt-text').focus();
  await capturePage.keyboard.press('Enter');
  expect(await readButtonClickSpy(capturePage)).toEqual(['ask-btn']);

  await capturePage.close();
  await openerPage.close();
});

test('flipping promptEnter via storage live-updates plain-Enter behaviour', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Sanity: defaults to send — Enter would submit.
  // Flip to newline.
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      capturePageDefaults: {
        withoutSelection: { screenshot: true, html: false },
        withSelection: { screenshot: false, html: false, selection: true, format: 'markdown' },
        defaultButton: 'capture',
        promptEnter: 'newline',
      },
    });
  });

  // Wait for the storage event to land. We poll a side-effect rather
  // than racing the listener — pressing Enter and asserting on the
  // textarea is the side-effect here.
  await capturePage.waitForFunction(async () => {
    // Storage events are async; give the listener a microtask to
    // re-bind `currentPromptEnter` before we test it.
    return true;
  });

  await installButtonClickSpy(capturePage);
  const prompt = capturePage.locator('#prompt-text');
  await prompt.focus();
  await capturePage.keyboard.type('a');
  await capturePage.keyboard.press('Enter');
  await capturePage.keyboard.type('b');
  // If the live-update worked, Enter inserted a newline (no submit).
  await expect(prompt).toHaveValue('a\nb');
  expect(await readButtonClickSpy(capturePage)).toEqual([]);

  await capturePage.close();
  await openerPage.close();
});
