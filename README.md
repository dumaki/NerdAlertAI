# NerdAlert AI

A self-hosted AI agent with personality. Talk to it in your browser or terminal.

---

## Getting Started

**Before you do anything else — move this folder somewhere permanent.**

The folder you're looking at right now is where NerdAlert will live on your machine. Don't leave it in Downloads. Put it somewhere you won't accidentally delete it, like:

- `~/Documents/NerdAlertAI`
- `~/Desktop/NerdAlertAI`

Once it's where you want it, follow these steps:

---

### Step 1 — Open Terminal

Press `Command + Space`, type `terminal`, hit Enter.

---

### Step 2 — Navigate to the folder

Type `cd` followed by a space, then drag the NerdAlert folder from Finder directly into the terminal window. It will fill in the path automatically. Hit Enter.

Or type it manually — for example:
```
cd ~/Documents/NerdAlertAI
```

---

### Step 3 — Run setup

```
bash setup.sh
```

The script will walk you through everything — it checks your dependencies, sets up your configuration, and gets your aliases ready. Follow the prompts.

---

### Step 4 — You're in

After setup finishes, run:
```
source ~/.zshrc
```

Then open a new terminal tab and type:
```
nerd-start
```

That starts the server. You'll see a URL appear — `http://localhost:3773`.

Open a second new terminal tab and type:
```
nerd-open
```

Or just copy `http://localhost:3773` from the nerd-start tab and paste it into your browser directly.

Pick your agent and start talking.

---

## Questions?

Read `SHIPPING.md` for a full breakdown of what's included, what needs setup, and how to switch models.
