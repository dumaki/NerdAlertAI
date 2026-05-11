// ============================================================
// src/reminders/index.ts
// ============================================================
// Public interface of the reminders module.
// server/index.ts and tools/builtin/reminders-tool.ts both import
// only from here — never from the internal files directly. Keeps
// the module boundary clean and lets the internals be reshaped
// without anything outside the folder needing to change.
// ============================================================

export { startReminders, stopReminders } from './engine';
export {
  createReminder,
  getReminder,
  getPendingReminders,
  cancelReminder,
} from './store';
export type { Reminder } from './store';
