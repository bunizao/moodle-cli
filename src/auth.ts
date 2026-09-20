import { fetchWithSession } from "./session-fetch.js";
import { ALL_PROFILES, getCookies } from "@steipete/sweet-cookie";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DASHBOARD_PATH,
  ENV_MOODLE_TOKEN,
  ENV_MOODLE_SESSION,
  LOGIN_PATH,
  MOODLE_SESSION_COOKIE_PREFIX,
} from "./constants.js";
import { browserCookieStores, cookieStoresBlocked, unreadableCookieStores, type CookieStore } from "./cookie-stores.js";
import { CdpError, cdpProfileDir, findChromiumBrowser, loginWithCdp, type CdpCookie, type CdpLoginOptions, type CdpLoginResult } from "./cdp-login.js";
import { fetchMobileToken, mintSessionFromMobileToken, readMobilePublicConfig, type MobileToken } from "./mobile-login-core.js";
import { AuthError, asNetworkError } from "./errors.js";
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

export type CookieProvider = (baseUrl: string, options: AuthOptions) => Promise<MoodleSessionCookie[]>;
export type SessionValidator = (baseUrl: string, cookie: MoodleSessionCookie) => Promise<SessionValidation | null>;

export interface AuthOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  validateSession?: SessionValidator;
  browserCookieProvider?: CookieProvider;
  homeDir?: string;
  platform?: NodeJS.Platform;
  noCache?: boolean;
  cacheTtlMs?: number;
  now?: () => number;
  nonInteractive?: boolean;
  onCookieWarnings?: (warnings: string[]) => void;
  // Trade a genuinely new session for a durable mobile token, when the site
  // offers one. Opt-in so ordinary cold reads never make the extra call; the
  // login commands set it.
  captureMobileToken?: boolean;
}

export interface BrowserLoginOptions extends AuthOptions {
  onBrowserOpened?: (url: string) => void;
  // Drive sign-in through a CLI-owned Chromium over CDP instead of the cookie
  // store. Injected in tests; defaults to the real browser launcher.
  cdpLogin?: (options: CdpLoginOptions) => Promise<CdpLoginResult>;
  // Probe for an installed Chromium; injected in tests to simulate its absence.
  findBrowser?: (options: CdpLoginOptions) => Promise<{ path: string; name: string } | null>;
  // Render no browser window; only usable when the CLI profile already holds a
  // live identity-provider session. Used by unattended renewal.
  headlessCdp?: boolean;
  // How long the OS cookie-store read may take before we abandon it and drive a
  // browser sign-in instead. A macOS Keychain prompt or a locked store can stall
  // the read indefinitely, and that must never block the login the user asked
  // for. Injected small in tests.
  cookieStoreTimeoutMs?: number;
}

// Enough for a user to approve a Keychain prompt, short enough that a wedged
// store read hands off to the browser without an awkward wait.
const COOKIE_STORE_TIMEOUT_MS = 8_000;

/** Resolve with the promise, or with `onTimeout()` after `ms`, whichever is first. */
function withTimeoutValue<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
        `${envSession.source === ENV_MOODLE_TOKEN ? ENV_MOODLE_TOKEN : ENV_MOODLE_SESSION} is set but did not authenticate for ${baseUrl}.`,
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

  // A durable mobile token renews the cookie with no browser and no disk access,
  // so wherever the instance supports the mobile service it is the best source.
  // Prefer it before reading the OS cookie store. readCachedSession honours
  // noCache, so an explicit fresh login never silently reuses the token.
  const minted = await mintFromStoredToken(baseUrl, options, validate);
  if (minted) {
    return minted;
  }

  const cookieWarnings: string[] = [];
  const providerOptions: AuthOptions = {
    ...options,
    onCookieWarnings: (warnings) => {
      cookieWarnings.push(...warnings);
      options.onCookieWarnings?.(warnings);
    },
  };
  const browserProvider = options.browserCookieProvider ?? defaultBrowserCookieProvider;
  const browserCookies = matchingMoodleSessionCookies(await browserProvider(baseUrl, providerOptions), baseUrl);
  const browserSession = await firstValidSession(baseUrl, browserCookies, validate);
  if (browserSession) {
    await refreshSessionCache(baseUrl, browserSession.cookie, browserSession.context, options);
    return { baseUrl, cookie: browserSession.cookie, ...browserSession.context, fromCache: false };
  }

  // Every command lands here, so it must name the same cause as auth login does.
  const stores = await browserCookieStores({ homeDir: options.homeDir, platform: options.platform });
  throw new AuthError(
    `No usable MoodleSession found for ${baseUrl}.`,
    authFailureHint(baseUrl, cookieWarnings, options.platform, unreadableCookieStores(stores), options.env),
  );
}

export async function getAuthenticatedSessionWithBrowserFallback(
  baseUrl: string,
  options: BrowserLoginOptions = {},
): Promise<AuthenticatedSession> {
  const cookieWarnings: string[] = [];
  // Time-bound the cookie-store read so a stalled Keychain prompt or a locked
  // store cannot keep the CLI from reaching the browser sign-in below. A read
  // that succeeds quickly still wins, so the zero-interaction path is preserved.
  const rawProvider = options.browserCookieProvider ?? defaultBrowserCookieProvider;
  const cookieStoreTimeoutMs = options.cookieStoreTimeoutMs ?? COOKIE_STORE_TIMEOUT_MS;
  const boundedProvider: CookieProvider = (url, opts) =>
    withTimeoutValue(rawProvider(url, opts), cookieStoreTimeoutMs, () => {
      opts.onCookieWarnings?.(["Reading the browser cookie store timed out; opening a browser to sign in."]);
      return [];
    });
  const authOptions: AuthOptions = {
    ...options,
    noCache: true,
    nonInteractive: true,
    browserCookieProvider: boundedProvider,
    onCookieWarnings: (warnings) => {
      cookieWarnings.push(...warnings);
      options.onCookieWarnings?.(warnings);
    },
  };
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

  // The old fallback opened the system browser and polled the cookie store,
  // which is exactly what fails inside a sandboxed terminal or a locked store.
  // Instead, sign in through a Chromium the CLI drives over CDP and read the
  // cookie straight from that live browser. When no browser exists to drive and
  // the store is also unreadable, the store error is still the honest cause.
  const probeBrowser = options.findBrowser ?? findChromiumBrowser;
  const hasBrowser = Boolean(await probeBrowser({ ...(options as CdpLoginOptions) }));
  if (!hasBrowser) {
    const stores = await browserCookieStores({ homeDir: options.homeDir, platform: options.platform });
    if (cookieAccessBlocked(cookieWarnings) || cookieStoresBlocked(stores)) {
      throw new AuthError(
        `Cannot read browser cookies for ${baseUrl}.`,
        cookieAccessHint(cookieWarnings, options.platform, unreadableCookieStores(stores), options.env),
      );
    }
  }
  return loginViaCdp(baseUrl, { ...options, ...browserAuthOptions });
}

function toSessionCookie(cookie: CdpCookie): MoodleSessionCookie {
  return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, source: "cdp" };
}

/**
 * Sign in through a CLI-owned Chromium and read the resulting session over CDP.
 * A fresh MoodleSession appears before login on many sites (an anonymous
 * session), so presence alone is not enough: we validate a candidate only when
 * its value changes, which keeps the login to one dashboard check per real
 * cookie rather than one per poll.
 */
async function loginViaCdp(baseUrl: string, options: BrowserLoginOptions): Promise<AuthenticatedSession> {
  const validate = options.validateSession ?? validateSessionWithFetch(options);
  const runCdp = options.cdpLogin ?? loginWithCdp;
  const url = loginUrl(baseUrl);
  let resolved: { cookie: MoodleSessionCookie; context: SessionValidation } | null = null;
  let lastChecked = "";

  try {
    await runCdp({
      url,
      headless: options.headlessCdp ?? false,
      homeDir: options.homeDir,
      platform: options.platform,
      env: options.env,
      onOpened: () => options.onBrowserOpened?.(url),
      isDone: async (cookies) => {
        if (resolved) return true;
        const top = matchingMoodleSessionCookies(cookies.map(toSessionCookie), baseUrl)[0];
        if (!top || top.value === lastChecked) return false;
        lastChecked = top.value;
        const context = await validate(baseUrl, top);
        if (context) {
          resolved = { cookie: top, context };
          return true;
        }
        return false;
      },
    });
  } catch (error) {
    if (error instanceof CdpError) {
      throw new AuthError(error.message, error.hint ?? authFailureHint(baseUrl, [], options.platform, [], options.env));
    }
    throw error;
  }

  const session = resolved as { cookie: MoodleSessionCookie; context: SessionValidation } | null;
  if (!session) {
    throw new AuthError(`Sign-in did not complete for ${baseUrl}.`, `Run: moodle auth login`);
  }
  await refreshSessionCache(baseUrl, session.cookie, session.context, { ...options, noCache: false });
  return { baseUrl, cookie: session.cookie, ...session.context, fromCache: false };
}

/**
 * Pulls the cookie out of whatever the browser was willing to copy: a devtools
 * "Copy as cURL" command, a Cookie header, a name=value pair, or the bare value.
 * Deciding which of those to produce is the step users get wrong, and a wrong
 * paste costs one failed request, so parsing loosely is cheaper than explaining.
 */
export function parsePastedSessionCookie(raw: string): MoodleSessionCookie | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const pair = /\b(MoodleSession\w*)=([^;\s'"\\]+)/.exec(text);
  if (pair) {
    return { name: pair[1], value: pair[2], source: "paste" };
  }
  // A lone token is the value itself; anything else is a mis-paste we should
  // reject rather than send to Moodle as a cookie.
  return /[\s=;]/.test(text) ? null : { name: MOODLE_SESSION_COOKIE_PREFIX, value: text, source: "paste" };
}

/**
 * The escape hatch for machines where the cookie store cannot be read at all.
 * The cookie is cached like any other, so this is a one-time paste.
 */
export async function authenticateWithPastedCookie(
  baseUrl: string,
  raw: string,
  options: AuthOptions = {},
): Promise<AuthenticatedSession> {
  const cookie = parsePastedSessionCookie(raw);
  if (!cookie) {
    throw new AuthError(`That is not a ${MOODLE_SESSION_COOKIE_PREFIX} cookie value.`, pastedCookieHint(baseUrl));
  }
  const validate = options.validateSession ?? validateSessionWithFetch(options);
  const context = await validate(baseUrl, cookie);
  if (!context) {
    throw new AuthError(`The pasted cookie did not authenticate for ${baseUrl}.`, pastedCookieHint(baseUrl));
  }
  await refreshSessionCache(baseUrl, cookie, context, { ...options, noCache: false });
  return { baseUrl, cookie, ...context, fromCache: false };
}

export function pastedCookieHint(baseUrl: string): string {
  return [
    `Sign in at ${loginUrl(baseUrl)}, then open the browser developer tools.`,
    'In the Network tab, right-click any request to the site and choose "Copy as cURL", then paste the whole command.',
    `Copying the ${MOODLE_SESSION_COOKIE_PREFIX} value from Application (or Storage) > Cookies works too.`,
  ].join("\n");
}

export function loadSessionFromEnv(env: Record<string, string | undefined> = process.env): MoodleSessionCookie | null {
  const source = env[ENV_MOODLE_TOKEN] ? ENV_MOODLE_TOKEN : ENV_MOODLE_SESSION;
  const value = env[source]?.trim();
  return value ? { name: MOODLE_SESSION_COOKIE_PREFIX, value, source } : null;
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
    : { cookies: [], warnings: [] as string[] };

  // sweet-cookie reports unreadable stores here and documents that warnings never
  // contain cookie values, so they are safe to relay to the user verbatim.
  const warnings = [...(primary.warnings ?? []), ...(brave.warnings ?? [])];
  if (warnings.length) {
    options.onCookieWarnings?.(warnings);
  }

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
      : platform === "darwin"
        ? [join(home, "Library/Application Support/BraveSoftware/Brave-Browser")]
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

const FULL_DISK_ACCESS_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/**
 * macOS grants Full Disk Access to the application that owns the process tree,
 * which is the terminal, never the CLI. Naming it saves the user from guessing.
 */
const TERMINAL_APPLICATIONS: Readonly<Record<string, string>> = {
  Apple_Terminal: "Terminal",
  ghostty: "Ghostty",
  Hyper: "Hyper",
  "iTerm.app": "iTerm",
  Tabby: "Tabby",
  vscode: "Visual Studio Code",
  WarpTerminal: "Warp",
  WezTerm: "WezTerm",
};

export function hostApplicationName(env: Record<string, string | undefined> = process.env): string | null {
  const program = env.TERM_PROGRAM?.trim();
  return program ? TERMINAL_APPLICATIONS[program] ?? program : null;
}

const COOKIE_ACCESS_DENIED = /EPERM|EACCES|operation not permitted|permission denied/i;
// Chromium cookie stores are read through node:sqlite, which Node only ships
// unflagged from 22.13. Older runtimes cannot read any browser cookie.
const COOKIE_SQLITE_UNAVAILABLE = /No such built-in module: node:sqlite/i;
export const MINIMUM_NODE_FOR_BROWSER_COOKIES = "22.13.0";

/**
 * True when the cookie store could not be read at all. Logging in again cannot
 * fix this, so callers must not fall back to a browser login loop.
 */
export function cookieAccessBlocked(warnings: readonly string[]): boolean {
  return warnings.some((warning) => COOKIE_ACCESS_DENIED.test(warning) || COOKIE_SQLITE_UNAVAILABLE.test(warning));
}

export function cookieAccessHint(
  warnings: readonly string[],
  platform: NodeJS.Platform = process.platform,
  unreadable: readonly CookieStore[] = [],
  env: Record<string, string | undefined> = process.env,
): string {
  const grant = platform === "darwin"
    ? [
        `Grant Full Disk Access to ${hostApplicationName(env) ?? "the application running this command"}, then restart it:`,
        `  open "${FULL_DISK_ACCESS_PANE}"`,
      ].join("\n")
    : "Run this command as the user that owns the browser profile, or grant it read access to the browser cookie store.";
  const remedy: string[] = [];
  if (warnings.some((warning) => COOKIE_SQLITE_UNAVAILABLE.test(warning))) {
    remedy.push(
      `This Node.js runtime has no node:sqlite, which is needed to read browser cookies. Use Node.js ${MINIMUM_NODE_FOR_BROWSER_COOKIES} or newer, or run the CLI with Bun (bunx --bun moodle-cli).`,
    );
  }
  // An unreadable store is a permission problem even when the runtime is also
  // too old, so both remedies belong in the message.
  if (unreadable.length || !remedy.length) {
    remedy.push(
      "If this runs inside a sandboxed app (an IDE or agent terminal), rerun it from a regular terminal first.",
      grant,
    );
  }
  return [
    "The browser cookie store could not be read, so the session could not be detected.",
    ...remedy,
    "Or skip the store entirely: `moodle auth login --paste` takes the cookie by hand and caches it.",
    "Run moodle doctor for runtime and browser diagnostics.",
    ...cookieDiagnostics(warnings, unreadable),
  ].join("\n");
}

/**
 * Only the stores that could have held a session are worth printing. "Edge
 * cookies database not found" on a machine without Edge is noise, and every
 * command used to print four such lines on every auth failure.
 */
function cookieDiagnostics(warnings: readonly string[], unreadable: readonly CookieStore[]): string[] {
  const probed = unreadable.map((store) => store.path);
  const lines = [
    ...unreadable.map((store) => `  - ${store.browser} cookie store exists but cannot be opened: ${store.path}`),
    ...warnings
      .filter((warning) => COOKIE_ACCESS_DENIED.test(warning) || COOKIE_SQLITE_UNAVAILABLE.test(warning))
      .filter((warning) => !probed.some((path) => warning.includes(path)))
      .map((warning) => `  - ${warning}`),
  ];
  return lines.length ? ["", "Cookie store diagnostics:", ...lines] : [];
}

export function authFailureHint(
  baseUrl: string,
  cookieWarnings: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  unreadable: readonly CookieStore[] = [],
  env: Record<string, string | undefined> = process.env,
): string {
  if (cookieAccessBlocked(cookieWarnings) || unreadable.length) {
    return cookieAccessHint(cookieWarnings, platform, unreadable, env);
  }
  return [
    `Log in to ${loginUrl(baseUrl)} in your browser, then rerun the command.`,
    "Or run `moodle auth login` to sign in through a browser window this command controls.",
    "Or run `moodle auth login --paste` to hand over the cookie yourself.",
    ...cookieDiagnostics(cookieWarnings, unreadable),
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
      response = await fetchWithSession(`${baseUrl}${DASHBOARD_PATH}`, {}, baseUrl, cookie, fetcher);
    } catch (error) {
      // An unreachable site is not an expired cookie. Reporting it as one sends
      // the user off to log in again while the real fault is the connection.
      const network = asNetworkError(error);
      if (network) {
        throw network;
      }
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
    cookieSource: cookie.source,
    cookieValue: cookie.value,
    sesskey: context.sesskey,
    userid: context.userid,
    savedAt: (options.now ?? Date.now)(),
  };
  try {
    // Keep what the previous session learned about this account: the services
    // the site disables, the dashboard profile, and the durable mobile token all
    // survive an expired cookie.
    const previous = await readCachedSession(baseUrl, { ...cacheOptions(options), allowExpired: true });
    // Mobile-service support is a property of the instance, not the account, so
    // carry it across a login even when the user changed.
    if (typeof previous?.mobileServiceEnabled === "boolean") session.mobileServiceEnabled = previous.mobileServiceEnabled;
    if (previous?.userid === context.userid) {
      if (previous.unavailable?.length) session.unavailable = previous.unavailable;
      if (previous.user) session.user = previous.user;
      // Only carry forward a token that can actually renew. A token without a
      // privatetoken is useless for the autologin key, so dropping it lets the
      // capture below fetch a real one instead of pinning the dead value.
      if (previous.mobileToken?.privatetoken) session.mobileToken = previous.mobileToken;
    }
    // A genuinely new cookie is worth one attempt to obtain a durable mobile
    // token; steady-state re-validation of the same cookie must not re-ask, and a
    // site already known not to offer the service is never probed again.
    const newCookie = !previous || previous.cookieValue !== cookie.value;
    if (!session.mobileToken && newCookie && options.captureMobileToken && session.mobileServiceEnabled !== false) {
      const captured = await captureMobileToken(baseUrl, cookie, options);
      session.mobileServiceEnabled = captured.supported;
      if (captured.token) session.mobileToken = captured.token;
    }
    await writeCachedSession(session, cacheOptions(options));
  } catch {
    return;
  }
}

/**
 * Detect whether the instance offers the mobile web service and, if so, trade
 * the live session for a durable token. Best-effort: on any failure we report
 * support as unknown-but-not-false so a later login can retry.
 */
async function captureMobileToken(
  baseUrl: string,
  cookie: MoodleSessionCookie,
  options: AuthOptions,
): Promise<{ supported?: boolean; token?: MobileToken }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const config = await readMobilePublicConfig(baseUrl, fetchImpl);
    if (config && !config.mobileServiceEnabled) return { supported: false };
    const token = (await fetchMobileToken(baseUrl, cookie, fetchImpl)) ?? undefined;
    // With a readable config, trust its flag; otherwise a minted token is itself
    // proof of support, and no token leaves support undetermined for next time.
    return { supported: config?.mobileServiceEnabled ?? (token ? true : undefined), token };
  } catch {
    return {};
  }
}

/**
 * Mint a fresh session cookie from a stored durable token and confirm it is a
 * real login for the same account. Shared by the cold-read path and the
 * background keepalive so both apply the same anti-anonymous-page guard.
 */
export async function mintValidatedSession(
  baseUrl: string,
  stored: Pick<CachedSession, "userid" | "mobileToken">,
  options: AuthOptions = {},
): Promise<{ cookie: MoodleSessionCookie; context: SessionValidation } | null> {
  if (!stored.mobileToken?.privatetoken) return null;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const minted = await mintSessionFromMobileToken(baseUrl, stored.userid, stored.mobileToken, fetchImpl);
  if (!minted) return null;
  const cookie: MoodleSessionCookie = { name: minted.cookie.name, value: minted.cookie.value, source: minted.cookie.source };
  const validate = options.validateSession ?? validateSessionWithFetch(options);
  const context = await validate(baseUrl, cookie);
  // A login/anonymous page also carries a sesskey but userid 0; accept the mint
  // only when it produced a genuine session for the same account.
  if (!context || context.userid === 0 || context.userid !== stored.userid) return null;
  return { cookie, context };
}

/** Try to renew via a stored durable token before touching the OS cookie store. */
async function mintFromStoredToken(
  baseUrl: string,
  options: AuthOptions,
  validate: SessionValidator,
): Promise<AuthenticatedSession | null> {
  let stored: CachedSession | null;
  try {
    // Honours noCache: a forced fresh login never silently reuses the token.
    stored = await readCachedSession(baseUrl, { ...cacheOptions(options), allowExpired: true });
  } catch {
    return null;
  }
  if (!stored?.mobileToken?.privatetoken) return null;
  const result = await mintValidatedSession(baseUrl, stored, { ...options, validateSession: validate });
  if (!result) return null;
  await refreshSessionCache(baseUrl, result.cookie, result.context, options);
  return { baseUrl, cookie: result.cookie, ...result.context, fromCache: false };
}

function cachedSessionToAuth(baseUrl: string, cached: CachedSession): AuthenticatedSession {
  return {
    baseUrl,
    cookie: { name: cached.cookieName, value: cached.cookieValue, source: cached.cookieSource ?? "cache" },
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

export function loginUrl(baseUrl: string): string {
  return new URL(LOGIN_PATH, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

export function isLoginRedirect(responseUrl: string, baseUrl: string): boolean {
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

