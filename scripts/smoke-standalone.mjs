import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "moodle-cli-standalone-"));
const executable = join(temporaryDirectory, process.platform === "win32" ? "moodle.exe" : "moodle");

try {
  const build = spawnSync("bun", ["build", resolve("src/cli.ts"), "--compile", "--outfile", executable], {
    encoding: "utf8",
  });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout);
    process.exit(build.status ?? 1);
  }

  const run = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout);
    process.exit(run.status ?? 1);
  }
  if (run.stdout.trim() !== version) {
    throw new Error(`Standalone CLI reported ${JSON.stringify(run.stdout.trim())}; expected ${version}`);
  }

  console.log(`Standalone CLI smoke passed: ${version}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
