# Connecting Google Calendar to NerdAlert

NerdAlert reads and writes your Google Calendar through your *own* Google
OAuth client. The client ID and secret are entered in the `/setup` panel
(stored in your OS keychain) — never typed into chat.

This takes about 10 minutes, mostly in the Google Cloud console.

---

## Step 1 — Pick a Google Cloud project

Go to `console.cloud.google.com` and sign in. Use the project picker in the
top bar to create and name a project (e.g. "NerdAlert"), or select an existing
one. *(If your account already has a project from a previous setup, reuse it
and skip to Step 5.)*

## Step 2 — Open the API library

Open the navigation menu (☰) → **APIs & Services → Library**.

## Step 3 — Enable the Calendar API

Search for **Google Calendar API**, open it, and click **Enable**.

## Step 4 — Start the credentials wizard

On the API page, click **Create Credentials**. This opens a guided form:

- **Which API are you using?** → Google Calendar API.
- **What data will you be accessing?** → **User data**. → Next.

## Step 5 — Fill the consent-screen fields

The wizard collects the OAuth consent information: **App name**, a **user
support email**, and a **developer contact email**. For a personal account the
user type is **External**.

*(If the wizard asks you to add scopes, you can skip it — NerdAlert requests
the calendar scope itself at sign-in. If it insists, add
`https://www.googleapis.com/auth/calendar`.)*

## Step 6 — Create the OAuth client

- Set **Application type → Desktop app** and give it a name.
- Click **Create**. The dialog shows your **Client ID** and **Client secret**.
  Copy **both** (or click **Download JSON**, which contains both) — NerdAlert
  needs both. The secret can be re-viewed later by reopening the client under
  **Clients**.
- You do **not** need to add a redirect URI: a Desktop-app client allows the
  local loopback redirect NerdAlert uses automatically.

## Step 7 — Publishing status (how long the connection lasts)

Under **Google Auth Platform → Audience**, choose how long the connection
stays valid:

- **Testing** (default): add yourself under **Test users**. Works immediately
  with no verification, but the refresh token expires about 7 days after you
  authorize — you would re-run "connect calendar" each week.
- **In production**: click **Publish app**. Because the calendar scope is
  "sensitive", the consent screen shows a one-time "unverified app" warning the
  first time — that is expected for a self-use app; click **Advanced → Go to
  NerdAlert (unsafe)** to proceed. The refresh token then does not expire on
  the 7-day clock.

> For a first live test, **Testing + yourself as a test user** is the fastest
> path (the token is good for a week — plenty to verify). Publish to Production
> later if you want the connection to persist indefinitely.

## Step 8 — Enter the credentials in /setup

Open the NerdAlert `/setup` panel. Paste the **Client ID** into the
**google-calendar-client-id** field and the **Client secret** into
**google-calendar-client-secret**, then Save. These go into your OS keychain
and never travel through chat.

## Step 9 — Connect

Say **"connect calendar"**. I will give you a Google authorization link — open
it in a browser on this machine, pick your Google account, and approve calendar
access (click through the one-time warning if you published unverified). The
connection finishes automatically; ask **"what's on my calendar"** to confirm.

---

## Troubleshooting

- **`invalid_grant`** — the refresh token expired or was revoked. Run
  "connect calendar" again to mint a fresh one.
- **"Access blocked" / "app not verified"** — confirm the Calendar API is
  enabled, and that you are a listed **test user** (Testing) or the app is
  **published** (Production).
- **"missing client id / secret"** when connecting — finish Step 8 in `/setup`
  first, then say "connect calendar" again.
