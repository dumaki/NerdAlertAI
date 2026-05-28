// ============================================================
// src/tools/builtin/cron-delete-tool.ts  — v0.8 L2 arc: cron delete (L3)
// ============================================================
// The dangerous-write half of the cron split. `delete` used to live in
// cron-manager.ts at a per-action L2 gate alongside create/pause/resume.
// It now lives here as its own tool at a compiled L3 floor, so the
// permission-broker AND the per-model trust ceiling enforce it natively
// — getModelVisibleTools() hides it from a capped model, which never
// even sees it.
//
// Why split: `delete` is the only one of the four cron writes that's
// irreversible. `create` is recoverable via `delete`; `pause` and
// `resume` are trivially inverse. `delete` drops a job AND its entire
// run history — the cron analogue of `gmail_send` (one-way action).
// Same rationale as the gmail send/cleanup split.
//
// Trust: L3 (compiled floor). At global trust L1/L2 this tool is
// filtered out of getAvailableTools() entirely — dormant until an
// operator deliberately raises global trust to 3. Strict-superset:
// not registering this tool, or disabling it in config, leaves the
// cron UX byte-identical to the pre-split version (the model still
// has create/pause/resume/list/status/logs via cron_manager).
//
// Approval pattern (wrapper-level, not engine):
//   Unlike gmail_send (where sendDraft self-enforces approved:true),
//   deleteJob() in cron/store is a simple DELETE — no two-step baked
//   in. Cleaner to put the approval in the wrapper. First call without
//   approved:true returns a summary of what would be deleted (job
//   name, schedule, recent runs). Second call with approved:true
//   actually calls deleteJob. Same structural shape as the gmail
//   send/cleanup approval — only the location of the gate differs
//   (wrapper vs engine).
//
// Anti-recursion: IS_CRON_CONTEXT blocks this tool during scheduled
// job execution, exactly as cron_manager does. A scheduled job must
// not be able to delete other jobs (or itself).
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { getJob, deleteJob, getRecentRuns } from '../../cron/store';
import { IS_CRON_CONTEXT } from '../../cron/runner';

// ── Response helpers ──────────────────────────────────────────
// Local copies (cron-manager.ts keeps its own private pair). Kept
// inline rather than exported/shared so this L3 tool has no compile-
// time coupling to the L1 tool beyond the engine functions it wraps.

function ok(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function err(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

const cronDeleteTool: NerdAlertTool = {
  name:        'cron_delete',
  description: `Permanently delete a scheduled job AND its entire run history. This is irreversible — the job stops firing and the history is gone. Use this ONLY when the user explicitly asks to permanently remove a scheduled job; for pausing (reversible) use cron_manager with action "pause" instead. Requires approved:true, which you set only after the user has explicitly confirmed the deletion in chat. The first call without approved:true returns a summary of what would be deleted and changes nothing; the second call with approved:true actually deletes. Requires: job_id. Use cron_manager action "list" first if you don't know the job_id.`,

  trustLevel: 3,

  parameters: {
    type: 'object',
    properties: {
      job_id: {
        type:        'string',
        description: 'The ID of the scheduled job to delete. Use cron_manager action "list" to find it.',
      },
      approved: {
        type:        'boolean',
        description: 'Must be true to actually delete the job and its history. Set only after explicit user confirmation in chat. The first call without approved returns a summary and changes nothing.',
      },
    },
    required: ['job_id'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {

    // ── Anti-recursion gate ─────────────────────────────────
    // Mirror cron-manager.ts: scheduled jobs must not be able to
    // delete other jobs (or themselves) mid-fire. Same posture, same
    // wording — different tool, identical blast-radius concern.
    if (IS_CRON_CONTEXT) {
      return err(
        'Cron management is disabled during scheduled job execution. ' +
        'Scheduled jobs cannot delete other scheduled jobs.'
      );
    }

    const job_id = params.job_id as string;
    if (!job_id) {
      return err('cron_delete requires job_id. Use cron_manager action "list" to find it.');
    }

    const job = getJob(job_id);
    if (!job) {
      return err(`No job found with ID "${job_id}".`);
    }

    // ── Build the summary of what would be deleted ─────────────
    // The summary is what the user sees on the first (un-approved) call
    // — it makes the destructive action CONCRETE so the user knows
    // exactly what they're losing. Mirrors cron-manager status's
    // section ordering (status → schedule → runs) so the model sees a
    // familiar shape when narrating it back.
    const runs = getRecentRuns(job_id, 3);
    const status = job.enabled ? '🟢 active' : '⏸️  paused';

    let runsSection: string;
    if (runs.length === 0) {
      runsSection = `  Recent runs: (no run history)`;
    } else {
      const lines = runs.map((r: any) => {
        const icon = r.status === 'success' ? '✅' : r.status === 'missed' ? '⏭️' : '❌';
        const t    = new Date(r.fired_at).toLocaleString('en-US', { timeZone: job.timezone });
        return `    ${icon} ${t}`;
      }).join('\n');
      runsSection = `  Recent runs (last ${runs.length}):\n${lines}`;
    }

    const summary = [
      `About to permanently delete:`,
      `  ${status} — "${job.name}" (${job_id})`,
      `  Schedule: ${job.expression} (${job.timezone})`,
      runsSection,
      ``,
      `⚠️  This cannot be undone — the job stops firing and the entire run history is removed.`,
    ].join('\n');

    // ── Approval gate ─────────────────────────────────────────
    // First call (no approved): summarize, change nothing.
    // Second call (approved:true): apply.
    if (params.approved !== true) {
      return ok(
        `${summary}\n\nNothing has been deleted yet. Re-call cron_delete with approved:true to permanently remove this job and its history.`
      );
    }

    // ── Apply ───────────────────────────────────────────────────
    // deleteJob handles the actual DELETE across the jobs row and its
    // run-history rows in one transaction; the same engine function
    // cron_manager.delete used to call.
    deleteJob(job_id);
    return ok(
      `Job "${job.name}" (${job_id}) deleted permanently, including all run history.`
    );
  },
};

export default cronDeleteTool;
