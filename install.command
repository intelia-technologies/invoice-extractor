#!/usr/bin/env bash
# Invoice Extractor — one-click installer for macOS and Linux.
# macOS: double-click this file. Linux: run `bash install.command`.
# Optional arguments: [1password|bitwarden] [vault name]
set -euo pipefail

cd "$(dirname "$0")"

echo "==================================================="
echo "  Invoice Extractor — Installer (macOS / Linux)"
echo "==================================================="

# 0. Node.js 18+ is the only prerequisite we cannot install for you silently.
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is not installed."
  if [[ "$(uname)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node
  else
    echo "Install Node.js 18 or newer from https://nodejs.org and run this installer again."
    read -r -p "Press Enter to close..." _ || true
    exit 1
  fi
fi

# 1. Choose the password manager (1Password or Bitwarden).
MANAGER="${1:-}"
if [[ -z "$MANAGER" ]]; then
  echo ""
  echo "Which password manager stores your billing logins?"
  echo "  1) 1Password"
  echo "  2) Bitwarden"
  read -r -p "Choose 1 or 2 [1]: " choice || true
  if [[ "${choice:-1}" == "2" ]]; then MANAGER="bitwarden"; else MANAGER="1password"; fi
fi
VAULT="${2:-Personal}"

# 2. Install dependencies (npm packages, Chromium for automation, password manager CLI, Chrome connector).
node bin/invoice-extractor.mjs doctor --fix --manager "$MANAGER"

# 3. Link the agent Skill for Claude Code / OMP / Antigravity.
mkdir -p "$HOME/.claude/skills" "$HOME/.gemini/config/skills"
ln -sfn "$(pwd)/skills/invoice-extractor" "$HOME/.claude/skills/invoice-extractor"
ln -sfn "$(pwd)/skills/invoice-extractor" "$HOME/.gemini/config/skills/invoice-extractor"

# 4. Connect the password manager and register the MCP server in Claude Desktop.
if [[ "$MANAGER" == "bitwarden" ]]; then
  node bin/invoice-extractor.mjs setup --manager bitwarden
else
  node bin/invoice-extractor.mjs setup --manager 1password --mode desktop --vault "$VAULT"
fi

echo ""
echo "Done. Last step: open chrome://extensions, enable Developer mode,"
echo "click 'Load unpacked' and select this folder:"
echo "   $(pwd)"
echo ""
echo "Then ask your agent or Claude Desktop:"
echo "   'Sync my providers and download this month's invoices'"
read -r -p "Press Enter to close..." _ || true
