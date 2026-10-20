#!/bin/bash
# Launch a sandboxed Chromium for extension development/testing.
# Uses Playwright's Chromium — runs independently of your main Chrome.
#
# Usage:
#   ./dev-chrome.sh          # launch sandbox Chromium
#   ./dev-chrome.sh --reset  # wipe the test profile and start fresh
#
# First run: you'll need to log in to Google manually (one time).
# The session persists in .test-profile/ across runs.
# Remote debugging is enabled on port 9222 for Playwright/CDP access.

set -euo pipefail

# Use Playwright's Chromium (separate app — won't conflict with your Chrome)
CHROMIUM="$(find "$HOME/Library/Caches/ms-playwright" -name "Chromium" -path "*/MacOS/*" 2>/dev/null | head -1)"
if [[ -z "$CHROMIUM" ]]; then
  echo "Playwright Chromium not found. Installing..."
  npx playwright install chromium
  CHROMIUM="$(find "$HOME/Library/Caches/ms-playwright" -name "Chromium" -path "*/MacOS/*" 2>/dev/null | head -1)"
fi

PROFILE_DIR="$(cd "$(dirname "$0")" && pwd)/.test-profile"
EXT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=9222

if [[ "${1:-}" == "--reset" ]]; then
  echo "Wiping test profile..."
  rm -rf "$PROFILE_DIR"
  echo "Done. Run again without --reset to start fresh."
  exit 0
fi

if lsof -i ":$PORT" &>/dev/null; then
  echo "Port $PORT is in use. Close whatever is using it or change PORT in this script."
  exit 1
fi

mkdir -p "$PROFILE_DIR"
node "$EXT_DIR/scripts/install-onepassword-host.mjs" >/dev/null 2>&1 || true

echo "Launching sandbox Chromium (separate from your Chrome)..."
echo "  Profile: $PROFILE_DIR"
echo "  Extension: $EXT_DIR"
echo "  CDP: http://localhost:$PORT"
echo ""
echo "First run? Log in to Google manually. The session will persist."
echo "Press Ctrl+C to stop."
echo ""

exec "$CHROMIUM" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT_DIR" \
  --remote-debugging-port=$PORT \
  --remote-allow-origins='*' \
  --no-first-run \
  --no-default-browser-check \
  --disable-default-apps \
  --disable-features=ThirdPartyCookieBlocking \
  2>/dev/null
