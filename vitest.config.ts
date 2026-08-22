import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Component tests are .tsx. Leaving them out of the pattern is a silent
    // way to have tests that never run.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 30_000,
  },
});
