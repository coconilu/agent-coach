import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.test.mjs", "node_modules/**", "dist/**"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
