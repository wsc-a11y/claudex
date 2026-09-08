import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Each test file gets its own tmp state dir; see tests/helpers.
    pool: "threads",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      exclude: ["src/bin/**", "src/index.ts"],
    },
  },
});
