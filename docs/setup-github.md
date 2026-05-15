# GitHub Setup Playbook
<!-- AGENT INSTRUCTIONS — not shown to the user
This file is read by the github-setup tool when a user triggers GitHub setup.
Present one step at a time. Wait for confirmation before moving to the next.
This is Device Flow OAuth — the user never copies a token. They get an
8-character code, type it at github.com/login/device, and approve.

The flow has TWO TOOL CALLS over a single setup session:
  1. After Step 2, call github-setup with action: "connect".
     The tool returns a user_code and verification_uri to show the user.
  2. After the user says they've approved (Step 4), call github-setup with
     action: "check" and pass back the device_code from step 1.
     If still pending, tell the user to take their time and try again
     when they've clicked Authorize.
     If success, the tool stores the token and returns the connected
     username — confirm to the user and you're done.

If the user already has a Personal Access Token they want to use instead,
call github-setup with action: "save_pat" and pass the pat parameter.

Do not present multiple steps at once. One step, one pause.
-->

## Step 1 — Do you have a GitHub account?

Before we connect anything, just need to check — do you already have a GitHub account?

- If **yes**, say *ready* and we'll keep going.
- If **no**, head to **https://github.com/signup** and create one (takes about 2 minutes).
  Come back and say *ready* once you're signed in.

GitHub is where developers store code. Even if you're not a developer, it's where I'll look up issues, read project docs, and check things you have access to.

---

## Step 2 — What I'll be able to see

Quick heads up on what this connection grants me, since I want you to know what you're approving:

- **Your repos** — public and private ones you own or collaborate on, READ ONLY
- **Your issues and pull requests** — anything assigned to you or that mentions you
- **Your org memberships** — which organizations you belong to (for finding shared repos)
- **Your notifications inbox** — to surface what's waiting for your attention

What I **cannot** do:
- Push code, edit files, or change anything in your repos
- Open issues or comment on them
- Add or remove collaborators
- Modify any settings

If we ever want me to do write actions, that's a separate upgrade you opt into later — different trust level, different conversation.

Say *ready* when you've read this and we'll start the connection.

---

## Step 3 — Get your one-time code

I'm about to ask GitHub for an 8-character code. When I show it to you:

1. Open **https://github.com/login/device** in a browser tab where you're signed in
2. Type the 8-character code I give you (it'll look like `WDJB-MJHT`)
3. Click **Continue**
4. GitHub will show you a page summarizing what NerdAlert wants access to
5. Click **Authorize NerdAlertAI**

The code lasts 15 minutes. If you take longer than that we'll just generate a new one — no big deal.

Ready? I'll request the code now.

<!-- AGENT: After the user confirms ready, call github-setup with action: "connect".
     The tool will return user_code, verification_uri, and device_code.
     Show user_code and verification_uri to the user in a clear, large format.
     Tell them you'll wait for them to come back and say "done" or "approved".
     Stash the device_code for the next tool call. -->

---

## Step 4 — Authorize on GitHub

You should now have your 8-character code from me. Head to the page and authorize.

Take your time — read what GitHub asks you to approve. The page should say something like:
*"NerdAlertAI by [your-account] wants to access your account"* with a list of permissions
(user, repo, read:org, notifications).

Click **Authorize NerdAlertAI**. The page will say *"Congratulations, you're all set!"* or
something similar.

When you've done that, come back here and say **done** (or *approved*, or *I authorized it*).

<!-- AGENT: When the user signals they've authorized, call github-setup with
     action: "check" and pass the device_code from the previous step.
     Three possible outcomes:
       - ok:true, accountLogin: '...' → success, confirm the username
       - status: 'pending'           → user hasn't clicked yet, ask them to retry
       - status: 'expired'           → code timed out, restart from Step 3
       - status: 'denied'            → user clicked Cancel, ask if they want to retry
       - status: 'error'             → show the hint
-->

---

## Step 5 — Confirmation

Once GitHub approves, I'll know your username, run a quick sanity check by listing a couple
of your recent repos, and confirm everything works.

After that you can ask me things like:
- *"what issues are assigned to me?"*
- *"what's in my notifications?"*
- *"read me the README of dumaki/NerdAlertAI"*
- *"what are my most recently updated repos?"*

---

## Alternative path — Personal Access Token

If you already have a GitHub Personal Access Token (PAT) and just want to paste it instead
of doing the OAuth dance, say so and I'll switch paths.

You'd just need:
- A fine-grained PAT with read access to repos, issues, pull requests, and notifications
- Or a classic PAT with `repo`, `read:org`, `read:user`, and `notifications` scopes

This path is for developers who already know what a PAT is. If that's not you, stick with
the OAuth flow — it's safer and there's nothing to copy or store on your end.
