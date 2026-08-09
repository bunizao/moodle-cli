import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    worker: "src/worker/entry.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  bundle: true,
  clean: false,
  sourcemap: false,
  dts: false,
  splitting: false,
  outExtension: () => ({ js: ".js" }),
  outDir: "dist/worker",
});
