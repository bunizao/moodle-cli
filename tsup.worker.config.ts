import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// The kit's package entry also loads Node-only modules (commander, yaml, prompts). The Worker only
// needs toolDescription, so point the entry at the one browser-safe module that has it.
const kitIntents = fileURLToPath(new URL("./node_modules/@bunizao/cli-kit/dist/intents.js", import.meta.url));

export default defineConfig({
  entry: {
    worker: "src/worker/entry.ts",
    recovery: "src/worker/recovery.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  bundle: true,
  esbuildOptions(options) {
    options.alias = { ...options.alias, "@bunizao/cli-kit": kitIntents };
  },
  noExternal: ["node-html-parser", "zod", "@bunizao/cli-kit"],
  clean: false,
  sourcemap: false,
  dts: false,
  splitting: false,
  outExtension: () => ({ js: ".js" }),
  outDir: "dist/worker",
});
