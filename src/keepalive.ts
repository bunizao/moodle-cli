import { fetchWithSession } from "./session-fetch.js";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAuthenticatedSession } from "./auth.js";
import {
  AJAX_SERVICE_PATH,
  CACHE_DIR_NAME,
  FUNC_SESSION_TIME_REMAINING,
  FUNC_SESSION_TOUCH,
  KEEPALIVE_DEFAULT_INTERVAL_MINUTES,
  KEEPALIVE_LAUNCH_AGENT_LABEL,
  KEEPALIVE_LOG_FILENAME,
} from "./constants.js";
import { readCachedSession, writeCachedSession } from "./session-cache.js";

export interface TouchResult {
  alive: boolean | null;
  timeRemainingSeconds: number | null;
}

export interface KeepaliveRunResult {
  status: "renewed" | "reauthenticated" | "expired" | "no_session" | "unreachable";
  time_remaining_seconds: number | null;
}

export interface AuthStatus {
  base_url: string;
  session_cached: boolean;
  cache_age_minutes: number | null;
  session_alive: boolean | null;
  session_time_remaining_seconds: number | null;
  keepalive_installed: boolean;
  keepalive_plist_path: string;
}

export interface KeepaliveInstallResult {
  plist_path: string;
  interval_minutes: number;
  log_path: string;
  command: string[];
}

export interface KeepaliveStatus {
  installed: boolean;
  plist_path: string;
}

export interface KeepaliveOptions {
  homeDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  renewOnExpiry?: boolean;
  authenticate?: (baseUrl: string) => Promise<unknown>;
}

export interface KeepaliveInstallOptions {
  homeDir?: string;
  intervalMinutes?: number;
  platform?: NodeJS.Platform;
  execPath?: string;
  argv1?: string;
  uid?: number;
  runCommand?: typeof spawnSync;
}

export async function touchMoodleSession(
  baseUrl: string,
  cookie: { name: string; value: string },
  sesskey: string,
  fetchImpl: typeof fetch = fetch,
  extend = true,
): Promise<TouchResult> {
  const methods = extend ? [FUNC_SESSION_TOUCH, FUNC_SESSION_TIME_REMAINING] : [FUNC_SESSION_TIME_REMAINING];
  const url = `${baseUrl.replace(/\/$/, "")}${AJAX_SERVICE_PATH}?sesskey=${encodeURIComponent(sesskey)}&info=${methods.join(",")}`;
  let response: Response;
  try {
    response = await fetchWithSession(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${cookie.name}=${cookie.value}`,
      },
      body: JSON.stringify(methods.map((methodname, index) => ({ index, methodname, args: {} }))),
    }, baseUrl, cookie, fetchImpl);
  } catch {
    return { alive: null, timeRemainingSeconds: null };
  }

  if (!response.ok) {
    return { alive: null, timeRemainingSeconds: null };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body means the POST was bounced to an SSO or login page.
    return { alive: false, timeRemainingSeconds: null };
  }

  if (!Array.isArray(body) || !body.length) {
    return { alive: null, timeRemainingSeconds: null };
  }

  const first = body[0] as Record<string, unknown>;
  if (first?.error) {
    const exception = first.exception as Record<string, unknown> | undefined;
    const errorcode = typeof exception?.errorcode === "string" ? exception.errorcode : "";
    if (errorcode === "servicerequireslogin" || errorcode === "sitepolicynotagreed") {
      return { alive: false, timeRemainingSeconds: null };
    }
    return { alive: null, timeRemainingSeconds: null };
  }

  const last = body[body.length - 1] as Record<string, unknown>;
  const data = last?.data as Record<string, unknown> | undefined;
  const timeRemaining = typeof data?.timeremaining === "number" ? data.timeremaining : null;
  return { alive: true, timeRemainingSeconds: timeRemaining };
}

export async function keepAliveOnce(baseUrl: string, options: KeepaliveOptions = {}): Promise<KeepaliveRunResult> {
  const session = await readCachedSession(baseUrl, {
    homeDir: options.homeDir,
    ttlMs: Number.MAX_SAFE_INTEGER,
    now: options.now,
  });
  if (!session) {
    return { status: "no_session", time_remaining_seconds: null };
  }

  const touch = await touchMoodleSession(
    baseUrl,
    { name: session.cookieName, value: session.cookieValue },
    session.sesskey,
    options.fetchImpl ?? fetch,
  );
  if (touch.alive === true) {
    await writeCachedSession({ ...session, savedAt: (options.now ?? Date.now)() }, { homeDir: options.homeDir });
    return { status: "renewed", time_remaining_seconds: touch.timeRemainingSeconds };
  }
  if (touch.alive === null) {
    return { status: "unreachable", time_remaining_seconds: null };
  }
  if (options.renewOnExpiry === false) {
    return { status: "expired", time_remaining_seconds: null };
  }

  const authenticate = options.authenticate
    ?? ((url: string) =>
      getAuthenticatedSession(url, {
        homeDir: options.homeDir,
        fetch: options.fetchImpl,
        noCache: true,
        now: options.now,
        // Background runs must never block on an interactive Okta login.
        nonInteractive: true,
      }));
  try {
    await authenticate(baseUrl);
    return { status: "reauthenticated", time_remaining_seconds: null };
  } catch {
    return { status: "expired", time_remaining_seconds: null };
  }
}

export async function getAuthStatus(baseUrl: string, options: KeepaliveOptions = {}): Promise<AuthStatus> {
  const now = options.now ?? Date.now;
  const keepalive = await keepaliveStatus(options.homeDir);
  const session = await readCachedSession(baseUrl, {
    homeDir: options.homeDir,
    ttlMs: Number.MAX_SAFE_INTEGER,
    now: options.now,
  });
  if (!session) {
    return {
      base_url: baseUrl,
      session_cached: false,
      cache_age_minutes: null,
      session_alive: null,
      session_time_remaining_seconds: null,
      keepalive_installed: keepalive.installed,
      keepalive_plist_path: keepalive.plist_path,
    };
  }

  const touch = await touchMoodleSession(
    baseUrl,
    { name: session.cookieName, value: session.cookieValue },
    session.sesskey,
    options.fetchImpl ?? fetch,
    false,
  );
  return {
    base_url: baseUrl,
    session_cached: true,
    cache_age_minutes: Math.max(0, Math.round((now() - session.savedAt) / 60000)),
    session_alive: touch.alive,
    session_time_remaining_seconds: touch.timeRemainingSeconds,
    keepalive_installed: keepalive.installed,
    keepalive_plist_path: keepalive.plist_path,
  };
}

export function keepalivePlistPath(homeDir = homedir()): string {
  return join(homeDir, "Library/LaunchAgents", `${KEEPALIVE_LAUNCH_AGENT_LABEL}.plist`);
}

export function keepaliveLogPath(homeDir = homedir()): string {
  return join(homeDir, CACHE_DIR_NAME, KEEPALIVE_LOG_FILENAME);
}

export function keepaliveProgramArguments(execPath = process.execPath, argv1 = process.argv[1] ?? ""): string[] {
  const resolvedArgv1 = argv1 ? safeRealpath(argv1) : "";
  const tail = ["auth", "keepalive", "--json"];
  if (!resolvedArgv1 || resolvedArgv1 === safeRealpath(execPath)) {
    return [execPath, ...tail];
  }
  return [execPath, resolvedArgv1, ...tail];
}

export function buildKeepalivePlist(programArguments: string[], intervalMinutes: number, logPath: string): string {
  const args = programArguments.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${KEEPALIVE_LAUNCH_AGENT_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${Math.round(intervalMinutes * 60)}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "  <key>StandardErrPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function installKeepalive(options: KeepaliveInstallOptions = {}): Promise<KeepaliveInstallResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(
      "Automatic keepalive install requires macOS launchd. Add a cron entry instead: */30 * * * * moodle auth keepalive --json",
    );
  }

  const homeDir = options.homeDir ?? homedir();
  const intervalMinutes = options.intervalMinutes ?? KEEPALIVE_DEFAULT_INTERVAL_MINUTES;
  const plistPath = keepalivePlistPath(homeDir);
  const logPath = keepaliveLogPath(homeDir);
  const command = keepaliveProgramArguments(options.execPath, options.argv1);

  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await writeFile(plistPath, buildKeepalivePlist(command, intervalMinutes, logPath), "utf8");

  const runCommand = options.runCommand ?? spawnSync;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  runCommand("launchctl", ["bootout", `gui/${uid}/${KEEPALIVE_LAUNCH_AGENT_LABEL}`], { stdio: "ignore" });
  const bootstrap = runCommand("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "ignore" }) as SpawnSyncReturns<Buffer>;
  if (bootstrap.error || bootstrap.status !== 0) {
    const legacy = runCommand("launchctl", ["load", "-w", plistPath], { stdio: "ignore" }) as SpawnSyncReturns<Buffer>;
    if (legacy.error || legacy.status !== 0) {
      throw new Error(`Failed to register the launch agent. Try manually: launchctl bootstrap gui/${uid} ${plistPath}`);
    }
  }

  return { plist_path: plistPath, interval_minutes: intervalMinutes, log_path: logPath, command };
}

export async function uninstallKeepalive(options: KeepaliveInstallOptions = {}): Promise<KeepaliveStatus> {
  const homeDir = options.homeDir ?? homedir();
  const plistPath = keepalivePlistPath(homeDir);
  const runCommand = options.runCommand ?? spawnSync;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  runCommand("launchctl", ["bootout", `gui/${uid}/${KEEPALIVE_LAUNCH_AGENT_LABEL}`], { stdio: "ignore" });
  await rm(plistPath, { force: true });
  return { installed: false, plist_path: plistPath };
}

export async function keepaliveStatus(homeDir = homedir()): Promise<KeepaliveStatus> {
  const plistPath = keepalivePlistPath(homeDir);
  try {
    return { installed: (await stat(plistPath)).isFile(), plist_path: plistPath };
  } catch {
    return { installed: false, plist_path: plistPath };
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
