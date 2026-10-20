#!/bin/sh
# Wrapper launched by Chrome Native Messaging for com.intelia.invoice_extractor.op.
# Ensures Homebrew and NVM paths are available even when Chrome starts from macOS LaunchServices.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -z "$(command -v node)" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NODE_BIN="$(ls -1d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | tail -n 1)"
  if [ -n "$LATEST_NODE_BIN" ]; then
    export PATH="$LATEST_NODE_BIN:$PATH"
  fi
fi
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/onepassword-host.mjs"
