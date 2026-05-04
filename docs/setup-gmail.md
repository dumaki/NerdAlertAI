# Gmail Setup Playbook
<!-- AGENT INSTRUCTIONS — not shown to user
This file is read by the gmail-setup tool when a user triggers email setup.
Present one step at a time. Wait for confirmation before moving to the next.
Collect three pieces of information across the steps:
  1. Their Gmail address (Step 1)
  2. Their App Password — 16 characters, no spaces (Step 3)
  3. Their email signature — what they want appended to outgoing mail (Step 4)
When you have all three, call gmail-setup with action: "save" and pass all three values.
Do not rush. Do not present multiple steps at once. One step, one pause.
-->

## Step 1 — Your Gmail address

First things first — what Gmail address do you want to connect?
Type it out and I'll get us moving.

---

## Step 2 — Check that 2-Step Verification is on

Gmail requires 2-Step Verification to be active before it will let you generate an App Password.

Open this link in your browser and make sure it shows as **On**:

🔗 **2-Step Verification:**
https://myaccount.google.com/signinoptions/two-step-verification

If it's already on, say **ready** and we'll move to the next step.
If it's off, turn it on first — Google will walk you through it — then come back and say **ready**.

---

## Step 3 — Generate your App Password

Now for the actual password. Open this link — copy and paste the whole thing into your browser:

🔗 **App Passwords page:**
https://myaccount.google.com/apppasswords

You may need to sign in again. Once you're in:

1. In the **App name** field, type: `NerdAlert`
2. Click **Create**
3. Google will show you a **16-character password** — it looks something like `abcd efgh ijkl mnop`
4. Copy it (spaces don't matter, I'll strip them)

Paste the password here when you have it.

---

## Step 4 — Your email signature

Almost done. What do you want your outgoing emails to say at the bottom?

This gets appended to every email you send through me. Something like:

```
Thanks,
[Your Name]
```

Or just your name. Or nothing at all — say **skip** to leave it blank.

---

## Step 5 — Saving

Once I have your address, password, and signature I'll save everything and enable email.
You won't need to touch any config files or edit anything manually.
