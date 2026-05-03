// Shared postMessage-bridge driver used by the live-test specs to
// invoke `ask-inject.ts` the same way the production widget does.
//
// Mirrors `callMain` + `CALL_MAIN_TIMEOUTS_MS` in `src/ask-widget.ts`
// — keeping the two in sync (same per-op budget, same request shape)
// means a slow op surfaces here the way it would in production rather
// than as a generic Playwright timeout. Lives in a shared helper so
// `live-suite.ts` and `google.live.spec.ts` don't drift apart.

import type { Page } from '@playwright/test';

export interface AskAttachment {
  data: string;
  kind: 'image' | 'text';
  mimeType: string;
  filename: string;
}

// Mirror of `dispatchOp`'s selector parameter shape. Kept loose
// because each provider extends the base set with its own ranked
// selector arrays.
export interface AskSelectors {
  preFileInputClicks?: string[];
  fileInput: string[];
  textInput: string[];
  submitButton: string[];
  attachmentPreview?: string[];
}

// Per-op budgets copied from `CALL_MAIN_TIMEOUTS_MS` in
// `src/ask-widget.ts` — see the comment block above that constant
// for the rationale (settle + chip-confirm vs sub-second insertion vs
// the 30 s submit-enable poll). Keeping the values in sync here means
// a slow live op surfaces with the same failure mode it would in
// production rather than as a generic Playwright timeout.
export const BRIDGE_TIMEOUTS_MS: Record<string, number> = {
  attachFile: 15_000,
  typePrompt: 5_000,
  clickSubmit: 35_000,
};

/** Single bridge call: post `{swis: 'request', id, op, args}` into
 *  MAIN world and resolve with the matching response (or reject on
 *  failure / timeout). The whole round-trip happens inside
 *  `page.evaluate` so postMessage stays in the page realm — exactly
 *  like the widget's bridge does in production. */
export async function callBridge(
  page: Page,
  op: string,
  args: unknown,
): Promise<unknown> {
  const timeoutMs = BRIDGE_TIMEOUTS_MS[op];
  if (timeoutMs === undefined) {
    throw new Error(`Unknown bridge op "${op}"`);
  }
  return await page.evaluate(
    ({ op: callOp, args: callArgs, timeoutMs: callTimeout }) => {
      return new Promise((resolve, reject) => {
        const id = `live-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let settled = false;
        function cleanup(): void {
          settled = true;
          window.removeEventListener('message', onMsg);
          clearTimeout(timer);
        }
        function onMsg(ev: MessageEvent): void {
          if (ev.source !== window) return;
          const data = ev.data as
            | { swis?: string; id?: string; ok?: boolean; result?: unknown; error?: string }
            | undefined;
          if (
            !data
            || typeof data !== 'object'
            || data.swis !== 'response'
            || data.id !== id
          ) {
            return;
          }
          if (settled) return;
          cleanup();
          if (data.ok) resolve(data.result ?? null);
          else reject(new Error(data.error ?? 'Unknown bridge error'));
        }
        window.addEventListener('message', onMsg);
        const timer = setTimeout(() => {
          if (settled) return;
          cleanup();
          reject(new Error(`Bridge op "${callOp}" timed out after ${callTimeout}ms`));
        }, callTimeout);
        window.postMessage({ swis: 'request', id, op: callOp, args: callArgs }, '*');
      });
    },
    { op, args, timeoutMs },
  );
}

/** Drive the runtime the way the widget does: one `attachFile` op
 *  per file, then `typePrompt` (only when non-empty after trimming —
 *  matches `buildItems` in `src/background/ask/index.ts`), then
 *  `clickSubmit` when `autoSubmit` is on. The try/catch lets call
 *  sites use `expect(result.ok, result.error).toBe(true)` like the
 *  pre-bridge runtime did. */
export async function driveBridge(
  page: Page,
  selectors: AskSelectors,
  attachments: AskAttachment[],
  promptText: string,
  autoSubmit: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const attachment of attachments) {
      await callBridge(page, 'attachFile', { attachment, selectors });
    }
    const trimmedPrompt = promptText.trim();
    if (trimmedPrompt.length > 0) {
      await callBridge(page, 'typePrompt', { text: promptText, selectors });
    }
    if (autoSubmit && trimmedPrompt.length > 0) {
      await callBridge(page, 'clickSubmit', { selectors });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
