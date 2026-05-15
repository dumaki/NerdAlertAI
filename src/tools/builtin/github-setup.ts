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
//   'connect'    — requests a device code from GitHub. Returns
//                  the 8-character user_code and verification_uri
//                  for the agent to show the user. Also returns
//                  the opaque device_code, which the agent MUST
//                  pass back on the next 'check' call. The agent
//                  holds device_code in its conversation context.
//
//   'check'      — polls GitHub for the access token using the
//                  device_code from 'connect'. On success: stores
//                  token in keychain, refreshes the cache, runs a
//                  whoami sanity check, returns the connected
//                  username. On pending: tells agent to ask user
//                  to wait a moment and retry.
//
//   'save_pat'   — alternative path for users who already have a
//                  Personal Access Token. Validates by hitting
//                  /user, stores in keychain on success.
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


// PAT length sanity bounds. GitHub PATs come in two shapes:
//   classic       — 40-char hex string after "ghp_" or older
//                   variants; full length 40-50 chars.
//   fine-grained  — starts with "github_pat_", full length
//                   ~85-90 chars.
// We bound to 30..200 to accept both with margin.
const PAT_MIN_LEN = 30;
const PAT_MAX_LEN = 200;


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
                 and device_code (pass back on the next 'check' call).
                 Show the user the user_code prominently along with the verification URL.
  'check'      — after the user says they've authorized on github.com/login/device,
                 call this with the device_code from 'connect'. Returns either
                 success (with the connected username) or a pending/error status.
                 If pending, ask the user to wait a moment and try again.
  'save_pat'   — alternative path: user has an existing Personal Access Token
                 they want to use instead. Validates and stores it.

Never call 'check' before the user has confirmed they completed the authorization on GitHub.
Never call 'connect' twice without first finishing or expiring the previous attempt.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'connect', 'check', 'save_pat'],
        description: 'Which step of the GitHub setup flow to run.',
      },
      device_code: {
        type:        'string',
        description: "Required for 'check'. The opaque device_code returned from a prior 'connect' call.",
      },
      pat: {
        type:        'string',
        description: "Required for 'save_pat'. A GitHub Personal Access Token.",
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
      const r = await requestDeviceCode(READ_ONLY_SCOPES);
      if (!r.ok) {
        return err(`Could not start GitHub connection: ${r.hint}`);
      }

      // Return content that includes the user_code prominently
      // so the agent can pull it out and show the user. Also
      // explicitly include device_code in the content (NOT as
      // a metadata field — the agent needs to read it back to
      // us on the next 'check' call).
      //
      // The user_code is safe to display. The device_code is
      // also safe to show — it's not a credential by itself,
      // it only redeems for a token after the user authorizes.
      const minutes = Math.floor(r.expiresIn / 60);
      const lines = [
        `device_code: ${r.deviceCode}`,
        `user_code: ${r.userCode}`,
        `verification_uri: ${r.verificationUri}`,
        `expires_in: ${r.expiresIn}s (~${minutes} minutes)`,
        `interval: ${r.interval}s`,
        '',
        'AGENT INSTRUCTIONS:',
        `  Show the user the user_code "${r.userCode}" prominently.`,
        `  Tell them to open ${r.verificationUri} and enter that code.`,
        `  Wait for them to confirm they authorized.`,
        `  Then call github-setup with action: "check" and device_code: "${r.deviceCode}".`,
        `  The code expires in about ${minutes} minutes.`,
      ];
      return ok('GitHub device code requested', lines.join('\n'));
    }


    // ── check ────────────────────────────────────────────────
    if (action === 'check') {
      const deviceCode = (params.device_code as string ?? '').trim();
      if (!deviceCode) {
        return err("'check' requires device_code from the prior 'connect' call.");
      }

      const r = await pollForToken(deviceCode);

      // Pending — user hasn't clicked Authorize yet, or just
      // submitted and GitHub is still propagating. Soft fail.
      if (!r.ok && r.pending) {
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
            "then say 'check again' and I'll retry.",
          ].join('\n'),
        );
      }

      // Terminal error — expired, denied, etc.
      if (!r.ok) {
        // Map a couple of well-known cases to clearer agent
        // status codes. The hint from oauth.ts is already
        // user-friendly; we just classify so the agent knows
        // whether to offer a restart.
        let status = 'error';
        if (r.error === 'expired_token')         status = 'expired';
        else if (r.error === 'access_denied')    status = 'denied';
        else if (r.error === 'incorrect_device_code') status = 'invalid';
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
        return err(`Token received from GitHub but storing it in the keychain failed: ${e?.message ?? 'unknown error'}. The credential was not saved — please run setup again.`);
      }

      // Refresh the cache so getGithubToken() returns the new
      // value without a server restart. Without this, every
      // subsequent github tool call would still see "not
      // configured" until next boot.
      await initGithubCredential();

      // Sanity-check by calling /user. Catches the (rare) case
      // where GitHub handed us a token that doesn't actually
      // work — better to fail at setup time than the first
      // time the user asks for something.
      const userR = await getUser();
      if (!userR.ok) {
        return err(`Token saved, but verification with GitHub failed: ${userR.hint}. Try 'github test' to retry the check.`);
      }

      const u = userR.data;
      const lines = [
        'status: connected',
        `Connected as @${u.login}${u.name ? ` (${u.name})` : ''}`,
        `Public repos: ${u.publicRepos}  ·  Followers: ${u.followers}`,
        `Granted scopes: ${r.scopes || '(none reported)'}`,
        '',
        'GitHub is ready. Try:',
        "  - 'what issues are assigned to me'",
        "  - 'list my repos'",
        "  - 'what's in my notifications'",
      ];
      return ok('GitHub connected', lines.join('\n'));
    }


    // ── save_pat ─────────────────────────────────────────────
    if (action === 'save_pat') {
      const pat = (params.pat as string ?? '').trim();

      if (!pat) {
        return err("'save_pat' requires a Personal Access Token in the 'pat' parameter.");
      }
      if (pat.length < PAT_MIN_LEN || pat.length > PAT_MAX_LEN) {
        return err(`That doesn't look like a valid Personal Access Token (length ${pat.length}; expected ${PAT_MIN_LEN}-${PAT_MAX_LEN} chars). Double-check what you copied and try again.`);
      }

      // Stash first, verify second. Order matters: if storing
      // fails we never want to claim "connected".
      try {
        await setCredential('github-token', pat);
      } catch (e: any) {
        return err(`Could not store the token: ${e?.message ?? 'unknown error'}.`);
      }

      await initGithubCredential();

      const userR = await getUser();
      if (!userR.ok) {
        // Token saved but didn't work. Tell the user clearly.
        // We could clear the credential here, but leaving it
        // gives the user a chance to fix it (e.g. a scope issue
        // they can correct on GitHub without re-pasting).
        return err(`Token saved but GitHub rejected it: ${userR.hint}. Check that the token has the required scopes (repo, read:org, read:user, notifications) and try again.`);
      }

      const u = userR.data;
      return ok(
        'GitHub connected (via PAT)',
        [
          'status: connected',
          `Connected as @${u.login}${u.name ? ` (${u.name})` : ''}`,
          'GitHub is ready. Note: PATs expire — if you set an expiration date, mark your calendar to refresh it.',
        ].join('\n'),
      );
    }


    return err(`Unknown action: "${action}". Use 'start', 'connect', 'check', or 'save_pat'.`);
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
