// src/security/safe-console.ts
// ─────────────────────────────────────────────────────────────────────────────
// Wraps the global console.{log,info,warn,error,debug} methods so every
// argument formatted into the output stream first passes through redact().
//
// This is the OUTPUT-boundary half of the persistence-scrubbing pair the
// v0.5.3 spec called out:
//   • secret-scanner.ts runs at chat ingress (halts critical/high pre-model)
//   • memory engine capture() applies redact() before write              ← v0.5.25
//   • THIS file applies redact() before anything reaches stdout/stderr   ← v0.5.25
//
// The wrapper is bulletproof — if util.format() or redact() ever throws on
// weird input, we fall through rather than crashing the caller. Logging is
// never allowed to break the server.
//
// Install once at server boot, before any other top-level statement runs.
// Re-installation is idempotent (subsequent calls are no-ops).
// ─────────────────────────────────────────────────────────────────────────────

import { format } from 'util';
import { redact } from './secret-scanner';

// Holds the unwrapped references so restoreConsole() can put them back. Also
// acts as the "already installed?" sentinel (non-null = installed).
interface OriginalConsole {
  log:   typeof console.log;
  info:  typeof console.info;
  warn:  typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
}

let original: OriginalConsole | null = null;

/**
 * Format console arguments the way Node would (via util.format), then redact
 * any secrets present in the resulting string.
 *
 * Exported separately from installConsoleRedaction() so unit tests can exercise
 * the format-and-redact step without monkey-patching the global console object.
 *
 * Defensive on weird input: if format() or redact() throws for any reason,
 * falls back to a plain String() join. The wrapper must never throw at a
 * caller — a crash in the log path would break the whole server.
 */
export function redactConsoleArgs(...args: unknown[]): string {
  try {
    return redact(format(...args));
  } catch {
    try {
      return args.map((a) => String(a)).join(' ');
    } catch {
      // Final safety net — even String() can throw on exotic objects with
      // poisoned Symbol.toPrimitive. Return a fixed marker rather than die.
      return '[console-format-error]';
    }
  }
}

/**
 * Replace the global console methods with redacting versions.
 *
 * Idempotent — calling twice has no additional effect. Useful for ts-node
 * dev mode where module state can sometimes be reset on hot reload.
 *
 * The wrapped methods collapse all arguments into a single pre-formatted
 * string before calling the original. This matches what Node would have
 * rendered to a non-TTY stream anyway (file/pipe/journal), but does mean
 * interactive terminals lose the ability to expand objects inline. For a
 * server process logging to systemd/journal/file that's the desired shape.
 */
export function installConsoleRedaction(): void {
  if (original) return;

  original = {
    log:   console.log,
    info:  console.info,
    warn:  console.warn,
    error: console.error,
    debug: console.debug,
  };

  // Helper that takes the original method and returns a wrapped version.
  // The original is captured in closure so each wrapped method calls the
  // right underlying function (log → log, error → error, etc).
  const wrap = (orig: (...args: any[]) => void) => {
    return (...args: any[]) => {
      const scrubbed = redactConsoleArgs(...args);
      try {
        orig(scrubbed);
      } catch {
        // If even the underlying console method fails (extremely rare —
        // closed stdout, broken pipe to journal, etc.) swallow rather than
        // propagate. The whole point of this wrapper is to never crash the
        // caller.
      }
    };
  };

  console.log   = wrap(original.log);
  console.info  = wrap(original.info);
  console.warn  = wrap(original.warn);
  console.error = wrap(original.error);
  console.debug = wrap(original.debug);
}

/**
 * Restore the original console methods. Primarily for tests; production
 * code should not need this.
 */
export function restoreConsole(): void {
  if (!original) return;
  console.log   = original.log;
  console.info  = original.info;
  console.warn  = original.warn;
  console.error = original.error;
  console.debug = original.debug;
  original = null;
}
