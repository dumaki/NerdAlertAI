#!/usr/bin/env bash
# ============================================================
# NerdAlert — First-Time Setup Script
# ============================================================
# Run this once on a fresh machine to get NerdAlert running.
#
# What this script does:
#   1. Checks for Homebrew (Mac) and offers install instructions
#   2. Checks for Node.js 18+ and offers install instructions
#   3. Installs npm packages
#   4. Generates a unique auth token for your instance
#   5. Creates your .env file with that token
#   6. Prompts for your OpenRouter API key (free tier)
#   7. Detects your shell and adds the nerd-start / nerd aliases
#   8. Prints a summary of what was set up
#
# What this script does NOT do:
#   - Install Homebrew or Node.js automatically (instructions provided)
#   - Gmail setup (run: npm run setup:gmail after this)
#   - Modify anything outside this project folder and your shell rc file
#
# Usage:
#   bash setup.sh
# ============================================================

set -e

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
print_header() {
  echo ""
  echo -e "${CYAN}${BOLD}============================================================${RESET}"
  echo -e "${CYAN}${BOLD}  NerdAlert — Setup${RESET}"
  echo -e "${CYAN}${BOLD}============================================================${RESET}"
  echo ""
}

ok()   { echo -e "  ${GREEN}✓${RESET}  $1"; }
info() { echo -e "  ${GRAY}→${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}!${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; }

# ── Get the directory this script lives in ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# ============================================================
# STEP 1 — Check for Homebrew (Mac only)
# ============================================================
print_header

echo -e "${BOLD}Step 1 — Checking dependencies${RESET}"
echo ""

# Only check for Homebrew on Mac — Linux doesn't need it
if [[ "$OSTYPE" == "darwin"* ]]; then
  if ! command -v brew &>/dev/null; then
    fail "Homebrew is not installed."
    echo ""
    echo "  Homebrew is the easiest way to install Node.js on a Mac."
    echo "  Install it by running this command:"
    echo ""
    echo -e "  ${CYAN}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${RESET}"
    echo ""
    echo "  After Homebrew installs, run:"
    echo -e "  ${CYAN}brew install node${RESET}"
    echo ""
    echo "  Then run this setup script again:"
    echo -e "  ${CYAN}bash setup.sh${RESET}"
    echo ""
    exit 1
  fi
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
fi

# ============================================================
# STEP 2 — Check for Node.js
# ============================================================
if ! command -v node &>/dev/null; then
  fail "Node.js is not installed."
  echo ""
  echo "  NerdAlert requires Node.js version 18 or higher."
  echo ""

  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  Install it with Homebrew:"
    echo -e "  ${CYAN}brew install node${RESET}"
  else
    echo "  Install it from: https://nodejs.org"
  fi

  echo ""
  echo "  Then run this setup script again:"
  echo -e "  ${CYAN}bash setup.sh${RESET}"
  echo ""
  exit 1
fi

NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js version $NODE_VERSION is too old. Version 18+ is required."
  echo ""
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  Update with: brew upgrade node"
  else
    echo "  Update at: https://nodejs.org"
  fi
  echo ""
  echo "  Then run this setup script again:"
  echo -e "  ${CYAN}bash setup.sh${RESET}"
  echo ""
  exit 1
fi

ok "Node.js $NODE_VERSION"

if ! command -v npm &>/dev/null; then
  fail "npm is not installed (it should come with Node.js)."
  echo "  Try reinstalling Node.js."
  exit 1
fi

ok "npm $(npm --version)"

# ============================================================
# STEP 3 — Install packages
# ============================================================
echo ""
echo -e "${BOLD}Step 2 — Installing packages${RESET}"
echo ""

info "Running npm install..."
cd "$PROJECT_ROOT"
npm install --silent
ok "Packages installed"

# ============================================================
# STEP 4 — Generate auth token
# ============================================================
echo ""
echo -e "${BOLD}Step 3 — Generating your auth token${RESET}"
echo ""

if command -v openssl &>/dev/null; then
  AUTH_TOKEN=$(openssl rand -hex 16)
else
  AUTH_TOKEN=$(cat /dev/urandom | LC_ALL=C tr -dc 'a-f0-9' | head -c 32)
fi

ok "Token generated: ${CYAN}${AUTH_TOKEN}${RESET}"
info "This is saved to .env and to ~/.nerdalert/token.txt"

# ============================================================
# STEP 5 — OpenRouter API key
# ============================================================
echo ""
echo -e "${BOLD}Step 4 — OpenRouter API key${RESET}"
echo ""
echo "  NerdAlert uses OpenRouter to access AI models for free."
echo ""
echo "  Get your free key at: ${CYAN}https://openrouter.ai${RESET}"
echo "  Sign up → Dashboard → Keys → Create key"
echo ""
echo -n "  Paste your OpenRouter API key (or press Enter to skip for now): "
read -r OPENROUTER_KEY
echo ""

if [ -z "$OPENROUTER_KEY" ]; then
  OPENROUTER_KEY="YOUR_OPENROUTER_KEY_HERE"
  warn "Skipped — you'll need to add your OpenRouter key to .env before NerdAlert will respond."
else
  ok "OpenRouter key saved"
fi

# ============================================================
# STEP 6 — Write .env
# ============================================================
echo ""
echo -e "${BOLD}Step 5 — Creating .env${RESET}"
echo ""

ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  warn ".env already exists — backing it up to .env.backup"
  cp "$ENV_FILE" "$ENV_FILE.backup"
fi

cat > "$ENV_FILE" <<EOF
# ============================================================
# NerdAlert — Environment Variables
# ============================================================
# Generated by setup.sh on $(date)
#
# DO NOT commit this file to git.
# It is listed in .gitignore.
# ============================================================

# --- SERVER ---
SERVER_PORT=3773
SERVER_AUTH_TOKEN=${AUTH_TOKEN}

# --- MODEL ---
# Default: free Nemotron model via OpenRouter
# To switch to Claude: set MODEL=anthropic/claude-sonnet-4-6
# and set ANTHROPIC_API_KEY to your real key below
OPENROUTER_API_KEY=${OPENROUTER_KEY}
MODEL=nvidia/nemotron-3-super-120b-a12b:free

# --- ANTHROPIC (optional — only needed if switching to Claude) ---
# Remove the # below and add your key to use Claude instead of OpenRouter
ANTHROPIC_API_KEY=not-used

# --- GMAIL (optional — run: npm run setup:gmail) ---
# GMAIL_CONFIG_PATH=~/.nerdalert/secrets/email-gmail.json
# GOOGLE_CALENDAR_SECRET_PATH=~/.nerdalert/secrets/google-calendar.json

# --- SOC (self-hosted hardware only — not for general use) ---
# OPENCLAW_URL=
# OPENCLAW_TOKEN=
# PIHOLE_API_KEY=
EOF

ok ".env created at $ENV_FILE"

mkdir -p "$HOME/.nerdalert"
echo "$AUTH_TOKEN" > "$HOME/.nerdalert/token.txt"
chmod 600 "$HOME/.nerdalert/token.txt"
ok "Token backed up to ~/.nerdalert/token.txt"

# ============================================================
# STEP 7 — Shell aliases
# ============================================================
echo ""
echo -e "${BOLD}Step 6 — Setting up shell aliases${RESET}"
echo ""

SHELL_RC=""
SHELL_NAME=$(basename "$SHELL")

case "$SHELL_NAME" in
  zsh)
    SHELL_RC="$HOME/.zshrc"
    ;;
  bash)
    if [[ "$OSTYPE" == "darwin"* ]] && [ -f "$HOME/.bash_profile" ]; then
      SHELL_RC="$HOME/.bash_profile"
    else
      SHELL_RC="$HOME/.bashrc"
    fi
    ;;
  fish)
    SHELL_RC="$HOME/.config/fish/config.fish"
    ;;
  *)
    SHELL_RC="$HOME/.profile"
    ;;
esac

info "Detected shell: $SHELL_NAME → writing to $SHELL_RC"
touch "$SHELL_RC"

if grep -q "NerdAlert aliases" "$SHELL_RC" 2>/dev/null; then
  warn "Aliases already present in $SHELL_RC — skipping"
else
  cat >> "$SHELL_RC" <<EOF

# ── NerdAlert aliases ────────────────────────────────────────
alias nerd-start="cd $PROJECT_ROOT && npm run dev"
alias nerd="cd $PROJECT_ROOT && npx ts-node scripts/chat.ts"
alias nerd-open="open http://localhost:3773"
# ─────────────────────────────────────────────────────────────
EOF
  ok "Aliases added to $SHELL_RC"
fi

# Always explicitly tell the user to source — don't rely on auto-source working
echo ""
echo -e "  ${YELLOW}Important:${RESET} Run this now to activate your aliases:"
echo -e "  ${CYAN}source $SHELL_RC${RESET}"
echo ""

# ============================================================
# DONE — Summary
# ============================================================
echo ""
echo -e "${CYAN}${BOLD}============================================================${RESET}"
echo -e "${CYAN}${BOLD}  You're ready.${RESET}"
echo -e "${CYAN}${BOLD}============================================================${RESET}"
echo ""
echo -e "  ${BOLD}Your auth token:${RESET}"
echo -e "  ${CYAN}${AUTH_TOKEN}${RESET}"
echo -e "  ${GRAY}(Also saved to ~/.nerdalert/token.txt)${RESET}"
echo ""
echo -e "  ${BOLD}Step 1 — Load your aliases (do this first):${RESET}"
echo -e "  ${CYAN}source $SHELL_RC${RESET}"
echo ""
echo -e "  ${BOLD}Step 2 — Start NerdAlert:${RESET}"
echo -e "  ${YELLOW}nerd-start${RESET}    ${GRAY}← starts the server${RESET}"
echo ""
echo -e "  ${BOLD}Step 3 — Open the UI:${RESET}"
echo -e "  ${YELLOW}nerd-open${RESET}     ${GRAY}← opens http://localhost:3773 in your browser${RESET}"
echo ""

if [ "$OPENROUTER_KEY" = "YOUR_OPENROUTER_KEY_HERE" ]; then
  echo -e "  ${YELLOW}!  Reminder:${RESET} Add your OpenRouter key to .env before starting"
  echo -e "  ${GRAY}   Get one free at https://openrouter.ai${RESET}"
  echo ""
fi

echo -e "  ${BOLD}Optional — set up Gmail:${RESET}"
echo -e "  ${GRAY}npm run setup:gmail${RESET}"
echo ""
echo -e "  ${GRAY}Questions? See SHIPPING.md for full documentation.${RESET}"
echo ""
