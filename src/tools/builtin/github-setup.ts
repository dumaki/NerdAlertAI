// ============================================================
// src/tools/builtin/github-setup.ts  — GitHub Onboarding Tool
// ============================================================
// Guides a first-time user through GitHub OAuth Device Flow
// and stores the resulting access token in the OS keychain.
//
// Actions:
//   'start'      — reads docs/setup-github.md and returns it
//                  to the agent. Agent walks the user through
//                  one step at a time.
//
//   'connect'    — requests a device code from GitHub. Stores
//                  the device_code in module-scope state and
//                  returns ONLY the user_code + verification_uri
//                  for the agent to show the user. The agent
//                  does NOT carry the device_code between calls.
//
//   'check'      — uses the device_code held in module state
//                  from the prior 'connect'. No parameters needed
//                  from the agent. On success: stores token in
//                  keychain, refreshes the cache, runs a whoami
//                  sanity check, returns the connected username.
//                  On pending: tells agent to ask user to wait
//                  a moment and retry.
//
// Why server-side state for the device_code:
//   v0.5.31.0 made the agent carry the long opaque device_code
//   between connect and check tool calls. Smaller models (Mistral
//   24B, etc.) regularly mangled or hallucinated the value, causing
//   GitHub to return expired_token / incorrect_device_code on every
//   check attempt — looking like the flow was just broken. Holding
//   the device_code in module-scope state and having 'check' read
//   it from there eliminates the entire failure mode.
//
//   Single-user system → no concurrency concern. A new 'connect'
//   replaces any prior pending setup. Auto-clears on the device-
//   code expiry boundary (typically 15 min).
//
// Trust level: L1 — only side effects are network calls to
// GitHub (read-only OAuth endpoints + /user verification) and
// a write to the OS keychain. No filesystem access outside
// the keychain backend.
// ============================================================

import fs   from 'fs';
import path from 'path';
import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { requestDeviceCode, pollForToken } from '../../github/oauth';
import { initGithubCredential } from '../../github/config';
import { getUser } from '../../github/client';
import { setCredential } from '../../security/credential-store';


// Scopes we request for v0.5.31 (read-only operations).
// `repo` is broad — it covers private repos for read AND
// write, but we gate write actions at trust level L3 in
// the tool itself. L1 today = capability exists, but the
// agent never invokes write endpoints.
const READ_ONLY_SCOPES = [
  'read:user',
  'repo',
  'read:org',
  'notifications',
];


// ── Module-scope state ──────────────────────────────────────
//
// Holds the device_code + metadata of the in-flight setup.
// A new 'connect' replaces any prior value. The 'check' action
// reads from here so the agent never has to carry the opaque
// device_code across tool calls.
//
// Single-user assumption: this server is one user's NerdAlert
// instance, not a multi-tenant service. If two browser tabs ever
// triggered concurrent setups (unlikely — setup is a deliberate
// action), the second 'connect' replaces the first, the first
// becomes a no-op. Acceptable failure mode.

interface PendingSetup {
  deviceCode: string;
  userCode:   string;
  expiresAt:  number;   // ms since epoch
  startedAt:  number;   // ms since epoch
}

let pendingSetup: PendingSetup | null = null;


// ── Tool definition ────────────────────────────────────────

const githubSetupTool: NerdAlertTool = {
  name: 'github-setup',

  description: `Guides the user through GitHub connection using OAuth Device Flow.
Use this when:
  - The user asks to set up GitHub
  - The user says "run github setup" or "connect github"
  - The github tool returns a 'not_configured' status

Actions (call these in order during a setup conversation):
  'start'      — read the setup playbook, walk the user through it one step at a time.
  'connect'    — request a one-time code from GitHub. Returns user_code (show to user)
                 and verification_uri. The server holds the device_code internally —
                 you do NOT need to pass it on subsequent calls.
  'check'      — after the user says they've authorized on github.com/login/device,
                 call this with NO parameters. The server uses the device_code from
                 the prior 'connect'. Returns either success (with the connected
                 username) or a pending/error status. If pending, ask the user to
                 wait a moment and try again.

If the user already has a Personal Access Token they would rather use, tell them to open
the /setup panel and paste it into the github-token field. Tokens are entered through the
setup panel, never through chat.
Never call 'check' before the user has confirmed they completed the authorization on GitHub.
A new 'connect' replaces any prior in-flight setup.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'connect', 'check'],
        description: 'Which step of the GitHub setup flow to run.',
      },
    },
    required: ['action'],
  },


  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = params.action as string;

    // ── start ────────────────────────────────────────────────
    if (action === 'start') {
      const playbookPath = path.join(process.cwd(), 'docs', 'setup-github.md');
      if (!fs.existsSync(playbookPath)) {
        return err('Setup playbook not found at docs/setup-github.md. The file may be missing from the project.');
      }
      const playbook = fs.readFileSync(playbookPath, 'utf8');
      return ok('GitHub Setup Playbook', playbook);
    }


    // ── connect ──────────────────────────────────────────────
    if (action === 'connect') {
      // Clear any prior in-flight setup before starting a new
      // one. Prevents the case where a user retried twice and
      // the second 'check' reads a stale device_code.
      pendingSetup = null;

      const r = await requestDeviceCode(READ_ONLY_SCOPES);
      if (!r.ok) {
        console.warn(`[github-setup] connect failed: error=${r.error} hint="${r.hint}"`);
        return err(`Could not start GitHub connection: ${r.hint}`);
      }

      // Stash the device_code in module state. The agent never
      // sees this value — only user_code and verification_uri.
      pendingSetup = {
        deviceCode: r.deviceCode,
        userCode:   r.userCode,
        expiresAt:  Date.now() + r.expiresIn * 1000,
        startedAt:  Date.now(),
      };

      // Auto-clear on expiry boundary. Only clears IF the
      // currently-held setup is still ours — guards against a
      // race where a newer 'connect' replaced this one and we
      // would otherwise wipe the newer state.
      const ourDeviceCode = r.deviceCode;
      setTimeout(() => {
        if (pendingSetup && pendingSetup.deviceCode === ourDeviceCode) {
          pendingSetup = null;
        }
      }, r.expiresIn * 1000).unref();

      console.log(`[github-setup] connect ok user_code=${r.userCode} expires_in=${r.expiresIn}s`);

      const minutes = Math.floor(r.expiresIn / 60);
      const lines = [
        `user_code: ${r.userCode}`,
        `verification_uri: ${r.verificationUri}`,
        `expires_in: ${r.expiresIn}s (~${minutes} minutes)`,
        '',
        'AGENT INSTRUCTIONS:',
        `  Show the user the user_code "${r.userCode}" prominently.`,
        `  Tell them to open ${r.verificationUri} and enter that code.`,
        `  Wait for them to confirm they authorized.`,
        `  Then call github-setup with action: "check" (no other parameters).`,
        `  The code expires in about ${minutes} minutes.`,
      ];
      return ok('GitHub device code requested', lines.join('\n'));
    }


    // ── check ────────────────────────────────────────────────
    if (action === 'check') {
      if (!pendingSetup) {
        return err([
          'status: no_pending',
          "There's no GitHub setup in flight. Call 'connect' first to start the flow.",
        ].join('\n'));
      }

      // Local expiry check — short-circuit the GitHub round-
      // trip if our own clock says the window's gone.
      if (Date.now() > pendingSetup.expiresAt) {
        console.log(`[github-setup] check: local expiry detected, clearing pendingSetup`);
        pendingSetup = null;
        return err([
          'status: expired',
          'The code expired (15-minute limit). Say "retry" and I will get a fresh one.',
        ].join('\n'));
      }

      const r = await pollForToken(pendingSetup.deviceCode);

      // Pending — user hasn't clicked Authorize yet, or just
      // submitted and GitHub is still propagating. Soft fail.
      // Keep pendingSetup so the next 'check' can use it.
      if (!r.ok && r.pending) {
        console.log(`[github-setup] check: pending (${r.error})`);
        if (r.error === 'slow_down') {
          return ok(
            'Still waiting on GitHub',
            [
              'status: pending',
              `GitHub asked me to slow down (new interval: ${r.newInterval ?? 10}s).`,
              'Give it a few more seconds and ask me to check again.',
            ].join('\n'),
          );
        }
        return ok(
          'Still waiting on GitHub',
          [
            'status: pending',
            "GitHub hasn't seen the authorization yet.",
            'Make sure you clicked "Authorize NerdAlertAI" on the github.com/login/device page,',
            "then say 'check again' and I will retry.",
          ].join('\n'),
        );
      }

      // Terminal error — expired, denied, etc. Clear pendingSetup
      // so the next attempt has to start fresh from 'connect'.
      if (!r.ok) {
        console.warn(`[github-setup] check: terminal error=${r.error} hint="${r.hint}"`);
        pendingSetup = null;
        let status = 'error';
        if (r.error === 'expired_token')               status = 'expired';
        else if (r.error === 'access_denied')          status = 'denied';
        else if (r.error === 'incorrect_device_code')  status = 'invalid';
        else if (r.error === 'device_flow_disabled')   status = 'device_flow_disabled';
        return err([
          `status: ${status}`,
          r.hint,
        ].join('\n'));
      }

      // Success path. Three things to do:
      //   1. Stash the token in the keychain via setCredential.
      //   2. Refresh the in-memory cache in github/config.ts.
      //   3. Verify with /user so we can show the connected
      //      username AND confirm the token actually works.

      try {
        await setCredential('github-token', r.accessToken);
      } catch (e: any) {
        console.error(`[github-setup] credential store failed: ${e?.message}`);
        // Keep pendingSetup in case the user can retry without
        // re-doing the OAuth dance — the token is still valid
        // for the device_code window.
        return err(`Token received from GitHub but storing it in the keychain failed: ${e?.message ?? 'unknown error'}. The credential was not saved — please run setup again.`);
      }

      // Refresh the cache so getGithubToken() returns the new
      // value without a server restart. Without this, every
      // subsequent github tool call would still see "not
      // configured" until next boot.
      await initGithubCredential();

      // Setup is complete — clear the pending state.
      pendingSetup = null;

      // Sanity-check by calling /user. Catches the (rare) case
      // where GitHub handed us a token that doesn't actually
      // work — better to fail at setup time than the first
      // time the user asks for something.
      const userR = await getUser();
      if (!userR.ok) {
        console.warn(`[github-setup] /user verification failed: ${userR.hint}`);
        return err(`Token saved, but verification with GitHub failed: ${userR.hint}. Try 'github test' to retry the check.`);
      }

      const u = userR.data;
      console.log(`[github-setup] check: connected as @${u.login}`);
      const lines = [
        'status: connected',
        `Connected as @${u.login}${u.name ? ` (${u.name})` : ''}`,
        `Public repos: ${u.publicRepos}  ·  Followers: ${u.followers}`,
        `Granted scopes: ${r.scopes || '(none reported)'}`,
        '',
        'GitHub is ready. Try:',
        "  - 'what issues are assigned to me'",
        "  - 'list my repos'",
        "  - 'what is in my notifications'",
      ];
      return ok('GitHub connected', lines.join('\n'));
    }


    return err(`Unknown action: "${action}". Use 'start', 'connect', or 'check'.`);
  },
};


// ── Response helpers ──────────────────────────────────────────

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } };
}

function err(message: string): NerdAlertResponse {
  return { type: 'text', content: `[github-setup] ${message}`, metadata: { title: 'GitHub setup', sources: [] } };
}


export default githubSetupTool;
