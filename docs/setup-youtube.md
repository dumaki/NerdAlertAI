# YouTube Search Setup

The video tool can search YouTube when you give it a YouTube Data API v3 key.
This is **optional**. Without a key, "show me a video of X" still works — it
searches Wikimedia Commons (open-licensed educational, scientific, and
historical clips). Adding a key just widens the catalog to all of YouTube
(music, tutorials, pop culture).

The key lives in the OS keychain (or a chmod-600 file fallback), never in
`.env` and never in the repo. You paste it once into the `/setup` panel.

---

## Step 1 — Sign in to Google Cloud Console

Go to **https://console.cloud.google.com** and sign in with a Google account.
A personal account is fine; you don't need a paid plan.

---

## Step 2 — Create (or pick) a project

At the top of the page, click the project dropdown and either select an
existing project or click **New Project**. Name it anything ("NerdAlert" works)
and create it. Make sure that project is selected before continuing.

---

## Step 3 — Enable the YouTube Data API v3

1. In the search bar, type **YouTube Data API v3** and open it.
2. Click **Enable**.

This is the specific API the video tool calls. Enabling it is what makes your
key able to run searches.

---

## Step 4 — Create an API key

1. Go to **APIs & Services -> Credentials** (left sidebar).
2. Click **Create Credentials -> API key**.
3. Google shows you the key — a ~39-character string starting with `AIza`.
   Copy it.

### Restrict the key (recommended)

Click **Edit API key** on the key you just made and, under **API
restrictions**, choose **Restrict key** and select **YouTube Data API v3**.
That way the key can only be used for YouTube search — if it ever leaks, it
can't touch anything else in your Google account.

---

## Step 5 — Paste it into NerdAlert

1. Open the setup panel at **http://localhost:3773/api/setup/panel**.
2. Find **YouTube Data API v3 key** and paste the key.
3. Click **Save**.

The key takes effect immediately — no server restart. The next "show me a
video of X" will try YouTube first.

---

## What you get / what it costs

- **Coverage:** All public YouTube videos, embedded privately via
  `youtube-nocookie.com` (no tracking cookies until you press play).
- **Quota:** Google's free tier is 10,000 units/day. Each search costs 100
  units, so roughly **100 searches per day**. NerdAlert requests one result
  per search to keep the cost predictable.
- **If the quota runs out** (or the key is wrong, or YouTube is unreachable):
  the search silently falls back to Wikimedia Commons. You'll see a one-line
  note in the server log (`[video] youtube search failed ... falling back to
  wikimedia`), but the user just gets a result. Nothing breaks.

## Removing it

Delete the key from the keychain (or the `~/.nerdalert/secrets/` file) and
restart, or just stop using it — with no key configured, video search reverts
to Wikimedia-only exactly as it shipped before this feature. The video tool is
self-contained; turning the key off changes nothing else.
