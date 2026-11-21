import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { appIdDefine } from 'deepspace/build'

const appDir = fileURLToPath(new URL('.', import.meta.url))

// Dedicated Vitest config, intentionally standalone (Vitest prefers this file
// over vite.config.ts, so the app build config is never loaded for unit tests).
//
// Two reasons it exists:
//   1. vite.config.ts is built for the Cloudflare Worker / rolldown-vite
//      toolchain (@cloudflare/vite-plugin, generouted, vite-plugin-checker).
//      Vitest cannot load those plugins, and they are irrelevant to unit tests.
//   2. Vitest's default `include` would sweep up the Playwright specs in
//      tests/*.spec.ts and fail. Explicit unit-test paths keep the runners
//      separate; Playwright runs via `npm test` / tests/playwright.config.ts.
//
// Unit tests live next to their source. The Node-only prerender test stays at
// the root so it does not enter the browser/Worker TypeScript project in src/.
export default defineConfig({
  // Same app id the bundle is built with, from the same wrangler config —
  // so a unit test importing src/constants.ts sees what the browser will.
  define: appIdDefine({ appDir }),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Unit tests only; tests/*.spec.ts are Playwright suites run separately.
    include: ['prerender.test.ts', 'src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    // The default 'threads'/'forks' pools spawn real OS worker threads or
    // child processes to isolate each test file. In this sandboxed dev
    // container that isolation silently breaks: the worker never receives
    // its init message, so `describe()` runs with no runner context and
    // throws "Cannot read properties of undefined (reading 'config')" (or,
    // on some vitest versions, silently registers zero tests). `vmThreads`
    // isolates each file in a V8 vm context inside the *same* thread
    // instead of a separate OS thread/process, which sidesteps whatever is
    // broken here. See docs/DEBUGGING_LOG.md ("Vitest unit-test runner")
    // for the full investigation — this is a sandbox-specific workaround,
    // not a vitest bug fix, and may not be needed on a normal machine.
    pool: 'vmThreads',
  },
})
