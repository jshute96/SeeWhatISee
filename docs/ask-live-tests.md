# Ask AI live tests

Manual e2e tests that run our injection library
(`src/ask-inject.ts`) against the **real** AI provider pages
(claude.ai and gemini.google.com today; ChatGPT later). Used to
confirm the production selectors still match the live DOM and the
production timing constants are still right.

These tests are **not** part of `npm test` — they require a
manually-launched browser, a logged-in test account, and they
create real conversations on that account. Run them when:

- You change selectors in `src/background/ask/<provider>.ts`.
- You change timings in `src/ask-inject.ts`.
- You suspect upstream DOM drift after an Ask failure in the wild.
- Before cutting a release.

## What's under test

Narrow scope by design — covered here:

- Each provider's selectors still resolve on the real page.
- The injection library at `src/ask-inject.ts` runs end-to-end
  against the real provider: file attaches, prompt typed,
  Send clicked.
- Production timing constants (`FILE_SETTLE_DELAY_MS = 1500`,
  `POLL_INTERVAL_MS = 150`, `SUBMIT_ENABLE_TIMEOUT_MS = 30_000`)
  are still enough headroom on a real network.

Explicitly **not** covered (the deterministic e2e suite handles
these):

- The Capture page UI / menu / message wiring.
- The matrix of Save-checkbox combinations.
- Edit-content / annotated-image flows.
- Error paths.

## Why CDP-attach instead of `launchPersistentContext`

- Google detects automation on page load when Playwright launches
  the browser itself, and refuses to let the user log in.
- Workaround: launch Chromium **manually** — Google can't tell
  it apart from a regular browser — then have Playwright attach
  afterward via `chromium.connectOverCDP`.
- Same pattern is used for Claude and ChatGPT for consistency,
  even though they don't currently block automation as
  aggressively.
- Cost: tests can't auto-launch the browser. You run a script
  once at the start of a session; the browser stays open across
  test runs.

## File layout

| File | Role |
|------|------|
| `playwright.config.live.ts` | Live config; one Playwright project per provider |
| `scripts/open-test-browser.sh` | Launches Playwright's Chromium with the extension + remote-debug port 9222 + persistent profile |
| `.chrome-test-profile/` | Persistent browser profile holding AI-provider login sessions (gitignored) |
| `tests/e2e-live/lib/types.ts` | `LiveProvider` plugin shape: selectors + DOM-verification helpers |
| `tests/e2e-live/lib/live-suite.ts` | Shared test cases — `runLiveSuite(provider)` runs all five tests against any plugin |
| `tests/e2e-live/<provider>.live.spec.ts` | Thin per-provider wiring: builds a `LiveProvider`, calls `runLiveSuite` |

The deterministic e2e fixture at `tests/fixtures/extension.ts`
is **not** used by live tests. Each live spec attaches to the
running browser via `chromium.connectOverCDP` directly.

### Plugin pattern

Each provider's spec file is small — selectors, then a handful of
DOM-verification helpers, then `runLiveSuite(provider)`. The five
tests (selectors smoke, multi-file no-submit, two prompt-only
calls accumulate, two file-attach calls accumulate, image + HTML +
selection + prompt → submit) live once in `lib/live-suite.ts`.

When you add a new provider, you implement the plugin contract
(`LiveProvider`) and you get the same coverage Claude and Gemini
get, with no test logic copied.

## One-time setup

```bash
npm install
npx playwright install chromium
npm run build
scripts/open-test-browser.sh
```

A Chromium window opens.

- Log in to each AI provider's site (claude.ai and
  gemini.google.com today). Use a **dedicated test account** for
  each — every auto-submit run creates a real conversation.
- Sessions persist in `.chrome-test-profile/`. Future runs reuse
  the saved login.

Leave the browser running.

## Running

```bash
npm run test:live-claude     # just Claude
npm run test:live-gemini     # just Gemini
npm run test:live            # all enabled providers
```

If the browser isn't running, you'll get a clear error pointing
at the launch script.

Production timings are exercised (no `__seeWhatISeeAskTuning`
override). Expect ~30 s per submitting test on Claude and ~10 s
on Gemini.

## Test design principles

### Token economy: minimize submits

Each submit creates a real conversation in the test account and
consumes Claude server-side resources. Live specs follow the
**1-of-N submits** rule:

- One test per spec actually submits and verifies the
  user-message bubble appears in the conversation.
- That single submitting test exercises the full attachment
  matrix (image + HTML + selection together) so we don't need
  multiple submits to cover file-type variation.
- Every other test asserts on UI state without pressing Send:
  file thumbnails appear, composer is in the right state, etc.

### Inject the library, skip the extension

Live tests don't load the extension or drive the Capture page.
They:

1. Open a fresh provider tab.
2. `page.evaluate(<contents of dist/ask-inject.js>)` to register
   `window.__seeWhatISeeAsk`.
3. Call the runtime with a synthetic payload.
4. Assert on the resulting DOM state.

This keeps the live suite fast and focused: the only thing that
can fail is the contract between our library and the real page.

### Test-account tagging

Each run uses a per-process tag like `[SeeWhatISee live test
1777520000000]`. Tagged messages cluster at the top of the test
account's history and are easy to identify and delete by hand.
Claude doesn't expose a programmatic conversation-delete API.

### Tab cleanup

Each test tracks its opened pages in a per-test array and an
`afterEach` closes them. Without this, every failed test leaks
a `claude.ai/new` tab into the user's interactive browser.

## Per-provider tests

Each provider runs the same five-test set, defined once in
`lib/live-suite.ts`:

| Test | Submits? | Asserts |
|------|----------|---------|
| Selectors smoke | No | The file-input entry selector and the prompt-composer selector match the live DOM. Type one character first so the Send button renders. |
| Multi-file no-submit | No | All three attachment types (image + HTML + selection) attach in one call; provider-specific locators see each by filename; composer is empty; user can keep typing. |
| Two prompt-only calls accumulate | No | Calling the runtime twice with text but no submit appends — pins the additive contract used by repeat-Ask flows. |
| Two file-attach calls accumulate | No | Calling the runtime twice with files but no submit shows both attachments — same contract on the upload side. |
| Multi-file + prompt → submit | **Yes** | Same payload + tagged prompt; provider-specific user-message locator sees the tag in the conversation. Then a follow-up call confirms the composer was reset and the runtime works against a fresh editor. |

## Troubleshooting

### "Failed to attach to CDP browser at http://127.0.0.1:9222"

You haven't launched the test browser, or it's been closed.

```bash
scripts/open-test-browser.sh
```

### Selector smoke test fails

Most likely upstream DOM drift. Open the test browser yourself,
go to the provider's site, inspect the elements that match each
of the prod selectors, and update `src/background/ask/<provider>.ts`.

The live spec imports those selectors directly — there's no
separate mirror to keep in sync.

### Auto-submit test passes but no `user-message` bubble

Inspect the trace via `npx playwright show-trace
test-results/<…>/trace.zip`. Often the runtime returned `ok:
true` but Claude rejected the message (e.g., quota hit). Try
the same flow manually in the test browser to confirm.

### Iterating on extension code

Chrome doesn't auto-reload extensions when `dist/` files
change. After an `npm run build`:

- Either kill the test browser and rerun `scripts/open-test-browser.sh`.
- Or open `chrome://extensions` in the test browser, find the
  extension, click the reload icon (developer mode must be on).

The live tests don't depend on the extension being up-to-date —
they read `dist/ask-inject.js` directly — but if you're cross-
checking against the running extension, reload it first.

## Adding a new provider (ChatGPT, …)

1. Drop a spec at `tests/e2e-live/<provider>.live.spec.ts`:
   - Import `selectors` and `newTabUrl` from the prod adapter at
     `src/background/ask/<provider>.ts`.
   - Write the four DOM-verification helpers + `readComposerText`
     for that provider's chip / message DOM.
   - Call `runLiveSuite(provider)`.
   - `gemini.live.spec.ts` is the smallest template.
2. Uncomment the matching project in `playwright.config.live.ts`.
3. Log in to the provider in the running test browser
   (`.chrome-test-profile/` retains the session).
4. Optionally add an `npm run test:live-<provider>` script.

## Cleanup

Each "auto-submit" run creates a real conversation in the test
account, tagged `[SeeWhatISee live test <timestamp>]`. They sort
to the top of the conversations list. Delete by hand when they
accumulate. No programmatic API to do this.
