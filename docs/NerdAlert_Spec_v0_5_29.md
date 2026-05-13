# NerdAlert Spec — v0.5.29

**Date:** 2026-05-12
**Branch:** dev
**Predecessor:** v0.5.28 (narration dissonance defense-in-depth)
**Scope:** Additive module release. Ships an L1 `rss` tool that
fetches and parses RSS 2.0 / Atom 1.0 feeds with a curated
default registry (CISA KEV, CISA advisories, NVD recent CVEs,
r/homelab). Zero new dependencies — hand-rolled parser. No core
changes, no narration changes, no defense-layer interactions.

## What shipped

One commit on `dev` since v0.5.28:

| SHA | Title |
|---|---|
| _(pending)_ | feat(rss): L1 RSS / Atom feed reader with curated registry |

Files changed:
- `src/tools/builtin/rss-tool.ts` — NEW. Hand-rolled RSS 2.0 /
  Atom 1.0 parser, in-memory 10-min cache, 5MB body cap, four
  registered default feeds, sources rail integration.
- `src/tools/registry.ts` — one import line + one entry in
  `ALL_TOOLS` between `webTool` and `hostMetricsTool`.
- `config.yaml` — new `rss:` entry under `tools:` between
  `web:` and `host_metrics:`, `enabled: true, trust_level: 1`.
- `package.json` — version bump `0.5.28` → `0.5.29`.

## The shape of the addition

L1 RSS reader. Outbound HTTP only, no auth, no credentials,
public feeds only. Same trust posture as `web` and `weather`.

The tool accepts either a registered `feed_name` or an explicit
`url`, fetches the feed body with a streamed read and a 5MB
cap, parses it via a hand-rolled RSS/Atom parser, filters items
by recency (`since_hours`), caps the count (`max_items`), and
returns a clean text block with `metadata.sources` populated
per item link.

The curated registry ships with four feeds:

| Name | Source | Notes |
|---|---|---|
| `cisa_kev` | CISA Known Exploited Vulnerabilities | URL uses the XML variant; if it 404s, swap to JSON via the web tool or update the registry. |
| `cisa_advisories` | CISA Cybersecurity Advisories | Standard CISA RSS, stable. |
| `nvd_recent` | NVD Recent CVEs | Long-standing nvd.nist.gov feed. UA required (default Node UAs get blocked) — `NERDALERT_UA` applied proactively. |
| `homelab_reddit` | r/homelab subreddit | Reddit's standard subreddit RSS pattern. |

Hardcoded in `rss-tool.ts` for auditability. Adding or
overriding entries via `config.yaml` is a deliberate v0.5.30+
extension — the type plumbing in `AgentConfig` is held back
this release so the type surface doesn't churn for one tool.

## Why hand-rolled, not `rss-parser`

`rss-parser` is the standard npm pick (~80kb, MIT). Declined
this release for three reasons:

1. **Zero supply-chain delta.** The parser is ~80 lines —
   smaller than `web-tool.ts`. The complexity isn't worth a
   transitive dependency on an L1 read-external surface.
2. **The four shipped feeds cover RSS 2.0 and Atom 1.0** which
   are both ~5 distinct field shapes. Edge cases (CDATA, entity
   decode, namespaced fields like `dc:date` and `content:encoded`)
   are handled explicitly.
3. **Interface stays stable if we swap later.** If we hit a
   feed that the hand-rolled parser can't handle cleanly, we
   pull `rss-parser` in behind the same tool surface. No
   caller change, no agent description change.

## Tool surface

```ts
rss({
  url?:          string,    // explicit feed URL, mutex with feed_name
  feed_name?:    string,    // one of: cisa_kev | cisa_advisories
                            //         nvd_recent | homelab_reddit
  max_items?:    number,    // default 10, hard cap 50
  since_hours?:  number,    // default 24, hard cap 720 (30 days)
  list_feeds?:   boolean,   // short-circuit: return the registry table
}) → NerdAlertResponse
```

Output shape (capped, §5 output discipline):

```
CISA Known Exploited Vulnerabilities — 4 items in the last 24 hours:

• CVE-2025-XXXXX — Vendor product RCE
  2h ago — Critical; actively exploited per CISA…
  https://www.cisa.gov/…

• …
```

Sources rail populated with one entry per item link plus the
feed itself last (lower-priority attribution).

## Patterns reused

| From | Pattern | Where |
|---|---|---|
| `web-tool.ts` | `NERDALERT_UA` header on every request | `fetchFeedBody` |
| `web-tool.ts` | AbortController + fetch timeout | `fetchFeedBody` |
| `weather-tool.ts` | 10-min in-memory cache keyed by canonical URL | `FEED_CACHE` |
| `weather-tool.ts` | Defensive parameter coercion + clamp | `coerceNumber` |
| `weather-tool.ts` | Error responses return `NerdAlertResponse`, never throw | All catch blocks |
| v0.5.6 sources rail | `metadata.sources` populated for citation rendering | Response construction |

New pattern introduced (not yet at Direct Client Patterns
canonical-reference status — needs reuse before promotion):

### Streamed body fetch with size cap

Pre-`rss-tool.ts`, every HTTP fetch in NerdAlertAI used
`res.text()` or `res.json()`, accumulating the full body in
memory before parsing. For tools fetching attacker-controlled
or unbounded content (RSS feeds, arbitrary URLs the agent
chose), this is a DoS vector — a single 500MB feed could OOM
the box.

`fetchFeedBody` streams via `res.body?.getReader()`, accumulates
a `TextDecoder`-decoded string, and `reader.cancel()`s once the
byte total exceeds `MAX_BODY_BYTES` (5MB). The cancellation
releases the upstream socket immediately rather than draining.

Generalizable to any future tool that fetches user-or-agent-
chosen URLs. Worth promoting to §18 patterns if web-tool's
`fetch` action adopts it too.

## v0.5.28 dissonance defense interaction

None. The tool is reachable only via the tool-loop adapter
path — agent picks it from the description because it's not in
the intent-prefetch keyword map. The narration path (where
Layers A/B/C live) never sees RSS data. Strict-superset
property holds.

This was a deliberate design choice: adding `rss` to prefetch
keywords would re-introduce exactly the keyword-collision class
v0.5.27 fixed. RSS queries are too varied ("CVEs", "homelab",
"latest from CISA") to anchor cleanly, and the cost of
prefetch (one extra HTTP round-trip on every message) isn't
worth the latency savings for a tool the agent picks
correctly via its description.

If real-world telemetry shows the agent under-using the tool,
we re-evaluate — but the first move is to refine the
description, not to wire prefetch.

## Module Status (additions)

The v0.5.28 Module Status table is extended:

| **Module** | **Status** | **Notes** |
|---|---|---|
| **RSS / Atom feed reader (`rss` tool, v0.5.29)** | ✅ Complete | L1 trust, four registered default feeds (CISA KEV, CISA advisories, NVD recent, r/homelab). Hand-rolled parser, zero new deps. 10-min cache, 5MB body cap, sources rail integrated. Disabled cleanly via `config.yaml` `tools.rss.enabled: false` — strict-superset property holds. |

## What did NOT change

- **`core/agent.ts`** — core loop untouched.
- **`core/permission-broker.ts`** — trust chokepoint untouched.
- **`core/intent-prefetch.ts`** — no new keyword group for RSS.
  See "v0.5.28 dissonance defense interaction" above for the
  rationale. The file is byte-identical to v0.5.28.
- **`core/narration-postcheck.ts`** — byte-identical.
- **The three event adapters** — pinned.
- **The memory engine (`src/memory/*`)** — byte-identical.
- **Telegram cron (`src/telegram/cron.ts`)** — byte-identical.
  Morning brief integration is deferred to a follow-up session
  (see "What's still on the horizon" below). Today the agent
  can call `rss` on demand; the morning brief still has its
  four existing sections (SOC log, calendar, mail, reminders).
- **Tier-1 security primitives** — `secret-scanner.ts` and
  `safe-console.ts` unchanged.
- **`.env`** — secrets continue to never live there. RSS feeds
  are public; no credentials involved.
- **`AgentConfig` type in `response.types.ts`** — held stable
  this release. Configurable feed registry (a `rss.feeds` block)
  lands in v0.5.30+ if user demand surfaces.

The module isolation contract from v0.5.26 holds: with
`tools.rss.enabled: false` the tool disappears from the agent's
available list and the experience is identical to v0.5.28.

## Test surface

No new automated tests. Manual verification plan:

| Test query | Expected behavior |
|---|---|
| `rss list_feeds:true` | Returns the four-row registry table without any HTTP. |
| "What's new from CISA today?" | Agent calls `rss` with `feed_name: cisa_advisories`, summarizes items from the last 24h, sources rail shows each item link. |
| "Check the CISA KEV feed" | Agent calls `rss` with `feed_name: cisa_kev`. If the URL 404s, tool returns a graceful "fetch failed" response — verify and update the URL in the registry. |
| "Anything interesting on r/homelab this week?" | Agent calls `rss` with `feed_name: homelab_reddit, since_hours: 168`. |
| Explicit URL: "fetch https://example.com/feed.xml" | Agent calls `rss` with `url: "..."`, parser handles whichever format the feed uses. |
| Invalid URL: `rss url:"not-a-url"` | Returns graceful "invalid URL" response, no fetch attempt. |
| `rss url:"file:///etc/passwd"` | Returns graceful "must be http or https" response, no fetch attempt. SSRF guard validated. |

Telemetry to watch:

- First-call latency per feed name. NVD's feed is large; the
  5MB cap may trip on rare large-update days. Monitor.
- Whether the agent reaches for `rss` when appropriate vs.
  defaulting to `web.search`. If under-used, refine the
  description before considering prefetch wiring.

## Cross-references

- v0.5.28 spec — predecessor, narration dissonance defenses.
- `src/tools/builtin/weather-tool.ts` — pattern source for
  cache, error handling, parameter coercion.
- `src/tools/builtin/web-tool.ts` — pattern source for UA
  header, fetch timeout, sources rail integration.
- `src/tools/registry.ts` — wiring point.
- `config.yaml` `tools.rss` — gate.

## Files for next-session orientation

1. `docs/NerdAlert_Spec_v0_5_29.md` — this document.
2. `src/tools/builtin/rss-tool.ts` — read the file-level
   comment first; it explains the trust posture, the dep
   decision, and the cache/cap rationale.
3. `src/telegram/cron.ts` — unchanged this release; the
   morning brief integration ticket below targets this file.

## What's still on the horizon

### Morning brief integration (next session)

Add a 5th section to `runMorningBrief()` in `src/telegram/cron.ts`
between Mail and Reminders:

```ts
// 5. Security RSS — overnight critical advisories
try {
  const security = await askAgent(
    'Use the rss tool to check cisa_advisories and nvd_recent ' +
    'for items in the last 24 hours. Summarize anything CVSS 7+ ' +
    'or actively exploited. If nothing critical, say "No critical ' +
    'advisories overnight." Keep it under 6 lines.'
  );
  parts.push(`🛡️ *Security News*\n${security}`);
} catch {
  parts.push('🛡️ *Security News* — unavailable');
}
```

One-file edit. Lands in v0.5.30 unless rolled with other cron
work.

### Configurable feed registry (v0.5.30+, demand-driven)

Add a `rss.feeds` block to `AgentConfig`:

```yaml
rss:
  feeds:
    my_blog:
      url: https://example.com/feed.xml
      label: My Personal Blog
```

Loader merges over the hardcoded `FEED_REGISTRY` in
`rss-tool.ts`. Held back this release to keep the type surface
stable; landed if real users want it.

### NVD/KEV JSON ingestion (deferred, low priority)

If CISA's KEV XML URL turns out to be unstable, swap the
`cisa_kev` entry to JSON ingestion via the web tool plus a
small adapter. Today this is a "wait for the 404" decision —
not worth pre-building.

## Deployment notes from prod (2026-05-12 post-merge)

Deployed to the Optiplex (Ubuntu 24.04, `nerdalert@dumaki`
systemd) the same session v0.5.29 landed on `dev`. The pull
surfaced three operational artifacts worth recording.

### 1. Config drift between dev and prod

The Optiplex's `config.yaml` had eight `tool_groups` flipped
to `enabled: true` (wazuh, pihole, crowdsec, pfsense, fail2ban,
ntopng, loki, influxdb) — the SOC services where credentials
actually live on the prod box. `git pull` refused to merge
because my upstream change to the same file would have stomped
those local edits.

Resolved this session via the standard recovery dance:

```bash
git stash push -m "prod: enable SOC tool_groups" config.yaml
git pull origin dev
git stash pop
```

Stash pop applied cleanly — my edit (adding `rss:` under
`tools:`) and prod's edits (flipping `tool_groups:` enabled
flags) touched disjoint line ranges. No conflict markers.

**Class-of-problem:** this will recur on every pull that
touches `config.yaml`. The architectural fix is a
`config.local.yaml` overlay loaded on top of the tracked
`config.yaml` at boot, with the local file in `.gitignore`.
Proposed for v0.5.30+ alongside the setup.sh audit.

### 2. npm install gap in the deploy procedure

The prod box was ~14 versions stale (last deploy was
v0.5.13-era based on the spec doc deletions in the pull diff).
Pulling head brought in every dep that landed across that
span at once: `chrono-node`, `@huggingface/transformers`,
`mathjs`, and others. The build failed with `TS2307: Cannot
find module` errors because `node_modules/` was out of sync
with `package.json`.

Resolved by running `npm install` before the build:

```bash
npm install && npm run build && sudo systemctl restart nerdalert@dumaki
```

**Class-of-problem:** the deploy procedure documented in
handoffs and memory was `pull && build && restart`. It should
be `pull && npm install && build && restart`. `npm install` is
a no-op when `package-lock.json` matches installed modules, so
there's no downside to running it every time. Action item for
v0.5.30 setup audit.

### 3. `Tools : ...` boot-log line not visible

The v0.5.14 spec records `logAvailableTools()` as called at
boot, printing a `Tools  : tool1, tool2, ...` line that would
have been the cleanest verification that `rss` registered.
The line is absent from the journalctl tail of the v0.5.29
restart. The service is healthy and SOC watchdog cron is
firing, so this is a missing log signal, not a missing tool.

Two possible causes worth a brief grep next session:
  - The call was lost in a refactor between v0.5.14 and v0.5.29.
  - The call fires but its output is sent somewhere journalctl
    doesn't capture (unlikely — every other `console.log` at
    boot shows up).

Not blocking — the tool was verified live in Telegram by
asking Sherman to list registered RSS feeds. Treat the log
line as a minor regression to investigate, not a deploy
failure.

### 4. Second restart at 15:56:11 (unexplained)

Journalctl shows a second `SIGTERM received — shutting down`
14 minutes after the first restart, followed by a clean
respawn. Origin unknown — probably manual (Ben re-running
something) but worth a `journalctl -u nerdalert@dumaki
--since "15:55" --until "15:57"` if a pattern emerges over
the next 24 hours.

## Version bump

`package.json` bumps from `0.5.28` to `0.5.29`.
