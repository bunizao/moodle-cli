import { defineConfig } from "tsup";

// `moodle-cli/core`: dependencies stay external so the host bundles one copy of each.
// Types come from tsconfig.core.json; tsup's own dts step does not run on TypeScript 7.
export default defineConfig({
  entry: { core: "src/core.ts" },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  bundle: true,
  clean: false,
  sourcemap: false,
  dts: false,
  splitting: false,
  outExtension: () => ({ js: ".js" }),
  outDir: "dist/core",
});
