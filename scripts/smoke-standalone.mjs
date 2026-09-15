import { buildStandalone } from "./build-standalone.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "moodle-cli-standalone-"));
const executable = join(temporaryDirectory, process.platform === "win32" ? "moodle.exe" : "moodle");

try {
  await buildStandalone(executable, undefined, temporaryDirectory);

  const run = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout);
    process.exit(run.status ?? 1);
  }
  if (run.stdout.trim() !== version) {
    throw new Error(`Standalone CLI reported ${JSON.stringify(run.stdout.trim())}; expected ${version}`);
  }

  for (const bundle of ["worker.js", "recovery.js"]) if (readFileSync(join(temporaryDirectory, bundle)).length < 1000) throw new Error(`Missing embedded ${bundle}`);
  const home = join(temporaryDirectory, "home");
  mkdirSync(home);
  writeFileSync(join(home, "config.yaml"), "base_url: https://moodle.example.edu\n");
  const status = spawnSync(executable, ["mcp", "status", "--json"], { encoding: "utf8", env: { ...process.env, HOME: home, MOODLE_BASE_URL: "https://moodle.example.edu", MOODLE_CONFIG: join(home, "config.yaml") } });
  if (status.status !== 0) throw new Error(`Standalone status failed: ${status.stderr}`);
  if (!JSON.parse(status.stdout).profile) throw new Error("Standalone status did not return a managed profile.");
  if (/packaged Wrangler|MODULE_NOT_FOUND|ENOENT.*worker/u.test(status.stderr)) throw new Error(status.stderr);
  const completion = spawnSync(executable, ["completion", "bash"], { encoding: "utf8" });
  if (completion.status !== 0 || !completion.stdout.includes("complete -W")) throw new Error("Standalone completion failed.");
  console.log(`Standalone CLI smoke passed: ${version}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
