# Gmail Setup Playbook

<!-- AGENT INSTRUCTIONS — not shown to user

This file is read by the gmail-setup tool when a user triggers email setup.
Present one step at a time. Wait for confirmation before moving to the next.

Collect TWO pieces of information from the user in chat:
  1. Their Gmail address (Step 1)
  2. Their email signature — what they want appended to outgoing mail (Step 4)

The App Password is NOT collected in chat. The user generates it and enters it
themselves through the /setup panel (Step 3), where it is stored in the
credential store. It never passes through this conversation or the model.

When you have the address and signature, call gmail-setup with action: "save"
and pass email + signature. Then remind the user to finish in /setup if they
have not already.

Do not rush. Do not present multiple steps at once. One step, one pause.
Never ask the user to paste their App Password into the chat.
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

## Step 3 — Generate your App Password and enter it in /setup

Now for the actual password. Open this link — copy and paste the whole thing into your browser:

🔗 **App Passwords page:**
https://myaccount.google.com/apppasswords

You may need to sign in again. Once you're in:

1. In the **App name** field, type: `NerdAlert`
2. Click **Create**
3. Google will show you a **16-character password** — it looks something like `abcd efgh ijkl mnop`
4. Copy it

**Important — do not paste the password into this chat.** Instead, open the **/setup** panel, find the **gmail-app-password** field, paste the password there, and click **Save**. That stores it securely in your credential store; it never travels through this conversation.

When you've saved it in /setup, say **done** and we'll keep going.

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

Once I have your address and signature I'll save the mail configuration and enable email. You won't need to touch any config files or edit anything manually.

If you haven't already entered your App Password in /setup (Step 3), do that now — email won't connect without it. Then restart the server for the changes to take effect.
