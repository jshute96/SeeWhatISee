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
  // After the settle, wait this long for `attachmentPreview` chips
  // to appear before declaring the upload rejected. Only consulted
  // when the provider opts in via `selectors.attachmentPreview`.
  // Sized to cover slow networks while staying well under the
  // submit-enable budget.
  const PREVIEW_CONFIRM_TIMEOUT_MS = 8000;
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
    previewConfirmTimeoutMs?: number;
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

  /**
   * Count `attachmentPreview` matches across the selector list. Each
   * matching DOM node is one chip — we sum across selectors so a
   * provider can list both image-thumb and file-pill selectors and
   * have them tally together. Returns 0 when the field is undefined
   * or empty (the verification step then short-circuits).
   */
  function countPreviews(selectors: string[] | undefined): number {
    if (!selectors || selectors.length === 0) return 0;
    let total = 0;
    for (const sel of selectors) {
      total += document.querySelectorAll(sel).length;
    }
    return total;
  }

  async function attachFiles(
    files: File[],
    selectors: AskSelectors,
  ): Promise<void> {
    log(
      `attachFiles: ${files.length} file(s)`,
      files.map((f) => `${f.name} (${f.type}, ${f.size} bytes)`),
    );

    // Baseline preview count, taken BEFORE dispatching change so we
    // can verify that `files.length` new chips appeared (rather than
    // a total count, which would false-positive on leftover chips
    // from a previous Ask call into the same tab).
    const baselinePreviews = countPreviews(selectors.attachmentPreview);
    if (selectors.attachmentPreview?.length) {
      log(`attachFiles: baseline preview count = ${baselinePreviews}`);
    }

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

      // Poll for the file input — even providers without preClicks
      // can render their input lazily after navigation completes
      // (e.g. claude.ai/code mounts its composer a beat later than
      // claude.ai). Picks the LAST matching element on the page, so
      // a stale input from a previous Ask call (in the preClicks
      // flow) doesn't get reused. For providers where the input is
      // already in the initial DOM the first poll iteration matches
      // and the timeout never kicks in.
      input = await waitForRankedLast<HTMLInputElement>(
        'fileInput',
        selectors.fileInput,
        3000,
      );
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

    // Settle delay protects the typing step from a transient
    // composer reset while the site ingests the upload.
    const settle = tuning().fileSettleMs ?? FILE_SETTLE_DELAY_MS;
    log(`attachFiles: settling for ${settle}ms`);
    await delay(settle);

    // Per-provider attachment-preview verification. Opt-in via
    // `selectors.attachmentPreview`: when defined, we poll for the
    // preview count to rise by `files.length` (i.e. one chip per
    // file we sent). The delta is what matters — counting against
    // a baseline tolerates any pre-existing chips from a previous
    // Ask call in the same tab and avoids false positives from
    // unrelated page chrome that happens to match the selectors.
    //
    // This catches the case where the destination ACCEPTED the
    // file-input dispatch but server-rejected the upload (e.g.
    // ChatGPT logged-out: image uploads work, others surface a
    // "File type must be one of …" toast). Without this check we'd
    // happily proceed to typing + submit and report success even
    // though the attachment never landed.
    if (selectors.attachmentPreview?.length && files.length > 0) {
      const expectedDelta = files.length;
      const expectedTotal = baselinePreviews + expectedDelta;
      const timeout = tuning().previewConfirmTimeoutMs ?? PREVIEW_CONFIRM_TIMEOUT_MS;
      const deadline = Date.now() + timeout;
      let last = countPreviews(selectors.attachmentPreview);
      while (last < expectedTotal && Date.now() < deadline) {
        await delay(POLL_INTERVAL_MS);
        last = countPreviews(selectors.attachmentPreview);
      }
      const seenDelta = Math.max(0, last - baselinePreviews);
      if (seenDelta < expectedDelta) {
        // Distinguish "selectors never matched anything" (probably
        // selector drift after a UI change on the destination) from
        // "some chips appeared but fewer than we sent" (the real
        // partial-reject signal). The first case shouldn't blame the
        // user for being logged out.
        if (last === 0 && baselinePreviews === 0) {
          throw new Error(
            `Could not verify attachment delivery. ` +
              `Check the conversation manually; the upload may have succeeded.`,
          );
        }
        throw new Error(
          seenDelta === 0
            ? `No attachments were accepted by the destination.`
            : `Only ${seenDelta} of ${expectedDelta} attachments were accepted by the destination.`,
        );
      }
      log(
        `attachFiles: confirmed ${seenDelta}/${expectedDelta} preview chip(s) appeared`,
      );
    }
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
    log('clickSubmit: waiting for an enabled submit button to appear');
    let polls = 0;
    let logged = false;
    while (Date.now() < deadline) {
      const found = findEnabledSubmit(selectors.submitButton);
      if (found) {
        if (!logged) {
          log(
            `submitButton: matched ${found.selector}` +
              (found.matchCount > 1
                ? ` (picking first enabled of ${found.matchCount})`
                : ''),
          );
          logged = true;
        }
        log(`clickSubmit: firing click on submit after ${Date.now() - start}ms (${polls} poll(s))`);
        fireClick(found.btn);
        return;
      }
      polls++;
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error('Submit button stayed disabled — uploads may still be processing');
  }

  /**
   * Find the FIRST submit button that's currently enabled.
   *
   * Claude Code renders TWO `aria-label="Send"` buttons in its
   * composer (one per mode), and only the active mode's button
   * enables once the prompt is non-empty. The naive
   * `document.querySelector(sel)` picks the first match in document
   * order — which is the dormant one — and clickSubmit then waits
   * forever for it to enable. By scanning all matches per selector
   * and returning the first enabled one we tolerate that layout.
   *
   * Selectors are walked in declaration order so a page-specific
   * selector (e.g. `aria-label="Send Message"`) still wins over a
   * looser fallback when both happen to match. Returns `null` while
   * no enabled match exists, letting the poll loop keep waiting.
   */
  function findEnabledSubmit(
    selectorList: string[],
  ): { btn: HTMLButtonElement; selector: string; matchCount: number } | null {
    for (const sel of selectorList) {
      const matches = document.querySelectorAll<HTMLButtonElement>(sel);
      for (const btn of Array.from(matches)) {
        if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
          return { btn, selector: sel, matchCount: matches.length };
        }
      }
    }
    return null;
  }

  /**
   * Click a button with the full pointer-event sequence a real mouse
   * would generate. Plain `.click()` (or a bare `MouseEvent`) is
   * sometimes ignored by React handlers that listen for
   * `onPointerDown` / `onPointerUp` instead — Claude Code's send
   * button is one such case (it stays "ready" but never actually
   * dispatches the message). Firing pointerdown→pointerup→click in
   * order matches what an OS-level click does and exercises both
   * legacy mouse-event and modern pointer-event paths so both the
   * old composer (regular Claude) and the new one (Claude Code)
   * accept the synthetic gesture.
   */
  function fireClick(btn: HTMLButtonElement): void {
    const rect = btn.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const pointerInit: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX,
      clientY,
    };
    btn.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    btn.dispatchEvent(new MouseEvent('mousedown', { ...pointerInit, buttons: 1 }));
    btn.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }));
    btn.dispatchEvent(new MouseEvent('mouseup', { ...pointerInit, buttons: 0 }));
    btn.click();
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
