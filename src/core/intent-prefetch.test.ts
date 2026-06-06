// Tests for the selection-only action-tool intent groups (browser / ssh /
// shell) added to intent-prefetch.ts. Run with: npm test (or npx vitest run).
//
// These groups exist so the weak-model tool-selector's recall net
// (intentToolNames) surfaces browser / browser_act / ssh_exec / shell_exec
// on browse / remote-command queries -- without them a freeze-prone local
// model (Mistral) never sees the tools and returns an empty turn. They are
// selectionOnly: prefetchTools must NOT execute them (interactive actions,
// not prefetchable data sources). detectIntent + intentToolNames are pure;
// prefetchTools routes through the broker, so executeTool is mocked to prove
// the skip without running any real tool.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  executeTool: vi.fn(),
  config: { documents: {}, agent: {} } as any,
  embed: vi.fn(),
  cap: { available: false } as { available: boolean; error?: string },
  browserEnabled: true,
}));

vi.mock('../config/loader', () => ({ config: h.config }));
vi.mock('./permission-broker', () => ({ executeTool: h.executeTool }));
vi.mock('../memory/embedder', () => ({ embed: h.embed }));
vi.mock('../memory/capability', () => ({ getEmbeddingCapability: () => h.cap }));
vi.mock('./browser-config', () => ({ isBrowserEnabled: () => h.browserEnabled }));

import { detectIntent, intentToolNames, prefetchTools, extractNavUrl, evaluatePrefetchRelevance } from './intent-prefetch';

const CTX = { userTrustLevel: 5, maxModelTrustLevel: 5, modelLabel: 'm', agentName: 'A' } as any;

// ── detectIntent matches the new groups ──────────────────────

describe('detectIntent -- selection-only action groups', () => {
  it('matches browser on a click-the-link query (the observed failure case)', () => {
    expect(detectIntent('Open the website and click the entertainment link')).toContain('browser');
  });
  it('matches browser on navigate phrasing', () => {
    expect(detectIntent('navigate to the page and scroll down')).toContain('browser');
  });
  it('matches ssh on ssh phrasing', () => {
    expect(detectIntent('ssh into the box and check the logs')).toContain('ssh');
  });
  it('matches shell on local-command phrasing', () => {
    expect(detectIntent('run a command on the local host')).toContain('shell');
  });
});

// ── intentToolNames surfaces the right tools ─────────────────

describe('intentToolNames -- action group tool mapping', () => {
  it('browser surfaces both browser tools into the recall net', () => {
    expect(intentToolNames(['browser'])).toEqual(['browser', 'browser_act']);
  });
  it('ssh surfaces ssh_exec', () => {
    expect(intentToolNames(['ssh'])).toEqual(['ssh_exec']);
  });
  it('shell surfaces shell_exec', () => {
    expect(intentToolNames(['shell'])).toEqual(['shell_exec']);
  });
});

// ── web demotion handles the browse/web collision for free ───

describe('web demotion -- an explicit browse verb beats a generic web keyword', () => {
  it('drops web when the browser group also matches', () => {
    // 'pull up' is a web keyword; 'website' + 'click the' are browser.
    const matched = detectIntent('pull up the website and click the login button');
    expect(matched).toContain('browser');
    expect(matched).not.toContain('web');
  });
});

// ── prefetchTools never executes a selection-only group ──────

describe('prefetchTools -- selectionOnly groups are not executed', () => {
  beforeEach(() => h.executeTool.mockReset());

  it('skips a browser-only turn entirely (no execution, empty results)', async () => {
    const results = await prefetchTools(['browser'], CTX, 'click the link');
    expect(h.executeTool).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('executes a co-matched data group while skipping the selection-only one', async () => {
    h.executeTool.mockResolvedValue({ error: false, output: 'DATA', sources: [] });
    const results = await prefetchTools(['ssh', 'weather'], CTX, 'how is the weather');
    // ssh (selectionOnly) skipped; weather (data group) executed exactly once.
    expect(h.executeTool).toHaveBeenCalledTimes(1);
    expect(h.executeTool.mock.calls[0][0].name).toBe('weather');
    expect(results.map(r => r.toolName)).toEqual(['weather']);
  });
});

// ── nav-gate: bare domains, hard-intent demotion, guards (v0.11.x) ──
//
// The nav-gate gets the browser group onto a bare-domain turn ("open
// kotaku.com") that matches no keyword, and lets an explicit navigation
// beat the data groups that collide via a service name in the domain
// (gmail/github/video). hasHardBrowseIntent is adjacency-gated, so a
// non-adjacent verb (the email guard) and a bare media URL (the video
// embed) do NOT trigger the demotion.

describe('detectIntent -- nav-gate matching', () => {
  it('matches browser on a bare domain with a browse verb (issue #1)', () => {
    expect(detectIntent('open kotaku.com')).toContain('browser');
  });
  it('matches browser on an explicit URL with a browse verb', () => {
    expect(detectIntent('go to https://kotaku.com/news')).toContain('browser');
  });
  it('matches browser on a bare pasted URL (recall net)', () => {
    expect(detectIntent('https://kotaku.com')).toContain('browser');
  });
});

describe('detectIntent -- nav-gate demotion (browser wins the turn)', () => {
  it('browser beats gmail on "open gmail.com" (issue #2)', () => {
    const matched = detectIntent('open gmail.com');
    expect(matched).toContain('browser');
    expect(matched).not.toContain('gmail');
  });
  it('browser beats video on "go to youtube.com"', () => {
    const matched = detectIntent('go to youtube.com');
    expect(matched).toContain('browser');
    expect(matched).not.toContain('video');
  });
  it('browser beats github on "open github.com"', () => {
    const matched = detectIntent('open github.com');
    expect(matched).toContain('browser');
    expect(matched).not.toContain('github');
  });
});

describe('detectIntent -- nav-gate guards (the demotion must NOT overreach)', () => {
  it('video keeps its embed turn on a bare media URL', () => {
    // 'play this' is a media-embed phrase, so the bare-URL signal is
    // suppressed (WEB_FETCH_OR_PLAY) and there is no browse verb -> no
    // hard intent -> video keeps its embed turn.
    const matched = detectIntent('play this https://youtu.be/dQw4w9WgXcQ');
    expect(matched).toContain('video');
    expect(matched).not.toContain('browser');
  });
  it('a non-adjacent verb does not steal the turn (email guard)', () => {
    const matched = detectIntent('open a ticket and email ben@gmail.com about it');
    expect(matched).not.toContain('browser');
    expect(matched).toContain('gmail');
  });
  it('"check my gmail" (no domain) still routes to gmail, not browser', () => {
    const matched = detectIntent('check my gmail');
    expect(matched).toContain('gmail');
    expect(matched).not.toContain('browser');
  });
  it('a filename is left to project (.xlsx is not a TLD)', () => {
    const matched = detectIntent('open the budget.xlsx');
    expect(matched).toContain('project');
    expect(matched).not.toContain('browser');
  });
});

// ── nav prefetch: extractNavUrl + browser navigate prefetch (v0.11.x) ──
//
// The browser group is selectionOnly for the recall net, but the L2 read
// tool's navigate action is a data source: on a hard "open <domain>" intent
// prefetchTools opens the page server-side so a weak model narrates it
// instead of failing to emit the tool_call. browser_act (L5) is NEVER
// prefetched. The result is relevanceExempt so the cosine gate can't bail it.

describe('extractNavUrl -- the URL/host to open', () => {
  it('returns the bare host on a verb+domain intent', () => {
    expect(extractNavUrl('open kotaku.com')).toBe('kotaku.com');
  });
  it('returns the full URL (path preserved) when one is present', () => {
    expect(extractNavUrl('go to https://kotaku.com/news/today')).toBe('https://kotaku.com/news/today');
  });
  it('returns null on a bare pasted URL with no browse verb', () => {
    expect(extractNavUrl('https://kotaku.com')).toBeNull();
  });
  it('returns null on a media-embed phrasing', () => {
    expect(extractNavUrl('play this https://youtu.be/dQw4w9WgXcQ')).toBeNull();
  });
  it('returns null when there is no navigation intent', () => {
    expect(extractNavUrl('check my gmail')).toBeNull();
  });
});

describe('prefetchTools -- browser navigate prefetch', () => {
  beforeEach(() => { h.executeTool.mockReset(); h.browserEnabled = true; });

  it('prefetches browser navigate on a hard "open <domain>" intent', async () => {
    h.executeTool.mockResolvedValue({ error: false, output: 'PAGE TEXT', sources: [{ label: 'Kotaku', url: 'https://kotaku.com' }] });
    const results = await prefetchTools(['browser'], CTX, 'open kotaku.com');
    expect(h.executeTool).toHaveBeenCalledTimes(1);
    const call = h.executeTool.mock.calls[0][0];
    expect(call.name).toBe('browser');
    expect(call.args).toEqual({ action: 'navigate', url: 'kotaku.com' });
    expect(results).toHaveLength(1);
    expect(results[0].toolName).toBe('browser');
    expect(results[0].available).toBe(true);
    expect(results[0].relevanceExempt).toBe(true);
  });

  it('never prefetches browser_act (L5), only the read tool', async () => {
    h.executeTool.mockResolvedValue({ error: false, output: 'PAGE TEXT', sources: [] });
    await prefetchTools(['browser'], CTX, 'open gmail.com');
    expect(h.executeTool).toHaveBeenCalledTimes(1);
    expect(h.executeTool.mock.calls.every(c => c[0].name !== 'browser_act')).toBe(true);
  });

  it('does NOT navigate-prefetch without a hard nav signal', async () => {
    const results = await prefetchTools(['browser'], CTX, 'click the login button');
    expect(h.executeTool).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('skips the navigate prefetch when the browser module is disabled (dormancy)', async () => {
    h.browserEnabled = false;
    const results = await prefetchTools(['browser'], CTX, 'open kotaku.com');
    expect(h.executeTool).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});

describe('evaluatePrefetchRelevance -- exempt tools bypass the cosine gate', () => {
  it('scores a relevanceExempt result as fully relevant without embedding it', async () => {
    h.cap = { available: true };
    h.embed.mockReset();
    const judgment = await evaluatePrefetchRelevance('open kotaku.com', [
      { toolName: 'browser', groupName: 'browser', data: 'PAGE TEXT', available: true, relevanceExempt: true },
    ] as any);
    expect(judgment.relevant).toBe(true);
    expect(judgment.maxSimilarity).toBe(1);
    // The user message is embedded once; the exempt tool's data is NOT.
    expect(h.embed).toHaveBeenCalledTimes(1);
    h.cap = { available: false };
  });
});
