// ============================================================
// src/server/boot-id.ts — per-process server boot marker
// ============================================================
// A short, non-secret nonce minted ONCE per server process at
// module load. It is NOT a credential: it carries no auth weight
// and is safe to expose to the client (it rides in
// window.NERDALERT_CONFIG alongside other runtime values).
//
// Purpose: it lets the client distinguish "same server session"
// from "the server was restarted." The Render Window keys its
// localStorage pointer by this value (nerdalert:render:<bootId>),
// so a restart changes the id, the old key no longer matches, and
// the last-viewed artifact is forgotten — exactly the "wipe the
// view on restart" behavior, with zero server-side state to track.
//
// Minted at module load (the first import during boot), so every
// request within one process observes the same value and a fresh
// process observes a fresh one. No init call, no async, no I/O.
// ============================================================

import { randomUUID } from 'crypto';

const BOOT_ID = randomUUID();

/** The current process's boot id. Stable for the process lifetime. */
export function getBootId(): string {
  return BOOT_ID;
}
