import { defineConfig, type Options } from "tsup";

const workerRuntime: Options = {
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  bundle: true,
  // Provided by the Workers runtime itself.
  external: ["cloudflare:workers"],
  clean: false,
  sourcemap: false,
  splitting: false,
  outExtension: () => ({ js: ".js" }),
};

export default defineConfig([
  // The standalone Worker the CLI deploys: one self-contained file per entry.
  {
    ...workerRuntime,
    entry: {
      worker: "src/worker/entry.ts",
      recovery: "src/worker/recovery.ts",
    },
    noExternal: ["node-html-parser", "zod", "@bunizao/cli-kit"],
    dts: false,
    outDir: "dist/worker",
  },
  // `moodle-cli/worker` for host Workers. Dependencies stay imports so the host's
  // bundler dedupes zod with its own copy.
  {
    ...workerRuntime,
    entry: { worker: "src/worker/library.ts" },
    // Declarations come from tsc (tsconfig.lib.json): tsup's dts step needs the
    // TypeScript JS API, which TypeScript 7 does not ship.
    dts: false,
    outDir: "dist/lib",
  },
]);
