// ============================================================
// src/tools/builtin/github-write-tool.ts  — v0.8.1 GitHub write surface (L3)
// ============================================================
// The L3 dangerous-writes half of the GitHub tool surface. Mirror of
// gmail_send / gmail_cleanup and cron_delete in the v0.8 arc: a
// compiled trustLevel: 3 floor so the permission-broker, the per-
// model trust ceiling, AND getModelVisibleTools() enforce gating
// natively. A capped model (Mistral / Nemotron at their derived L1
// cap) never even sees this tool.
//
// Scope (interaction-tier writes — mirror of github-tool's read surface):
//   - create_issue    create a new issue on a repo
//   - comment_issue   add a comment to an issue or PR
//   - close_issue     close an open issue (state = closed)
//   - reopen_issue    reopen a closed issue (state = open)
//   - add_labels      add labels to an issue or PR
//   - remove_label    remove a label from an issue or PR
//   - assign_issue    assign users to an issue or PR
//
// Deferred to a follow-on slice (history-altering writes):
//   create_pull_request, merge_pr, push (commits), delete_branch,
//   delete_issue. These will live in a separate github-publish-tool
//   when they ship — different blast radius, different design
//   pressure (push needs branch/ref resolution; merge wants CI-pass
//   awareness; delete_branch wants protection-rule checks).
//
// Approval pattern (wrapper-level, mirrors cron_delete):
//   Each engine function in github/client.ts is a thin REST wrapper
//   with no built-in two-step (unlike gmail's sendDraft, where the
//   approval lives in the engine because two call sites share it).
//   Cleanest to put the approval in the wrapper. First call without
//   approved:true returns a preview of WHAT WOULD HAPPEN and changes
//   nothing; second call with approved:true actually hits the GitHub
//   API. The agent never sets approved:true unprompted — only after
//   an explicit confirmation from the user in chat.
//
// Trust: L3 (compiled floor). At global trust L1/L2 this tool is
// filtered out of getAvailableTools() entirely — dormant until an
// operator deliberately raises global trust to 3. Strict-superset:
// not registering this tool, or disabling it in config, leaves the
// existing github read UX byte-identical.
//
// Positional bias: registered BEFORE githubTool in ALL_TOOLS so a
// small model scoring tools top-to-bottom matches a write request
// against this narrow L3 tool first. Mirrors the gmail and cron
// L3-before-broad ordering. Bites only once global trust is 3.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, Source } from '../../types/response.types';
import {
  isGithubConfigured,
  createIssue,
  commentIssue,
  closeIssue,
  reopenIssue,
  addLabels,
  removeLabel,
  assignIssue,
  GithubIssueWriteResult,
  GithubError,
} from '../../github/client';


// ── Response helpers ──────────────────────────────────────────
// Local copies — same posture cron-delete-tool.ts and the gmail L3
// tools use: no compile-time coupling to github-tool.ts beyond the
// engine functions both wrap.

function ok(title: string, content: string, sources: Source[] = []): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources } };
}

function err(message: string): NerdAlertResponse {
  return {
    type:    'text',
    content: `[github_write] ${message}`,
    metadata: { title: 'GitHub write error', sources: [] },
  };
}

function errFromGithub(e: GithubError): NerdAlertResponse {
  return {
    type:    'text',
    content: `[github_write] ${e.hint}`,
    metadata: { title: `GitHub error: ${e.error}`, sources: [] },
  };
}


// Resolve owner + repo from either two separate params or a single
// "owner/repo" shorthand passed as `repo`. Mirrors the convenience
// github-tool offers for list_issues / list_pulls, so the param
// shape stays familiar across read and write surfaces.
//
// Returns a string (the error message) on failure, the resolved
// pair on success — caller does an `if (typeof result === 'string')`
// guard rather than nesting result types.
function resolveOwnerRepo(
  params: Record<string, unknown>,
): { owner: string; repo: string } | string {
  let owner = (params.owner as string | undefined)?.trim();
  let repo  = (params.repo  as string | undefined)?.trim();

  // If `repo` looks like "owner/repo" and `owner` is empty, split it.
  if (!owner && repo && repo.includes('/')) {
    const [o, r] = repo.split('/', 2);
    if (o && r) {
      owner = o;
      repo  = r;
    }
  }

  if (!owner || !repo) {
    return 'owner and repo are both required (or pass repo as "owner/repo").';
  }
  return { owner, repo };
}


const githubWriteTool: NerdAlertTool = {
  name: 'github_write',

  description: `Write to GitHub: create or close/reopen issues, post comments, manage labels and assignees on issues or PRs. (L3 — dangerous writes, externally visible.)

USE THIS TOOL when the user explicitly asks to MUTATE something on GitHub: 'create an issue', 'comment on PR #42', 'close that issue', 'add the bug label', 'assign me to it'. For read queries (list issues, view an issue, search repos, read a file), use the 'github' tool instead — never use github_write to read.

Every action follows a TWO-STEP approval. The FIRST call (without approved:true) returns a preview of WHAT WOULD HAPPEN and changes nothing. The user must then explicitly confirm in chat ('yes', 'go ahead', 'do it'). Only then do you call again with approved:true, which actually hits the GitHub API. NEVER set approved:true on the first call. NEVER set approved:true without an explicit user confirmation.

Actions:
'create_issue'   create a new issue. Requires owner, repo, title. Optional: body, labels, assignees.
'comment_issue'  add a comment to an issue or PR. Requires owner, repo, number, body. Works on both issues AND PRs — GitHub treats PR comment threads as issue comments.
'close_issue'    close an open issue (or PR). Requires owner, repo, number. Optional: state_reason ('completed' | 'not_planned' | 'duplicate').
'reopen_issue'   reopen a closed issue. Requires owner, repo, number.
'add_labels'     add labels to an issue or PR. Requires owner, repo, number, labels (string array). If a label doesn't exist on the repo, GitHub auto-creates it (with 'repo' scope) — for an unfamiliar label name, ASK the user before submitting whether they want a new repo-level label created.
'remove_label'   remove a single label. Requires owner, repo, number, label.
'assign_issue'   assign users to an issue or PR. Requires owner, repo, number, assignees (string array of usernames, no '@' prefix).

Repo references use "owner/repo" format. You may pass them separately as owner + repo, OR pass the full path in repo (e.g. repo: 'dumaki/NerdAlertAI', owner blank).

If GitHub isn't configured this tool returns 'not_configured' — offer to run 'github setup'.`,

  trustLevel: 3,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'create_issue', 'comment_issue', 'close_issue', 'reopen_issue',
          'add_labels', 'remove_label', 'assign_issue',
        ],
        description: 'The write operation to perform.',
      },
      owner: {
        type:        'string',
        description: "Repo owner login (e.g. 'dumaki'). Optional if `repo` is passed as 'owner/repo'.",
      },
      repo: {
        type:        'string',
        description: "Repo name (e.g. 'NerdAlertAI') or 'owner/repo' shorthand.",
      },
      number: {
        type:        'number',
        description: 'Issue or PR number. Required for comment_issue, close_issue, reopen_issue, add_labels, remove_label, assign_issue.',
      },
      title: {
        type:        'string',
        description: 'Issue title. Required for create_issue.',
      },
      body: {
        type:        'string',
        description: 'Issue body markdown (create_issue) or comment text (comment_issue). Optional for create_issue, REQUIRED for comment_issue.',
      },
      labels: {
        type:        'array',
        items:       { type: 'string' },
        description: "Labels to attach. Required for add_labels. Optional for create_issue. Missing labels are auto-created on the repo by GitHub (with 'repo' scope) — confirm with the user before submitting any unfamiliar label name.",
      },
      label: {
        type:        'string',
        description: 'Single label name to remove. Required for remove_label.',
      },
      assignees: {
        type:        'array',
        items:       { type: 'string' },
        description: "GitHub usernames to assign (no '@' prefix). Required for assign_issue. Optional for create_issue. Non-collaborators are silently dropped by GitHub.",
      },
      state_reason: {
        type:        'string',
        enum:        ['completed', 'not_planned', 'duplicate'],
        description: "Optional close reason for close_issue. GitHub also accepts 'reopened' but use the reopen_issue action instead.",
      },
      approved: {
        type:        'boolean',
        description: 'Must be true to actually apply the change. Set only AFTER an explicit user confirmation in chat. The first call without approved returns a preview and changes nothing.',
      },
    },
    required: ['action'],
  },


  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = params.action as string;

    // ── Not-configured check ────────────────────────────────
    // Mirrors github-tool: the 'not_configured' prefix is the
    // signal the agent reads to offer the setup flow.
    if (!isGithubConfigured()) {
      return {
        type:    'text',
        content: [
          'not_configured',
          '',
          "GitHub isn't connected yet, so I can't write anything.",
          "Say **run github setup** and I'll walk you through it.",
        ].join('\n'),
        metadata: { title: 'GitHub not configured', sources: [] },
      };
    }

    const approved = params.approved === true;

    try {
      switch (action) {

        // ── create_issue ─────────────────────────────────────

        case 'create_issue': {
          const ownerRepo = resolveOwnerRepo(params);
          if (typeof ownerRepo === 'string') return err(ownerRepo);
          const title = (params.title as string | undefined)?.trim();
          if (!title) return err('create_issue requires title.');

          const body      = params.body      as string | undefined;
          const labels    = params.labels    as string[] | undefined;
          const assignees = params.assignees as string[] | undefined;

          if (!approved) {
            const lines = [
              `About to CREATE a new issue on ${ownerRepo.owner}/${ownerRepo.repo}:`,
              `  Title: ${title}`,
              labels?.length    ? `  Labels: ${labels.join(', ')}`                            : '  Labels: (none)',
              assignees?.length ? `  Assignees: ${assignees.map(a => '@' + a).join(', ')}`    : '  Assignees: (none)',
              body              ? `\n  Body:\n${indent(body, '    ')}`                       : '\n  Body: (empty)',
              '',
              'Nothing has been created yet. Re-call github_write with approved:true to file the issue.',
            ];
            return ok('Preview: create_issue', lines.join('\n'));
          }

          const r = await createIssue(ownerRepo.owner, ownerRepo.repo, { title, body, labels, assignees });
          if (!r.ok) return errFromGithub(r);
          return ok(
            `Created ${r.data.repo}#${r.data.number}`,
            formatIssueWriteResult('Created', r.data),
            [issueToSource(r.data)],
          );
        }


        // ── comment_issue ────────────────────────────────────

        case 'comment_issue': {
          const ownerRepo = resolveOwnerRepo(params);
          if (typeof ownerRepo === 'string') return err(ownerRepo);
          const number = toNumber(params.number);
          if (!number) return err('comment_issue requires number.');
          const body = (params.body as string | undefined)?.trim();
          if (!body) return err('comment_issue requires body.');

          if (!approved) {
            const lines = [
              `About to POST a comment on ${ownerRepo.owner}/${ownerRepo.repo}#${number}:`,
              '',
              indent(body, '    '),
              '',
              'Nothing has been posted yet. Re-call github_write with approved:true to post the comment.',
            ];
            return ok('Preview: comment_issue', lines.join('\n'));
          }

          const r = await commentIssue(ownerRepo.owner, ownerRepo.repo, number, body);
          if (!r.ok) return errFromGithub(r);
          return ok(
            `Comment posted on ${ownerRepo.owner}/${ownerRepo.repo}#${number}`,
            `Comment posted: ${r.data.commentUrl}`,
            [{ label: `Comment on ${ownerRepo.owner}/${ownerRepo.repo}#${number}`, url: r.data.commentUrl }],
          );
        }


        // ── close_issue ──────────────────────────────────────

        case 'close_issue': {
          const ownerRepo = resolveOwnerRepo(params);
          if (typeof ownerRepo === 'string') return err(ownerRepo);
          const number = toNumber(params.number);
          if (!number) return err('close_issue requires number.');
          const stateReason = params.state_reason as string | undefined;

          if (!approved) {
            const lines = [
              `About to CLOSE ${ownerRepo.owner}/${ownerRepo.repo}#${number}` +
                (stateReason ? ` (reason: ${stateReason})` : '') + '.',
              'Nothing has changed yet. Re-call github_write with approved:true to close the issue.',
            ];
            return ok('Preview: close_issue', lines.join('\n'));
          }

          const r = await closeIssue(ownerRepo.owner, ownerRepo.repo, number, stateReason);
          if (!r.ok) return errFromGithub(r);
          return ok(
            `Closed ${r.data.repo}#${r.data.number}`,
            formatIssueWriteResult('Closed', r.data),
            [issueToSource(r.data)],
          );
        }


        // ── reopen_issue ─────────────────────────────────────

        case 'reopen_issue': {
          const ownerRepo = resolveOwnerRepo(params);
          if (typeof ownerRepo === 'string') return err(ownerRepo);
          const number = toNumber(params.number);
          if (!number) return err('reopen_issue requires number.');

          if (!approved) {
            return ok(
              'Preview: reopen_issue',
              [
                `About to REOPEN ${ownerRepo.owner}/${ownerRepo.repo}#${number}.`,
                'Nothing has changed yet. Re-call github_write with approved:true to reopen the issue.',
              ].join('\n'),
            );
          }

          const r = await reopenIssue(ownerRepo.owner, ownerRepo.repo, number);
          if (!r.ok) return errFromGithub(r);
          return ok(
            `Reopened ${r.data.repo}#${r.data.number}`,
            formatIssueWriteResult('Reopened', r.data),
            [issueToSource(r.data)],
          );
        }


        // ── add_labels ───────────────────────────────────────

        case 'add_labels': {
          const ownerRepo = resolveOwnerRepo(params);
          if (typeof ownerRepo === 'string') return err(ownerRepo);
          const number = toNumber(params.number);
          if (!number) return err('add_labels requires number.');
          const labels = params.labels as string[] | undefined;
          if (!labels || labels.length === 0) {
            return err('add_labels requires labels (non-empty array of label names).');
          }

          if (!approved) {
            return ok(
              'Preview: add_labels',
              [
                `About to ADD labels [${labels.join(', ')}] to ${ownerRepo.owner}/${ownerRepo.repo}#${number}.`,
                'Nothing has changed yet. Re-call github_write with approved:true to add the labels.',
              ].join('\n'),
            );
          }

          const r = await addLabels(ownerRepo.owner, ownerRepo.repo, number, labels);
          if (!r.ok) return errFromGithub(r);
          return ok(
            `Labels added to ${ownerRepo.owner}/${ownerRepo.repo}#${number}`,
            `Labels on ${ownerRepo.owner}/${ownerRepo.repo}#${number}: ${r.data.length ? r.data.join(', ') : '(none)'}`,
          );
        }


        // ── remove_label ─────────────────────────────────────

        case 'remove_label': {
          const ownerRepo = resolveOwnerRepo(params);
          if (typeof ownerRepo === 'string') return err(ownerRepo);
          const number = toNumber(params.number);
          if (!number) return err('remove_label requires number.');
          const label = (params.label as string | undefined)?.trim();
          if (!label) return err('remove_label requires label.');

          if (!approved) {
            return ok(
              'Preview: remove_label',
              [
                `About to REMOVE label "${label}" from ${ownerRepo.owner}/${ownerRepo.repo}#${number}.`,
                'Nothing has changed yet. Re-call github_write with approved:true to remove the label.',
              ].join('\n'),
            );
          }

          const r = await removeLabel(ownerRepo.owner, ownerRepo.repo, number, label);
          if (!r.ok) {
            // GitHub returns 404 when the label isn't on the issue, which
            // sounds scarier than it is. Translate to a friendly message.
            if (r.error === 'not_found') {
              return err(
                `Label "${label}" wasn't on ${ownerRepo.owner}/${ownerRepo.repo}#${number} — nothing to remove.`,
              );
            }
            return errFromGithub(r);
          }
          return ok(
            `Label removed from ${ownerRepo.owner}/${ownerRepo.repo}#${number}`,
            `Remaining labels on ${ownerRepo.owner}/${ownerRepo.repo}#${number}: ${r.data.length ? r.data.join(', ') : '(none)'}`,
          );
        }


        // ── assign_issue ─────────────────────────────────────

        case 'assign_issue': {
          const ownerRepo = resolveOwnerRepo(params);
          if (typeof ownerRepo === 'string') return err(ownerRepo);
          const number = toNumber(params.number);
          if (!number) return err('assign_issue requires number.');
          const assignees = params.assignees as string[] | undefined;
          if (!assignees || assignees.length === 0) {
            return err('assign_issue requires assignees (non-empty array of GitHub usernames).');
          }

          if (!approved) {
            return ok(
              'Preview: assign_issue',
              [
                `About to ASSIGN [${assignees.map(a => '@' + a).join(', ')}] to ${ownerRepo.owner}/${ownerRepo.repo}#${number}.`,
                'Nothing has changed yet. Re-call github_write with approved:true to apply the assignment.',
              ].join('\n'),
            );
          }

          const r = await assignIssue(ownerRepo.owner, ownerRepo.repo, number, assignees);
          if (!r.ok) return errFromGithub(r);

          // Diff requested vs actual — GitHub silently drops non-
          // collaborators, so the user deserves to know when names
          // didn't take. Case-sensitive compare matches GitHub's
          // own login casing semantics.
          const dropped = assignees.filter(a => !r.data.assignees.includes(a));
          const lines = [formatIssueWriteResult('Assignees updated on', r.data)];
          if (dropped.length) {
            lines.push('');
            lines.push(
              `Note: GitHub dropped [${dropped.map(d => '@' + d).join(', ')}] — most likely not a collaborator on ${ownerRepo.owner}/${ownerRepo.repo}.`,
            );
          }
          return ok(
            `Assignees updated on ${r.data.repo}#${r.data.number}`,
            lines.join('\n'),
            [issueToSource(r.data)],
          );
        }


        default:
          return err(`Unknown github_write action: "${action}"`);
      }
    } catch (e: any) {
      // Last-resort catch. Client functions are designed to NEVER
      // throw — they return GithubError. This protects against any
      // future client-layer code that forgets the contract.
      return err(`github_write tool error: ${e?.message ?? String(e)}`);
    }
  },
};


// ── Helpers ───────────────────────────────────────────────────


// Render a write result as the agent-visible summary block.
// Same shape across all four issue-state-changing actions so the
// model sees a consistent pattern when narrating the outcome.
function formatIssueWriteResult(verb: string, d: GithubIssueWriteResult): string {
  const lines = [
    `${verb}: ${d.repo}#${d.number} — ${d.title}  [${d.state}]`,
    d.labels.length    ? `Labels: ${d.labels.join(', ')}`                            : '',
    d.assignees.length ? `Assignees: ${d.assignees.map(a => '@' + a).join(', ')}`    : '',
    d.htmlUrl,
  ];
  return lines.filter(s => s !== '').join('\n');
}


function issueToSource(d: GithubIssueWriteResult): Source {
  return { label: `${d.repo}#${d.number}`, url: d.htmlUrl };
}


// Indent every line of a multi-line block by the given prefix.
// Used to echo user-supplied bodies back inside the preview blocks
// without losing their original line breaks.
function indent(s: string, prefix: string): string {
  return s.split('\n').map(l => `${prefix}${l}`).join('\n');
}


// Type-coerce params.number into a number (matches github-tool's
// defensive parameter parsing for the same field).
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}


export default githubWriteTool;
