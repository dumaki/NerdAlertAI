# Gmail + Calendar Setup — Phase 4

## Overview

Phase 4 adds Gmail and Google Calendar to NerdAlert.
All credentials live in protected JSON files outside the project repo.
Nothing sensitive is ever committed to git.

---

## Gmail Setup

### Step 1 — Enable Gmail IMAP

In Gmail: Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP

### Step 2 — Create a Google App Password

Your Gmail account must have 2-Step Verification enabled.

Google Account → Security → 2-Step Verification → App passwords

Create a new app password. You'll get a 16-character code.
This is what goes in `appPassword` — never your real Google password.

### Step 3 — Create the secrets file

Create the directory:
```bash
mkdir -p ~/.nerdalert/secrets
```

Create the config file:
```bash
touch ~/.nerdalert/secrets/email-gmail.json
chmod 600 ~/.nerdalert/secrets/email-gmail.json
```

Paste this structure and fill in your values:
```json
{
  "accountId": "gmail-main",
  "provider":  "gmail",
  "email":     "you@gmail.com",
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "tls":  true
  },
  "smtp": {
    "host":   "smtp.gmail.com",
    "port":   465,
    "secure": true
  },
  "auth": {
    "user":        "you@gmail.com",
    "appPassword": "xxxx xxxx xxxx xxxx"
  },
  "defaults": {
    "mailbox":      "INBOX",
    "maxListLimit": 25
  },
  "signature": {
    "text": "Your Name\nyour@email.com"
  },
  "logging": {
    "path":         "/Users/yourname/.nerdalert/logs/gmail.log",
    "metadataOnly": true
  }
}
```

### Step 4 — Set the path in .env

In your NerdAlert `.env` file, add:
```
GMAIL_CONFIG_PATH=/Users/yourname/.nerdalert/secrets/email-gmail.json
```

### Step 5 — Test the connection

```bash
ask-sherman test gmail connection
```

Sherman will call the `gmail` tool with action `test` and confirm IMAP + SMTP are working.

---

## Google Calendar Setup (optional)

Calendar adds context to email triage — Sherman can flag emails that relate
to upcoming meetings.

### Step 1 — Create OAuth credentials in Google Cloud Console

1. Go to https://console.cloud.google.com/
2. Create a project (or use an existing one)
3. Enable the Google Calendar API
4. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID
5. Application type: Desktop app
6. Add `http://localhost:8765` as an authorized redirect URI
7. Note your Client ID and Client Secret

### Step 2 — Run the auth script

```bash
npx ts-node scripts/calendar-auth.ts --clientId <YOUR_CLIENT_ID> --clientSecret <YOUR_CLIENT_SECRET>
```

A browser URL will be printed. Open it, approve access, and the script will
print a JSON credential block.

### Step 3 — Save the credentials

```bash
mkdir -p ~/.nerdalert/secrets
touch ~/.nerdalert/secrets/google-calendar.json
chmod 600 ~/.nerdalert/secrets/google-calendar.json
```

Paste the printed JSON into that file.

### Step 4 — Set the path in .env

```
GOOGLE_CALENDAR_SECRET_PATH=/Users/yourname/.nerdalert/secrets/google-calendar.json
```

---

## Mailbox Structure Expected

Sherman's classifier routes mail to these folders.
Create them in Gmail if they don't exist:
- **Coupons** — promotional mail, marked read on move
- **Vinyl Preorders** — vinyl order and tracking mail
- **Review** — non-urgent, non-promo mail for later review

---

## Signature

The `signature.text` field in the config is appended to all drafts and outgoing mail.
Format it however you want — plain text, multi-line is fine.

Example:
```json
"signature": {
  "text": "Ben Hughes\nben@example.com\nNerd Alert"
}
```

---

## Security Notes

- `appPassword` is a Google-generated token, not your account password
- The secrets file should always have permissions `600`
- The secrets directory should be outside the project folder
- `GMAIL_CONFIG_PATH` in `.env` tells NerdAlert where to find it
- The engine refuses to load secrets from inside the project directory
- All log output redacts email addresses (first 2 chars + ***)
