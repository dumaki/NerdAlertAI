// ============================================================
// src/github/client.ts  — GitHub REST API Client (read-only)
// ============================================================
// Thin wrapper around GitHub's REST API for v0.5.31 read
// operations. Uses native fetch — no octokit dependency.
//
// Design rules:
//   - Every public function returns a discriminated union:
//       { ok: true, data: ... } | { ok: false, error: string }
//     Callers never have to wrap in try/catch.
//   - All network calls funnel through githubFetch() — one
//     place handles auth, User-Agent, timeout, rate-limit
//     parsing, and error normalisation.
//   - Rate-limit metadata surfaces in every response so the
//     tool layer can warn the user when we're getting close.
//   - Response bodies get TYPED at the boundary (the `as` cast
//     inside githubFetch). Beyond that we trust the shape.
//
// Trust posture: L1 read-only. Every function below corresponds
// to a GET on api.github.com. No POST/PATCH/PUT/DELETE in this
// file — write actions will land in a separate write-client at
// L3 in a future release.
//
// Mirrors the shape of src/gmail/client.ts so the github-tool
// surface looks familiar to anyone who's worked on gmail-tool.
// ============================================================

import { getGithubToken, isGithubConfigured } from './config';


// ── Configuration ──────────────────────────────────────────

const API_BASE          = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PER_PAGE  = 25;     // cap most list endpoints at this
const MAX_BODY_CHARS    = 4_000;  // cap issue/PR body text for the model

// User-Agent — GitHub asks every API caller to set one and
// will throttle harder without it. Same value the rss-tool
// uses, version-bumped to match the release this lands in.
const USER_AGENT = 'NerdAlertAI/0.5.31 (https://github.com/dumaki/NerdAlertAI)';

// API version pin. GitHub serves multiple versions of the
// REST API in parallel and recommends pinning to the date you
// developed against, so a future API change can't silently
// break you. Bump when we deliberately move to a newer one.
const API_VERSION = '2022-11-28';


// ── Re-exports ────────────────────────────────────────────
//
// The github-tool reads isGithubConfigured() at the top of
// execute() to short-circuit when the user hasn't set up yet.
// Re-exporting it here means callers only need to import from
// this one file instead of remembering which module owns what.

export { isGithubConfigured };


// ── Result types ──────────────────────────────────────────
//
// Every public function returns one of these. Discriminated
// on `ok` so TypeScript narrows automatically (same pattern
// the oauth.ts module uses).

export interface RateLimitInfo {
  /** Remaining requests in the current window. */
  remaining: number;
  /** Max requests per window (typically 5000 for authenticated calls). */
  limit:     number;
  /** UNIX timestamp (seconds) when the window resets. */
  resetAt:   number;
}

export interface GithubResult<T> {
  ok:        true;
  data:      T;
  /** Always present on successful calls. */
  rateLimit: RateLimitInfo;
}

export interface GithubError {
  ok:        false;
  /** Machine-readable error code. */
  error:     string;
  /** Friendly explanation, safe to show the user. */
  hint:      string;
  /** HTTP status code if the request reached the server. */
  status?:   number;
  /** Rate limit info, if we could parse it. May be absent on transport errors. */
  rateLimit?: RateLimitInfo;
}


// ── Domain types ──────────────────────────────────────────
//
// Trimmed-down shapes of what we return to callers. GitHub
// responses are noisy — hundreds of fields per object. We
// project down to what the tool actually needs.

export interface GithubUser {
  login:      string;
  name:       string | null;
  email:      string | null;
  avatarUrl:  string;
  htmlUrl:    string;
  publicRepos: number;
  followers:  number;
}

export interface GithubRepo {
  id:           number;
  name:         string;
  fullName:     string;        // "owner/repo"
  description:  string | null;
  htmlUrl:      string;
  isPrivate:    boolean;
  isFork:       boolean;
  isArchived:   boolean;
  defaultBranch: string;
  language:     string | null;
  stars:        number;
  forks:        number;
  openIssues:   number;
  updatedAt:    string;         // ISO 8601
  pushedAt:     string | null;  // ISO 8601
}

export interface GithubIssueSummary {
  number:    number;
  title:     string;
  state:     'open' | 'closed';
  htmlUrl:   string;
  repo:      string;            // "owner/repo"
  author:    string;
  labels:    string[];
  isPullRequest: boolean;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
}

export interface GithubIssueFull extends GithubIssueSummary {
  body:        string;          // capped to MAX_BODY_CHARS
  bodyTruncated: boolean;
  assignees:   string[];
  comments:    GithubComment[];
}

export interface GithubComment {
  author:    string;
  createdAt: string;
  body:      string;            // capped to MAX_BODY_CHARS
  bodyTruncated: boolean;
}

export interface GithubPullFull extends GithubIssueFull {
  baseBranch:  string;
  headBranch:  string;
  isMerged:    boolean;
  isDraft:     boolean;
  mergeable:   boolean | null;
  changedFiles: number;
  additions:   number;
  deletions:   number;
  files:       GithubPullFile[];  // capped list
}

export interface GithubPullFile {
  path:      string;
  status:    string;            // "added" | "modified" | "removed" | ...
  additions: number;
  deletions: number;
}

export interface GithubNotification {
  id:        string;
  reason:    string;            // "mention" | "review_requested" | ...
  subject:   {
    title: string;
    type:  string;              // "Issue" | "PullRequest" | "Commit" | "Release"
    url:   string | null;       // API URL, may need transform for browser
  };
  repo:      string;
  updatedAt: string;
  unread:    boolean;
}

export interface GithubFileContents {
  path:      string;
  size:      number;
  encoding:  string;             // "base64" | "none"
  content:   string;              // decoded text, or empty if binary
  isBinary:  boolean;
  sha:       string;
  htmlUrl:   string;
}


// ── githubFetch — the one place that talks to GitHub ───────
//
// Every public function uses this. Centralises:
//   - Authorization header (Bearer token from cache)
//   - User-Agent + API version headers
//   - Timeout via AbortController
//   - Rate-limit header parsing
//   - Error normalisation (HTTP, GitHub, network all funnel
//     into the same GithubError shape)
//
// Type parameter <T>: TypeScript "generic". Callers say
// "I'm calling /user, treat the response as a GithubUserPayload"
// and TypeScript carries that type through. At runtime it's
// just JSON.parse — no validation. If GitHub returns garbage
// we'd notice via the field accesses in the caller.

async function githubFetch<T>(
  pathAndQuery: string,
  options: { method?: string } = {},
): Promise<GithubResult<T> | GithubError> {

  const token = getGithubToken();
  if (!token) {
    return {
      ok:    false,
      error: 'not_configured',
      hint:  "GitHub isn't set up yet. Say 'run github setup' and I'll walk you through it.",
    };
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = pathAndQuery.startsWith('http')
      ? pathAndQuery
      : `${API_BASE}${pathAndQuery}`;

    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'Authorization':         `Bearer ${token}`,
        'Accept':                'application/vnd.github+json',
        'X-GitHub-Api-Version':  API_VERSION,
        'User-Agent':            USER_AGENT,
      },
      signal: ctrl.signal,
    });

    // Parse rate-limit headers BEFORE returning, so callers
    // see the limit info even on error responses.
    const rateLimit = parseRateLimit(response);

    if (!response.ok) {
      const status = response.status;
      const text   = await safeReadText(response);

      // Specific common-failure handling. Each branch builds
      // a friendly hint so the agent can tell the user
      // something useful instead of "HTTP 403".
      if (status === 401) {
        return {
          ok:        false,
          error:     'unauthorized',
          hint:      "GitHub rejected the token. It may have been revoked — run 'github setup' to reconnect.",
          status,
          rateLimit,
        };
      }
      if (status === 403 && rateLimit && rateLimit.remaining === 0) {
        const minutes = Math.ceil((rateLimit.resetAt * 1000 - Date.now()) / 60_000);
        return {
          ok:        false,
          error:     'rate_limited',
          hint:      `GitHub rate limit hit. Resets in ~${minutes} minute(s).`,
          status,
          rateLimit,
        };
      }
      if (status === 403) {
        return {
          ok:        false,
          error:     'forbidden',
          hint:      "GitHub refused the request. The token may be missing the required scope, or you don't have access to that resource.",
          status,
          rateLimit,
        };
      }
      if (status === 404) {
        return {
          ok:        false,
          error:     'not_found',
          hint:      "GitHub returned 404. The resource doesn't exist, or your token doesn't have permission to see it.",
          status,
          rateLimit,
        };
      }
      return {
        ok:        false,
        error:     `http_${status}`,
        hint:      `GitHub returned ${status}. ${truncate(text, 200)}`,
        status,
        rateLimit,
      };
    }

    const data = await response.json() as T;
    return { ok: true, data, rateLimit: rateLimit ?? FALLBACK_RATE_LIMIT };

  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return {
        ok:    false,
        error: 'timeout',
        hint:  `GitHub didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s. Try again, or check your connection.`,
      };
    }
    return {
      ok:    false,
      error: 'network_error',
      hint:  `Could not reach GitHub: ${e?.message ?? 'unknown error'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}


// ── Public API ─────────────────────────────────────────────


// getUser — who am I?
//
// Used by the setup flow to confirm the token works AND to
// show the user their own username ("connected as @robreherman").
// Also useful as a connection test on its own.

export async function getUser(): Promise<GithubResult<GithubUser> | GithubError> {
  const r = await githubFetch<UserPayload>('/user');
  if (!r.ok) return r;
  return {
    ok:        true,
    rateLimit: r.rateLimit,
    data: {
      login:       r.data.login,
      name:        r.data.name ?? null,
      email:       r.data.email ?? null,
      avatarUrl:   r.data.avatar_url,
      htmlUrl:     r.data.html_url,
      publicRepos: r.data.public_repos ?? 0,
      followers:   r.data.followers ?? 0,
    },
  };
}


// listRepos — repos owned by, or accessible to, the authenticated user.
//
// `affiliation` controls which repos appear:
//   - "owner"                       → only mine
//   - "collaborator"                → ones I've been invited to
//   - "organization_member"         → ones from orgs I belong to
//   - "owner,collaborator,organization_member" (default) → everything

export async function listRepos(opts: {
  perPage?:    number;
  sort?:       'created' | 'updated' | 'pushed' | 'full_name';
  affiliation?: string;
  visibility?: 'all' | 'public' | 'private';
} = {}): Promise<GithubResult<GithubRepo[]> | GithubError> {
  const params = new URLSearchParams({
    per_page:    String(Math.min(opts.perPage ?? DEFAULT_PER_PAGE, 100)),
    sort:        opts.sort ?? 'updated',
    affiliation: opts.affiliation ?? 'owner,collaborator,organization_member',
    visibility:  opts.visibility ?? 'all',
  });
  const r = await githubFetch<RepoPayload[]>(`/user/repos?${params}`);
  if (!r.ok) return r;
  return { ok: true, rateLimit: r.rateLimit, data: r.data.map(projectRepo) };
}


// repoInfo — one repo's full details.

export async function repoInfo(
  owner: string,
  repo:  string,
): Promise<GithubResult<GithubRepo> | GithubError> {
  const r = await githubFetch<RepoPayload>(`/repos/${enc(owner)}/${enc(repo)}`);
  if (!r.ok) return r;
  return { ok: true, rateLimit: r.rateLimit, data: projectRepo(r.data) };
}


// searchRepos — full-text search across all of GitHub's repos.
//
// Note: search API has a tighter rate limit (30/min authenticated
// vs 5000/hour for the core API). The tool layer should warn the
// user if they're chaining many of these.

export async function searchRepos(
  query: string,
  perPage = DEFAULT_PER_PAGE,
): Promise<GithubResult<GithubRepo[]> | GithubError> {
  const params = new URLSearchParams({
    q:        query,
    per_page: String(Math.min(perPage, 100)),
    sort:     'stars',
    order:    'desc',
  });
  const r = await githubFetch<{ items: RepoPayload[] }>(`/search/repositories?${params}`);
  if (!r.ok) return r;
  return { ok: true, rateLimit: r.rateLimit, data: r.data.items.map(projectRepo) };
}


// listIssues — issues matching a filter. Uses the search API so
// we can filter by assignee/author/mentions in one call across all
// of the user's accessible repos.
//
// `filter`:
//   - "assigned" → assigned to me, still open
//   - "created"  → opened by me, still open
//   - "mentioned" → I'm @-mentioned, still open
//   - "all"      → any state, assigned to me (open + closed)
//
// `repo` optional — limit to one repo.

export async function listIssues(opts: {
  filter?: 'assigned' | 'created' | 'mentioned' | 'all';
  repo?:   string;       // "owner/repo"
  state?:  'open' | 'closed' | 'all';
  perPage?: number;
}): Promise<GithubResult<GithubIssueSummary[]> | GithubError> {
  return searchIssues({ ...opts, kind: 'issue' });
}


// listPulls — same as listIssues but PR-flavoured.

export async function listPulls(opts: {
  filter?: 'assigned' | 'created' | 'mentioned' | 'all';
  repo?:   string;
  state?:  'open' | 'closed' | 'all';
  perPage?: number;
}): Promise<GithubResult<GithubIssueSummary[]> | GithubError> {
  return searchIssues({ ...opts, kind: 'pr' });
}


// readIssue — one issue's full body + all comments.

export async function readIssue(
  owner:  string,
  repo:   string,
  number: number,
): Promise<GithubResult<GithubIssueFull> | GithubError> {
  const path = `/repos/${enc(owner)}/${enc(repo)}/issues/${number}`;
  const issueR = await githubFetch<IssuePayload>(path);
  if (!issueR.ok) return issueR;

  const commentsR = await githubFetch<CommentPayload[]>(`${path}/comments`);
  if (!commentsR.ok) return commentsR;

  return {
    ok:        true,
    rateLimit: commentsR.rateLimit,
    data: {
      ...projectIssueSummary(issueR.data, `${owner}/${repo}`),
      body:           capBody(issueR.data.body),
      bodyTruncated:  isBodyTruncated(issueR.data.body),
      assignees:      (issueR.data.assignees ?? []).map(a => a.login),
      comments:       commentsR.data.map(projectComment),
    },
  };
}


// readPull — one PR's full body, comments, and file change summary.
//
// Three round-trips: PR detail, comments, files. Could be made
// concurrent with Promise.all, but sequential is easier to
// reason about and the latency cost is acceptable for a
// human-driven tool. Worth revisiting if it becomes a bottleneck.

export async function readPull(
  owner:  string,
  repo:   string,
  number: number,
): Promise<GithubResult<GithubPullFull> | GithubError> {
  const path = `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`;

  const prR = await githubFetch<PullPayload>(path);
  if (!prR.ok) return prR;

  // PR comments live at the issues endpoint (yes, that's
  // really how GitHub organises it — PRs are issues with
  // extra fields). Per-file review comments live at /comments
  // under the pulls endpoint and aren't included here.
  const commentsR = await githubFetch<CommentPayload[]>(
    `/repos/${enc(owner)}/${enc(repo)}/issues/${number}/comments`,
  );
  if (!commentsR.ok) return commentsR;

  // Cap at 20 files — large PRs (100s of files) would otherwise
  // flood the model's context window with no analytical value.
  const filesR = await githubFetch<PullFilePayload[]>(`${path}/files?per_page=20`);
  if (!filesR.ok) return filesR;

  return {
    ok:        true,
    rateLimit: filesR.rateLimit,
    data: {
      ...projectIssueSummary(prR.data, `${owner}/${repo}`),
      body:           capBody(prR.data.body),
      bodyTruncated:  isBodyTruncated(prR.data.body),
      assignees:      (prR.data.assignees ?? []).map(a => a.login),
      comments:       commentsR.data.map(projectComment),
      baseBranch:     prR.data.base.ref,
      headBranch:     prR.data.head.ref,
      isMerged:       prR.data.merged ?? false,
      isDraft:        prR.data.draft ?? false,
      mergeable:      prR.data.mergeable ?? null,
      changedFiles:   prR.data.changed_files ?? 0,
      additions:      prR.data.additions ?? 0,
      deletions:      prR.data.deletions ?? 0,
      files:          filesR.data.map(f => ({
        path:      f.filename,
        status:    f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
    },
  };
}


// readFile — file contents from a repo at a specific path and
// optional ref (branch/tag/commit). Default branch if ref omitted.
//
// GitHub returns content base64-encoded. We decode if it looks
// like text; binary files (images, etc.) come back with empty
// content and isBinary: true.

export async function readFile(
  owner: string,
  repo:  string,
  path:  string,
  ref?:  string,
): Promise<GithubResult<GithubFileContents> | GithubError> {
  const params = ref ? `?ref=${enc(ref)}` : '';
  const r = await githubFetch<FileContentsPayload>(
    `/repos/${enc(owner)}/${enc(repo)}/contents/${path.split('/').map(enc).join('/')}${params}`,
  );
  if (!r.ok) return r;

  // The contents endpoint returns an array for directories.
  // The tool description tells the model to use a different
  // pattern for directories; refuse here cleanly if someone
  // hands us a directory path.
  if (Array.isArray(r.data)) {
    return {
      ok:    false,
      error: 'is_directory',
      hint:  `${path} is a directory, not a file. Pick a specific file path.`,
    };
  }

  // Decode if base64 + likely text. We don't try to handle
  // every encoding — UTF-8 covers 99% of source code.
  let decoded = '';
  let isBinary = false;
  if (r.data.encoding === 'base64' && r.data.content) {
    const buf = Buffer.from(r.data.content, 'base64');
    // Heuristic: scan first 8KB for null bytes → assume binary.
    isBinary = buf.subarray(0, 8192).includes(0);
    if (!isBinary) decoded = buf.toString('utf-8');
  }

  return {
    ok:        true,
    rateLimit: r.rateLimit,
    data: {
      path:     r.data.path,
      size:     r.data.size ?? 0,
      encoding: r.data.encoding ?? 'none',
      content:  decoded,
      isBinary,
      sha:      r.data.sha,
      htmlUrl:  r.data.html_url ?? '',
    },
  };
}


// listNotifications — the user's notification inbox.
//
// "all=true" includes already-read notifications; we leave it
// false to surface only fresh items unless the caller asks.

export async function listNotifications(opts: {
  all?: boolean;
  perPage?: number;
} = {}): Promise<GithubResult<GithubNotification[]> | GithubError> {
  const params = new URLSearchParams({
    all:      opts.all ? 'true' : 'false',
    per_page: String(Math.min(opts.perPage ?? DEFAULT_PER_PAGE, 50)),
  });
  const r = await githubFetch<NotificationPayload[]>(`/notifications?${params}`);
  if (!r.ok) return r;
  return {
    ok:        true,
    rateLimit: r.rateLimit,
    data: r.data.map(n => ({
      id:        n.id,
      reason:    n.reason,
      subject:   {
        title: n.subject.title,
        type:  n.subject.type,
        url:   n.subject.url,
      },
      repo:      n.repository.full_name,
      updatedAt: n.updated_at,
      unread:    n.unread,
    })),
  };
}


// testConnection — alias for getUser, used by the setup flow
// and by the github tool's 'test' action. Same call, just
// signals intent at the call site.

export async function testConnection(): Promise<GithubResult<GithubUser> | GithubError> {
  return getUser();
}


// ── Internal helpers ──────────────────────────────────────────


// Shared search-issues path used by both listIssues and listPulls.
// GitHub treats issues and PRs as the same resource at the search
// API level, differentiated by `is:issue` or `is:pr` in the query
// string.

async function searchIssues(opts: {
  kind:    'issue' | 'pr';
  filter?: 'assigned' | 'created' | 'mentioned' | 'all';
  repo?:   string;
  state?:  'open' | 'closed' | 'all';
  perPage?: number;
}): Promise<GithubResult<GithubIssueSummary[]> | GithubError> {

  // Build the query incrementally. Use plain strings + an
  // array to avoid quoting/encoding traps URLSearchParams hits
  // with GitHub's `+`-separated query syntax.
  const parts: string[] = [`is:${opts.kind}`];

  if (opts.state && opts.state !== 'all') {
    parts.push(`is:${opts.state}`);
  } else if (!opts.state) {
    parts.push('is:open');
  }

  switch (opts.filter ?? 'assigned') {
    case 'assigned':  parts.push('assignee:@me'); break;
    case 'created':   parts.push('author:@me');   break;
    case 'mentioned': parts.push('mentions:@me'); break;
    case 'all':       parts.push('involves:@me'); break;
  }

  if (opts.repo) {
    parts.push(`repo:${opts.repo}`);
  }

  const q       = parts.join(' ');
  const perPage = Math.min(opts.perPage ?? DEFAULT_PER_PAGE, 100);
  const url     = `/search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}&sort=updated&order=desc`;

  const r = await githubFetch<{ items: IssuePayload[] }>(url);
  if (!r.ok) return r;

  return {
    ok:        true,
    rateLimit: r.rateLimit,
    data: r.data.items.map(i => projectIssueSummary(i, extractRepoFromIssueUrl(i.html_url))),
  };
}


// Parse rate-limit headers off a Response. Returns undefined
// if the server didn't send them (rare — almost every API
// response includes these). Used by both success and error
// paths.

function parseRateLimit(response: Response): RateLimitInfo | undefined {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const limit     = response.headers.get('x-ratelimit-limit');
  const reset     = response.headers.get('x-ratelimit-reset');
  if (remaining === null || limit === null || reset === null) return undefined;
  const remainingN = Number(remaining);
  const limitN     = Number(limit);
  const resetN     = Number(reset);
  if (Number.isNaN(remainingN) || Number.isNaN(limitN) || Number.isNaN(resetN)) {
    return undefined;
  }
  return { remaining: remainingN, limit: limitN, resetAt: resetN };
}

// Fallback rate-limit info for the (rare) case where GitHub
// didn't send headers. Optimistic — we don't want to false-
// positive a rate-limit warning when we have no data.
const FALLBACK_RATE_LIMIT: RateLimitInfo = {
  remaining: 5000,
  limit:     5000,
  resetAt:   Math.floor(Date.now() / 1000) + 3600,
};


// projectRepo — squash a verbose repo payload down to the
// fields the tool actually uses. Kept beside the public API
// so it's easy to extend when we surface a new field.

function projectRepo(p: RepoPayload): GithubRepo {
  return {
    id:            p.id,
    name:          p.name,
    fullName:      p.full_name,
    description:   p.description ?? null,
    htmlUrl:       p.html_url,
    isPrivate:     p.private,
    isFork:        p.fork ?? false,
    isArchived:    p.archived ?? false,
    defaultBranch: p.default_branch ?? 'main',
    language:      p.language ?? null,
    stars:         p.stargazers_count ?? 0,
    forks:         p.forks_count ?? 0,
    openIssues:    p.open_issues_count ?? 0,
    updatedAt:     p.updated_at,
    pushedAt:      p.pushed_at ?? null,
  };
}

function projectIssueSummary(p: IssuePayload, repoFullName: string): GithubIssueSummary {
  return {
    number:        p.number,
    title:         p.title,
    state:         (p.state === 'closed' ? 'closed' : 'open'),
    htmlUrl:       p.html_url,
    repo:          repoFullName,
    author:        p.user?.login ?? 'unknown',
    labels:        (p.labels ?? []).map(l => typeof l === 'string' ? l : l.name),
    isPullRequest: !!p.pull_request,
    createdAt:     p.created_at,
    updatedAt:     p.updated_at,
    commentCount:  p.comments ?? 0,
  };
}

function projectComment(c: CommentPayload): GithubComment {
  return {
    author:        c.user?.login ?? 'unknown',
    createdAt:     c.created_at,
    body:          capBody(c.body),
    bodyTruncated: isBodyTruncated(c.body),
  };
}


// The search API returns issue/PR results with html_url shaped
// like "https://github.com/{owner}/{repo}/issues/123". We need
// the "owner/repo" pair for display and don't want to make a
// second API call just to fetch repository_url. Regex it out.

function extractRepoFromIssueUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\//);
  return m ? `${m[1]}/${m[2]}` : '';
}


// capBody — truncate long bodies. Issue/PR bodies can be huge
// (RFCs, design docs). 4000 chars is enough for the model to
// summarise without flooding context.

function capBody(body: string | null | undefined): string {
  if (!body) return '';
  if (body.length <= MAX_BODY_CHARS) return body;
  return body.slice(0, MAX_BODY_CHARS) + '\n\n[truncated — full body on GitHub]';
}

function isBodyTruncated(body: string | null | undefined): boolean {
  return !!body && body.length > MAX_BODY_CHARS;
}


// Percent-encode a path segment. Repos/owners can have dots,
// hyphens, underscores (all safe), but we use this defensively
// in case GitHub ever permits more.
function enc(s: string): string {
  return encodeURIComponent(s);
}


async function safeReadText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}


// ── Raw payload types ──────────────────────────────────────
// Shapes of what GitHub returns. Trimmed to the fields we use.
// Not exported — public functions project these into clean
// GithubFoo types above.

interface UserPayload {
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url: string;
  html_url: string;
  public_repos?: number;
  followers?: number;
}

interface RepoPayload {
  id: number;
  name: string;
  full_name: string;
  description?: string | null;
  html_url: string;
  private: boolean;
  fork?: boolean;
  archived?: boolean;
  default_branch?: string;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  updated_at: string;
  pushed_at?: string | null;
}

interface IssuePayload {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user?: { login: string };
  labels?: Array<string | { name: string }>;
  pull_request?: object;
  created_at: string;
  updated_at: string;
  comments?: number;
  body?: string | null;
  assignees?: Array<{ login: string }>;
}

interface PullPayload extends IssuePayload {
  base:   { ref: string };
  head:   { ref: string };
  merged?: boolean;
  draft?:  boolean;
  mergeable?: boolean | null;
  changed_files?: number;
  additions?: number;
  deletions?: number;
}

interface PullFilePayload {
  filename:  string;
  status:    string;
  additions: number;
  deletions: number;
}

interface CommentPayload {
  user?: { login: string };
  created_at: string;
  body: string;
}

interface NotificationPayload {
  id: string;
  reason: string;
  subject: { title: string; type: string; url: string | null };
  repository: { full_name: string };
  updated_at: string;
  unread: boolean;
}

interface FileContentsPayload {
  path: string;
  size?: number;
  encoding?: string;
  content?: string;
  sha: string;
  html_url?: string;
}
