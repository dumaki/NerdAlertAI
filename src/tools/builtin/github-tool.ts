// ============================================================
// src/tools/builtin/github-tool.ts  — GitHub Read Tool (L1)
// ============================================================
// NerdAlert tool surface for GitHub read operations. Wraps
// src/github/client.ts in the NerdAlertTool interface so the
// agent's tool-loop can call GitHub the same way it calls
// gmail, memory, etc.
//
// Trust level: L1 (read external).
//
// Actions in v0.5.31 (read-only):
//   - 'whoami'          → confirm the connected GitHub account
//   - 'list_repos'      → repos owned/collaborated/org
//   - 'repo_info'       → one repo's details
//   - 'search_repos'    → search GitHub for repos by query
//   - 'list_issues'     → issues filtered by assignee/author/mention
//   - 'list_pulls'      → pull requests filtered same way
//   - 'read_issue'      → one issue's body + comments
//   - 'read_pull'       → one PR's body + comments + file summary
//   - 'read_file'       → file contents at a path
//   - 'list_notifications' → notification inbox
//   - 'test'            → connectivity sanity check
//
// L3 follow-ons (NOT in this release):
//   create_issue, comment, push, merge, etc. These live in a
//   future github-write-tool.ts at trust level 3.
//
// not_configured handling:
//   First check at top of execute(). Returns a friendly message
//   pointing the user at "run github setup" — identical pattern
//   to gmail-tool.ts. The agent sees this and offers to start
//   the setup flow.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, Source } from '../../types/response.types';
import {
  isGithubConfigured,
  testConnection,
  getUser,
  listRepos,
  repoInfo,
  searchRepos,
  listIssues,
  listPulls,
  readIssue,
  readPull,
  readFile,
  listNotifications,
  GithubResult,
  GithubError,
  GithubRepo,
  GithubIssueSummary,
  RateLimitInfo,
} from '../../github/client';


// ── Tool definition ─────────────────────────────────────────

const githubTool: NerdAlertTool = {
  name: 'github',

  description: `Access GitHub repos, issues, pull requests, and notifications (read-only).
Use this when the user asks about:
  - their GitHub activity, issues, or pull requests
  - a specific repo's details, README, or source files
  - what's assigned to them on GitHub
  - their GitHub notifications

Actions:
'whoami'             — return the connected GitHub username and profile.
'list_repos'         — list user's repos. Optional: sort, visibility, perPage.
'repo_info'          — get one repo's metadata. Requires: owner, repo.
'search_repos'       — search all of GitHub. Requires: query.
'list_issues'        — issues filtered by relationship. Optional: filter (assigned|created|mentioned|all), repo, state.
'list_pulls'         — pull requests, same filter shape as list_issues.
'read_issue'         — one issue body + comments. Requires: owner, repo, number.
'read_pull'          — one PR body + comments + file changes. Requires: owner, repo, number.
'read_file'          — file contents at a path. Requires: owner, repo, path. Optional: ref (branch/tag/commit).
'list_notifications' — unread notifications by default. Optional: all (include read), perPage.
'test'               — sanity-check the GitHub connection.

If GitHub is not configured, this tool returns 'not_configured'. When you see that,
offer to run 'github-setup' to walk the user through OAuth.

Repo references use 'owner/repo' format (e.g. 'dumaki/NerdAlertAI'). For actions
needing owner and repo separately, split on the '/'.

Surface citations in metadata.sources for any issue/PR/repo you reference.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'whoami', 'list_repos', 'repo_info', 'search_repos',
          'list_issues', 'list_pulls', 'read_issue', 'read_pull',
          'read_file', 'list_notifications', 'test',
        ],
        description: 'The GitHub read operation to perform.',
      },
      owner: {
        type:        'string',
        description: "Repo owner login (e.g. 'dumaki'). Required for repo_info, read_issue, read_pull, read_file.",
      },
      repo: {
        type:        'string',
        description: "Repo name (e.g. 'NerdAlertAI'). Required for repo_info, read_issue, read_pull, read_file. For list_issues/list_pulls, optionally pass as 'owner/repo'.",
      },
      number: {
        type:        'number',
        description: 'Issue or PR number. Required for read_issue and read_pull.',
      },
      path: {
        type:        'string',
        description: "File path within the repo (e.g. 'README.md' or 'src/index.ts'). Required for read_file.",
      },
      ref: {
        type:        'string',
        description: "Branch, tag, or commit SHA for read_file. Defaults to the repo's default branch.",
      },
      query: {
        type:        'string',
        description: 'Search query for search_repos. Supports GitHub search syntax.',
      },
      filter: {
        type:        'string',
        enum:        ['assigned', 'created', 'mentioned', 'all'],
        description: 'Relationship filter for list_issues / list_pulls. Default: assigned.',
      },
      state: {
        type:        'string',
        enum:        ['open', 'closed', 'all'],
        description: 'State filter for list_issues / list_pulls. Default: open.',
      },
      sort: {
        type:        'string',
        enum:        ['created', 'updated', 'pushed', 'full_name'],
        description: 'Sort order for list_repos. Default: updated.',
      },
      visibility: {
        type:        'string',
        enum:        ['all', 'public', 'private'],
        description: 'Visibility filter for list_repos. Default: all.',
      },
      perPage: {
        type:        'number',
        description: 'Items per page (cap 100). Default 25.',
      },
      all: {
        type:        'boolean',
        description: 'For list_notifications: include already-read items. Default false.',
      },
    },
    required: ['action'],
  },


  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = params.action as string;

    // ── Not-configured check ────────────────────────────────
    // Same shape as gmail-tool.ts. Agent reads the
    // 'not_configured' prefix and offers to start setup.
    if (!isGithubConfigured()) {
      return {
        type:    'text',
        content: [
          'not_configured',
          '',
          "Looks like GitHub isn't connected yet.",
          "Say **run github setup** and I'll walk you through it — takes about 2 minutes.",
          "You'll just need a GitHub account and a browser tab open.",
        ].join('\n'),
        metadata: { title: 'GitHub not configured', sources: [] },
      };
    }

    try {
      switch (action) {

        // ── whoami / test ────────────────────────────────────

        case 'whoami':
        case 'test': {
          const r = await getUser();
          if (!r.ok) return errFromGithub(r);
          const u = r.data;
          const lines = [
            `Connected as @${u.login}${u.name ? ` (${u.name})` : ''}`,
            u.email     ? `Email: ${u.email}`                : null,
            `Public repos: ${u.publicRepos} · Followers: ${u.followers}`,
            `Profile: ${u.htmlUrl}`,
            rateLine(r.rateLimit),
          ].filter(Boolean).join('\n');
          return ok('GitHub account', lines, [{ label: `@${u.login} on GitHub`, url: u.htmlUrl }]);
        }


        // ── list_repos ───────────────────────────────────────

        case 'list_repos': {
          const r = await listRepos({
            perPage:    toNumber(params.perPage),
            sort:       params.sort as any,
            visibility: params.visibility as any,
          });
          if (!r.ok) return errFromGithub(r);
          if (r.data.length === 0) {
            return ok('Repos', 'No repos found for the current filters.');
          }
          const sources = r.data.slice(0, 10).map(repoToSource);
          return ok(
            `Repos (${r.data.length})`,
            formatRepoList(r.data) + '\n' + rateLine(r.rateLimit),
            sources,
          );
        }


        // ── repo_info ────────────────────────────────────────

        case 'repo_info': {
          const owner = params.owner as string;
          const repo  = params.repo  as string;
          if (!owner || !repo) return err('repo_info requires both owner and repo');
          const r = await repoInfo(owner, repo);
          if (!r.ok) return errFromGithub(r);
          const d = r.data;
          const lines = [
            `${d.fullName}${d.isPrivate ? ' (private)' : ''}${d.isArchived ? ' (archived)' : ''}`,
            d.description ? `\n${d.description}` : '',
            '',
            `Language: ${d.language ?? 'none'}  ·  Stars: ${d.stars}  ·  Forks: ${d.forks}`,
            `Open issues: ${d.openIssues}  ·  Default branch: ${d.defaultBranch}`,
            `Last pushed: ${formatDate(d.pushedAt)}`,
            d.htmlUrl,
            rateLine(r.rateLimit),
          ].filter(Boolean).join('\n');
          return ok(d.fullName, lines, [repoToSource(d)]);
        }


        // ── search_repos ─────────────────────────────────────

        case 'search_repos': {
          const query = params.query as string;
          if (!query || !query.trim()) return err('search_repos requires query');
          const r = await searchRepos(query, toNumber(params.perPage) ?? 10);
          if (!r.ok) return errFromGithub(r);
          if (r.data.length === 0) {
            return ok('Search results', `No repos matched "${query}".`);
          }
          const sources = r.data.slice(0, 10).map(repoToSource);
          return ok(
            `Search: "${query}" — ${r.data.length} results`,
            formatRepoList(r.data) + '\n' + rateLine(r.rateLimit),
            sources,
          );
        }


        // ── list_issues / list_pulls ─────────────────────────

        case 'list_issues':
        case 'list_pulls': {
          const fn = action === 'list_issues' ? listIssues : listPulls;
          const r = await fn({
            filter:  params.filter as any,
            repo:    params.repo as string | undefined,
            state:   params.state as any,
            perPage: toNumber(params.perPage),
          });
          if (!r.ok) return errFromGithub(r);
          const label = action === 'list_issues' ? 'issues' : 'pull requests';
          if (r.data.length === 0) {
            return ok(`No ${label} found`, `No ${label} match the filter.`);
          }
          const sources = r.data.slice(0, 10).map(issueToSource);
          return ok(
            `${capitalize(label)} (${r.data.length})`,
            formatIssueList(r.data) + '\n' + rateLine(r.rateLimit),
            sources,
          );
        }


        // ── read_issue / read_pull ───────────────────────────

        case 'read_issue': {
          const owner  = params.owner  as string;
          const repo   = params.repo   as string;
          const number = toNumber(params.number);
          if (!owner || !repo || !number) return err('read_issue requires owner, repo, and number');
          const r = await readIssue(owner, repo, number);
          if (!r.ok) return errFromGithub(r);
          const d = r.data;
          const lines = [
            `#${d.number} — ${d.title}  [${d.state}]`,
            `${d.repo}  ·  opened by @${d.author}  ·  ${formatDate(d.createdAt)}`,
            d.labels.length ? `Labels: ${d.labels.join(', ')}` : '',
            d.assignees.length ? `Assignees: ${d.assignees.map(a => '@' + a).join(', ')}` : '',
            '',
            d.body || '[no body]',
            d.bodyTruncated ? '' : '',  // truncation marker already appended by capBody
            '',
            d.comments.length ? `── Comments (${d.comments.length}) ──` : 'No comments yet.',
            ...d.comments.map(c => `\n@${c.author} · ${formatDate(c.createdAt)}\n${c.body}`),
            rateLine(r.rateLimit),
          ].filter(s => s !== '').join('\n');
          return ok(`Issue #${d.number}: ${d.title}`, lines, [issueToSource(d)]);
        }

        case 'read_pull': {
          const owner  = params.owner  as string;
          const repo   = params.repo   as string;
          const number = toNumber(params.number);
          if (!owner || !repo || !number) return err('read_pull requires owner, repo, and number');
          const r = await readPull(owner, repo, number);
          if (!r.ok) return errFromGithub(r);
          const d = r.data;
          const mergeStatus =
            d.isMerged ? 'merged' :
            d.isDraft  ? 'draft'  :
            d.state === 'closed' ? 'closed' :
            d.mergeable === false ? 'open (conflicts)' : 'open';
          const lines = [
            `PR #${d.number} — ${d.title}  [${mergeStatus}]`,
            `${d.repo}  ·  ${d.headBranch} → ${d.baseBranch}  ·  by @${d.author}`,
            `+${d.additions} / -${d.deletions} across ${d.changedFiles} file(s)`,
            d.labels.length ? `Labels: ${d.labels.join(', ')}` : '',
            '',
            d.body || '[no body]',
            '',
            d.files.length ? `── Files changed (showing ${d.files.length}) ──` : '',
            ...d.files.map(f => `  ${f.status.padEnd(10)} ${f.path}  (+${f.additions}/-${f.deletions})`),
            '',
            d.comments.length ? `── Comments (${d.comments.length}) ──` : 'No comments yet.',
            ...d.comments.map(c => `\n@${c.author} · ${formatDate(c.createdAt)}\n${c.body}`),
            rateLine(r.rateLimit),
          ].filter(s => s !== '').join('\n');
          return ok(`PR #${d.number}: ${d.title}`, lines, [issueToSource(d)]);
        }


        // ── read_file ────────────────────────────────────────

        case 'read_file': {
          const owner = params.owner as string;
          const repo  = params.repo  as string;
          const path  = params.path  as string;
          const ref   = params.ref   as string | undefined;
          if (!owner || !repo || !path) return err('read_file requires owner, repo, and path');
          const r = await readFile(owner, repo, path, ref);
          if (!r.ok) return errFromGithub(r);
          const d = r.data;
          if (d.isBinary) {
            return ok(
              `${d.path} (binary)`,
              `Binary file — ${d.size} bytes. Cannot display contents inline.\n${d.htmlUrl}\n${rateLine(r.rateLimit)}`,
              [{ label: `${owner}/${repo}/${d.path}`, url: d.htmlUrl }],
            );
          }
          const sizeLabel = d.size > 100_000 ? ` (${Math.round(d.size / 1024)} KB — large file)` : '';
          return ok(
            `${d.path}${sizeLabel}`,
            [d.content, '', rateLine(r.rateLimit)].join('\n'),
            [{ label: `${owner}/${repo}/${d.path}`, url: d.htmlUrl }],
          );
        }


        // ── list_notifications ───────────────────────────────

        case 'list_notifications': {
          const r = await listNotifications({
            all:     params.all === true,
            perPage: toNumber(params.perPage),
          });
          if (!r.ok) return errFromGithub(r);
          if (r.data.length === 0) {
            return ok('Notifications', 'Inbox is clear. Nothing waiting for you.');
          }
          const lines = r.data.map(n =>
            `[${n.unread ? '•' : ' '}] ${n.reason.padEnd(18)} ${n.repo} — ${n.subject.title}  (${formatDate(n.updatedAt)})`,
          );
          return ok(
            `Notifications (${r.data.length})`,
            lines.join('\n') + '\n' + rateLine(r.rateLimit),
          );
        }


        default:
          return err(`Unknown github action: "${action}"`);
      }
    } catch (e: any) {
      // Last-resort catch. github client functions are designed
      // to NEVER throw — they return GithubError. This protects
      // against future code that forgets that rule.
      return err(`GitHub tool error: ${e?.message ?? String(e)}`);
    }
  },
};


// ── Helpers ───────────────────────────────────────────────────


// Convert a GithubError (from the client layer) into a
// NerdAlertResponse. Surfaces the friendly hint as the
// content so the agent can read it back to the user.
function errFromGithub(e: GithubError): NerdAlertResponse {
  return {
    type:    'text',
    content: `[github] ${e.hint}`,
    metadata: { title: `GitHub error: ${e.error}`, sources: [] },
  };
}


function ok(title: string, content: string, sources: Source[] = []): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources } };
}

function err(message: string): NerdAlertResponse {
  return { type: 'text', content: `[github] ${message}`, metadata: { title: 'GitHub error', sources: [] } };
}


// Format a list of repos for display. Cap at 10 lines plus a
// "and N more" line if needed (matches gmail-tool's list cap).
function formatRepoList(repos: GithubRepo[]): string {
  if (repos.length === 0) return 'No repos found.';
  const display = repos.slice(0, 10);
  const lines = display.map(r => {
    const flags = [
      r.isPrivate  ? 'private'  : null,
      r.isFork     ? 'fork'     : null,
      r.isArchived ? 'archived' : null,
    ].filter(Boolean).join(', ');
    const flagStr = flags ? ` [${flags}]` : '';
    const lang = r.language ? `  ${r.language}` : '';
    return `${r.fullName}${flagStr}  ★${r.stars}${lang} — ${r.description ?? 'no description'}`;
  });
  if (repos.length > 10) {
    lines.push(`… and ${repos.length - 10} more. Increase perPage to see more.`);
  }
  return lines.join('\n');
}


function formatIssueList(items: GithubIssueSummary[]): string {
  if (items.length === 0) return 'No items found.';
  const display = items.slice(0, 10);
  const lines = display.map(i => {
    const stateMark = i.state === 'open' ? '○' : '●';
    const labels = i.labels.length ? `  [${i.labels.join(', ')}]` : '';
    return `${stateMark} ${i.repo}#${i.number}  ${i.title}${labels}  · @${i.author}  · ${formatDate(i.updatedAt)}`;
  });
  if (items.length > 10) {
    lines.push(`… and ${items.length - 10} more.`);
  }
  return lines.join('\n');
}


// Append a small rate-limit line so the agent can mention if
// we're getting close to the cap. Suppressed when we have
// plenty of budget left.
function rateLine(r: RateLimitInfo): string {
  if (r.remaining > 100) return '';
  const minutes = Math.ceil((r.resetAt * 1000 - Date.now()) / 60_000);
  return `\n(rate limit: ${r.remaining}/${r.limit} remaining, resets in ${minutes}min)`;
}


function repoToSource(r: GithubRepo): Source {
  return { label: r.fullName, url: r.htmlUrl };
}

function issueToSource(i: GithubIssueSummary): Source {
  const kind = i.isPullRequest ? 'PR' : 'Issue';
  return { label: `${i.repo} ${kind} #${i.number}`, url: i.htmlUrl };
}


function formatDate(iso: string | null): string {
  if (!iso) return 'unknown';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}


// Type-coerce params.foo (which is `unknown`) into a number,
// or undefined if it can't be coerced. Same pattern the
// rss-tool uses for defensive parameter parsing.
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}


function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}


export default githubTool;
