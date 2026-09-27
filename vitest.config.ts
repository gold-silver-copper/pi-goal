import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/support/vitest.global-setup.ts"],
    setupFiles: ["./test/support/vitest.setup.ts"],
    pool: "forks",
    testTimeout: 5_000,
  },
});
