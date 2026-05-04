# NerdAlert — Shipping Guide

This document covers what to send testers, what stays on your machine, and what each person needs to do to get running.

---

## What this is

NerdAlert is a self-hosted AI agent with a personality layer. The default personality is Sherman. It runs locally on your machine — there's no cloud, no subscription, no shared server. Everyone who runs it has their own isolated instance.

---

## What to send testers (Jung, Rob, etc.)

Send the project folder — everything **except** your `.env` file and your `~/.nerdalert/secrets/` folder. Those contain your personal keys and credentials and must never leave your machine.

The cleanest way to share the project is a zip of the folder with `.env` excluded, or a private GitHub repo they can clone.

**What they get:**
- All the source code
- `config.yaml` (no secrets in here)
- `setup.sh` (the onboarding script)
- `SHIPPING.md` (this file)
- `package.json` and dependencies list

**What stays on your machine:**
- `.env` — your API keys, your auth token, your credentials
- `~/.nerdalert/secrets/` — Google OAuth tokens, app passwords
- SOC tools — these talk to your home hardware (Wazuh, Pi-hole, pfSense, etc.) and are useless without it

---

## What testers need before running setup.sh

### Required
- **A Mac or Linux machine** (Windows support is planned but not yet included)
- **Node.js 18 or higher** — download from [nodejs.org](https://nodejs.org)
- **A free OpenRouter account** — get a key at [openrouter.ai](https://openrouter.ai)
  - Sign up → Dashboard → Keys → Create key
  - The default model (Nemotron) is completely free. No credit card needed.

### Optional (unlocks Gmail features)
- A Gmail account with 2-factor authentication enabled
- Willingness to go through a one-time Google OAuth flow

---

## Running setup for the first time

```bash
bash setup.sh
```

The script will:
1. Check that Node.js is installed
2. Install npm packages
3. Generate a unique 32-character auth token
4. Ask for your OpenRouter API key
5. Create your `.env` file
6. Add shell aliases to your terminal config

After it finishes, open a new terminal tab and run:

```bash
nerd-start    # Tab 1 — starts the server
nerd          # Tab 2 — opens the chat REPL
```

Or open the web UI:

```bash
nerd-open     # opens http://localhost:3773 in your browser
```

---

## Switching AI models

NerdAlert supports three model tiers. Think of it like browser compatibility — Claude is Chrome (full feature support), GPT is Firefox (very good), and free Nemotron is Safari (works, with limitations).

### Model tiers

| Tier | Model | Tool support | Best for |
|---|---|---|---|
| **Chrome** | `anthropic/claude-sonnet-4-6` | Full ReAct loop | Owner use, complex tasks |
| **Firefox** | GPT-4o via OAuth | Pre-fetched tools | Testers with OpenAI accounts |
| **Safari** | Nemotron (free) | Pre-fetched tools | Zero-cost testing |

The default model is **Nemotron** (free, via OpenRouter). To switch to Claude (costs money, but noticeably smarter):

1. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com)
2. Open `.env` in any text editor
3. Add your key and change the model line:

```
ANTHROPIC_API_KEY=sk-ant-...
MODEL=anthropic/claude-sonnet-4-6
```

4. Restart the server (`nerd-start`)

To switch back to free Nemotron, change `MODEL` back to `nvidia/llama-3.1-nemotron-70b-instruct:free` and remove or comment out `ANTHROPIC_API_KEY`.

**Important:** The `MODEL` value must start with `anthropic/` exactly to route to the Claude path. `claude/sonnet-4-6` or any other variation will fall through to OpenRouter instead.

---

## How tools work on free models (OpenRouter path)

When running on Nemotron or other OpenRouter models, NerdAlert uses **intent pre-fetching** instead of a live tool loop. This means:

- The server detects what you're asking about from keywords in your message
- It fetches the relevant tool data before sending anything to the model
- The model receives the real data and narrates it — no hallucination on tool results
- Collapsed tool blocks appear in the UI just like the Claude path

**What this means in practice:**
- Datetime, Pi-hole, Wazuh, and other SOC tools all work on free models
- Tool blocks appear at the bottom of the response, same as Claude
- If a tool times out or is unavailable, it's silently skipped — the model won't mention it

**Known limitation — Nemotron reasoning traces:**
Free tier models (Nemotron in particular) sometimes show their reasoning process out loud in responses, especially on complex tool queries. This looks like "Let me check the data... I can see [PIHOLE_SUMMARY]..." rather than just reporting the result cleanly. This is a model behavior quirk, not a bug. GPT-4o tier handles this more cleanly if it's a problem.

---

## Available tools (what works out of the box)

| Tool | Works without setup | What it needs |
|---|---|---|
| **datetime** | ✅ Yes | Nothing |
| **memory** | ✅ Yes | Nothing — stores locally |
| **gmail** | ⚙️ Setup required | Google OAuth (see below) |
| **calendar** | ⚙️ Setup required | Google OAuth (same flow) |
| **SOC tools** | 🚫 Not for general use | Your homelab hardware |

---

## Setting up Gmail (optional)

Gmail access requires a one-time OAuth flow that opens a browser window. Run:

```bash
npm run setup:gmail
```

Follow the prompts. When it's done, your credentials are saved to `~/.nerdalert/secrets/` on your machine. They never leave your machine.

Once Gmail is set up, enable it in `config.yaml`:

```yaml
tools:
  gmail:
    enabled: true
```

Then restart the server.

---

## What the SOC tools are (and why they're disabled)

The SOC tools (Wazuh, Pi-hole, pfSense, CrowdSec, etc.) connect to home network security hardware. They're part of the project but are only useful if you're running that hardware yourself. They're disabled by default in `config.yaml` and will print a clear message if you try to enable them without the right setup.

If you're curious about building a homelab that supports these tools, that's a separate conversation.

---

## Troubleshooting

**"command not found: nerd-start"**
The aliases haven't loaded yet. Open a new terminal tab and try again. If it still doesn't work, run `source ~/.zshrc` (or `~/.bashrc` if you use bash).

**Server starts but Sherman doesn't respond**
Check that your OpenRouter key is in `.env` and is valid. Verify the key at [openrouter.ai/keys](https://openrouter.ai/keys).

**"Unauthorized" error**
Your auth token isn't being sent correctly. The token is in `.env` as `SERVER_AUTH_TOKEN`. The REPL reads it automatically — if you're hitting the API manually, include it as `Authorization: Bearer YOUR_TOKEN`.

**Gmail errors on startup**
Gmail is probably enabled in `config.yaml` but not configured. Either run `npm run setup:gmail` or set `gmail.enabled: false` in `config.yaml`.

**Port 3773 already in use**
Something else is on that port. Either stop that process or change `SERVER_PORT` in `.env` to any unused port (e.g. `3774`).

**Model routing to OpenRouter when you expect Claude**
Check that `MODEL` in `.env` starts with exactly `anthropic/` — for example `anthropic/claude-sonnet-4-6`. Any variation like `claude/sonnet-4-6` will route to OpenRouter instead.

**Tool responses show reasoning traces (Nemotron)**
This is expected behavior on the free model tier. Nemotron sometimes narrates its reasoning process. Switch to `anthropic/claude-sonnet-4-6` for clean tool responses, or accept it as a free-tier limitation.

---

## Docker support

Docker support is planned for a future release. When the project has a proper UI layer and multiple services to orchestrate, a `docker-compose.yml` will make more sense than asking people to install Docker before they can even run `bash setup.sh`. For now, Node.js + the setup script is the right install path.

---

## Planned features not yet in this build

- Voice bridge (Raspberry Pi STT → agent → TTS)
- GitHub tools
- Plex / Sonarr / Radarr integration
- Authentik SSO for the web UI
- GPT-4o OAuth tier (Firefox path)
- Telegram notification bridge for cron/scheduled alerts
- Cron/scheduled tool polling with smart narration routing

---

*NerdAlert is a work in progress. If something breaks, that's expected — this is a beta build shared with friends, not a finished product.*
