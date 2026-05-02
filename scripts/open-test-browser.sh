#!/usr/bin/env bash
#
# Launch Playwright's bundled Chromium with the SeeWhatISee extension
# loaded and remote debugging enabled, used by the live e2e suite
# (tests/e2e-live/*) to attach via `chromium.connectOverCDP`.
#
# Why this pattern: Google aggressively detects automation when
# Playwright launches the browser itself (via launchPersistentContext
# or storageState load) and refuses to log in. Manual launch +
# CDP-attach sidesteps that — the browser is "real" from Google's
# point of view, and Playwright connects to an already-authenticated
# session. Same approach applies to Claude / ChatGPT for consistency.
#
# Profile dir `.chrome-test-profile/` is gitignored. Log in to each
# AI provider once; sessions persist across test runs.
#
# Usage:
#   scripts/open-test-browser.sh             # opens about:blank
#   scripts/open-test-browser.sh <url>       # opens <url>
#
# Prerequisites:
#   npm install
#   npx playwright install chromium
#   npm run build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="$PROJECT_DIR/.chrome-test-profile"
EXTENSION_DIR="$PROJECT_DIR/dist"
DEBUG_PORT=9222
URL="${1:-about:blank}"

if [[ ! -d "$EXTENSION_DIR" || ! -f "$EXTENSION_DIR/manifest.json" ]]; then
  echo "Extension not built. Run: npm run build" >&2
  exit 1
fi

# Use Playwright's bundled Chromium — system Chrome dropped support
# for command-line --load-extension, and its CDP behaviour drifts
# from what Playwright tests against.
CHROME=$(find "$HOME/.cache/ms-playwright/chromium-"*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)
if [[ -z "$CHROME" ]]; then
  echo "Playwright's bundled Chromium not found." >&2
  echo "Install it with: npx playwright install chromium" >&2
  exit 1
fi

echo "Opening Chromium with the SeeWhatISee extension."
echo "Binary:    $CHROME"
echo "Profile:   $PROFILE_DIR"
echo "Extension: $EXTENSION_DIR"
echo "CDP:       http://127.0.0.1:$DEBUG_PORT"
echo ""
echo "First-time setup: log in to your test accounts (claude.ai,"
echo "later gemini/chatgpt) in this browser. Sessions persist in the"
echo "profile dir, so subsequent test runs reuse them."
echo ""

exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port="$DEBUG_PORT" \
  --disable-extensions-except="$EXTENSION_DIR" \
  --load-extension="$EXTENSION_DIR" \
  "$URL"
