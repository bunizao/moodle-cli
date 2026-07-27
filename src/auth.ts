import { ALL_PROFILES, getCookies } from "@steipete/sweet-cookie";
import { execFile as execFileCallback } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DASHBOARD_PATH,
  ENV_MOODLE_SESSION,
  LOGIN_PATH,
  MOODLE_SESSION_COOKIE_PREFIX,
  OKTA_AUTH_CONFIG_COMMAND,
  OKTA_AUTH_INSTALL_COMMAND,
  OKTA_AUTH_URL,
} from "./constants.js";
import { AuthError } from "./errors.js";
import {
  deleteCachedSession,
  readCachedSession,
  writeCachedSession,
  type CachedSession,
} from "./session-cache.js";

export interface MoodleSessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  source?: string;
}

export interface SessionValidation {
  sesskey: string;
  userid: number;
}

export interface AuthenticatedSession extends SessionValidation {
  baseUrl: string;
  cookie: MoodleSessionCookie;
  fromCache: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFile = (file: string, args: string[]) => Promise<CommandResult>;
export type CookieProvider = (baseUrl: string, options: AuthOptions) => Promise<MoodleSessionCookie[]>;
export type SessionValidator = (baseUrl: string, cookie: MoodleSessionCookie) => Promise<SessionValidation | null>;

export interface AuthOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  validateSession?: SessionValidator;
  browserCookieProvider?: CookieProvider;
  oktaCookieProvider?: CookieProvider;
  execFile?: ExecFile;
  homeDir?: string;
  platform?: NodeJS.Platform;
  noCache?: boolean;
  cacheTtlMs?: number;
  now?: () => number;
  nonInteractive?: boolean;
}

export interface BrowserLoginOptions extends AuthOptions {
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  browserLoginTimeoutMs?: number;
  browserLoginPollIntervalMs?: number;
  onBrowserOpened?: (url: string) => void;
}

export async function getAuthenticatedSession(
  baseUrl: string,
  options: AuthOptions = {},
): Promise<AuthenticatedSession> {
  const envSession = loadSessionFromEnv(options.env);
  const validate = options.validateSession ?? validateSessionWithFetch(options);

  if (envSession) {
    const context = await validate(baseUrl, envSession);
    if (!context) {
      throw new AuthError(
        `${ENV_MOODLE_SESSION} is set but did not authenticate for ${baseUrl}.`,
        authFailureHint(baseUrl),
      );
    }
    await refreshSessionCache(baseUrl, envSession, context, options);
    return { baseUrl, cookie: envSession, ...context, fromCache: false };
  }

  const cached = await readCache(baseUrl, options);
  if (cached) {
    return cached;
  }

  const browserProvider = options.browserCookieProvider ?? defaultBrowserCookieProvider;
  const browserCookies = matchingMoodleSessionCookies(await browserProvider(baseUrl, options), baseUrl);
  const browserSession = await firstValidSession(baseUrl, browserCookies, validate);
  if (browserSession) {
    await refreshSessionCache(baseUrl, browserSession.cookie, browserSession.context, options);
    return { baseUrl, cookie: browserSession.cookie, ...browserSession.context, fromCache: false };
  }

  const oktaProvider = options.oktaCookieProvider ?? loadSessionsFromOktaCli;
  const oktaCookies = matchingMoodleSessionCookies(await oktaProvider(baseUrl, options), baseUrl);
  const oktaSession = await firstValidSession(baseUrl, oktaCookies, validate);
  if (oktaSession) {
    await refreshSessionCache(baseUrl, oktaSession.cookie, oktaSession.context, options);
    return { baseUrl, cookie: oktaSession.cookie, ...oktaSession.context, fromCache: false };
  }

  if (!options.oktaCookieProvider && oktaCookies.length && !options.nonInteractive) {
    const refreshed = matchingMoodleSessionCookies(
      await loadSessionsFromOktaCli(baseUrl, { ...options, oktaCookieProvider: undefined, noCache: true }, true),
      baseUrl,
    );
    const refreshedSession = await firstValidSession(baseUrl, refreshed, validate);
    if (refreshedSession) {
      await refreshSessionCache(baseUrl, refreshedSession.cookie, refreshedSession.context, options);
      return { baseUrl, cookie: refreshedSession.cookie, ...refreshedSession.context, fromCache: false };
    }
  }

  throw new AuthError(`No usable MoodleSession found for ${baseUrl}.`, authFailureHint(baseUrl));
}

export async function getAuthenticatedSessionWithBrowserFallback(
  baseUrl: string,
  options: BrowserLoginOptions = {},
): Promise<AuthenticatedSession> {
  const authOptions: AuthOptions = { ...options, noCache: true, nonInteractive: true };
  const browserAuthOptions: AuthOptions = {
    ...authOptions,
    env: { ...(options.env ?? process.env), [ENV_MOODLE_SESSION]: undefined },
  };
  try {
    return await getAuthenticatedSession(baseUrl, authOptions);
  } catch (error) {
    if (!(error instanceof AuthError)) {
      throw error;
    }
  }

  if (loadSessionFromEnv(options.env)) {
    try {
      return await getAuthenticatedSession(baseUrl, browserAuthOptions);
    } catch (error) {
      if (!(error instanceof AuthError)) {
        throw error;
      }
    }
  }

  const url = loginUrl(baseUrl);
  await (options.openBrowser ?? ((target) => openSystemBrowser(target, options)))(url);
  options.onBrowserOpened?.(url);

  const pollIntervalMs = options.browserLoginPollIntervalMs ?? 1_000;
  const timeoutMs = options.browserLoginTimeoutMs ?? 120_000;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollOptions: AuthOptions = { ...browserAuthOptions, oktaCookieProvider: async () => [] };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(pollIntervalMs);
    try {
      return await getAuthenticatedSession(baseUrl, pollOptions);
    } catch (error) {
      if (!(error instanceof AuthError)) {
        throw error;
      }
    }
  }

  throw new AuthError(
    `Timed out waiting for browser login at ${baseUrl}.`,
    `Complete the login in your browser, then rerun: moodle auth login`,
  );
}

export function loadSessionFromEnv(env: Record<string, string | undefined> = process.env): MoodleSessionCookie | null {
  const value = env[ENV_MOODLE_SESSION]?.trim();
  return value ? { name: MOODLE_SESSION_COOKIE_PREFIX, value, source: "env" } : null;
}

export function matchingMoodleSessionCookies(cookies: MoodleSessionCookie[], baseUrl: string): MoodleSessionCookie[] {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const ranked: Array<{ cookie: MoodleSessionCookie; rank: number; index: number }> = [];
  const seen = new Set<string>();

  cookies.forEach((cookie, index) => {
    if (!cookie.name.startsWith(MOODLE_SESSION_COOKIE_PREFIX) || !cookie.value) {
      return;
    }
    const rank = cookieHostRank(cookie.domain, host);
    if (rank === null) {
      return;
    }
    const key = `${cookie.name}\0${cookie.value}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    ranked.push({ cookie, rank, index });
  });

  return ranked
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ cookie }) => cookie);
}

export async function defaultBrowserCookieProvider(
  baseUrl: string,
  options: AuthOptions = {},
): Promise<MoodleSessionCookie[]> {
  const primary = await getCookies({
    url: baseUrl,
    browsers: ["chrome", "edge", "firefox", "safari"],
    chromeProfile: ALL_PROFILES,
    edgeProfile: ALL_PROFILES,
    firefoxProfile: ALL_PROFILES,
    mode: "merge",
  });
  const braveProfiles = await braveProfilePaths(options);
  const brave = braveProfiles.length
    ? await getCookies({ url: baseUrl, browsers: ["chrome"], chromeProfile: braveProfiles, mode: "merge" })
    : { cookies: [] };

  return [...primary.cookies, ...brave.cookies].map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    source: [cookie.source?.browser, cookie.source?.profile].filter(Boolean).join(":") || "browser",
  }));
}

export async function braveProfilePaths(options: AuthOptions = {}): Promise<string[]> {
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const roots = platform === "linux"
    ? [
        join(home, ".config/BraveSoftware/Brave-Browser"),
        join(home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
      ]
    : platform === "win32"
      ? [join(home, "AppData/Local/BraveSoftware/Brave-Browser/User Data")]
      : [];

  const profiles: string[] = [];
  for (const root of roots) {
    try {
      profiles.push(
        ...(await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .filter((name) => name === "Default" || name === "Guest Profile" || name.startsWith("Profile "))
          .sort()
          .map((name) => join(root, name)),
      );
    } catch {
      continue;
    }
  }
  return profiles;
}

export async function loadSessionsFromOktaCli(
  baseUrl: string,
  options: AuthOptions = {},
  forceLogin = false,
): Promise<MoodleSessionCookie[]> {
  const execFile = options.execFile ?? defaultExecFile;
  const executable = await findExecutable("okta", execFile, options.platform);
  if (!executable) {
    return [];
  }

  const stored = await readOktaCookies(executable, baseUrl, execFile);
  if ((stored.length && !forceLogin) || options.nonInteractive) {
    return stored;
  }

  const login = await runOktaJson(executable, ["login", baseUrl], execFile);
  if (!login) {
    return stored;
  }
  const refreshed = await readOktaCookies(executable, baseUrl, execFile);
  return refreshed.length ? refreshed : stored;
}

export function authFailureHint(baseUrl: string): string {
  return [
    `Log in to ${loginUrl(baseUrl)} in your browser, then rerun the command.`,
    `Or set ${ENV_MOODLE_SESSION} to a valid MoodleSession cookie value.`,
    `For automatic login, install okta-auth: ${OKTA_AUTH_INSTALL_COMMAND}, then run ${OKTA_AUTH_CONFIG_COMMAND}.`,
    `okta-auth: ${OKTA_AUTH_URL}`,
  ].join("\n");
}

export async function invalidateCachedSession(baseUrl: string, options: AuthOptions = {}): Promise<void> {
  await deleteCachedSession(baseUrl, cacheOptions(options));
}

export function parseSessionContext(html: string): SessionValidation | null {
  const sesskey = firstMatch(html, [
    /"sesskey"\s*:\s*"([^"]+)"/,
    /\bsesskey\s*:\s*'([^']+)'/,
    /name=["']sesskey["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']sesskey["']/i,
  ]);
  if (!sesskey) {
    return null;
  }

  const useridRaw = firstMatch(html, [
    /"userid"\s*:\s*(\d+)/,
    /\buserid\s*:\s*(\d+)/,
    /data-userid=["'](\d+)["']/i,
  ]);

  return { sesskey: decodeHtml(sesskey), userid: useridRaw ? Number(useridRaw) : 0 };
}

function validateSessionWithFetch(options: AuthOptions): SessionValidator {
  return async (baseUrl: string, cookie: MoodleSessionCookie): Promise<SessionValidation | null> => {
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher) {
      throw new AuthError("fetch is not available in this runtime.", authFailureHint(baseUrl));
    }

    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${DASHBOARD_PATH}`, {
        redirect: "follow",
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      });
    } catch {
      return null;
    }

    if (response.status >= 400 || isLoginRedirect(response.url, baseUrl)) {
      return null;
    }

    const html = await response.text();
    if (looksLikeLoginPage(html)) {
      return null;
    }
    return parseSessionContext(html);
  };
}

async function readOktaCookies(
  executable: string,
  baseUrl: string,
  execFile: ExecFile,
): Promise<MoodleSessionCookie[]> {
  const payload = await runOktaJson(executable, ["cookies", baseUrl], execFile);
  if (!payload) {
    return [];
  }

  const cookies = Array.isArray(payload.cookies) ? payload.cookies : Array.isArray(payload) ? payload : [];
  return cookies.filter(isRecord).map((cookie) => ({
    name: String(cookie.name ?? ""),
    value: String(cookie.value ?? ""),
    domain: typeof cookie.domain === "string" ? cookie.domain : undefined,
    path: typeof cookie.path === "string" ? cookie.path : undefined,
    source: "okta",
  }));
}

async function runOktaJson(
  executable: string,
  args: string[],
  execFile: ExecFile,
): Promise<Record<string, unknown> | null> {
  const result = await execFile(executable, [...args, "--json"]);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function findExecutable(
  name: string,
  execFile: ExecFile,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const command = platform === "win32" ? "where" : "which";
  const result = await execFile(command, [name]);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.split(/\r?\n/, 1)[0]?.trim() || null;
}

async function firstValidSession(
  baseUrl: string,
  cookies: MoodleSessionCookie[],
  validate: SessionValidator,
): Promise<{ cookie: MoodleSessionCookie; context: SessionValidation } | null> {
  for (const cookie of cookies) {
    const context = await validate(baseUrl, cookie);
    if (context) {
      return { cookie, context };
    }
  }
  return null;
}

async function readCache(baseUrl: string, options: AuthOptions): Promise<AuthenticatedSession | null> {
  try {
    const cached = await readCachedSession(baseUrl, cacheOptions(options));
    return cached ? cachedSessionToAuth(baseUrl, cached) : null;
  } catch {
    return null;
  }
}

async function refreshSessionCache(
  baseUrl: string,
  cookie: MoodleSessionCookie,
  context: SessionValidation,
  options: AuthOptions,
): Promise<void> {
  const session: CachedSession = {
    baseUrl,
    cookieName: cookie.name,
    cookieValue: cookie.value,
    sesskey: context.sesskey,
    userid: context.userid,
    savedAt: (options.now ?? Date.now)(),
  };
  try {
    await writeCachedSession(session, cacheOptions(options));
  } catch {
    return;
  }
}

function cachedSessionToAuth(baseUrl: string, cached: CachedSession): AuthenticatedSession {
  return {
    baseUrl,
    cookie: { name: cached.cookieName, value: cached.cookieValue, source: "cache" },
    sesskey: cached.sesskey,
    userid: cached.userid,
    fromCache: true,
  };
}

function cacheOptions(options: AuthOptions) {
  return {
    homeDir: options.homeDir,
    ttlMs: options.cacheTtlMs,
    now: options.now,
    noCache: options.noCache,
  };
}

function cookieHostRank(domain: string | undefined, host: string): number | null {
  if (!domain) {
    return 2;
  }
  const normalized = domain.replace(/^\./, "").toLowerCase();
  if (normalized === host) {
    return 0;
  }
  if (host.endsWith(`.${normalized}`)) {
    return 1;
  }
  return null;
}

function loginUrl(baseUrl: string): string {
  return new URL(LOGIN_PATH, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function isLoginRedirect(responseUrl: string, baseUrl: string): boolean {
  if (!responseUrl) {
    return false;
  }
  const path = new URL(responseUrl, baseUrl).pathname;
  return path === LOGIN_PATH || path.startsWith("/login/");
}

function looksLikeLoginPage(html: string): boolean {
  return /name=["']username["']/i.test(html) && /name=["']password["']/i.test(html);
}

function firstMatch(value: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function openSystemBrowser(url: string, options: AuthOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const command = platform === "darwin"
    ? { file: "open", args: [url] }
    : platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const result = await (options.execFile ?? defaultExecFile)(command.file, command.args);
  if (result.exitCode !== 0) {
    throw new AuthError(
      `Could not open the browser for Moodle login.`,
      `Open ${url} manually, then rerun: moodle auth login`,
    );
  }
}

const defaultExecFile: ExecFile = (file: string, args: string[]) =>
  new Promise((resolve) => {
    execFileCallback(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const errorWithCode = error as (Error & { code?: number | string }) | null;
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode: errorWithCode ? Number(errorWithCode.code) || 1 : 0,
      });
    });
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
