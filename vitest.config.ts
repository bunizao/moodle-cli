import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./tests/support/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    restoreMocks: true,
    include: ["tests/**/*.test.ts"],
  },
});
