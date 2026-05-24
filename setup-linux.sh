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
#   5. Prompts for the Telegram chat ID (not a secret — it's an
#      identifier that locks the bot to one user)
#   6. Prompts for model provider preference (writes MODEL=...)
#   7. Installs systemd service so the bot starts on boot
#   8. Builds TypeScript
#   9. Starts the service
#
# What it does NOT do (post credential-store migration):
#   - It does NOT generate or write SERVER_AUTH_TOKEN. The
#     server auto-generates this on first boot and stores it
#     in the keychain (or chmod-600 file fallback).
#   - It does NOT prompt for OpenRouter, Anthropic, OpenClaw,
#     or Telegram bot tokens. Add those via /setup after starting
#     the server. All four are stored in the OS keychain.
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

# Telegram chat ID (NOT a secret — it's an identifier that locks
# the bot to one user). The bot TOKEN goes through /setup, not
# this file.
TELEGRAM_CHAT_ID=

# OpenClaw gateway URL (the URL is config; the TOKEN goes in /setup)
OPENCLAW_URL=

# Gmail (optional)
# GMAIL_CONFIG_PATH=~/.nerdalert/secrets/email-gmail.json
# GOOGLE_CALENDAR_SECRET_PATH=~/.nerdalert/secrets/google-calendar.json
EOF

  echo "  ✓ .env created"
fi

# ── 5. Telegram chat ID ───────────────────────────────────────
# Chat ID stays in .env because it's not a secret — it's an
# identifier that locks the bot to one user. The bot TOKEN is
# entered via the /setup panel after the server starts.
echo ""
echo "→ Telegram chat ID"
echo ""

EXISTING_CHAT=$(grep "^TELEGRAM_CHAT_ID=" .env | cut -d= -f2)
if [ -z "$EXISTING_CHAT" ]; then
  echo "  The chat ID locks the bot to one user (you). The bot"
  echo "  silently ignores messages from any other chat."
  echo ""
  echo "  To get your chat ID:"
  echo "  1. Add your bot via /setup AFTER this script finishes:"
  echo "     http://localhost:3773/api/setup/panel  →  telegram-bot-token"
  echo "  2. Start a conversation with your bot in Telegram, send any message"
  echo "  3. Visit: https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
  echo "  4. Find 'chat':{'id': XXXXXXX} in the response"
  echo ""
  read -rp "  Paste your chat ID (or skip and edit .env later): " CHAT_ID
  if [ -n "$CHAT_ID" ]; then
    sed -i "s|^TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=${CHAT_ID}|" .env
    echo "  ✓ Chat ID saved"
  else
    echo "  ⚠ Skipped — set TELEGRAM_CHAT_ID in .env before starting Telegram"
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
    echo "  → Make sure OLLAMA_HOST is set in .env (e.g. http://192.168.0.218:11434)"
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

# ── 7. Optional capabilities (semantic memory + voice) ───
# NerdAlert ships three opt-in capabilities that the agent enables
# automatically when their assets are present. The repo deliberately
# does not bundle these — see voices.example/README.md and
# whisper-models.example/README.md for the license-cleanroom + size
# rationale.
#
# This block detects what's installed, creates the empty directories
# so the user sees where things go, and offers to download the two
# model files. It does NOT install binaries — those have user-
# preferred install methods (apt vs pipx vs source build) we refuse
# to choose for the user.
echo ""
echo "→ Optional capabilities (semantic memory + voice)"

# Create the three optional-asset directories up front so the user
# sees where assets go even if they skip the downloads.
mkdir -p "$HOME/.nerdalert/embeddings"      && chmod 700 "$HOME/.nerdalert/embeddings"
mkdir -p "$HOME/.nerdalert/voices"          && chmod 700 "$HOME/.nerdalert/voices"
mkdir -p "$HOME/.nerdalert/whisper-models"  && chmod 700 "$HOME/.nerdalert/whisper-models"

# Binary detection — used by both the prompts below and the final
# summary block. Don't fail-fast on missing tools; modules light up
# at next boot via their capability checks (Pattern 25).
HAS_GIT_LFS="no"
HAS_PIPER="no"
HAS_WHISPER_CLI="no"
HAS_FFMPEG="no"
command -v git-lfs     &>/dev/null && HAS_GIT_LFS="yes"
command -v piper       &>/dev/null && HAS_PIPER="yes"
command -v whisper-cli &>/dev/null && HAS_WHISPER_CLI="yes"
command -v ffmpeg      &>/dev/null && HAS_FFMPEG="yes"

# Semantic memory model.
# TODO(v1.0.0): consider flipping default to N for broader-user
# releases. Today (beta — Rob + Jung) default Y keeps fresh installs
# at full capability with one Enter press. See HANDOFF_v0_5_30 for
# the rationale.
SEM_MODEL_DIR="$HOME/.nerdalert/embeddings/bge-base-en-v1.5"
if [ -d "$SEM_MODEL_DIR" ] && [ -f "$SEM_MODEL_DIR/config.json" ]; then
  echo "  ✓ Semantic memory model already installed"
else
  echo ""
  echo "  Semantic memory model — bge-base-en-v1.5 (~400 MB)"
  echo "  Powers smarter memory.search() recall via embeddings."
  echo "  Skipping is safe: memory falls back to TF-IDF keyword search."
  echo ""
  read -rp "  Download now? [Y/n]: " DOWNLOAD_SEM
  DOWNLOAD_SEM="${DOWNLOAD_SEM:-Y}"
  if [[ "$DOWNLOAD_SEM" =~ ^[Yy] ]]; then
    if [ "$HAS_GIT_LFS" = "yes" ]; then
      echo "  → Cloning BAAI/bge-base-en-v1.5 via git-lfs..."
      # --skip-repo: we're not inside a git repo and don't want
      # git-lfs to write its smudge filter to global config.
      git lfs install --skip-repo &>/dev/null || true
      if git clone https://huggingface.co/BAAI/bge-base-en-v1.5 "$SEM_MODEL_DIR"; then
        echo "  ✓ Semantic memory model installed"
      else
        echo "  ⚠ Clone failed — semantic memory will fall back to TF-IDF"
        echo "    Retry later with:"
        echo "      git clone https://huggingface.co/BAAI/bge-base-en-v1.5 $SEM_MODEL_DIR"
        # Don't leave a partial clone on disk — the capability check
        # would see an incomplete directory and report it as broken
        # rather than missing, which is a more confusing failure mode.
        rm -rf "$SEM_MODEL_DIR"
      fi
    else
      echo "  ⚠ git-lfs not installed — can't auto-download"
      echo "    Install with:  sudo apt install git-lfs"
      echo "    Then run:"
      echo "      git clone https://huggingface.co/BAAI/bge-base-en-v1.5 $SEM_MODEL_DIR"
    fi
  else
    echo "  → Skipped — semantic memory will use TF-IDF keyword search"
  fi
fi

# Whisper STT model. Matches config.yaml default voice.stt.model:
# base.en. Direct HuggingFace curl avoids the whisper.cpp clone-
# and-run-script dance — same file the official downloader fetches.
WHISPER_MODEL="$HOME/.nerdalert/whisper-models/ggml-base.en.bin"
if [ -f "$WHISPER_MODEL" ]; then
  echo "  ✓ Whisper STT model (base.en) already installed"
else
  echo ""
  echo "  Whisper STT model — base.en (~142 MB)"
  echo "  Required for the mic button + voice input."
  echo "  Also requires whisper-cli + ffmpeg binaries (see summary)."
  echo ""
  read -rp "  Download now? [Y/n]: " DOWNLOAD_WHISPER
  DOWNLOAD_WHISPER="${DOWNLOAD_WHISPER:-Y}"
  if [[ "$DOWNLOAD_WHISPER" =~ ^[Yy] ]]; then
    echo "  → Downloading ggml-base.en.bin from HuggingFace..."
    # -f: fail on HTTP errors (don't write a 404 body to disk)
    # -L: follow redirects (HF uses CDN redirects)
    # --progress-bar: visible progress without verbose curl noise
    if curl -fL --progress-bar \
        -o "$WHISPER_MODEL" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"; then
      echo "  ✓ Whisper model installed"
    else
      echo "  ⚠ Download failed — STT will be unavailable until you retry"
      # Same hygiene as the LFS branch above: never leave a partial
      # file on disk where capability checks might find it.
      rm -f "$WHISPER_MODEL"
      echo "    Retry later with:"
      echo "      curl -fL -o $WHISPER_MODEL \\"
      echo "        https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
    fi
  else
    echo "  → Skipped — STT mic button will stay hidden until installed"
  fi
fi

# ── 8. Build TypeScript ───────────────────────────────────────
echo ""
echo "→ Building TypeScript..."
npm run build
echo "  ✓ Build complete"

# ── 9. Shell aliases ────────────────────────────────────────────
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

# ── 10. systemd service ────────────────────────────────────────
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
echo "  2. Add your credentials — all live in the OS keychain:"
echo "        • telegram-bot-token  (required for Telegram bot)"
echo "        • openrouter-key  or  anthropic-key  (whichever model you chose)"
echo "        • openclaw-token  (if running OpenClaw + SOC tools)"
echo "        • wazuh-indexer-password, crowdsec-* tokens, etc. as needed"
echo ""
echo "  The server bearer token was auto-generated on first boot"
echo "  and stored in the credential store — the browser UI will"
echo "  pick it up automatically when you open http://localhost:3773"
echo ""
echo "  Check status:  nerd-status"
echo "  View logs:     nerd-logs"
echo "  Restart:       nerd-restart"
echo ""
# ── Optional capabilities status ───────────────────────────────
# Re-evaluates the same conditions the step 7 block checked, so
# this stays accurate even if the user accepted only some of the
# downloads. Mirrors the macOS setup.sh summary.
echo "  Optional capabilities — status:"
if [ -d "$SEM_MODEL_DIR" ] && [ -f "$SEM_MODEL_DIR/config.json" ]; then
  echo "    ✓ Semantic memory model installed"
else
  echo "    ○ Semantic memory — TF-IDF fallback active"
fi
if [ "$HAS_PIPER" = "yes" ]; then
  echo "    ✓ Piper TTS binary on PATH (drop voice.onnx into ~/.nerdalert/voices/<personality>/)"
else
  echo "    ○ Piper TTS — install with: pipx install piper-tts"
fi
if [ "$HAS_WHISPER_CLI" = "yes" ] && [ "$HAS_FFMPEG" = "yes" ]; then
  if [ -f "$WHISPER_MODEL" ]; then
    echo "    ✓ Whisper STT ready (binaries + model)"
  else
    echo "    ! Whisper binaries installed, model not downloaded"
  fi
else
  # No apt package for whisper-cli on Ubuntu — build from source.
  # ffmpeg has an apt package; bundle hints into one line for brevity.
  echo "    ○ Whisper STT — sudo apt install ffmpeg + build whisper.cpp from source"
  echo "      (https://github.com/ggerganov/whisper.cpp)"
fi
echo "  See voices.example/README.md + whisper-models.example/README.md for full setup."
echo ""
# ── Recurring deploy procedure ────────────────────────────────
# Addresses HANDOFF_v0_5_30 gap #2 + the v0.5.29 "Tools : log
# regression" mystery.
#
# Two gotchas this procedure handles:
#   1. Dep drift: prod was 14 versions stale when v0.5.29
#      deployed and `pull && build && restart` failed because
#      deps had drifted. `npm install` is a no-op when
#      package-lock matches installed modules, so safe to run
#      every time.
#   2. Boot-output delay: there's a ~2s gap between systemctl
#      marking the service "Started" and the Node process
#      actually emitting its boot banner (Express wire-up +
#      initServerAuthToken + the app.listen callback). Running
#      journalctl too quickly after restart misses the boot
#      lines. `sleep 3` covers it. Verified live on Optiplex
#      2026-05-12: systemd "Started" at 18:26:51, boot banner
#      emitted at 18:26:53.
echo "  To deploy updates after pulling from dev:"
echo "    git pull origin dev \\"
echo "      && npm install \\"
echo "      && npm run build \\"
echo "      && sudo systemctl restart $SERVICE_NAME \\"
echo "      && sleep 3 \\"
echo "      && sudo journalctl -u $SERVICE_NAME --since '10 seconds ago' --no-pager"
echo ""
echo "  To verify a tool registered (e.g. after adding to registry)"
echo "  without restarting, grep the journal for the most recent"
echo "  Tools line:"
echo "    sudo journalctl -u $SERVICE_NAME | grep 'Tools  :' | tail -1"
echo "  ══════════════════════════════════════════"
echo ""
