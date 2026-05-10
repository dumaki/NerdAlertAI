# NerdAlert — Shipping Guide

This document covers what to send testers, what stays on your machine, and what each person needs to do to get running.

---

## What this is

NerdAlert is a self-hosted AI agent with a personality layer. The default personality is Sherman. It runs locally on your machine — there's no cloud, no subscription, no shared server. Everyone who runs it has their own isolated instance.

---

## What to send testers (Jung, Rob, etc.)

Send the project folder. Your `.env`, your `~/.nerdalert/secrets/` folder, and your OS keychain entries stay on your machine.

The cleanest way to share is a private GitHub repo they can clone (`.gitignore` already excludes `.env`).

**What they get:**
- All the source code
- `config.yaml` (no secrets in here)
- `setup.sh` (Mac) / `setup-linux.sh` (Linux)
- `SHIPPING.md` (this file)
- `package.json` and dependencies list

**What stays on your machine:**
- Your OS keychain entries — every API key, token, and password lives there
- `~/.nerdalert/secrets/` — chmod-600 file fallback for systems without a keychain (headless Linux)
- `.env` — no secrets, but contains your local URLs and config
- SOC tool credentials — these talk to your home hardware (Wazuh, Pi-hole, pfSense, etc.) and are useless without it

---

## What testers need before running setup

### Required
- **A Mac or Linux machine** (Windows support is planned but not yet included)
- **Node.js 18 or higher** — download from [nodejs.org](https://nodejs.org)
- **A free OpenRouter account** — get a key at [openrouter.ai](https://openrouter.ai)
  - Sign up → Dashboard → Keys → Create key
  - The default model (Nemotron) is completely free. No credit card needed.

### Optional (unlocks Gmail features)
- A Gmail account with 2-Step Verification enabled

---

## Running setup for the first time

```bash
bash setup.sh        # Mac
# or
bash setup-linux.sh  # Linux
```

The script will:
1. Check that Node.js is installed
2. Install npm packages
3. Probe your credential backend (OS keychain or chmod-600 file fallback at `~/.nerdalert/secrets/`)
4. Write a minimal `.env` with non-secret config only — port, model, URLs, usernames
5. Add shell aliases (`nerd-start`, `nerd-setup`) to your terminal config

**The script does not ask for any API keys, tokens, or passwords.** All credentials are entered through the `/setup` panel after the server starts. This is by design — secrets never live in `.env`, never get written to disk in plaintext, and never travel through chat.

After it finishes, open a new terminal tab and run:

```bash
nerd-start    # starts the server on port 3773
```

The first time the server boots, it auto-generates your `server-auth-token` directly into the OS keychain. You'll see this on a clean boot:

```
[security] .env self-check: no secrets detected ✓
```

---

## Adding your credentials — the /setup panel

Once the server is running, open this URL **in the same browser, on the same machine** as the server:

```
http://localhost:3773/api/setup/panel
```

The panel is loopback-only — it refuses any connection that isn't from `127.0.0.1`. Paste each credential, click save, and the panel:
- Writes it to your OS keychain (or chmod-600 file at `~/.nerdalert/secrets/` if keychain isn't available)
- Clears the input field
- Notifies the running server to reload that credential without restart

**Credentials managed via /setup:**
- `openrouter-key` — required for free-tier models
- `anthropic-key` — required if you want to run on Claude
- `gmail-app-password` — required for Gmail features
- `telegram-bot-token` — required for Telegram alerts
- `openclaw-token` — only relevant if you're running OpenClaw
- SOC credentials (Wazuh, CrowdSec, etc.) — only relevant if you've enabled SOC tools

The server picks up new credentials live; no restart required for credential rotations.

---

## Switching AI models

NerdAlert supports four model paths today, with a fifth planned.

### Model tiers

| Tier | Model | Tool support | Best for |
|---|---|---|---|
| **Cloud — premium** | `anthropic/claude-sonnet-4-6` | Native ReAct loop | Owner use, complex tasks |
| **Cloud — free** | `nvidia/llama-3.1-nemotron-70b-instruct:free` | Pseudo-tool ReAct | Zero-cost testing |
| **Local — strong** | `ollama/mistral-small3.2` | OpenAI-native (auto-falls back to pseudo-tool) | Anyone with a 16GB+ VRAM GPU |
| **Local — small** | `ollama/qwen3.5:9b` | Pseudo-tool | Future Pi kit candidate |
| **Cloud — Firefox tier** | GPT-4o via OAuth | Planned | Testers with OpenAI accounts |

The default model is **Nemotron** (free, via OpenRouter). To switch, edit `MODEL=` in `.env`:

```
# Cloud — premium (requires anthropic-key in /setup)
MODEL=anthropic/claude-sonnet-4-6

# Cloud — free (requires openrouter-key in /setup)
MODEL=nvidia/llama-3.1-nemotron-70b-instruct:free

# Local — strong (requires Ollama running locally or on LAN, OLLAMA_HOST in .env)
MODEL=ollama/mistral-small3.2
```

Then restart the server. The agent dropdown in the web UI also lets you switch between three preset model labels at runtime.

**Routing rules:**
- `anthropic/...` → Anthropic SDK with native `tool_use` loop
- `ollama/...` → Ollama OpenAI-compat endpoint at `OLLAMA_HOST` (auto-falls back to pseudo-tool if the model isn't tagged tool-capable in its Modelfile)
- anything else → OpenRouter pseudo-tool path

---

## How tools work across model paths

Three different ReAct loops, one unified internal event layer (`AgentEvent`), one wire format the UI consumes.

| Path | How tool calls happen |
|---|---|
| **Anthropic native** | Model emits `tool_use` blocks; SDK handles the protocol |
| **Ollama OpenAI-native** | Model emits OpenAI `tool_calls` deltas; capability auto-detected, falls back if not supported |
| **Pseudo-tool (OpenRouter / Ollama fallback)** | Model emits `<tool_call>{...}</tool_call>` XML blocks; tag scanner parses, executes, injects results back, re-prompts |

All three paths go through the same permission broker (`core/permission-broker.ts`), so trust enforcement, enabled-state checks, and approval flows behave identically regardless of which model is active.

**Intent-prefetch:** for non-Anthropic paths, the server detects what you're asking about from keywords and pre-fetches relevant tool data before the model sees the prompt. This keeps free-tier models responsive even when their tool-call accuracy is shaky.

---

## Available tools (what works out of the box)

| Tool | Default | What it needs |
|---|---|---|
| **datetime** | ✅ Enabled | Nothing |
| **memory** | ✅ Enabled | Nothing — stores locally |
| **weather** | ✅ Enabled | Nothing — uses Open-Meteo (keyless) |
| **web** | ✅ Enabled | Nothing |
| **host_metrics** | ✅ Enabled | Nothing — local OS reads, no auth, no network |
| **project** | ✅ Enabled | Nothing — sandboxed reads under `~/.nerdalert/projects/` |
| **cron_manager** | ✅ Enabled | Built-in scheduled job runner; create / list / remove jobs |
| **gmail** | ⚙️ Setup required | App Password via the conversational flow (see below) |
| **google_calendar** | ⚙️ Setup required | Same OAuth flow as Gmail (planned) |
| **github** | 🚫 Disabled | Future tool (planned) |
| **SOC tools** (Wazuh, Pi-hole, CrowdSec, pfSense, NTopNG, Loki, InfluxDB, Fail2ban, Nmap) | 🚫 Disabled | Your homelab hardware + creds via `/setup` |

---

## Setting up Gmail (optional)

Gmail uses a Google App Password (not OAuth). The flow is conversational — start a chat and say:

> "Set up Gmail for me."

Sherman walks you through four steps:
1. Your Gmail address
2. Verifying 2-Step Verification is on
3. Generating an App Password at https://myaccount.google.com/apppasswords
4. Your email signature

The agent saves everything to your OS keychain on confirmation. You can also enter the App Password directly through `/setup` if you'd prefer to skip the conversational flow.

Gmail is already enabled in `config.yaml` by default — once credentials are saved, it's available immediately.

---

## What the SOC tools are (and why they're disabled)

The SOC tools (Wazuh, Pi-hole, pfSense, CrowdSec, NTopNG, Loki, InfluxDB, Fail2ban, Nmap) connect to home network security hardware. They're disabled by default in `config.yaml` and require credentials entered through `/setup`. Even with credentials, they only work if you're running the matching services on your network.

If you're curious about building a homelab that supports these tools, that's a separate conversation.

---

## Troubleshooting

**"command not found: nerd-start"**
The aliases haven't loaded yet. Open a new terminal tab and try again. If it still doesn't work, run `source ~/.zshrc` (or `~/.bashrc` if you use bash).

**Server starts but Sherman doesn't respond**
Check that you've added your `openrouter-key` (or `anthropic-key` if running on Claude) via `/setup`. If you just added them, the server picks them up live — no restart needed.

**`.env` self-check: 1 unexpected secret detected ✗**
The boot self-check flagged something in your `.env` that looks like a secret. The log line tells you exactly which key. Open `/setup`, save the affected credential there, then remove the matching line from `.env` and restart.

**Gmail errors on startup**
Either run the Gmail setup conversation with Sherman, or set `gmail.enabled: false` in `config.yaml` if you don't plan to use it.

**Port 3773 already in use**
Something else is on that port. Either stop that process or change `SERVER_PORT` in `.env` to any unused port (e.g. `3774`).

**Model routing to OpenRouter when you expect Claude**
Check that `MODEL` in `.env` starts with exactly `anthropic/` — for example `anthropic/claude-sonnet-4-6`. Any variation (`claude/...`, `claude-sonnet-4-6`) will route to OpenRouter instead.

**Tool error: "X is disabled in config.yaml"**
The permission broker rejects calls to disabled tools. Open `config.yaml`, set `enabled: true` for that tool, and restart.

**Tool responses show reasoning traces**
Free-tier models (Nemotron in particular) sometimes narrate their reasoning. Switch to Claude or Mistral for cleaner output, or accept it as a free-tier limitation.

---

## Docker support

Docker support is planned for a future release. When the project has a proper UI layer and multiple services to orchestrate, a `docker-compose.yml` will make more sense than asking people to install Docker before running `bash setup.sh`. For now, Node.js + the setup script is the right install path.

---

## Planned features not yet shipped

- Voice bridge (Raspberry Pi STT → agent → TTS)
- GitHub tools
- Plex / Sonarr / Radarr integration
- Authentik SSO for the web UI
- GPT-4o OAuth tier (Firefox path)
- Project storage as a first-class primitive (`~/.nerdalert/projects/<name>/` with auto-loading `NERDALERT.md`)
- Memory side panel (People / Projects / General)
- Document indexing with shared-embedding store
- File safety (git-soft-enforced for code; auto-snapshots for documents)
- BYOK / Multi-Provider Tool Loop (per-provider API keys via `/setup`)
- Elevation system (JAMF-style `/elevate` for L3+ tools, session-scoped)

---

*NerdAlert is a work in progress. If something breaks, that's expected — this is a beta build shared with friends, not a finished product.*
