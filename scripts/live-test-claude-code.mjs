#!/usr/bin/env node
//
// Live test for the Claude Code Ask flow against the real
// claude.ai/code product. NOT part of `npm test` — it requires a
// signed-in Chrome session running with `--remote-debugging-port=9222`
// and an open `https://claude.ai/code/<session>` tab the user has
// already set up. Critically the session **must have a repo selected
// already** — Claude Code's Send button stays disabled until that's
// done, and the runtime would time out waiting. A `scratch_testing`
// repo (or similar throwaway) is a fine target. Run manually after a
// UI change to the adapter:
//
//   node scripts/live-test-claude-code.mjs
//
// What it does:
//   1. Connects via CDP to 127.0.0.1:9222.
//   2. Finds the first tab on https://claude.ai/code.
//   3. Loads `dist/ask-inject.js` into that tab's MAIN world.
//   4. Calls `window.__seeWhatISeeAsk(selectors, payload)` with a
//      tiny PNG image + a uniquely-tagged prompt, with autoSubmit on.
//   5. Polls the tab for the prompt to appear in the user-visible
//      message list — the only DOM signal we have that submit fired.
//
// Prints a compact pass/fail summary plus the runtime's console
// breadcrumbs (which `ask-inject.ts` writes via `console.log`) so a
// failure points directly at which step misbehaved (selector match,
// click, submit-enable poll, …).
//
// Why this isn't a Playwright spec: claude.ai's DOM evolves without
// notice, the auth flow doesn't fit cleanly into the project's
// extension fixtures, and a CI failure here would be noise. The
// fake-Claude e2e suite (`ask.spec.ts`, `ask-url-variants.spec.ts`)
// covers the runtime's logic; this script covers "did anything
// regress against the real product."

import CDP from 'chrome-remote-interface';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOST = '127.0.0.1';
const PORT = 9222;
const TARGET_URL_PREFIX = 'https://claude.ai/code';
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const injectPath = join(repoRoot, 'dist', 'ask-inject.js');

// Selectors must match what `src/background/ask/claude.ts` ships —
// out-of-band drift here would make the live test pass while the
// real extension fails. Re-import via dynamic import so we read the
// production data, not a hand-maintained copy.
const { claudeProvider } = await import(
  join(repoRoot, 'dist', 'background', 'ask', 'claude.js')
);
const selectors = claudeProvider.selectors;

// Tiny 1x1 transparent PNG so the upload path runs end-to-end without
// pulling a real screenshot off disk.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

const tag = `live-test-${Date.now()}`;
const PROMPT = `[seewhatisee live-test ${tag}] please reply with the word "ack".`;

async function main() {
  // 1. Find the Claude Code tab. Prefer a session URL
  //    (`/code/session_…`) over the bare `/code` landing page —
  //    submit doesn't work until a repo is selected, and the user
  //    selecting a repo navigates from `/code` to `/code/session_…`.
  const targets = await CDP.List({ host: HOST, port: PORT });
  const candidates = targets.filter(
    (t) => t.type === 'page' && (t.url ?? '').startsWith(TARGET_URL_PREFIX),
  );
  const target =
    candidates.find((t) => (t.url ?? '').includes('/code/session_')) ??
    candidates[0];
  if (!target) {
    fail(
      `No tab on ${TARGET_URL_PREFIX} found at ${HOST}:${PORT}. ` +
        'Open one in your CDP-attached Chrome and select a repo (e.g. ' +
        'a scratch_testing repo) before running.',
    );
  }
  if (!(target.url ?? '').includes('/code/session_')) {
    console.warn(
      `[live-test] WARN — target is the /code landing page (${target.url}); ` +
        'submit will fail unless a repo is already selected.',
    );
  }
  console.log(`[live-test] target: ${target.url} (${target.id})`);

  const client = await CDP({ host: HOST, port: PORT, target: target.id });
  const { Runtime, Page } = client;
  await Page.enable();
  await Runtime.enable();

  // Stream MAIN-world console output back to our terminal so the
  // runtime's `[SeeWhatISee Ask]` breadcrumbs are visible — the most
  // useful diagnostic when something silently misbehaves.
  Runtime.consoleAPICalled(({ args }) => {
    const text = args
      .map((a) =>
        a.value !== undefined
          ? String(a.value)
          : a.description ?? a.unserializableValue ?? '',
      )
      .join(' ');
    if (text.startsWith('[SeeWhatISee Ask]')) {
      console.log('  page>', text);
    }
  });

  // 2. Load ask-inject.js into the tab's MAIN world. It registers
  //    `window.__seeWhatISeeAsk` (an IIFE).
  const injectSource = await readFile(injectPath, 'utf8');
  const injectResult = await Runtime.evaluate({
    expression: injectSource,
    awaitPromise: false,
    returnByValue: true,
  });
  if (injectResult.exceptionDetails) {
    fail(`Inject script failed: ${injectResult.exceptionDetails.text}`);
  }

  // No reliable per-bubble selector on Claude Code today, so we detect
  // submission via two signals: (1) the prompt input gets cleared,
  // and (2) our uniquely-tagged prompt text appears in the page body.
  // Both must flip from "not yet" to "yes" within the polling window.

  // 3. Invoke the runtime with one image attachment + the tagged prompt.
  const payload = {
    attachments: [
      {
        data: TINY_PNG_DATA_URL,
        kind: 'image',
        mimeType: 'image/png',
        filename: 'live-test.png',
      },
    ],
    promptText: PROMPT,
    autoSubmit: true,
  };
  const expr = `window.__seeWhatISeeAsk(${JSON.stringify(selectors)}, ${JSON.stringify(payload)})`;
  const callResult = await Runtime.evaluate({
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (callResult.exceptionDetails) {
    fail(`Runtime threw: ${callResult.exceptionDetails.text}`);
  }
  const result = callResult.result.value;
  console.log('[live-test] runtime result:', result);
  if (!result?.ok) fail(`runtime returned ${JSON.stringify(result)}`);

  // 4. Wait for evidence that the click actually submitted: the
  //    composer should clear AND our tag should land in the page
  //    body. 15s window — claude.ai's submit pipeline usually
  //    answers in a few seconds, but cold compose can be slower.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await Runtime.evaluate({
      expression: `JSON.stringify({
        promptText: (document.querySelector('div.ProseMirror[contenteditable="true"]')?.innerText ?? '').trim(),
        bodyHasTag: document.body.innerText.includes(${JSON.stringify(tag)}),
      })`,
      returnByValue: true,
    });
    const { promptText, bodyHasTag } = JSON.parse(state.result.value);
    if (bodyHasTag && promptText === '') {
      console.log(
        '[live-test] PASS — composer cleared and the tagged prompt is in the page body.',
      );
      await client.close();
      process.exit(0);
    }
    await sleep(500);
  }
  fail(
    `Submit click fired but no evidence of submission within 15s ` +
      `(composer didn't clear or tagged text never appeared in body).`,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function fail(msg) {
  console.error(`[live-test] FAIL — ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[live-test] crashed:', err);
  process.exit(2);
});
