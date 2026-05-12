// ============================================================
// src/server/memory-routes.ts
// ============================================================
// HTTP surface for the memory module's semantic sub-module.
//
// Routes (gated on config.memory.semantic existence + enabled flag):
//   GET /api/memory/embedding-capability — returns the capability descriptor
//                                          (available, enabled, modelPath,
//                                          modelId, dimensions, blendWeight,
//                                          error?).
//
// Why this exists:
//   The capability endpoint is the contract between the server and any UI
//   that wants to know "is semantic memory live?" without making a search
//   call. It mirrors the Voice module's capability pattern (spec §18,
//   Pattern 25) — same return shape, same isolation contract.
//
// Why this file mounts unconditionally:
//   Unlike voice-routes.ts (which only mounts when voice.enabled is true),
//   the memory capability endpoint mounts always. The semantic block being
//   absent or disabled is INFORMATION the capability endpoint reports — it's
//   not a reason to refuse to answer the question. A client asking "is
//   semantic ready?" should always get { available: false, error: '...' }
//   rather than a 404 that looks like the server is broken.
//
//   Compare to voice's TTS route: that's an ACTION (synthesize speech). An
//   action endpoint should 404 when the feature is off — there's nothing
//   to do. A capability endpoint is a QUERY, and queries always have
//   answers, even if the answer is "no."
// ============================================================

import type { Express, Request, Response } from 'express'
import { getEmbeddingCapability, logEmbeddingCapability } from '../memory/capability'

// ---- ROUTE MOUNT -----------------------------------------------
/**
 * Register memory routes on the Express app. Called from server/index.ts
 * at boot, after auth middleware is mounted.
 *
 * Currently mounts only the embedding-capability endpoint. Future routes
 * (e.g. POST /api/memory/search for direct search surface, or
 * GET /api/memory/health for index stats) land here too.
 */
export function mountMemoryRoutes(app: Express): void {
  app.get('/api/memory/embedding-capability', (_req: Request, res: Response) => {
    // Capability check is synchronous and cheap — a handful of fs.statSync
    // calls. No need to memoize: the check runs once per HTTP request and
    // a UI polling this endpoint at refresh rates we'd expect (seconds,
    // not milliseconds) won't notice the work.
    //
    // We also re-run on every request because the capability state CAN
    // change at runtime: a user could drop the model files into place
    // without restarting the server, and the next request should reflect
    // that the gun is now loaded.
    const cap = getEmbeddingCapability()
    res.json(cap)
  })
}

// ---- BOOT HOOK -------------------------------------------------
/**
 * Emit a single line at boot describing semantic-memory capability state.
 * Called from server/index.ts after mountMemoryRoutes(). Separate function
 * (rather than inlining inside mountMemoryRoutes) so the boot log only
 * fires once per process, not once per route registration.
 *
 * Matches the [voice] STT/TTS mount logs in voice-routes.ts for visual
 * consistency in the server banner.
 */
export function logMemoryBootCapability(): void {
  const cap = getEmbeddingCapability()
  logEmbeddingCapability(cap)
}
