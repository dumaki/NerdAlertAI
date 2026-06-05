# YouTube Search Setup

The video tool can search YouTube when you give it a YouTube Data API v3 key.
This is **optional**. Without a key, "show me a video of X" still works — it
searches Wikimedia Commons (open-licensed educational, scientific, and
historical clips). Adding a key just widens the catalog to all of YouTube
(music, tutorials, pop culture).

The key lives in the OS keychain (or a chmod-600 file fallback), never in
`.env` and never in the repo. You paste it once into the `/setup` panel.

> These steps were walked against the live Google Cloud Console on 2026-06-05.
> Google moves things around occasionally; the section labels below are what
> mattered, even if a button shifts.

---

## Step 1 — Sign in and make a dedicated project

1. Go to **https://console.cloud.google.com** and sign in with the Google
   account you want this key tied to. A personal account is fine — no billing
   required.
2. First time only: you'll get a country + Terms prompt. Accept it.
3. In the top nav bar, click the **project selector** (left of the search bar)
   and click **New Project**. Name it something obvious like
   `youtube-embedded` and click **Create**.

   Use a **separate project**, not your existing one (e.g. a calendar/OAuth
   project). Isolation means you can rotate or delete this key later without
   touching anything else, and the per-project quota dashboard stays readable.
4. Make sure the new project is the one selected in the top bar before
   continuing.

---

## Step 2 — Enable the YouTube Data API v3

1. From the project dashboard, under **Quick access**, click the
   **APIs & Services** card. (Equivalently: hamburger menu ->
   APIs & Services.)
2. In the left nav, click **Library**.
3. Search **youtube**. Several YouTube APIs come back (Data API v3, Analytics,
   Reporting, Embedded Player). Click **YouTube Data API v3** — the one whose
   description mentions "videos, playlists, and channels."
4. On its product page, click **Enable**.

It enables in a couple of seconds and lands you on the API's management page
(it shows Service name `youtube.googleapis.com`, Type "Public API", Status
"Enabled").

---

## Step 3 — Create the API key (Public data)

1. On the API management page, click **Create credentials** (top right), or go
   to **APIs & Services -> Credentials -> + Create credentials -> API key**.
2. A **Credential Type** wizard appears:
   - **Which API are you using?** -> **YouTube Data API v3** (usually
     pre-selected).
   - **What data will you be accessing?** -> choose **Public data**.

   This is the key distinction. **Public data** creates a plain **API key** —
   correct, because video search only reads public YouTube listings. **User
   data** would create an **OAuth client** (that's what a calendar/Gmail
   integration needs, because it reads a user's private account). You do **not**
   want OAuth here.
3. Click **Next**. Google generates the key and shows it under **Your API key**
   — a ~39-character string starting with `AIza`. **Copy it.**

---

## Step 4 — Restrict the key

Right on the key screen there's a "We recommend restricting this key" banner —
click **Restrict key** (or open the key later via Credentials -> click the
key). There are two restriction sections:

### Application restrictions -> None

This controls *where* the key may be called from. NerdAlert calls the API
**server-side** (the Node process makes the request), so:
- **Websites** would break it (no browser referrer is sent server-side).
- **IP addresses** is the tightest option *if* your server has a **static**
  public IP — but most home/residential connections have a dynamic IP, and if
  it rotates, the key silently starts returning 403 and video search quietly
  falls back to Wikimedia. Only use this if you have a static IP and accept the
  upkeep.
- **Android / iOS apps** don't apply.
- **None** is the sane default for a self-hosted key — its real protection is
  the API restriction below.

### API restrictions -> Restrict key -> YouTube Data API v3

This is the one that matters. Select **Restrict key**, check **YouTube Data
API v3** in the dropdown, and **Save**. Now even if the key leaks, it can only
call YouTube search — never any other API you might enable in this project
later.

---

## Step 5 — Paste it into NerdAlert

1. Open the setup panel at **http://localhost:3773/api/setup/panel**.
2. Find **YouTube Data API v3 key** and paste the key.
3. Click **Save**.

The key takes effect immediately — no server restart. The next "show me a
video of X" tries YouTube first.

---

## Step 6 — Confirm the keyed path works

Ask the agent for something Wikimedia Commons would miss but YouTube nails:

- **"show me a video of a Taylor Swift music video"** (or any mainstream music
  / pop-culture clip). A **YouTube embed** with a "YouTube" source link
  confirms the keyed path is live.
- Control: **"show me a video of a wind turbine"** works either way (both
  catalogs have it).

If the YouTube path is silently failing (bad/over-restricted key, quota
exhausted), you'll get a Wikimedia result instead and the server log shows:
`[video] youtube search failed (...) falling back to wikimedia`. That line is
your diagnostic.

*(Verified working on the Mistral narration path on 2026-06-05.)*

---

## What you get / what it costs

- **Coverage:** All public YouTube videos, embedded privately via
  `youtube-nocookie.com` (no tracking cookies until you press play).
- **Quota:** Google's free tier is 10,000 units/day. Each search costs 100
  units, so roughly **100 searches per day**. NerdAlert requests one result
  per search to keep the cost predictable. (This is also why the `/setup`
  field has no "Test" button — a probe call would burn 100 units per click.)
- **If the quota runs out** (or the key is wrong, or YouTube is unreachable):
  the search silently falls back to Wikimedia Commons. The user still gets a
  result; only the server log notes the fallback. Nothing breaks.

## Removing it

Delete the key from the keychain (or the `~/.nerdalert/secrets/` file) and
restart, or just stop using it — with no key configured, video search reverts
to Wikimedia-only exactly as it shipped before this feature. The video tool is
self-contained; turning the key off changes nothing else.
