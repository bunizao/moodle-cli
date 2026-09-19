import { createUi } from "@bunizao/cli-kit";
import { UsageError } from "../errors.js";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findExecutable, type SelfCommand } from "./self-command.js";
import type { DeploymentCommandRunner } from "./deployment/node-adapters.js";
import { WRANGLER_VERSION } from "../constants.js";

export async function resolveWrangler(runner: DeploymentCommandRunner, options: { homeDir?: string; env?: NodeJS.ProcessEnv; yes?: boolean; notice?: (text: string) => void } = {}): Promise<SelfCommand> {
  const env = options.env ?? process.env;
  const notice = options.notice ?? (text => process.stderr.write(`${text}\n`));
  const existing = findExecutable("wrangler", env);
  if (existing) {
    // A PATH Wrangler is only trusted when it is the pinned major line; the Worker
    // config and the deployment receipts are written against that.
    const version = await runner.run(existing, ["--version"]).then(result => result.stdout.match(/\d+\.\d+\.\d+/u)?.[0], () => undefined);
    if (version && sameMajorAtLeast(version, WRANGLER_VERSION)) return { command: existing, args: [] };
    notice(`Ignoring ${existing} (${version ?? "unknown version"}); Cloudflare management needs Wrangler ${WRANGLER_VERSION.split(".")[0]}.x.`);
  }
  const root = join(options.homeDir ?? homedir(), ".config", "moodle-cli", "tools", `wrangler@${WRANGLER_VERSION}`);
  const script = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  const bun = findExecutable("bun", env);
  const node = findExecutable("node", env);
  if (!bun && !node) throw new Error("Cloudflare management needs Bun or Node 22.13+. Install either, then retry moodle mcp deploy.");
  if (!existsSync(script)) {
    const npm = findExecutable("npm", env);
    if (!bun && !npm) throw new Error("Install Bun or npm to download the pinned Cloudflare toolchain.");
    const yes = options.yes ?? (process.argv.includes("--yes") || process.argv.includes("-y"));
    if (!yes) {
      const ui = createUi({ input: process.stdin, output: process.stderr });
      if (!ui.interactive) throw new UsageError("Cloudflare management needs a first-use Wrangler download.", "Rerun with --yes to download and cache the pinned toolchain.");
      if (!await ui.confirm(`Download Cloudflare Wrangler ${WRANGLER_VERSION} (cached for next time)?`, { initial: true })) {
        throw new UsageError("Wrangler download cancelled.", "Retry when ready to install Cloudflare's toolchain.");
      }
    }
    notice(`Cloudflare management needs Wrangler ${WRANGLER_VERSION}; downloading once to ${root}.`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await runner.run(bun ?? npm!, bun
      ? ["install", "--cwd", root, "--no-save", `wrangler@${WRANGLER_VERSION}`]
      : ["install", "--prefix", root, "--no-save", "--package-lock=false", "--no-audit", "--no-fund", `wrangler@${WRANGLER_VERSION}`]);
    if (!existsSync(script)) throw new Error("Wrangler installation did not create the expected executable. Retry moodle mcp deploy.");
  }
  // Wrangler is tested by Cloudflare on Node; Bun only runs it when Node is absent.
  return { command: node ?? bun!, args: [script] };
}

function sameMajorAtLeast(actual: string, pinned: string): boolean {
  const [aMajor, aMinor = 0, aPatch = 0] = actual.split(".").map(Number);
  const [pMajor, pMinor = 0, pPatch = 0] = pinned.split(".").map(Number);
  return aMajor === pMajor && (aMinor > pMinor || (aMinor === pMinor && aPatch >= pPatch));
}
