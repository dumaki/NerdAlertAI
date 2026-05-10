#!/usr/bin/env bash
# ============================================================
# setup-linux.sh
# NerdAlert setup for Ubuntu/Linux (Optiplex / production box)
#
# Run this once on the Linux machine:
#   bash setup-linux.sh
#
# What it does:
#   1. Checks Node.js version (18+ required)
#   2. npm install
#   3. Probes credential-store backend (keytar vs file fallback)
#   4. Writes a minimal .env with NON-SECRET config only
#      (port, MODEL string, optional Telegram chat ID)
#   5. Prompts for Telegram bot token + chat ID (transitional —
#      see TODO note below)
#   6. Prompts for model provider preference (writes MODEL=...)
#   7. Installs systemd service so the bot starts on boot
#   8. Builds TypeScript
#   9. Starts the service
#
# What it does NOT do (as of the credential-store migration):
#   - It does NOT generate or write SERVER_AUTH_TOKEN. The
#     server auto-generates this on first boot and stores it
#     in the keychain (or chmod-600 file fallback).
#   - It does NOT prompt for OpenRouter or Anthropic API keys.
#     Add those via the /setup panel after starting the server.
#   - It does NOT prompt for OPENCLAW_TOKEN. Add via /setup.
#
# TODO (next migration): Telegram bot token still lives in .env
# because src/telegram/bot.ts and src/telegram/index.ts read
# process.env.TELEGRAM_BOT_TOKEN directly. Once that code is
# migrated to use getCredential('telegram-bot-token'), drop the
# Telegram prompts here and route users to /setup for the token.
# The /setup panel already has a slot for telegram-bot-token; it
# just isn't read by the Telegram module yet.
# ============================================================

set -e

NERDALERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="nerdalert@${USER}"
SERVICE_FILE="nerdalert@.service"
SYSTEMD_DIR="/etc/systemd/system"

echo ""
echo "  ███╗   ██╗███████╗██████╗ ██████╗  █████╗ ██╗     ███████╗██████╗ ████████╗"
echo "  ████╗  ██║██╔════╝██╔══██╗██╔══██╗██╔══██╗██║     ██╔════╝██╔══██╗╚══██╔══╝"
echo "  ██╔██╗ ██║█████╗  ██████╔╝██║  ██║███████║██║     █████╗  ██████╔╝   ██║   "
echo "  ██║╚██╗██║██╔══╝  ██╔══██╗██║  ██║██╔══██║██║     ██╔══╝  ██╔══██╗   ██║   "
echo "  ██║ ╚████║███████╗██║  ██║██████╔╝██║  ██║███████╗███████╗██║  ██║   ██║   "
echo "  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   "
echo ""
echo "  Linux Setup"
echo ""

# ── 1. Node version check ─────────────────────────────────────
echo "→ Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Install Node 18+ first:"
  echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "    sudo apt-get install -y nodejs"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.version.split('.')[0].slice(1)))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  ✗ Node.js 18+ required (found v$(node -v))"
  echo "    Update with: sudo npm install -g n && sudo n 20"
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

# ── 2. npm install ────────────────────────────────────────────
echo ""
echo "→ Installing dependencies..."
cd "$NERDALERT_DIR"
npm install --silent
echo "  ✓ Dependencies installed"

# ── 3. Probe credential-store backend ─────────────────────────
# On a headless Linux box without an unlocked GNOME Keyring
# session, keytar will fall through to file storage at
# ~/.nerdalert/secrets/<name>.json (chmod 600). Either backend
# works fine for the credential store; we run the probe here
# so the user knows up front which one they'll be using.
echo ""
echo "→ Testing credential store..."
mkdir -p "$HOME/.nerdalert"
chmod 700 "$HOME/.nerdalert"

PROBE_SCRIPT="$NERDALERT_DIR/.keychain-probe.js"
cat > "$PROBE_SCRIPT" <<'PROBE_EOF'
(async () => {
  let keytar;
  try { keytar = require('keytar'); }
  catch (e) {
    console.log('RESULT=file');
    console.log('REASON=keytar load failed: ' + (e && e.message ? e.message : 'unknown'));
    process.exit(0);
  }
  const SERVICE = 'nerdalert';
  const KEY = '__probe__';
  const VAL = 'probe-' + Date.now();
  try {
    await keytar.setPassword(SERVICE, KEY, VAL);
    const got = await keytar.getPassword(SERVICE, KEY);
    await keytar.deletePassword(SERVICE, KEY);
    if (got === VAL) {
      console.log('RESULT=keychain');
    } else {
      console.log('RESULT=file');
      console.log('REASON=probe round-trip mismatch');
    }
  } catch (e) {
    console.log('RESULT=file');
    console.log('REASON=' + (e && e.message ? e.message : 'unknown'));
  }
})();
PROBE_EOF

PROBE_OUTPUT=$(cd "$NERDALERT_DIR" && node "$PROBE_SCRIPT" 2>&1)
rm -f "$PROBE_SCRIPT"

BACKEND=$(echo "$PROBE_OUTPUT" | grep '^RESULT=' | head -1 | cut -d= -f2)

if [ "$BACKEND" = "keychain" ]; then
  echo "  ✓ Keychain (libsecret/GNOME Keyring) available"
  echo "keychain" > "$HOME/.nerdalert/credential-backend.txt"
  chmod 600 "$HOME/.nerdalert/credential-backend.txt"
else
  echo "  ✓ Using file backend at ~/.nerdalert/secrets/ (expected on headless boxes)"
  echo "file" > "$HOME/.nerdalert/credential-backend.txt"
  chmod 600 "$HOME/.nerdalert/credential-backend.txt"
  mkdir -p "$HOME/.nerdalert/secrets"
  chmod 700 "$HOME/.nerdalert/secrets"
fi

# ── 4. Check for existing .env ────────────────────────────────
echo ""
if [ -f ".env" ]; then
  echo "→ Existing .env found — leaving it alone"
  echo "  (Delete .env and re-run setup if you want to start fresh)"
else
  echo "→ Creating .env (non-secret config only)..."

  cat > .env << 'EOF'
# ============================================================
# NerdAlert configuration (non-secret)
# ============================================================
# This file holds NON-SECRET configuration only. Secrets live in
# the OS keychain (or chmod-600 files at ~/.nerdalert/secrets/)
# via the /setup panel — http://localhost:3773/api/setup/panel.
#
# The server bearer token (SERVER_AUTH_TOKEN) is auto-generated
# on first boot and stored in the credential store. It is NOT
# written to this file.

# Model — uncomment one:
# MODEL=anthropic/claude-sonnet-4-6
MODEL=nvidia/llama-3.1-nemotron-70b-instruct:free

# Telegram chat ID (NOT a secret — it's an identifier).
# The bot TOKEN goes in below; that one IS a secret and will
# move to the credential store in a future migration.
TELEGRAM_CHAT_ID=

# TRANSITIONAL — Telegram bot token still reads from env.
# Once src/telegram/bot.ts is migrated to credential-store, this
# line goes away and the token moves to /setup.
TELEGRAM_BOT_TOKEN=

# OpenClaw gateway URL (the URL is config; the TOKEN goes in /setup)
OPENCLAW_URL=

# Gmail (optional)
# GMAIL_CONFIG_PATH=~/.nerdalert/secrets/email-gmail.json
# GOOGLE_CALENDAR_SECRET_PATH=~/.nerdalert/secrets/google-calendar.json
EOF

  echo "  ✓ .env created"
fi

# ── 5. Telegram setup (transitional) ──────────────────────────
# The Telegram bot token still reads from process.env, so we
# still need to write it to .env here. Drop this whole block
# once src/telegram/bot.ts has been migrated to use
# getCredential('telegram-bot-token').
echo ""
echo "→ Telegram setup (transitional — moving to /setup later)"
echo ""

EXISTING_TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" .env | cut -d= -f2)
if [ -z "$EXISTING_TOKEN" ]; then
  echo "  You need a Telegram bot token from @BotFather."
  echo "  1. Open Telegram and message @BotFather"
  echo "  2. Send /newbot and follow the prompts"
  echo "  3. Copy the token it gives you"
  echo ""
  echo "  (Press Enter to skip — you can add it later via /setup once"
  echo "   the Telegram module is migrated to credential-store.)"
  echo ""
  read -rp "  Paste your bot token (or skip): " BOT_TOKEN
  if [ -n "$BOT_TOKEN" ]; then
    sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${BOT_TOKEN}|" .env
    echo "  ✓ Bot token saved to .env"
  else
    echo "  ⚠ Skipped — Telegram alerts disabled until you add it"
  fi
else
  echo "  ✓ Bot token already set"
fi

echo ""
EXISTING_CHAT=$(grep "^TELEGRAM_CHAT_ID=" .env | cut -d= -f2)
if [ -z "$EXISTING_CHAT" ]; then
  echo "  To get your chat ID:"
  echo "  1. Start a conversation with your bot in Telegram"
  echo "  2. Send any message to it"
  echo "  3. Visit: https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
  echo "  4. Find 'chat':{'id': XXXXXXX} in the response"
  echo ""
  read -rp "  Paste your chat ID (or skip): " CHAT_ID
  if [ -n "$CHAT_ID" ]; then
    sed -i "s|^TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=${CHAT_ID}|" .env
    echo "  ✓ Chat ID saved"
  else
    echo "  ⚠ Skipped"
  fi
else
  echo "  ✓ Chat ID already set"
fi

# ── 6. Model selection (config only — keys go in /setup) ──────
echo ""
echo "→ Model selection"
echo ""
echo "  Which model do you want as the default?"
echo "  1) Nemotron 70B (free, OpenRouter)"
echo "  2) Claude Sonnet 4.6 (Anthropic)"
echo "  3) Mistral Small 3.2 (local Ollama)"
echo ""
echo "  This only sets the MODEL string in .env. The actual API key"
echo "  goes through /setup in your browser after the server starts."
echo ""
read -rp "  Choice [1/2/3]: " MODEL_CHOICE

case "$MODEL_CHOICE" in
  2)
    sed -i "s|^MODEL=.*|MODEL=anthropic/claude-sonnet-4-6|" .env
    echo "  ✓ MODEL set to anthropic/claude-sonnet-4-6"
    echo "  → Add your anthropic-key via /setup before chatting"
    ;;
  3)
    sed -i "s|^MODEL=.*|MODEL=ollama/mistral-small3.2|" .env
    echo "  ✓ MODEL set to ollama/mistral-small3.2"
    echo "  → Make sure OLLAMA_HOST is set in .env (e.g. http://192.168.10.100:11434)"
    if ! grep -q "^OLLAMA_HOST=" .env; then
      echo "" >> .env
      echo "# Local Ollama instance" >> .env
      echo "OLLAMA_HOST=" >> .env
      echo "  → Added empty OLLAMA_HOST line to .env — set the URL there"
    fi
    ;;
  *)
    sed -i "s|^MODEL=.*|MODEL=nvidia/llama-3.1-nemotron-70b-instruct:free|" .env
    echo "  ✓ MODEL set to nvidia/llama-3.1-nemotron-70b-instruct:free"
    echo "  → Add your openrouter-key via /setup before chatting"
    ;;
esac

# ── 7. Build TypeScript ───────────────────────────────────────
echo ""
echo "→ Building TypeScript..."
npm run build
echo "  ✓ Build complete"

# ── 8. Shell aliases ──────────────────────────────────────────
echo ""
echo "→ Adding shell aliases to ~/.bashrc..."

BASHRC="$HOME/.bashrc"
if ! grep -q "# NerdAlert aliases" "$BASHRC" 2>/dev/null; then
  cat >> "$BASHRC" << EOF

# NerdAlert aliases
alias nerd-start="cd ${NERDALERT_DIR} && npm run build && node dist/server/index.js"
alias nerd-logs="sudo journalctl -u ${SERVICE_NAME} -f"
alias nerd-restart="sudo systemctl restart ${SERVICE_NAME}"
alias nerd-status="sudo systemctl status ${SERVICE_NAME}"
EOF
  echo "  ✓ Aliases added (run 'source ~/.bashrc' to activate)"
else
  echo "  ✓ Aliases already present"
fi

# ── 9. systemd service ────────────────────────────────────────
echo ""
echo "→ Installing systemd service..."

if [ -f "$SERVICE_FILE" ]; then
  sudo cp "$SERVICE_FILE" "$SYSTEMD_DIR/"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl start "$SERVICE_NAME"
  echo "  ✓ Service installed and started"
  echo "  ✓ Will auto-start on boot"
else
  echo "  ⚠ nerdalert@.service not found — skipping systemd install"
  echo "  Start manually with: nerd-start"
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "  ══════════════════════════════════════════"
echo "  Setup complete."
echo ""
echo "  Next steps:"
echo "  1. Open http://localhost:3773/api/setup/panel in a browser"
echo "     (or via the host that can reach this box)"
echo "  2. Add your model API key (openrouter-key, anthropic-key)"
echo "  3. Optional: add openclaw-token, wazuh-indexer-password,"
echo "     and other SOC creds for the security tools"
echo ""
echo "  The server bearer token was auto-generated on first boot"
echo "  and stored in the credential store — the browser UI will"
echo "  pick it up automatically when you open http://localhost:3773"
echo ""
echo "  Check status:  nerd-status"
echo "  View logs:     nerd-logs"
echo "  Restart:       nerd-restart"
echo "  ══════════════════════════════════════════"
echo ""
