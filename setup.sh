#!/usr/bin/env bash
# ============================================================
# NerdAlert — First-Time Setup Script (macOS)
# ============================================================
# Run this once on a fresh machine to get NerdAlert running.
#
# What this script does:
#   1. Checks for Homebrew and Node.js 18+
#   2. Installs npm packages
#   3. Probes the OS keychain so we know which credential backend
#      will be used
#   4. Writes a minimal .env (non-secret config only)
#   5. Sets up the nerd-start / nerd-open shell aliases
#
# What this script does NOT do (intentional):
#   - It does NOT generate or write any secrets to .env. The
#     server bearer token is auto-generated on first boot. API
#     keys (OpenRouter, Anthropic, OpenClaw) are entered via the
#     /setup panel in your browser, where they go straight to
#     the OS keychain — never to .env, never to the model, never
#     to the logs.
#   - Gmail setup (run: npm run setup:gmail after this).
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
# STEP 1 — Check Homebrew (Mac only)
# ============================================================
print_header

echo -e "${BOLD}Step 1 — Checking dependencies${RESET}"
echo ""

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
# STEP 2 — Check Node.js
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
# STEP 4 — Probe credential store backend
# ============================================================
# We probe keytar here so the user knows up front which backend
# their credentials will land in. The actual writes happen later,
# via /setup in the browser. The probe is identical to what
# src/security/credential-store.ts does at first use — running it
# during setup is a friendlier UX than discovering at first
# credential write.
# ============================================================
echo ""
echo -e "${BOLD}Step 3 — Testing credential store${RESET}"
echo ""

mkdir -p "$HOME/.nerdalert"
chmod 700 "$HOME/.nerdalert"

info "Probing OS keychain (Apple Keychain on Mac, GNOME Keyring on Linux)..."

PROBE_SCRIPT="$PROJECT_ROOT/.keychain-probe.js"
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
      console.log('REASON=probe ok');
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

PROBE_OUTPUT=$(cd "$PROJECT_ROOT" && node "$PROBE_SCRIPT" 2>&1)
rm -f "$PROBE_SCRIPT"

BACKEND=$(echo "$PROBE_OUTPUT" | grep '^RESULT=' | head -1 | cut -d= -f2)
REASON=$(echo "$PROBE_OUTPUT" | grep '^REASON=' | head -1 | cut -d= -f2-)

if [ "$BACKEND" = "keychain" ]; then
  ok "Keychain available — credentials will be stored there"
  echo "keychain" > "$HOME/.nerdalert/credential-backend.txt"
  chmod 600 "$HOME/.nerdalert/credential-backend.txt"
elif [ "$BACKEND" = "file" ]; then
  warn "Keychain unavailable — falling back to file storage"
  info "Reason: ${REASON}"
  info "Credentials will live at ~/.nerdalert/secrets/ with chmod 600"
  echo "file" > "$HOME/.nerdalert/credential-backend.txt"
  chmod 600 "$HOME/.nerdalert/credential-backend.txt"
  mkdir -p "$HOME/.nerdalert/secrets"
  chmod 700 "$HOME/.nerdalert/secrets"
else
  warn "Probe returned unexpected output"
  info "Output: ${PROBE_OUTPUT}"
  info "Defaulting to file storage. You can re-run setup later."
  echo "file" > "$HOME/.nerdalert/credential-backend.txt"
  chmod 600 "$HOME/.nerdalert/credential-backend.txt"
  mkdir -p "$HOME/.nerdalert/secrets"
  chmod 700 "$HOME/.nerdalert/secrets"
fi

# ============================================================
# STEP 5 — Optional capabilities (semantic memory + voice)
# ============================================================
# NerdAlert ships three opt-in capabilities that the agent
# enables automatically when their assets are present. The
# repo deliberately does not bundle these — see
# voices.example/README.md and whisper-models.example/README.md
# for the license-cleanroom and file-size rationale.
#
# Capabilities and their assets:
#   1. Semantic memory (~400 MB)
#        Asset: bge-base-en-v1.5 HuggingFace model directory
#        Without it: memory.search() falls back to TF-IDF —
#        still works, just less smart on paraphrase queries.
#   2. Voice TTS (Piper)
#        Asset: piper binary + per-personality voice.onnx
#        Without it: speaker icons hidden, no TTS surface.
#   3. Voice STT (Whisper)
#        Asset: whisper-cli + ffmpeg + ggml-*.bin model
#        Without it: mic button hidden, /api/stt returns 503.
#
# This block detects what's installed, creates the empty
# directories so the user sees where things go, and offers
# to download the two model files. It does NOT install
# binaries — those have user-preferred install methods
# (brew vs pipx vs source build) we refuse to choose for the
# user.
# ============================================================
echo ""
echo -e "${BOLD}Step 4 — Optional capabilities${RESET}"
echo ""

# Create the three optional-asset directories up front so the
# user sees where assets go even if they skip the downloads.
# chmod 700 mirrors the existing ~/.nerdalert permission posture.
mkdir -p "$HOME/.nerdalert/embeddings"      && chmod 700 "$HOME/.nerdalert/embeddings"
mkdir -p "$HOME/.nerdalert/voices"          && chmod 700 "$HOME/.nerdalert/voices"
mkdir -p "$HOME/.nerdalert/whisper-models"  && chmod 700 "$HOME/.nerdalert/whisper-models"

# ── Binary detection ─────────────────────────────────────────
# Detect each optional binary so we can report status in the
# final summary block. We don't fail-fast on missing tools —
# user can install them later and the modules light up at next
# boot via their capability checks (Pattern 25, voice + memory).
HAS_GIT_LFS="no"
HAS_PIPER="no"
HAS_WHISPER_CLI="no"
HAS_FFMPEG="no"
command -v git-lfs     &>/dev/null && HAS_GIT_LFS="yes"
command -v piper       &>/dev/null && HAS_PIPER="yes"
command -v whisper-cli &>/dev/null && HAS_WHISPER_CLI="yes"
command -v ffmpeg      &>/dev/null && HAS_FFMPEG="yes"

# ── Semantic memory model download ───────────────────────────
# TODO(v1.0.0): consider flipping default to N for broader-user
# releases. Today (beta — Rob + Jung) default Y keeps fresh
# installs at full capability with one Enter press. See
# HANDOFF_v0_5_30_setup_audit.md for the rationale.
SEM_MODEL_DIR="$HOME/.nerdalert/embeddings/bge-base-en-v1.5"

if [ -d "$SEM_MODEL_DIR" ] && [ -f "$SEM_MODEL_DIR/config.json" ]; then
  ok "Semantic memory model already installed"
else
  info "Semantic memory model — bge-base-en-v1.5 (~400 MB)"
  info "Powers smarter memory.search() recall via embeddings."
  info "Skipping is safe: memory falls back to TF-IDF keyword search."
  echo ""
  read -rp "  Download now? [Y/n]: " DOWNLOAD_SEM
  DOWNLOAD_SEM="${DOWNLOAD_SEM:-Y}"

  if [[ "$DOWNLOAD_SEM" =~ ^[Yy] ]]; then
    if [ "$HAS_GIT_LFS" = "yes" ]; then
      info "Cloning BAAI/bge-base-en-v1.5 via git-lfs..."
      # --skip-repo: we're not inside a git repo and don't want
      # git-lfs to write its smudge filter to a global config.
      git lfs install --skip-repo &>/dev/null || true
      if git clone https://huggingface.co/BAAI/bge-base-en-v1.5 "$SEM_MODEL_DIR"; then
        ok "Semantic memory model installed"
      else
        warn "Clone failed — semantic memory will fall back to TF-IDF"
        info "Retry later with:"
        info "  git clone https://huggingface.co/BAAI/bge-base-en-v1.5 $SEM_MODEL_DIR"
        # Don't leave a partial clone on disk — the capability
        # check would report it as broken rather than missing,
        # which is a more confusing failure mode.
        rm -rf "$SEM_MODEL_DIR"
      fi
    else
      warn "git-lfs not installed — can't auto-download the model"
      info "Install git-lfs with:  brew install git-lfs"
      info "Then run:"
      info "  git clone https://huggingface.co/BAAI/bge-base-en-v1.5 $SEM_MODEL_DIR"
    fi
  else
    info "Skipped — semantic memory will use TF-IDF keyword search"
  fi
fi

# ── Whisper STT model download ───────────────────────────────
# Matches config.yaml default voice.stt.model: base.en.
# Direct HuggingFace curl avoids the whisper.cpp clone-and-run-
# script dance — same file the official downloader fetches.
WHISPER_MODEL="$HOME/.nerdalert/whisper-models/ggml-base.en.bin"

echo ""
if [ -f "$WHISPER_MODEL" ]; then
  ok "Whisper STT model (base.en) already installed"
else
  info "Whisper STT model — base.en (~142 MB)"
  info "Required for the mic button + voice input."
  info "Also requires whisper-cli + ffmpeg binaries (see summary)."
  echo ""
  read -rp "  Download now? [Y/n]: " DOWNLOAD_WHISPER
  DOWNLOAD_WHISPER="${DOWNLOAD_WHISPER:-Y}"

  if [[ "$DOWNLOAD_WHISPER" =~ ^[Yy] ]]; then
    info "Downloading ggml-base.en.bin from HuggingFace..."
    # -f: fail on HTTP errors (don't write a 404 body to disk)
    # -L: follow redirects (HF uses CDN redirects)
    # --progress-bar: visible progress without verbose curl noise
    if curl -fL --progress-bar \
        -o "$WHISPER_MODEL" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"; then
      ok "Whisper model installed"
    else
      warn "Download failed — STT will be unavailable until you retry"
      # Same hygiene as the LFS branch above: never leave a
      # partial file on disk where capability checks might find it.
      rm -f "$WHISPER_MODEL"
      info "Retry later with:"
      info "  curl -fL -o $WHISPER_MODEL \\"
      info "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
    fi
  else
    info "Skipped — STT mic button will stay hidden until installed"
  fi
fi

# ============================================================
# STEP 6 — Write .env (non-secrets only)
# ============================================================
# The .env file holds NON-SECRET configuration only:
# port numbers, MODEL string, OLLAMA_HOST URL, and similar.
#
# Secrets (server bearer token, API keys, gateway tokens) live
# in the OS keychain via /setup. The server auto-generates the
# bearer token on first boot if no keychain entry exists.
# ============================================================
echo ""
echo -e "${BOLD}Step 5 — Creating .env (non-secret config)${RESET}"
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
# This file holds NON-SECRET configuration only.
# Secrets live in the OS keychain — open http://localhost:3773/setup
# in your browser after starting the server.
#
# DO NOT commit this file to git (it is listed in .gitignore).
# ============================================================

# --- SERVER ---
SERVER_PORT=3773

# --- MODEL ---
# Default: free Nemotron via OpenRouter. Add your OpenRouter key via /setup.
# To switch to local Ollama: MODEL=ollama/<your-model>  +  set OLLAMA_HOST below
# To switch to Claude:       MODEL=anthropic/claude-sonnet-4-6  +  add anthropic-key via /setup
MODEL=nvidia/llama-3.1-nemotron-70b-instruct:free

# --- OLLAMA (only if running a local model) ---
# OLLAMA_HOST=http://192.168.0.218:11434

# --- GMAIL (optional — run: npm run setup:gmail) ---
# GMAIL_CONFIG_PATH=~/.nerdalert/secrets/email-gmail.json
# GOOGLE_CALENDAR_SECRET_PATH=~/.nerdalert/secrets/google-calendar.json

# --- SOC (self-hosted hardware only) ---
# OPENCLAW_URL=http://your-openclaw-host:18789
# WAZUH_INDEXER_HOST=http://your-wazuh-host:9200
# WAZUH_INDEXER_USER=admin
# WAZUH_INDEXER_INSECURE=1
# CROWDSEC_LAPI_URL=http://your-crowdsec-host:8080
# CROWDSEC_MACHINE_ID=nerdalert-readonly
# LOKI_URL=http://your-loki-host:3100
# INFLUXDB_URL=http://your-influxdb-host:8086
# INFLUXDB_TELEMETRY_BUCKET=optiplex-metrics
# PFSENSE_URL=http://192.168.1.1
# NTOPNG_URL=http://your-ntopng-host:3000
# NTOPNG_USERNAME=admin
# SYNOLOGY_URL=http://your-synology-host:5000
# SYNOLOGY_USERNAME=youruser
EOF

ok ".env created at $ENV_FILE"
info "(no secrets — those go through /setup)"

# ============================================================
# STEP 6 — Shell aliases
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
alias nerd-setup="open http://localhost:3773/api/setup/panel"
# ─────────────────────────────────────────────────────────────
EOF
  ok "Aliases added to $SHELL_RC"
fi

echo ""
echo -e "  ${YELLOW}Important:${RESET} Run this now to activate your aliases:"
echo -e "  ${CYAN}source $SHELL_RC${RESET}"
echo ""

# ============================================================
# DONE — Summary
# ============================================================
echo ""
echo -e "${CYAN}${BOLD}============================================================${RESET}"
echo -e "${CYAN}${BOLD}  Setup complete.${RESET}"
echo -e "${CYAN}${BOLD}============================================================${RESET}"
echo ""
echo -e "  ${BOLD}Step 1 — Load your aliases:${RESET}"
echo -e "  ${CYAN}source $SHELL_RC${RESET}"
echo ""
echo -e "  ${BOLD}Step 2 — Start NerdAlert:${RESET}"
echo -e "  ${YELLOW}nerd-start${RESET}    ${GRAY}← starts the server (auto-generates a bearer token on first run)${RESET}"
echo ""
echo -e "  ${BOLD}Step 3 — Open the credential setup panel:${RESET}"
echo -e "  ${YELLOW}nerd-setup${RESET}    ${GRAY}← opens http://localhost:3773/api/setup/panel${RESET}"
echo ""
echo -e "  Add your ${BOLD}OpenRouter${RESET} key (free at https://openrouter.ai) to start chatting."
echo -e "  Optional: add ${BOLD}Anthropic${RESET} or ${BOLD}OpenClaw${RESET} keys if you want those providers."
echo ""
echo -e "  ${BOLD}Step 4 — Open the chat UI:${RESET}"
echo -e "  ${YELLOW}nerd-open${RESET}     ${GRAY}← opens http://localhost:3773 in your browser${RESET}"
echo ""
echo -e "  ${BOLD}Optional — set up Gmail:${RESET}"
echo -e "  ${GRAY}npm run setup:gmail${RESET}"
echo ""
# ── Optional capabilities status ───────────────────────────────
# Echoes a final summary of what's wired up vs. what still
# needs manual install. Re-evaluates the same conditions the
# Step 4 block checked, so this stays accurate even if the user
# accepted only some of the downloads.
echo -e "  ${BOLD}Optional capabilities — status:${RESET}"
if [ -d "$SEM_MODEL_DIR" ] && [ -f "$SEM_MODEL_DIR/config.json" ]; then
  echo -e "  ${GREEN}✓${RESET} Semantic memory model installed"
else
  echo -e "  ${GRAY}○${RESET} Semantic memory — TF-IDF fallback active"
fi
if [ "$HAS_PIPER" = "yes" ]; then
  echo -e "  ${GREEN}✓${RESET} Piper TTS binary on PATH ${GRAY}(drop voice.onnx into ~/.nerdalert/voices/<personality>/)${RESET}"
else
  echo -e "  ${GRAY}○${RESET} Piper TTS — install with: ${CYAN}brew install piper${RESET} or ${CYAN}pipx install piper-tts${RESET}"
fi
if [ "$HAS_WHISPER_CLI" = "yes" ] && [ "$HAS_FFMPEG" = "yes" ]; then
  if [ -f "$WHISPER_MODEL" ]; then
    echo -e "  ${GREEN}✓${RESET} Whisper STT ready (binaries + model)"
  else
    echo -e "  ${YELLOW}!${RESET} Whisper binaries installed, model not downloaded"
  fi
else
  echo -e "  ${GRAY}○${RESET} Whisper STT — install with: ${CYAN}brew install whisper-cpp ffmpeg${RESET}"
fi
echo -e "  ${GRAY}See voices.example/README.md + whisper-models.example/README.md for full setup.${RESET}"
echo ""
echo -e "  ${GRAY}Questions? See SHIPPING.md for full documentation.${RESET}"
echo ""
