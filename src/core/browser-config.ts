// ============================================================
// src/core/browser-config.ts
// ============================================================
// Operator config surface for the L5 browser-automation module.
//
// Reads config.browser and exposes the gate + the resolved profile directory,
// headless flag, navigation timeout, and blocked-scheme allow-list that the
// browser engine (core/browser-client.ts, next slice) and the browser tools
// will use. Self-gating: with the browser block absent or enabled:false, every
// export is inert and boot is byte-identical -- the module-isolation contract
// (P6). Same tool/engine/config split as ssh_exec and shell_exec.
//
// This file owns NO secrets and touches NO network. It only knows whether the
// module is on, which DEDICATED profile directory the browser uses, whether to
// run headed or headless, how long a navigation may take, and which URL schemes
// the engine must refuse. The dedicated profile (NOT the operator's primary
// browser) is the structural credential boundary: the agent starts with no
// logged-in sessions, so there is nothing here to leak. The engine creates the
// profile directory lazily on first use; this file never writes to disk.
// ============================================================

import * as os from 'os';
import * as path from 'path';
import { config } from '../config/loader';

const DEFAULT_TIMEOUT_SECONDS = 30;

// Default profile lives under ~/.nerdalert, beside voices/, embeddings/, etc.
// A dedicated directory keeps the agent's browser state walled off from the
// operator's real Chrome profile.
const DEFAULT_PROFILE_SUBDIR = path.join('.nerdalert', 'browser-profile');

// Schemes the engine refuses to navigate to. chrome:/about: reach the browser's
// own settings (including the password manager); file: reads the local disk;
// view-source: is a cheap exfil wrapper around the other two. Normalized to
// lowercase with a trailing ':' so matching is exact regardless of how the
// operator typed them in config.
const DEFAULT_BLOCKED_SCHEMES = ['chrome:', 'about:', 'file:', 'view-source:'];

// ── Gate ─────────────────────────────────────────────────────
export function isBrowserEnabled(): boolean {
  return config.browser?.enabled === true;
}

// ── Working profile directory ────────────────────────────────
// Expand a leading ~ to the home dir (same convenience shell.cwd / voices_dir
// give). Anything else is returned untouched.
function expandHome(p: string): string {
  if (p === '~')          return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// The dedicated profile directory the browser launches against. Resolves
// config.browser.profile_dir (~-expanded) when set and non-empty; otherwise
// ~/.nerdalert/browser-profile. Unlike shell.cwd, we do NOT stat-and-fallback
// here: the engine creates this directory on first launch (a fresh profile is
// the expected state), so a not-yet-existing path is normal, not an error.
export function getBrowserProfileDir(): string {
  const configured = config.browser?.profile_dir;
  if (typeof configured === 'string' && configured.trim()) {
    return expandHome(configured.trim());
  }
  return path.join(os.homedir(), DEFAULT_PROFILE_SUBDIR);
}

// ── Headless flag ────────────────────────────────────────────
// Default false: on a desktop (the Mac dev box) the operator wants to WATCH the
// agent drive a real, visible Chrome window. A headless host (the Optiplex, no
// display) must set headless: true in config or the launch will fail -- flagged
// in the boot log so the operator sees the setting at startup.
export function getBrowserHeadless(): boolean {
  return config.browser?.headless === true;
}

// ── Navigation timeout ───────────────────────────────────────
export function getBrowserNavTimeoutSeconds(): number {
  const t = config.browser?.navigation_timeout_seconds;
  return typeof t === 'number' && t > 0 ? t : DEFAULT_TIMEOUT_SECONDS;
}

// ── Blocked schemes ──────────────────────────────────────────
// Normalize one scheme token to lowercase with exactly one trailing ':'
// ('CHROME' -> 'chrome:', 'about:' -> 'about:'), so operator input and the
// extracted URL scheme compare cleanly.
function normalizeScheme(s: string): string {
  const lower = s.trim().toLowerCase();
  if (!lower) return '';
  return lower.endsWith(':') ? lower : `${lower}:`;
}

// The effective blocked-scheme list. Returns the operator's list (normalized)
// when configured and non-empty, otherwise the safe defaults. Defensive: an
// empty/garbage array falls back to defaults rather than disabling the guard.
export function getBlockedSchemes(): string[] {
  const configured = config.browser?.blocked_schemes;
  if (Array.isArray(configured)) {
    const cleaned = configured
      .filter((s): s is string => typeof s === 'string')
      .map(normalizeScheme)
      .filter(s => s.length > 0);
    if (cleaned.length > 0) return cleaned;
  }
  return [...DEFAULT_BLOCKED_SCHEMES];
}

// Extract a URL's scheme as a lowercase token with a trailing ':'
// ('chrome://settings/passwords' -> 'chrome:'). Returns '' when the input has
// no scheme prefix (e.g. a bare 'example.com'), which the caller treats as
// not-blocked here -- the engine resolves bare inputs to https before dialing.
function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return m ? `${m[1].toLowerCase()}:` : '';
}

// True when a URL's scheme is on the blocked list. The browser engine calls this
// before every navigation so the agent can never reach the browser's own
// settings, the local filesystem, or a view-source wrapper around them.
export function isSchemeBlocked(url: string): boolean {
  const scheme = schemeOf(url);
  if (!scheme) return false;
  return getBlockedSchemes().includes(scheme);
}

// ── Boot log ─────────────────────────────────────────────────
// One summary line with the resolved profile dir, headed/headless mode, the
// navigation timeout, and the blocked-scheme count. Self-gating: no output when
// the browser module is disabled, so a no-browser boot is byte-identical.
// Mirrors the logShellConfigAtBoot / logSshHostsAtBoot posture.
export function logBrowserConfigAtBoot(): void {
  if (!isBrowserEnabled()) return;
  const profileDir = getBrowserProfileDir();
  const mode       = getBrowserHeadless() ? 'headless' : 'headed';
  const timeout    = getBrowserNavTimeoutSeconds();
  const blocked    = getBlockedSchemes();
  console.log(
    `[browser] L5 browser-automation module enabled - profile=${profileDir}, ` +
    `mode=${mode}, nav_timeout=${timeout}s, blocked_schemes=${blocked.length} (${blocked.join(' ')})`,
  );
}
