# NerdAlert v0.8.4 — Setup-credential audit: chat-credential paths retired + fine-grained PAT scanner coverage

**Released:** 2026-05-30 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version label:** v0.8.x security-hardening pass. (`package.json` reads 0.8.3;
a bump to 0.8.4 is an operator follow-up, not part of this cap.)

**Change set:**

```
github-setup save_pat removal   PAT entry routed to /setup only      commit 0290c39
gmail-setup de-credential        App Password via /setup; scaffold-only save  commit 1a0f5d2
setup-gmail.md playbook          Step 3 routes password to /setup     commit 1a0f5d2
secret-scanner fine-grained PAT  github_pat_ CRITICAL rule + 2 tests  commit d4b4cfa
docs/NerdAlert_Spec_v0_8_4_setup_audit.md   this spec (cap)           commit [pending]
```

All three code commits pushed to `origin/dev` (tip `d4b4cfa`). cap commit `[pending]`.

---

## What this was

The handoff carried a PREREQ before any net-new L2 write surface: audit the
`github-setup.ts` / `gmail-setup.ts` secret-entry / OAuth paths that had been
deferred from the earlier L2 wrapper sweep, to fully close the "claims L2,
enforces L1" trap audit. This release is that audit and the fixes it surfaced.

## Audit finding (the headline)

**No ceiling-bypass trap exists in either setup tool.** Neither `github-setup`
nor `gmail-setup` has a per-action gate keyed off global trust, neither threads
`exec?: ToolExecContext`, and both are honestly `trustLevel: 1`. There is
nothing in either file that lets a model capped below its apparent level slip
through a write. The trap audit is therefore closed for these two files — no
remaining traps beyond the gmail/memory ones already fixed in v0.8.0.

The github OAuth device-flow path (`start`/`connect`/`check`) was confirmed to
be the reference-correct implementation of the opaque-token principle: the
`device_code` lives in module-scope `pendingSetup`, the access token goes
straight from `pollForToken` into `setCredential`, and the model only ever sees
`user_code` + `verification_uri`. This is the pattern to copy for future OAuth
surfaces (calendar).

## What the audit surfaced (and this release fixed)

The chat-tool credential-entry actions were in direct tension with the
project's own secret-scanner contract ("credentials never travel through chat,
use /setup"). Three changes close that tension:

1. **github-setup: `save_pat` removed (commit 0290c39).** The action accepted a
   GitHub PAT as a tool parameter, routing a live credential through the model
   context. `/setup` already stores PATs under the identical `github-token`
   credential-store key, so the chat path was redundant. Removed the action, the
   `pat` parameter, the `PAT_MIN_LEN`/`PAT_MAX_LEN` constants, and the handler.
   The OAuth device-flow path is unchanged. Users with an existing PAT are
   routed to the `/setup` github-token field.

2. **gmail-setup: `save` de-credentialed (commit 1a0f5d2).** `save` previously
   accepted the 16-char App Password as a tool parameter and wrote it into
   `email-gmail.json` — a live credential through the model context. It now
   collects only `email` + `signature` and writes the JSON as a *scaffold* with
   a blank `auth.appPassword`. The user enters the password through the `/setup`
   gmail-app-password field (credential store); `loadGmailConfig` layers it in
   at read time, taking precedence over the file. Removed the `appPassword`
   parameter, `validateAppPassword`, and the `pwCheck` block. The
   `docs/setup-gmail.md` playbook Step 3 now directs the user to `/setup`
   instead of pasting the password into chat. **`save` was kept, not removed**
   — it does essential non-credential scaffold work (`email-gmail.json`, `.env`
   wiring, `config.yaml` enable) that `/setup` does not do.

3. **secret-scanner: fine-grained PAT coverage (commit d4b4cfa).** The
   `GITHUB-TOKEN` rule only matched classic/OAuth prefixes (`gh[opusr]_`) with a
   no-underscore body, so fine-grained PATs (`github_pat_<22>_<59>`) passed
   through unredacted — the one PAT shape the prior tooling explicitly accepted.
   Added a dedicated CRITICAL rule `GITHUB-FINE-GRAINED-PAT`, whose internal
   underscore is precisely why the classic rule could not simply be widened.
   This is the catch-all backstop for credentials pasted *outside* any setup
   flow.

## Locked decisions

1. **Retire chat-credential paths rather than scan harder.** The fix is to make
   the tools consistent with the `/setup` contract (the single credential-entry
   surface), not to chase every credential shape through chat.
2. **Keep gmail `save`, strip only the credential.** Verified against
   `gmail/config.ts`: `loadGmailConfig` requires `email-gmail.json` and only
   *overrides* `auth.appPassword` from the credential store. Removing `save`
   entirely would orphan email for a user who set the password via `/setup`;
   de-credentialing it preserves the scaffold work while keeping the secret out
   of chat. A user who skips `/setup` hits an honest `validateGmailConfig`
   "missing appPassword" throw — no silent half-config.
3. **No change to `gmail/config.ts`.** The keychain-precedence behaviour the new
   flow relies on already existed and was documented there as the
   legacy/migration direction; this release leans into it.
4. **Tight fixed-width PAT regex (`{22}_{59}`)** over a loose `{20,}` — GitHub's
   fine-grained format is fixed-width, so exact anchors drop false-positive risk
   to ~zero while matching every real token. Consistent with the catalog's
   "conservative on purpose / specificity over coverage" note.
5. **Separate scanner rule, not a widened one.** Classic and fine-grained PATs
   have genuinely different shapes (internal underscore); two clear rules read
   better than one regex straining to be both.

## Validation

- `tsc --noEmit` clean before each of the three commits.
- `vitest run secret-scanner.test.ts`: 20 passed (18 prior + 2 new). New cases:
  a fine-grained PAT that must redact at CRITICAL, and a `github_pat`-in-prose
  guard that must stay clean.
- Pre-flight regex check caught a fixture bug (a 58-char second segment that
  would not have fired); corrected to 59 and re-verified the rule matches and
  the prose guard does not, before the test was committed.
- Residual-reference greps after each removal confirmed no orphaned symbols
  (`save_pat`/`PAT_`/`params.pat` in github-setup; `appPassword`/
  `validateAppPassword`/`pwCheck` in gmail-setup). `setCredential` confirmed
  still used by github-setup's `check` success path (no orphaned import).
- Specific-file staging only; `config.yaml` and the six pending
  `docs/NerdAlert_Spec_v0_6_*.md` deletions stayed out of every commit.

## Module isolation / strict-superset

- No ResponseType added, no broker/registry/core-loop change, trust ladder
  untouched. Both setup tools remain `trustLevel: 1`.
- `.env` handling unchanged and compliant: gmail-setup still writes only
  `GMAIL_CONFIG_PATH=<path>` to `.env`, never a secret.

## Acceptance bar (as shipped)

1. github-setup exposes only `start`/`connect`/`check`; an existing-PAT user is
   pointed at `/setup`. PASS.
2. gmail-setup `save` writes the scaffold with a blank App Password; the
   password is supplied via `/setup` and layered in at read time. PASS.
3. setup-gmail.md never instructs the user to paste the password into chat. PASS.
4. A fine-grained `github_pat_` token is redacted + halted CRITICAL. PASS (test).
5. `github_pat` appearing in ordinary prose does not trigger. PASS (test).
6. No ceiling-bypass trap in either setup tool. PASS (audit).

## New learnings

- **A "redundant" chat path can be a credential-exfil path.** github `save_pat`
  looked like a harmless convenience, but its only *functioning* inputs were
  exactly the credentials the scanner failed to catch — so its sole working mode
  was the leak-to-remote-provider mode. Removing the path is cleaner than
  out-scanning it.
- **Verify the load path before deleting a write path.** The instinct to remove
  gmail `save` as "redundant with /setup" was wrong: reading `gmail/config.ts`
  showed `save` does scaffold work `/setup` cannot. The keychain only overrides
  one field. Deleting `save` would have orphaned email. Read the consumer before
  cutting the producer.
- **Scanner gaps cluster where the tooling is permissive.** The fine-grained PAT
  the scanner missed is the same shape github-setup's own comment documented as
  acceptable. When auditing a credential surface, the shapes the tool *accepts*
  are a map of where the scanner needs to look.

## Known follow-ups (not in this release)

- **`package.json` bump** to 0.8.4 (operator follow-up).
- **Bare-app-password scanner shape (declined for now).** A `xxxx xxxx xxxx xxxx`
  four-groups-of-lowercase rule without the keyword requirement was considered
  as extra coverage but left out — a "16 bare lowercase letters" rule
  false-positives on ordinary prose, which is why the existing rule requires a
  keyword. Revisit only if a real bare-password leak is observed.
- **Spec docs owed to the Project KB** (carried from prior handoffs):
  `NerdAlert_Spec_v0_8_0.md`, `NerdAlert_Spec_v0_8_2_render_window.md`,
  `NerdAlert_Spec_v0_8_3_dock.md`, and this doc.
