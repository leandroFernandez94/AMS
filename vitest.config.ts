import { defineConfig } from "vitest/config";

/**
 * Resolve intra-workspace packages to their TypeScript source so tests run
 * without a prior build step. Cross-package imports (e.g. @ams/shared) are
 * type-checked via tsconfig project references during `pnpm typecheck`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ams/api": new URL("./packages/api/src/index.ts", import.meta.url).pathname,
      "@ams/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/**/*.{test,spec}.ts"],
    environment: "node",
  },
});
