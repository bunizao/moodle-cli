import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function buildStandalone(outfile, target, verifyAssetsDirectory) {
  const directory = await mkdtemp(join(tmpdir(), "moodle-entry-"));
  try {
    const entry = join(directory, "standalone.ts");
    await writeFile(entry, [
      `import worker from ${JSON.stringify(resolve("dist/worker/worker.js"))} with { type: "file" };`,
      `import recovery from ${JSON.stringify(resolve("dist/worker/recovery.js"))} with { type: "file" };`,
      `import { runCli } from ${JSON.stringify(resolve("src/cli.ts"))};`,
      `process.env.MOODLE_BUNDLED_WORKER = worker;`,
      `process.env.MOODLE_BUNDLED_RECOVERY = recovery;`,
      ...(verifyAssetsDirectory ? [
        `import { copyReleaseBundle } from ${JSON.stringify(resolve("src/mcp/deployment/node-adapters.ts"))};`,
        `await copyReleaseBundle(worker, ${JSON.stringify(join(verifyAssetsDirectory, "worker.js"))});`,
        `await copyReleaseBundle(recovery, ${JSON.stringify(join(verifyAssetsDirectory, "recovery.js"))});`,
      ] : []),
      `process.exitCode = await runCli();`,
    ].join("\n"));
    const result = await Bun.build({ entrypoints: [entry], compile: { outfile, ...(target ? { target } : {}) }, minify: false });
    if (!result.success) throw new Error(result.logs.join("\n"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (import.meta.main) await buildStandalone(process.argv[2], process.argv[3]);
