// Node half of the update check: a once-a-day cache under the config directory,
// a startup notice on stderr, and the package-manager commands `moodle update` runs.

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "./constants.js";
import { findExecutable, selfCommand, type SelfCommand } from "./mcp/self-command.js";
import { fetchLatestVersion, GITHUB_RELEASES_URL, isNewerVersion, standaloneAssetUrl, standaloneUpdateHint, updateHint, UPDATE_CHECK_TTL_MS, UPDATE_RETRY_MS, type LatestVersionRecord } from "./update-core.js";
import { VERSION } from "./version.js";

export const UPDATE_CACHE_FILENAME = "update-check.json";
export const ENV_NO_UPDATE_CHECK = "MOODLE_NO_UPDATE_CHECK";

interface UpdateCache extends Partial<LatestVersionRecord> {
  notified_at?: number;
  failed_at?: number;
}

export interface UpdateCheckOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export function updateCachePath(homeDir = homedir()): string {
  return join(homeDir, CONFIG_DIR_NAME, UPDATE_CACHE_FILENAME);
}

export async function readUpdateCache(homeDir?: string): Promise<UpdateCache> {
  try {
    const parsed = JSON.parse(await readFile(updateCachePath(homeDir), "utf8")) as UpdateCache;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeUpdateCache(cache: UpdateCache, homeDir?: string): Promise<void> {
  const file = updateCachePath(homeDir);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
}

/** Ask npm once and remember the answer; returns the latest version or null when offline. */
export async function refreshLatestVersion(options: UpdateCheckOptions = {}): Promise<string | null> {
  const latest = await fetchLatestVersion(options.fetchImpl);
  const now = (options.now ?? Date.now)();
  const cache = await readUpdateCache(options.homeDir);
  await writeUpdateCache(latest ? { ...cache, latest, checked_at: now, failed_at: undefined } : { ...cache, failed_at: now }, options.homeDir);
  return latest;
}

function refreshDue(cache: UpdateCache, now: number): boolean {
  if (now - (cache.checked_at ?? 0) < UPDATE_CHECK_TTL_MS) return false;
  return now - (cache.failed_at ?? 0) >= UPDATE_RETRY_MS;
}

// Commands that run unattended, print machine output for tooling, or are the
// update itself must stay silent; a notice on them would confuse a parser or a log.
const QUIET_COMMANDS = new Set(["update", "dev", "completion", "commands", "skills", "mcp", "doctor"]);

export function startupCheckApplies(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[ENV_NO_UPDATE_CHECK] || env.CI) return false;
  const first = args.find((arg) => !arg.startsWith("-"));
  return first === undefined || !QUIET_COMMANDS.has(first);
}

/**
 * Print a one-line notice when a newer release is cached, at most once a day,
 * and refresh a stale cache in a detached child so no command waits on npm.
 */
export async function startupUpdateNotice(args: readonly string[], stderr: { write(chunk: string): unknown }, options: UpdateCheckOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (!startupCheckApplies(args, env)) return;
  const now = (options.now ?? Date.now)();
  const cache = await readUpdateCache(options.homeDir);
  if (isNewerVersion(cache.latest, VERSION) && now - (cache.notified_at ?? 0) >= UPDATE_CHECK_TTL_MS) {
    stderr.write(`${selfCommand().args.length ? updateHint(VERSION, cache.latest!) : standaloneUpdateHint(VERSION, cache.latest!)}\n`);
    await writeUpdateCache({ ...cache, notified_at: now }, options.homeDir);
  }
  if (refreshDue(cache, now)) spawnRefresh(env);
}

function spawnRefresh(env: NodeJS.ProcessEnv): void {
  const self = selfCommand();
  try {
    const child = spawn(self.command, [...self.args, "update", "--check", "--quiet"], { detached: true, stdio: "ignore", env: { ...env, [ENV_NO_UPDATE_CHECK]: "1" } });
    child.unref();
  } catch {
    /* A refresh that cannot start is retried on the next command. */
  }
}

export type InstallKind = "bun" | "npm" | "standalone";

/** Which installer owns this binary: bun's global store, npm's, or a downloaded standalone build. */
export function detectInstallKind(argv: readonly string[] = process.argv, execPath = process.execPath): InstallKind {
  const self = selfCommand(argv, execPath);
  if (!self.args.length) return "standalone";
  let script = self.args[0];
  try { script = realpathSync(script); } catch { /* Keep the unresolved path. */ }
  return /[\\/]\.bun[\\/]/u.test(script) || /[\\/]bun[\\/]install[\\/]global[\\/]/u.test(script) ? "bun" : "npm";
}

export function installCommand(kind: InstallKind): SelfCommand | null {
  if (kind === "bun") return { command: findExecutable("bun") ?? "bun", args: ["add", "--global", "moodle-cli@latest"] };
  if (kind === "npm") return { command: findExecutable("npm") ?? "npm", args: ["install", "-g", "moodle-cli@latest"] };
  return null;
}

/**
 * Swap a standalone binary for the published one. The download lands beside the
 * binary and is renamed over it, so a failed download never leaves a half-written
 * executable and the running process keeps its already-mapped file.
 */
export async function replaceStandalone(execPath: string, version: string, fetchImpl: typeof fetch = fetch, host = { platform: platform(), arch: arch() }): Promise<string | null> {
  const url = standaloneAssetUrl(version, host.platform, host.arch);
  if (!url) return `No standalone build is published for ${host.platform}-${host.arch}. See ${GITHUB_RELEASES_URL}`;
  const staging = `${execPath}.${process.pid}.download`;
  try {
    const response = await fetchImpl(url, { redirect: "follow" });
    if (!response.ok) return `Download failed with HTTP ${response.status} for ${url}`;
    await writeFile(staging, new Uint8Array(await response.arrayBuffer()), { mode: 0o755 });
    await chmod(staging, 0o755);
    await rename(staging, execPath);
    return null;
  } catch (error) {
    await rm(staging, { force: true });
    return `Could not replace ${execPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface RunUpdateOptions extends UpdateCheckOptions {
  runCommand?: (command: string, args: string[]) => SpawnSyncReturns<Buffer>;
  argv?: readonly string[];
  execPath?: string;
  /** Present when a managed Worker exists; true when its release digest is behind this package. */
  workerBehind?: boolean;
}

export interface UpdateReport {
  current: string;
  latest: string | null;
  install: InstallKind;
  updated: boolean;
  deployed: boolean;
  note: string;
}

/** Upgrade the package with its own installer, then let the new binary redeploy the Worker. */
export async function runUpdate(options: RunUpdateOptions): Promise<UpdateReport> {
  const run = options.runCommand ?? ((command: string, args: string[]) => spawnSync(command, args, { stdio: "inherit", env: options.env }));
  const install = detectInstallKind(options.argv, options.execPath);
  const latest = await refreshLatestVersion(options);
  const report: UpdateReport = { current: VERSION, latest, install, updated: false, deployed: false, note: "" };
  const newer = isNewerVersion(latest ?? undefined, VERSION);
  if (newer) {
    const command = installCommand(install);
    if (command) {
      const result = run(command.command, command.args);
      if (result.status !== 0) { report.note = `${command.command} exited with ${result.status ?? "a signal"}; the package was not updated.`; return report; }
    } else {
      const failure = await replaceStandalone(options.execPath ?? process.execPath, latest!, options.fetchImpl);
      if (failure) { report.note = `${standaloneUpdateHint(VERSION, latest!)} ${failure}`; return report; }
    }
    report.updated = true;
  }
  if (options.workerBehind === undefined) {
    report.note = newer ? `Updated to ${latest}.` : "Already up to date.";
    return report;
  }
  if (!newer && !options.workerBehind) { report.note = "Package and Worker are up to date."; return report; }
  // The process that just ran the installer is still the old code; the new bin on
  // PATH (or the freshly replaced standalone binary) deploys.
  const self = selfCommand(options.argv, options.execPath);
  const bin = newer && install !== "standalone" ? findExecutable("moodle") : undefined;
  const deploy: SelfCommand = bin ? { command: bin, args: ["mcp", "deploy"] } : { command: self.command, args: [...self.args, "mcp", "deploy"] };
  const result = run(deploy.command, deploy.args);
  report.deployed = result.status === 0;
  report.note = report.deployed ? `Worker redeployed from ${newer ? latest : VERSION}.` : "Worker deploy failed; run moodle mcp deploy to retry.";
  return report;
}
