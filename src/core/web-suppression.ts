// ============================================================
// src/core/web-suppression.ts
// ============================================================
// Mechanical enforcement that specialized tools own their lane.
// When a specialized tool succeeds inside an agent turn, the
// `web` tool gets intercepted and replaced with a synthetic
// "you already have an answer, don't stack web on top" result.
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// The v0.5.18.x patch arc (three iterations of progressively
// more specific prompt-layer guidance — tool descriptions,
// system-prompt tool-selection rules, explicit failing-pattern
// examples) converged on a hard ceiling for Mistral on the
// phrasings "What is X?" and "Who is X?". Those map to Google
// search-box syntax in Mistral's training data with enough
// signal to survive all three layers of prompt guidance.
//
// The architectural lesson from v0.5.18.3: prompt-layer
// guidance has a measurable ceiling against entrenched
// training-data priors in small models. The next layer must
// be mechanical, not advisory. This file is that mechanical
// layer.
//
// WHAT THIS IS NOT
// ─────────────────────────────────────────────────────────────
// - Not a permanent block on web. Web is fully callable when
//   no specialized tool has answered the turn.
// - Not a per-personality config. Every personality runs the
//   same suppression rules — picking the most specific tool
//   isn't a stylistic choice.
// - Not a core-loop change. The agent loop still runs every
//   tool call through the same permission broker. Suppression
//   lives in the adapter layer, gating the model's emitted
//   tool calls before they reach the broker.
//
// HOW EACH ADAPTER USES IT
// ─────────────────────────────────────────────────────────────
//   const tracker = new WebSuppressionTracker();
//
//   for each tool call the model emits in this turn:
//     if (tracker.shouldSuppress(call.name)) {
//       result = { output: tracker.buildSuppressedResult(call.name),
//                  error: false, sources: [] };
//       emit meta event
//     } else {
//       result = await executeTool(call, brokerContext);
//     }
//     tracker.recordResult(call.name, result.output, result.error);
//     emit tool_result event
//     push result into conversation history
//
// ============================================================

/**
 * Tools whose successful completion suppresses web for the rest
 * of the turn. These are informational tools — they ANSWER
 * questions. After any of them returns a real answer, web on
 * the same topic is redundant noise.
 *
 * Deliberately EXCLUDED:
 *   - `reminders`     — action tool (set / cancel), not Q&A
 *   - `cron_manager`  — action tool (write actions), not Q&A
 *
 * The exclusion is by design: a user asking "set a reminder to
 * read about CVE-2025-12345" should still be able to web-search
 * the CVE after the reminder is created. Treating reminders as
 * a suppression trigger would block that legitimate follow-up.
 *
 * Adding a new informational tool? Add it here. Keep this list
 * in sync with `personalities/base.ts` TOOL_BEHAVIOUR_RULES
 * "don't-stack-with-web" section.
 */
const SPECIALIZED_TOOLS: ReadonlySet<string> = new Set([
  // Core informational tools (the original v0.5.18.3 list)
  'calculate',
  'wikipedia',
  'weather',
  'get_datetime',
  'host_metrics',
  'gmail',
  'memory',

  // Added post-v0.5.18.3 — informational tools that landed
  // in v0.5.20 / v0.5.21
  'maps',
  'currency',
  'project',

  // SOC tools — every one of them is a status / inspection
  // query against a specific service. "Did pfSense block X" is
  // not a question for DuckDuckGo.
  'pihole_summary',          'pihole_top_blocked',
  'wazuh_get_alerts',        'wazuh_alert_summary',
  'crowdsec_decisions',      'crowdsec_alerts',
  'pfsense_gateway_status',  'pfsense_system_info',
  'fail2ban_status',         'fail2ban_recent_bans',
  'ntopng_interface_stats',  'ntopng_top_hosts',
  'nmap_quick_scan',         'nmap_ping_sweep',
  'loki_service_logs',
  'influxdb_host_overview',
]);

/**
 * Tool names that get intercepted when a specialized tool has
 * already succeeded this turn. Today just `web`. Future
 * candidates (none planned) would slot in here without any
 * adapter-side code changes.
 */
const SUPPRESSION_TARGETS: ReadonlySet<string> = new Set(['web']);

/**
 * Patterns in a tool's output that mean "I didn't actually
 * answer the question." These get filtered out before a tool
 * counts as having succeeded — otherwise wikipedia returning
 * a disambiguation page would falsely suppress web on a query
 * where web could legitimately help.
 *
 * Currently just the wikipedia disambiguation marker. Other
 * tools that have similar "didn't answer" surfaces should
 * extend this map.
 */
const NON_ANSWER_PATTERNS: Record<string, RegExp[]> = {
  wikipedia: [
    /is a disambiguation page on Wikipedia/i,
  ],
};


// ── WebSuppressionTracker ────────────────────────────────────
//
// Turn-scoped state. Each adapter creates one at the start of
// a turn and discards it when the turn ends. Tracking is
// in-memory only — there is no persistence, and there should
// not be: a fresh turn always starts with web available.

export class WebSuppressionTracker {

  /** Names of specialized tools that have produced real answers this turn. */
  private succeededTools: Set<string> = new Set();

  /**
   * Record the result of a tool execution. Adds the tool name to
   * the succeeded set only if:
   *   (1) the tool is in SPECIALIZED_TOOLS,
   *   (2) the call did NOT report an error,
   *   (3) the output has non-empty content,
   *   (4) the output doesn't match a known "didn't answer" pattern.
   *
   * Safe to call for every tool result regardless of whether the
   * tool is a suppression candidate — non-specialized tools
   * simply no-op here.
   */
  recordResult(toolName: string, output: string, hadError: boolean): void {
    if (hadError) return;
    if (!SPECIALIZED_TOOLS.has(toolName)) return;
    if (!output || !output.trim()) return;

    const nonAnswerPatterns = NON_ANSWER_PATTERNS[toolName];
    if (nonAnswerPatterns) {
      for (const pattern of nonAnswerPatterns) {
        if (pattern.test(output)) return;
      }
    }

    this.succeededTools.add(toolName);
  }

  /**
   * Should this tool call be intercepted?
   *
   * True iff the call is to a suppression target (today: web)
   * AND at least one specialized tool has already succeeded
   * this turn. Otherwise the tool runs normally.
   */
  shouldSuppress(toolName: string): boolean {
    if (!SUPPRESSION_TARGETS.has(toolName)) return false;
    return this.succeededTools.size > 0;
  }

  /**
   * Build the synthetic tool result text injected when a call
   * is suppressed. The message identifies which specialized
   * tool(s) already answered so the model knows what to refer
   * back to in its final response.
   *
   * The wording is deliberate: "Use that result to answer the
   * user directly" steers the model toward narrating the
   * existing data rather than re-attempting. The follow-up
   * carve-out ("on a future turn") preserves legitimate web
   * use for distinct topics in subsequent conversation turns.
   */
  buildSuppressedResult(targetName: string): string {
    const succeeded = Array.from(this.succeededTools);
    const list = formatToolList(succeeded);

    return (
      `${targetName} is suppressed for this turn — you have already received ` +
      `an authoritative answer from \`${list}\`. Use that result to answer ` +
      `the user directly. Do NOT call ${targetName} on top of a specialized ` +
      `tool answer; the user's question is already covered.\n\n` +
      `If the user asks a follow-up that genuinely needs web search (recent ` +
      `news, current events, a specific URL), call ${targetName} on a future ` +
      `turn after the user's next message.`
    );
  }

  /**
   * Names of specialized tools that have succeeded this turn.
   * Exposed for observability — the adapter emits this as part
   * of the meta event when a suppression fires.
   */
  succeededList(): string[] {
    return Array.from(this.succeededTools);
  }
}


/**
 * Format a list of tool names for inclusion in the suppression
 * message. One name → "calculate". Two → "calculate and wikipedia".
 * Three+ → "calculate, wikipedia, and weather". Mirrors English
 * list conventions so the model's output reads naturally if it
 * paraphrases the suppression message.
 */
function formatToolList(names: string[]): string {
  if (names.length === 0) return '(none)';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const head = names.slice(0, -1).join(', ');
  const tail = names[names.length - 1];
  return `${head}, and ${tail}`;
}


// ── Exports for adapter consumers and tests ──────────────────
//
// The constants are exported read-only so test scaffolding (if
// it lands later) can verify membership without rebuilding the
// suppression rules.

export {
  SPECIALIZED_TOOLS,
  SUPPRESSION_TARGETS,
  NON_ANSWER_PATTERNS,
};
