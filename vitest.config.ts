// ============================================================
// vitest.config.ts
// ============================================================
// Test runner config for NerdAlert's self-checks.
//
// SCOPE: only *.test.ts files under src/. These are fast, no-network
// unit checks of pure functions (the security redaction pipeline today).
// They never boot the server, touch the keychain, or hit a model.
//
// ENVIRONMENT: 'node' — everything under test is server-side Node code;
// there is no DOM to emulate.
//
// Vitest transforms TS via esbuild, independent of tsconfig's
// "module": "commonjs" setting, so the CommonJS source modules import
// cleanly here without a separate build step. Type-checking of source
// stays with `npm run typecheck` (tsc --noEmit); *.test.ts files are
// excluded from tsconfig so they neither slow the build nor get emitted
// into dist/ (see tsconfig.json "exclude").
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
