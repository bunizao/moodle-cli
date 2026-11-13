import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    restoreMocks: true,
    include: ["tests/**/*.test.ts"],
    // A first in-process CLI run on a Windows runner can take several seconds to import.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
});
