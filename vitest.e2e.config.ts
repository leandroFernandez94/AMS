import { defineConfig } from "vitest/config";

/**
 * Dedicated Vitest config for the E2E suite.
 *
 * Keeps its failure domain separate from the default `pnpm test` run:
 * `e2e/` is outside the root config's include glob, so CI never collects these
 * files. Aliases resolve workspace packages to their TypeScript source so the
 * suite runs without a prior build step.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ams/api": new URL("./packages/api/src/index.ts", import.meta.url).pathname,
      "@ams/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@ams/mcp": new URL("./packages/mcp/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
