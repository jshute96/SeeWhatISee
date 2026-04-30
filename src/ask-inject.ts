// Runtime injected into the AI provider's tab (currently claude.ai)
// to attach files, fill the prompt, and optionally submit.
//
// Loaded by `chrome.scripting.executeScript({ files: ['ask-inject.js'], world: 'MAIN' })`,
// then invoked via a second executeScript call. Must be a plain
// (non-module) script — no imports/exports — because executeScript
// runs files as classic content scripts. Selectors are passed in as
// data; site-specific logic stays out of this file.
//
// Lives in MAIN world so we can dispatch events the React-based
// composer expects to see (input/beforeinput on its ProseMirror,
// change on the hidden file input). The isolated world doesn't
// share React's state so synthesized events would be ignored.

(() => {
  interface AskSelectors {
    preFileInputClicks?: string[];
    fileInput: string[];
    textInput: string[];
    submitButton: string[];
    attachmentPreview?: string[];
  }

  interface AskAttachment {
    /** Data URL or raw text. `kind === 'image'` always means a data URL. */
    data: string;
    kind: 'image' | 'text';
    /** MIME type, e.g. 'image/png', 'text/html', 'text/markdown'. */
    mimeType: string;
    /** Filename presented to the AI site, e.g. 'screenshot.png'. */
    filename: string;
  }

  interface AskPayload {
    attachments: AskAttachment[];
    promptText: string;
    autoSubmit: boolean;
  }

  interface AskResult {
    ok: boolean;
    error?: string;
  }

  // Hard wait used by autoSubmit: the AI's submit button stays
  // disabled while uploads are processing, so its enable state is
  // the authoritative signal that everything's ready.
  const SUBMIT_ENABLE_TIMEOUT_MS = 30000;
  // Settle pause between attaching files and typing the prompt.
  // claude.ai sometimes resets the composer briefly while it
  // ingests the upload — typing during that window can drop
  // characters. This is also our only "files have been accepted"
  // signal in the no-autoSubmit path; for autoSubmit the longer
  // submit-enable poll picks up where this leaves off.
  const FILE_SETTLE_DELAY_MS = 1500;
  const POLL_INTERVAL_MS = 150;

  // Test-only tuning hook. If the target page sets
  // `window.__seeWhatISeeAskTuning` before the runtime is invoked,
  // those values override the defaults — the e2e fake-Claude
  // fixture uses this to skip the prod-side settle delays (the
  // fake page processes events synchronously, so the real-Claude
  // timings would just slow the suite down). Production claude.ai
  // never sets the global, so the production timings stand.
  interface AskTuning {
    fileSettleMs?: number;
    preSubmitSettleMs?: number;
  }
  function tuning(): AskTuning {
    return (
      (window as unknown as { __seeWhatISeeAskTuning?: AskTuning })
        .__seeWhatISeeAskTuning ?? {}
    );
  }

  // Console logger for diagnosing weird behavior on AI sites. Every
  // step of the Ask flow logs through here so a user looking at the
  // AI tab's DevTools console can see exactly what we did, which
  // selector matched, and where (if anywhere) we got stuck. Cheap to
  // leave on — these are infrequent, user-initiated calls.
  //
  // Both helpers go through `console.log` deliberately. Even though
  // we run in MAIN world via `chrome.scripting.executeScript`, Chrome
  // attributes console output back to the extension and `console.warn`
  // shows up on chrome://extensions as a warning. Failures here are
  // already caught and returned as `AskResult.error` to the SW, so
  // there's nothing for the user to act on at the extensions page —
  // the warn-level signal was just noise. `[warn]` in the message
  // keeps the bad-path lines visually distinct in DevTools.
  function log(...args: unknown[]): void {
    console.log('[SeeWhatISee Ask]', ...args);
  }
  function logWarn(...args: unknown[]): void {
    console.log('[SeeWhatISee Ask] [warn]', ...args);
  }

  function findRanked<T extends Element = HTMLElement>(
    role: string,
    selectors: string[],
  ): T | null {
    for (const sel of selectors) {
      const el = document.querySelector<T>(sel);
      if (el) {
        log(`${role}: matched`, sel);
        return el;
      }
    }
    logWarn(`${role}: no selector matched`, selectors);
    return null;
  }

  function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Poll for a single CSS selector to appear within `timeoutMs`.
  // Used by the preFileInputClicks flow where each click may render
  // the next click target asynchronously (Gemini opens a menu, then
  // the menu animation populates buttons).
  async function waitForSelector<T extends Element = HTMLElement>(
    selector: string,
    timeoutMs: number,
  ): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = document.querySelector<T>(selector);
      if (el) return el;
      await delay(POLL_INTERVAL_MS);
    }
    return null;
  }

  // Like findRanked, but polls until *some* selector matches and
  // returns the LAST element matching that selector (not the first).
  // Used by attachFiles after preFileInputClicks when the file input
  // is created asynchronously by the provider's upload-menu flow:
  // a stale input from a previous call may still be in the DOM, but
  // the freshly-created one is appended after it, so the last match
  // is the one we want. For Claude this path isn't used (preClicks
  // is empty and there's only one input anyway).
  async function waitForRankedLast<T extends Element = HTMLElement>(
    role: string,
    selectors: string[],
    timeoutMs: number,
  ): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const els = document.querySelectorAll<T>(sel);
        if (els.length > 0) {
          log(`${role}: matched`, sel, `(picking last of ${els.length})`);
          return els[els.length - 1];
        }
      }
      await delay(POLL_INTERVAL_MS);
    }
    logWarn(`${role}: no selector matched within ${timeoutMs}ms`, selectors);
    return null;
  }

  function dataUrlToFile(dataUrl: string, filename: string, mime: string): File {
    // Hand-decode to avoid going through fetch() — claude.ai's CSP can
    // intercept fetch() of data: URLs in some cases.
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('Malformed data URL');
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const isB64 = /;base64$/i.test(meta);
    let bytes: Uint8Array;
    if (isB64) {
      const bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return new File([bytes as BlobPart], filename, { type: mime });
  }

  function textToFile(text: string, filename: string, mime: string): File {
    const bytes = new TextEncoder().encode(text);
    return new File([bytes as BlobPart], filename, { type: mime });
  }

  async function attachFiles(
    files: File[],
    selectors: AskSelectors,
  ): Promise<void> {
    log(
      `attachFiles: ${files.length} file(s)`,
      files.map((f) => `${f.name} (${f.type}, ${f.size} bytes)`),
    );

    // Some providers (Gemini today) don't expose a file input in
    // their initial DOM — it's added only after the user opens an
    // "Add files" menu and picks an item. The clicks that surface it
    // would normally fire `input.click()` and pop the OS file
    // picker; we override `HTMLInputElement.prototype.click` for
    // `type=file` inputs to a no-op for the duration so we can set
    // `.files` directly without ever showing the picker.
    //
    // attachFiles is single-shot — the caller (run()) awaits each
    // call before issuing the next, so origClick is captured against
    // an unpatched prototype every time. Don't parallelize.
    const preClicks = selectors.preFileInputClicks ?? [];
    const origClick = HTMLInputElement.prototype.click;
    let input: HTMLInputElement | null;
    let didOverride = false;
    try {
      // Install the patch INSIDE the try so the matching restore is
      // lexically obvious — any future code added between install and
      // here can't bypass the finally.
      if (preClicks.length > 0) {
        HTMLInputElement.prototype.click = function (): void {
          if (this.type === 'file') {
            log('attachFiles: intercepted file-input click (suppressing native picker)');
            return;
          }
          return origClick.call(this);
        };
        didOverride = true;
      }

      for (const sel of preClicks) {
        const el = await waitForSelector<HTMLElement>(sel, 3000);
        if (!el) {
          throw new Error(`preFileInputClicks: selector did not appear: ${sel}`);
        }
        log('preFileInputClicks: clicking', sel);
        el.click();
        // Brief settle so the next selector (often part of a popup
        // menu) has a chance to render before we look for it.
        await delay(POLL_INTERVAL_MS);
      }

      // For providers with preClicks, the file input may not be in
      // the DOM yet — poll for it. We deliberately pick the LAST
      // matching element on the page, not the first: when Ask is
      // called twice in a row, the previous call's input may still
      // be in the DOM (now stale, with files already attached). The
      // freshly-created input is the one most recently inserted, so
      // in document order it's last among its siblings of the same
      // selector. For Claude (no preClicks) the first selector
      // matches immediately and there's only one.
      if (preClicks.length > 0) {
        input = await waitForRankedLast<HTMLInputElement>(
          'fileInput',
          selectors.fileInput,
          3000,
        );
      } else {
        input = findRanked<HTMLInputElement>('fileInput', selectors.fileInput);
      }
      if (!input) throw new Error('Could not find the file-upload input');

      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      log('attachFiles: dispatched change+input on file input');
    } finally {
      if (didOverride) HTMLInputElement.prototype.click = origClick;
    }

    // No DOM-based confirmation: AI sites' attachment-preview
    // selectors are too brittle to maintain across UI changes, and
    // false-positive matches in unrelated page chrome made our
    // count-based wait unreliable. The submit-enable poll in
    // clickSubmit() is the authoritative "uploads finished" gate
    // for the auto-submit path; this fixed settle delay only
    // protects the typing step from a transient composer reset.
    const settle = tuning().fileSettleMs ?? FILE_SETTLE_DELAY_MS;
    log(`attachFiles: settling for ${settle}ms`);
    await delay(settle);
  }

  async function typePrompt(
    text: string,
    selectors: AskSelectors,
  ): Promise<void> {
    if (!text) {
      log('typePrompt: empty prompt, skipping');
      return;
    }
    // Note: a whitespace-only prompt (e.g. just "\n\n") never reaches
    // here — capture-page.ts trims the input in `runAsk`, which both
    // suppresses auto-submit and short-circuits the all-empty case
    // ("Nothing to send — check at least one box or type a prompt.").
    const input = findRanked<HTMLElement>('textInput', selectors.textInput);
    if (!input) throw new Error('Could not find the prompt input');
    input.focus();
    log('typePrompt: focused input, starting insertion', {
      length: text.length,
      lines: text.split('\n').length,
    });

    // ProseMirror (Claude's composer) interprets a `\n` passed to
    // insertText as an Enter keypress — which submits the message
    // mid-insertion. Split on newlines and insert a paragraph break
    // between segments instead. Paragraph breaks (not soft `<br>`)
    // are what's needed to preserve blank lines: the empty string
    // between two consecutive `\n`s in the split becomes its own
    // empty paragraph, which is exactly the user's intent.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) insertParagraphBreak(input);
      if (lines[i]) insertTextLine(input, lines[i]);
    }
    log('typePrompt: insertion complete');
  }

  function insertTextLine(input: HTMLElement, line: string): void {
    // execCommand is deprecated but it's the only synthetic input that
    // reliably round-trips through ProseMirror's input rules. The
    // InputEvent fallback below covers the day Chrome retires it.
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, line);
    } catch {
      inserted = false;
    }
    if (inserted) return;
    logWarn('insertTextLine: execCommand returned false, using InputEvent fallback');
    input.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: line,
      }),
    );
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: line,
      }),
    );
  }

  function insertParagraphBreak(input: HTMLElement): void {
    // Real paragraph break (a new `<p>` block in the model), not a
    // soft `<br>` — the latter can be visually collapsed and won't
    // preserve blank lines as separate paragraphs. Critically, this
    // must NOT submit: `execCommand('insertParagraph')` arrives as
    // an `InputEvent` with `inputType: 'insertParagraph'`, which
    // bypasses the Enter-keydown handler Claude uses to submit.
    let ok = false;
    try {
      ok = document.execCommand('insertParagraph');
    } catch {
      ok = false;
    }
    if (ok) return;
    logWarn('insertParagraphBreak: execCommand returned false, using InputEvent fallback');
    // Fallback path: dispatch the same input event execCommand
    // would have. Still no keydown — same submit-bypass guarantee.
    input.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertParagraph',
      }),
    );
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertParagraph',
      }),
    );
  }

  async function clickSubmit(selectors: AskSelectors): Promise<void> {
    const start = Date.now();
    const deadline = start + SUBMIT_ENABLE_TIMEOUT_MS;
    log('clickSubmit: waiting for submit button to enable');
    let polls = 0;
    // The first findRanked call logs which selector matched. Subsequent
    // re-queries inside the poll loop go straight through `document.
    // querySelector` so the console isn't spammed with one
    // `submitButton: matched …` line per poll while uploads finish.
    let btn = findRanked<HTMLButtonElement>('submitButton', selectors.submitButton);
    while (Date.now() < deadline) {
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        log(`clickSubmit: clicking after ${Date.now() - start}ms (${polls} poll(s))`);
        btn.click();
        return;
      }
      polls++;
      await delay(POLL_INTERVAL_MS);
      // Re-query without logging — Claude can re-mount the button
      // while uploads are processing, so a cached reference can go
      // stale. Quiet path keeps the diagnostic log readable.
      btn = quietQuery<HTMLButtonElement>(selectors.submitButton);
    }
    throw new Error('Submit button stayed disabled — uploads may still be processing');
  }

  function quietQuery<T extends Element = HTMLElement>(
    selectors: string[],
  ): T | null {
    for (const sel of selectors) {
      const el = document.querySelector<T>(sel);
      if (el) return el;
    }
    return null;
  }

  async function run(
    selectors: AskSelectors,
    payload: AskPayload,
  ): Promise<AskResult> {
    log('run: invoked', {
      attachments: payload.attachments.length,
      promptLength: payload.promptText.length,
      autoSubmit: payload.autoSubmit,
      url: location.href,
    });
    try {
      // 1. Build File objects up front so a malformed data URL fails
      //    before we mutate any of the page's UI.
      const files: File[] = payload.attachments.map((a) => {
        if (a.kind === 'image') {
          return dataUrlToFile(a.data, a.filename, a.mimeType);
        }
        return textToFile(a.data, a.filename, a.mimeType);
      });

      // 2. Attach all files in a single change event, then a brief
      //    settle delay before the next step. The submit-enable poll
      //    in clickSubmit() is the authoritative "uploads finished"
      //    gate for the auto-submit path.
      if (files.length > 0) {
        await attachFiles(files, selectors);
      } else {
        log('run: no files to attach, skipping');
      }

      // 3. Type the prompt (if any) into the composer.
      await typePrompt(payload.promptText, selectors);

      // 4. Submit only when the user actually wrote a prompt — empty
      //    prompt means "set up the conversation, let me think."
      //    Brief settle so Claude's React state catches up to the
      //    insertText events before we start polling submit-enable.
      //    Without this, the no-attachment path can race the editor
      //    state update and the loop times out before re-render.
      if (payload.autoSubmit && payload.promptText.trim().length > 0) {
        await delay(tuning().preSubmitSettleMs ?? POLL_INTERVAL_MS);
        await clickSubmit(selectors);
      } else {
        log('run: autoSubmit off or prompt empty, leaving for user');
      }

      log('run: completed successfully');
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn('run: failed', message);
      return { ok: false, error: message };
    }
  }

  // Expose a single entry point on the page's window. The background
  // script invokes it via a second executeScript call rather than
  // running the work at file-load time, so retries land back in the
  // same MAIN-world realm without re-injecting the file.
  (window as unknown as { __seeWhatISeeAsk?: typeof run }).__seeWhatISeeAsk = run;
})();
