/**
 * Vite config for the renderer + the Vitest settings for the whole project.
 *
 * ── Renderer ────────────────────────────────────────────────────────────────
 * The renderer never talks to the game directly: in development Vite proxies
 * `/api` and `/ws` to the Express/WS host on 3001, so the browser sees a single
 * origin and the WebSocket URL can stay relative (`ws://<host>/ws`).
 *
 * `vitest` also reads this file, so the `test` block replaces a separate
 * `vitest.config.ts`.
 *
 * ── Harness tmp dir ─────────────────────────────────────────────────────────
 * Vitest's SSR module runner extracts transformed modules into a temp directory
 * derived from the OS temp dir. On a locked-down Windows install (or inside a
 * file-system sandbox) that directory can be unwritable, and the failure mode is
 * nasty: `EPERM` shows up as an *unhandled error* while one or two test files
 * silently fail to be collected, so the run looks green with fewer tests than
 * expected. Pinning the temp dir inside the project makes the suite hermetic and
 * machine-independent.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

// Anchor every temp write Vitest/Vite performs to a writable in-project path.
// Must happen before the worker pool is created, hence at config-load time.
const harnessTmp = resolve(process.cwd(), 'node_modules', '.cache', 'harness-tmp');
mkdirSync(harnessTmp, { recursive: true });
process.env.TMPDIR = harnessTmp;
process.env.TMP = harnessTmp;
process.env.TEMP = harnessTmp;

export default defineConfig(({ mode }) => {
  // Read `.env` explicitly: `loadEnv` with an empty prefix returns every key, so
  // `PORT` / `VITE_PORT` in `.env` actually reach this config. (Vite only injects
  // `VITE_`-prefixed values into `process.env` on its own, which would silently
  // ignore the documented names.)
  const env = loadEnv(mode, process.cwd(), '');
  const serverPort = Number(env.PORT ?? process.env.PORT ?? 3001);
  const webPort = Number(env.VITE_PORT ?? process.env.VITE_PORT ?? 5173);

  return {
    root: '.',
    // The renderer entry lives at index.html; the server code is never bundled.
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
      target: 'es2022',
    },
    // Keep Vite's own cache in-project too (same reason as the tmp dir above).
    cacheDir: 'node_modules/.cache/vite',
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `ws://localhost:${serverPort}`,
          ws: true,
        },
      },
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      testTimeout: 20_000,
      // Server/renderer modules are imported from `src/` directly; no DOM needed
      // except for the pure renderer helpers, which are written DOM-free.
      exclude: ['node_modules/**', 'dist/**'],
      // A green run must mean every file ran: fail if one silently failed to load.
      allowOnly: false,
      passWithNoTests: false,
    },
  };
});
