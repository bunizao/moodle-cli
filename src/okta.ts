import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readConfigSetting } from "./config.js";
import { CACHE_DIR_NAME } from "./constants.js";
import { AuthError, UsageError } from "./errors.js";
import { findExecutable } from "./mcp/self-command.js";

// The okta-auth CLI (`okta`) as an opt-in session source. It only helps sites
// behind Okta, so it never runs unless the user asked for it, or `okta` is
// installed and already holds a session for this site.

export interface OktaCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface OktaCli {
  /** The cookies `okta` saved for the site; empty when it has none. */
  cookies(url: string): Promise<OktaCookie[]>;
  /** Run a fresh `okta login`. "rejected" means Okta refused the username or password. */
  login(url: string): Promise<"ok" | "rejected" | "failed">;
}

export interface OktaSourceOptions {
  /** True after `moodle auth login --okta` or `okta: true` in the config; false opts out. */
  okta?: boolean;
  /** Injected in tests; null means `okta` is not installed. */
  oktaCli?: OktaCli | null;
  env?: Record<string, string | undefined>;
  cwd?: string;
  homeDir?: string;
  nonInteractive?: boolean;
}

// `okta login` exits with this when Okta refuses the username or password.
const EXIT_CREDENTIALS_REJECTED = 77;
const COOKIES_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 90_000;

export const OKTA_CONFIG_KEY = "okta";

/**
 * A session from `okta`'s saved cookies, refreshed by `okta login` only when the
 * user opted in. `accept` turns cookies into a session, or null when they do not
 * sign in; the result is null when this source has nothing to offer.
 */
export async function sessionFromOkta<T>(
  url: string,
  options: OktaSourceOptions,
  accept: (cookies: OktaCookie[]) => Promise<T | null>,
): Promise<T | null> {
  const enabled = options.okta ?? await enabledInConfig(options);
  if (enabled === false) return null;
  const cli = options.oktaCli === undefined ? defaultOktaCli(options.env) : options.oktaCli;
  if (!cli) return null;

  const saved = await cli.cookies(url);
  const reused = saved.length ? await accept(saved) : null;
  if (reused) return reused;

  // Only an explicit opt-in signs in again. Background runs never do, unless the
  // user is running `moodle auth login --okta` right now.
  const explicit = options.okta === true;
  if (!enabled || (options.nonInteractive && !explicit)) return null;
  // A rejected password stays rejected, and every attempt counts towards Okta's
  // lockout. Only the user, by asking again, lifts the stop.
  if (!explicit && await rejectedBefore(options.homeDir)) {
    throw new AuthError(
      "Okta rejected the username or password last time, so okta login was not run again.",
      OKTA_REJECTED_HINT,
    );
  }

  const outcome = await cli.login(url);
  if (outcome === "rejected") {
    await markRejected(options.homeDir);
    throw new AuthError("Okta rejected the username or password.", OKTA_REJECTED_HINT);
  }
  if (outcome === "failed") return null;
  await clearRejected(options.homeDir);
  const fresh = await cli.cookies(url);
  return fresh.length ? accept(fresh) : null;
}

const OKTA_REJECTED_HINT = [
  "Update the credentials okta uses (run: okta config), then run: moodle auth login --okta",
  "Not retried automatically: repeated attempts can lock the account.",
].join("\n");

async function enabledInConfig(options: OktaSourceOptions): Promise<boolean | undefined> {
  try {
    const value = await readConfigSetting(OKTA_CONFIG_KEY, { env: options.env, cwd: options.cwd, homeDir: options.homeDir });
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function defaultOktaCli(env: Record<string, string | undefined> = process.env): OktaCli | null {
  const executable = findExecutable("okta", env as NodeJS.ProcessEnv);
  if (!executable) return null;
  return {
    async cookies(url) {
      const result = await run(executable, ["cookies", url, "--json"], COOKIES_TIMEOUT_MS);
      return result.code === 0 ? parseOktaCookies(result.stdout) : [];
    },
    async login(url) {
      const result = await run(executable, ["login", url, "--json"], LOGIN_TIMEOUT_MS);
      if (result.code === EXIT_CREDENTIALS_REJECTED) return "rejected";
      return result.code === 0 ? "ok" : "failed";
    },
  };
}

// The Worker secrets `okta export` prints, by the names the Worker reads.
export const OKTA_WORKER_SECRETS = ["OKTA_USERNAME", "OKTA_PASSWORD", "OKTA_TOTP_SECRET"] as const;
export type OktaWorkerSecrets = Record<(typeof OKTA_WORKER_SECRETS)[number], string>;

/**
 * The credentials okta holds, for `moodle mcp deploy --okta` to store as Worker
 * secrets. stdout is a pipe, never a terminal, so okta agrees to print them;
 * nothing it prints ends up in an error.
 */
export async function exportOktaSecrets(env: Record<string, string | undefined> = process.env): Promise<OktaWorkerSecrets> {
  const executable = findExecutable("okta", env as NodeJS.ProcessEnv);
  if (!executable) {
    throw new UsageError("--okta needs the okta command from okta-auth-cli.", "Install it (npm install -g okta-auth-cli), run: okta setup, then deploy again.");
  }
  const result = await run(executable, ["export", "--dangerously-print-password-and-totp-secret"], COOKIES_TIMEOUT_MS);
  const secrets = result.code === 0 ? parseOktaExport(result.stdout) : null;
  if (!secrets) {
    throw new UsageError("okta export did not print a username, password and TOTP secret.", "Run: okta setup, then deploy again.");
  }
  return secrets;
}

export function parseOktaExport(stdout: string): OktaWorkerSecrets | null {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const secrets: Partial<OktaWorkerSecrets> = {};
  for (const name of OKTA_WORKER_SECRETS) {
    const value = payload[name];
    if (typeof value !== "string" || !value.trim()) return null;
    secrets[name] = value;
  }
  return secrets as OktaWorkerSecrets;
}

/** Both CLIs: the Python one prints {cookies: [...]}, the TypeScript one a bare list. */
export function parseOktaCookies(stdout: string): OktaCookie[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.cookies) ? payload.cookies : [];
  return list.filter(isRecord).flatMap((cookie) => typeof cookie.name === "string" && typeof cookie.value === "string"
    ? [{
      name: cookie.name,
      value: cookie.value,
      ...(typeof cookie.domain === "string" ? { domain: cookie.domain } : {}),
      ...(typeof cookie.path === "string" ? { path: cookie.path } : {}),
    }]
    : []);
}

// stdin is closed so a missing credential makes `okta` fail instead of waiting
// on a prompt nobody sees; its progress lines on stderr are dropped so they never
// mix into this CLI's own output.
function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => resolve({ code: null, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

function rejectedMarker(homeDir = homedir()): string {
  return join(homeDir, CACHE_DIR_NAME, "okta-rejected");
}

async function rejectedBefore(homeDir?: string): Promise<boolean> {
  return stat(rejectedMarker(homeDir)).then(() => true, () => false);
}

async function markRejected(homeDir?: string): Promise<void> {
  const path = rejectedMarker(homeDir);
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 }).catch(() => undefined);
}

async function clearRejected(homeDir?: string): Promise<void> {
  await rm(rejectedMarker(homeDir), { force: true }).catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
