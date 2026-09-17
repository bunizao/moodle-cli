import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateWithPastedCookie,
  authFailureHint,
  braveProfilePaths,
  cookieAccessBlocked,
  cookieAccessHint,
  hostApplicationName,
  parsePastedSessionCookie,
  getAuthenticatedSession,
  getAuthenticatedSessionWithBrowserFallback,
  loadSessionFromEnv,
  matchingMoodleSessionCookies,
} from "../src/auth.js";
import type { CdpCookie, CdpLoginOptions, CdpLoginResult } from "../src/cdp-login.js";
import { browserCookieStores, cookieStoresBlocked, unreadableCookieStores } from "../src/cookie-stores.js";
import { loadConfig, normalizeBaseUrl } from "../src/config.js";
import { ENV_MOODLE_BASE_URL, ENV_MOODLE_CONFIG, ENV_MOODLE_SESSION, ENV_MOODLE_TOKEN, ENV_MOODLE_URL } from "../src/constants.js";
import { readCachedSession, writeCachedSession } from "../src/session-cache.js";
import { render, resolveFormat } from "@bunizao/cli-kit";
import { runCli } from "../src/cli.js";
import { createMoodleClient } from "../src/client.js";

const BASE_URL = "https://school.example.edu";

/**
 * Stand in for the CLI-owned Chromium: replay each cookie frame through the
 * login's isDone check, the way a real browser's cookie jar changes as the user
 * signs in, and stop on the frame that satisfies it.
 */
function fakeCdp(frames: CdpCookie[][]) {
  return vi.fn(async (options: CdpLoginOptions): Promise<CdpLoginResult> => {
    options.onOpened?.();
    let last: CdpCookie[] = [];
    for (const frame of frames) {
      last = frame;
      if (await options.isDone(frame)) return { cookies: frame, browserName: "Google Chrome" };
    }
    return { cookies: last, browserName: "Google Chrome" };
  });
}

function cdpCookie(name: string, value: string, domain = "school.example.edu"): CdpCookie {
  return { name, value, domain, secure: true, httpOnly: true };
}

describe("pasted cookie login", () => {
  it("accepts every shape a cookie panel hands out", () => {
    expect(parsePastedSessionCookie("  abc123  ")).toMatchObject({ name: "MoodleSession", value: "abc123" });
    expect(parsePastedSessionCookie("MoodleSession=abc123")).toMatchObject({ name: "MoodleSession", value: "abc123" });
    expect(parsePastedSessionCookie("MoodleSessionprod=abc123")).toMatchObject({ name: "MoodleSessionprod", value: "abc123" });
    expect(parsePastedSessionCookie("Cookie: other=1; MoodleSession=abc123; more=2")).toMatchObject({ value: "abc123" });
    expect(parsePastedSessionCookie(`curl 'https://school.example.edu/my/' -H 'cookie: _ga=1; MoodleSession=abc123' -H 'accept: */*'`)).toMatchObject({ name: "MoodleSession", value: "abc123" });
    expect(parsePastedSessionCookie("")).toBeNull();
    expect(parsePastedSessionCookie("username=alice")).toBeNull();
    expect(parsePastedSessionCookie("not a cookie")).toBeNull();
  });

  it("caches the pasted cookie so the paste is a one-time cost", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-paste-"));
    const session = await authenticateWithPastedCookie(BASE_URL, "MoodleSession=pasted", {
      homeDir,
      validateSession: async () => ({ sesskey: "sess", userid: 11 }),
    });

    expect(session).toMatchObject({ userid: 11, cookie: { value: "pasted", source: "paste" } });
    expect(await readCachedSession(BASE_URL, { homeDir })).toMatchObject({ cookieValue: "pasted", userid: 11 });
  });

  it("rejects a cookie the site does not accept", async () => {
    const failure = await authenticateWithPastedCookie(BASE_URL, "stale", {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-paste-bad-")),
      validateSession: async () => null,
    }).then(() => null, (caught: Error & { hint?: string }) => caught);

    expect(failure?.message).toContain("did not authenticate");
    expect(failure?.hint).toContain("MoodleSession");
  });
});

describe("full disk access hint", () => {
  it("names the terminal macOS actually checks", () => {
    expect(hostApplicationName({ TERM_PROGRAM: "ghostty" })).toBe("Ghostty");
    expect(hostApplicationName({ TERM_PROGRAM: "SomeTerm" })).toBe("SomeTerm");
    expect(hostApplicationName({})).toBeNull();

    const hint = cookieAccessHint([], "darwin", [{ browser: "Chrome", path: "/cookies", readable: false }], { TERM_PROGRAM: "ghostty" });
    expect(hint).toContain("Grant Full Disk Access to Ghostty");
    expect(hint).toContain("x-apple.systempreferences");
    expect(hint).toContain("moodle auth login --paste");
  });
});

describe("auth chain", () => {
  it("keeps MOODLE_SESSION as the winning source", async () => {
    const validateSession = vi.fn(async (_baseUrl: string, cookie: { name: string; value: string }) => {
      expect(cookie.value).toBe("env-cookie");
      return { sesskey: "sess", userid: 7 };
    });
    const browserCookieProvider = vi.fn(async () => [{ name: "MoodleSession", value: "browser-cookie", domain: "school.example.edu" }]);

    const session = await getAuthenticatedSession(BASE_URL, {
      env: { [ENV_MOODLE_SESSION]: "env-cookie" },
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-chain-")),
      validateSession,
      browserCookieProvider,
    });

    expect(session.cookie.value).toBe("env-cookie");
    expect(browserCookieProvider).not.toHaveBeenCalled();
  });

  it("matches suffixed MoodleSession cookies by host", () => {
    const matches = matchingMoodleSessionCookies(
      [
        { name: "MoodleSession", value: "wrong", domain: "other.example.edu" },
        { name: "MoodleSessionABC", value: "right", domain: ".school.example.edu" },
      ],
      BASE_URL,
    );

    expect(loadSessionFromEnv({ [ENV_MOODLE_SESSION]: "env" })?.value).toBe("env");
    expect(matches.map((cookie) => [cookie.name, cookie.value])).toEqual([["MoodleSessionABC", "right"]]);
  });

  it("does not drive a browser when automatic extraction succeeds", async () => {
    const cdpLogin = fakeCdp([]);

    const session = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-auto-")),
      browserCookieProvider: async () => [
        { name: "MoodleSession", value: "browser-cookie", domain: "school.example.edu" },
      ],
      validateSession: async () => ({ sesskey: "sess", userid: 7 }),
      cdpLogin,
    });

    expect(session.cookie.value).toBe("browser-cookie");
    expect(cdpLogin).not.toHaveBeenCalled();
  });

  it("signs in through the CLI browser when no session is available", async () => {
    // The site hands out an anonymous MoodleSession before login; only the
    // cookie that appears after sign-in validates.
    const cdpLogin = fakeCdp([
      [cdpCookie("MoodleSession", "anon")],
      [cdpCookie("MoodleSessionSSO", "fresh-cookie", ".school.example.edu")],
    ]);

    const session = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-browser-")),
      browserCookieProvider: async () => [],
      validateSession: async (_baseUrl, cookie) =>
        cookie.value === "fresh-cookie" ? { sesskey: "fresh-sess", userid: 9 } : null,
      cdpLogin,
    });

    expect(cdpLogin).toHaveBeenCalledOnce();
    expect(session).toMatchObject({ userid: 9, sesskey: "fresh-sess" });
  });

  it("drives the browser when the cookie-store read stalls instead of blocking on it", async () => {
    // A Keychain prompt or a locked store can leave the read pending forever;
    // the login must time it out and open a browser rather than wedge.
    const cdpLogin = fakeCdp([[cdpCookie("MoodleSession", "fresh-cookie")]]);
    const stalledProvider = vi.fn(() => new Promise<never>(() => {}));

    const session = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-stall-")),
      browserCookieProvider: stalledProvider,
      cookieStoreTimeoutMs: 5,
      validateSession: async (_baseUrl, cookie) =>
        cookie.value === "fresh-cookie" ? { sesskey: "fresh-sess", userid: 9 } : null,
      findBrowser: async () => ({ name: "Google Chrome", path: "/Applications/Google Chrome.app" }),
      cdpLogin,
    });

    expect(stalledProvider).toHaveBeenCalledOnce();
    expect(cdpLogin).toHaveBeenCalledOnce();
    expect(session).toMatchObject({ userid: 9, sesskey: "fresh-sess" });
  });

  it("ignores a stale environment session during browser fallback", async () => {
    const cdpLogin = fakeCdp([[cdpCookie("MoodleSession", "fresh-cookie")]]);

    const session = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      env: { [ENV_MOODLE_SESSION]: "stale-cookie" },
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-stale-env-")),
      browserCookieProvider: async () => [],
      validateSession: async (_baseUrl, cookie) =>
        cookie.value === "fresh-cookie" ? { sesskey: "fresh-sess", userid: 9 } : null,
      cdpLogin,
    });

    expect(cdpLogin).toHaveBeenCalledOnce();
    expect(session.cookie.value).toBe("fresh-cookie");
  });

  it("discovers Brave profiles on Linux, Windows, and macOS", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-brave-"));
    const linuxRoot = join(homeDir, ".config/BraveSoftware/Brave-Browser");
    const flatpakRoot = join(homeDir, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser");
    const windowsRoot = join(homeDir, "AppData/Local/BraveSoftware/Brave-Browser/User Data");
    const macRoot = join(homeDir, "Library/Application Support/BraveSoftware/Brave-Browser");
    await Promise.all([
      mkdir(join(macRoot, "Default"), { recursive: true }),
      mkdir(join(linuxRoot, "Default"), { recursive: true }),
      mkdir(join(linuxRoot, "Profile 2"), { recursive: true }),
      mkdir(join(linuxRoot, "Crashpad"), { recursive: true }),
      mkdir(join(flatpakRoot, "Default"), { recursive: true }),
      mkdir(join(windowsRoot, "Default"), { recursive: true }),
    ]);

    await expect(braveProfilePaths({ homeDir, platform: "linux" })).resolves.toEqual([
      join(linuxRoot, "Default"),
      join(linuxRoot, "Profile 2"),
      join(flatpakRoot, "Default"),
    ]);
    await expect(braveProfilePaths({ homeDir, platform: "win32" })).resolves.toEqual([
      join(windowsRoot, "Default"),
    ]);
    await expect(braveProfilePaths({ homeDir, platform: "darwin" })).resolves.toEqual([
      join(macRoot, "Default"),
    ]);
  });

  it("reports a blocked cookie store when no browser can be driven either", async () => {
    const cdpLogin = fakeCdp([[cdpCookie("MoodleSession", "fresh")]]);
    const blocked = "Failed to read Safari cookies: EPERM: operation not permitted, open '/Users/x/Cookies.binarycookies'";

    await expect(
      getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
        homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-blocked-")),
        platform: "darwin",
        browserCookieProvider: async (_baseUrl, options) => {
          options.onCookieWarnings?.([blocked]);
          return [];
        },
        validateSession: async () => null,
        findBrowser: async () => null,
        cdpLogin,
      }),
    ).rejects.toThrow(/Cannot read browser cookies/);

    // No installed browser to sign in with, so the store error is the honest one.
    expect(cdpLogin).not.toHaveBeenCalled();
  });

  it("fails fast when a store exists but cannot be opened and no browser is present", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-auth-denied-"));
    const store = join(homeDir, "Library/Application Support/Google/Chrome/Default/Cookies");
    await mkdir(dirname(store), { recursive: true });
    await writeFile(store, "");
    await chmod(store, 0o000);

    const cdpLogin = fakeCdp([[cdpCookie("MoodleSession", "fresh")]]);

    // sweet-cookie reports a denied store as "not found", so the warning text
    // alone must not hide a store we genuinely cannot read.
    const error = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      homeDir,
      platform: "darwin",
      browserCookieProvider: async (_baseUrl, options) => {
        options.onCookieWarnings?.(["Chrome cookies database not found."]);
        return [];
      },
      validateSession: async () => null,
      findBrowser: async () => null,
      cdpLogin,
    }).then(() => null, (caught: Error & { hint?: string }) => caught);

    expect(error?.message).toMatch(/Cannot read browser cookies/);
    expect(error?.hint).toContain(store);
    expect(error?.hint).toContain("Full Disk Access");
    expect(cdpLogin).not.toHaveBeenCalled();
  });

  it("lists a readable store and an unreadable one apart", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-stores-"));
    const chrome = join(homeDir, "Library/Application Support/Google/Chrome/Default/Cookies");
    const edge = join(homeDir, "Library/Application Support/Microsoft Edge/Default/Cookies");
    for (const path of [chrome, edge]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "");
    }
    await chmod(chrome, 0o000);

    const stores = await browserCookieStores({ homeDir, platform: "darwin" });
    expect(stores).toEqual([
      { browser: "Chrome", path: chrome, readable: false },
      { browser: "Edge", path: edge, readable: true },
    ]);
    expect(unreadableCookieStores(stores).map((store) => store.path)).toEqual([chrome]);
    // Safari is unreadable on every Mac without Full Disk Access, so one denied
    // store must not block a login the user can still complete in Edge.
    expect(cookieStoresBlocked(stores)).toBe(false);
    expect(cookieStoresBlocked(stores.filter((store) => !store.readable))).toBe(true);
    expect(cookieStoresBlocked([])).toBe(false);
    // Only macOS withholds read access from a store the user owns.
    await expect(browserCookieStores({ homeDir, platform: "linux" })).resolves.toEqual([]);
  });

  it("still signs in through the CLI browser when one readable store remains", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-auth-partial-"));
    const denied = join(homeDir, "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies");
    const readable = join(homeDir, "Library/Application Support/Google/Chrome/Default/Cookies");
    for (const path of [denied, readable]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "");
    }
    await chmod(denied, 0o000);

    const cdpLogin = fakeCdp([[cdpCookie("MoodleSession", "fresh-cookie")]]);

    const session = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      homeDir,
      platform: "darwin",
      browserCookieProvider: async () => [],
      validateSession: async (_baseUrl, cookie) => (cookie.value === "fresh-cookie" ? { sesskey: "s", userid: 9 } : null),
      findBrowser: async () => ({ name: "Google Chrome", path: "/Applications/Google Chrome.app" }),
      cdpLogin,
    });

    expect(cdpLogin).toHaveBeenCalledOnce();
    expect(session.userid).toBe(9);
  });

  it("reports an unreachable site as a network fault, not a dead session", async () => {
    const error = await getAuthenticatedSession(BASE_URL, {
      env: { [ENV_MOODLE_SESSION]: "cookie" },
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-network-")),
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    }).then(() => null, (caught: Error & { code?: string; hint?: string }) => caught);

    expect(error?.code).toBe("network");
    expect(error?.message).toContain("school.example.edu");
    // Telling the user to log in again would send them after the wrong problem.
    expect(error?.hint).not.toContain("auth login");
  });

  it("separates an unreadable cookie store from a missing session", () => {
    const blocked = ["Failed to read Safari cookies: EPERM: operation not permitted"];
    expect(cookieAccessBlocked(blocked)).toBe(true);
    expect(cookieAccessBlocked(["Chrome cookies database not found."])).toBe(false);

    const sqliteMissing = ["node:sqlite failed reading Chrome cookies (requires modern Chromium, e.g. Chrome >= 100): No such built-in module: node:sqlite"];
    expect(cookieAccessBlocked(sqliteMissing)).toBe(true);
    expect(authFailureHint(BASE_URL, sqliteMissing, "darwin")).toMatch(/Node\.js 22\.13\.0 or newer/);
    expect(authFailureHint(BASE_URL, sqliteMissing, "darwin")).not.toMatch(/Full Disk Access/);

    const denied = authFailureHint(BASE_URL, blocked, "darwin");
    expect(denied).toContain("Full Disk Access");
    expect(denied).not.toContain("okta-auth");

    const missing = authFailureHint(BASE_URL, ["Chrome cookies database not found."], "darwin");
    expect(missing).toContain("moodle auth login");
    expect(missing).not.toContain("okta");
    // A browser the user does not have is not a diagnostic worth printing.
    expect(missing).not.toContain("Chrome cookies database not found.");
    expect(missing).not.toContain("Cookie store diagnostics");
  });
});

describe("config and session cache", () => {
  it("resolves config as env, cwd config, then user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-cli-"));
    const cwd = join(root, "cwd");
    const homeDir = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "config.yaml"), "base_url: https://cwd.example.edu\n");
    await mkdir(join(homeDir, ".config/moodle-cli"), { recursive: true });
    await writeFile(join(homeDir, ".config/moodle-cli/config.yaml"), "base_url: https://home.example.edu\n");

    await expect(loadConfig({ cwd, homeDir, env: { [ENV_MOODLE_BASE_URL]: "https://env.example.edu" } })).resolves.toMatchObject({ baseUrl: "https://env.example.edu" });
    await expect(loadConfig({ cwd, homeDir, env: {} })).resolves.toMatchObject({ baseUrl: "https://cwd.example.edu" });
    await expect(loadConfig({ cwd: join(root, "empty"), homeDir, env: {} })).resolves.toMatchObject({ baseUrl: "https://home.example.edu" });
  });

  it("supports canonical config and token variables with deprecated fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-cli-env-contract-"));
    const configPath = join(root, "custom.yaml");
    await writeFile(configPath, `base_url: ${BASE_URL}\n`);
    await expect(loadConfig({ env: { [ENV_MOODLE_CONFIG]: configPath } })).resolves.toMatchObject({ baseUrl: BASE_URL });

    const stderr = buffer();
    await expect(loadConfig({ env: { [ENV_MOODLE_URL]: BASE_URL }, stderr: stderr as unknown as NodeJS.WritableStream })).resolves.toMatchObject({ baseUrl: BASE_URL });
    expect(stderr.text()).toContain(`${ENV_MOODLE_URL} is deprecated`);
    expect(loadSessionFromEnv({ [ENV_MOODLE_TOKEN]: "canonical", [ENV_MOODLE_SESSION]: "legacy" })?.value).toBe("canonical");
  });

  it("rejects non-root URLs and non-TTY missing config", async () => {
    expect(() => normalizeBaseUrl(`${BASE_URL}/login/index.php`)).toThrow(/site root/);
    await expect(loadConfig({ cwd: await mkdtemp(join(tmpdir(), "moodle-cli-empty-")), homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-home-")), env: {}, stdin: { isTTY: false } })).rejects.toThrow(/MOODLE_BASE_URL/);
  });

  it("prompts, probes, saves, and then reads the saved config", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-cli-config-"));
    const cwd = join(root, "empty");
    const homeDir = join(root, "home");
    const prompt = vi.fn()
      .mockResolvedValueOnce(`${BASE_URL}/login/index.php`)
      .mockResolvedValueOnce(BASE_URL);
    const fetchImpl = vi.fn(async () => new Response('{"errorcode":"missingparam"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const stderr = buffer();

    await expect(loadConfig({
      cwd,
      homeDir,
      env: {},
      stdin: { isTTY: true },
      prompt,
      fetch: fetchImpl,
      stderr: stderr as unknown as NodeJS.WritableStream,
    })).resolves.toMatchObject({ baseUrl: BASE_URL });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readFile(join(homeDir, ".config/moodle-cli/config.yaml"), "utf8")).toContain(`base_url: ${BASE_URL}`);

    fetchImpl.mockClear();
    await expect(loadConfig({ cwd, homeDir, env: {}, stdin: { isTTY: false } })).resolves.toMatchObject({ baseUrl: BASE_URL });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("encrypts warm sessions with 0600 permissions and honors no-cache", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-cache-"));
    await writeCachedSession(
      { baseUrl: BASE_URL, cookieName: "MoodleSession", cookieValue: "secret", sesskey: "sess", userid: 7, savedAt: 1000 },
      { homeDir },
    );

    const cached = await readCachedSession(BASE_URL, { homeDir, now: () => 1000 });
    expect(cached?.cookieValue).toBe("secret");
    expect(await readCachedSession(BASE_URL, { homeDir, noCache: true })).toBeNull();

    const mode = (await stat(join(homeDir, ".cache/moodle-cli/session.json"))).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = await readFile(join(homeDir, ".cache/moodle-cli/session.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 2, encrypted_session: expect.any(String) });
    expect(raw).not.toContain('"sesskey"');
    expect(raw).not.toContain('"cookieValue"');
  });

  it("uses warm cache without dashboard or cookie reads", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-warm-cache-"));
    await writeCachedSession(
      { baseUrl: BASE_URL, cookieName: "MoodleSessionWarm", cookieValue: "cached-cookie", sesskey: "cached-sess", userid: 7, savedAt: 1000 },
      { homeDir },
    );
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      expect(init?.headers).toMatchObject({ cookie: "MoodleSessionWarm=cached-cookie" });
      return jsonResponse([{ error: false, data: { userid: 7, username: "alice", fullname: "Alice", sitename: "Campus", siteurl: BASE_URL } }]);
    });
    const browserCookieProvider = vi.fn(async () => [{ name: "MoodleSession", value: "browser-cookie", domain: "school.example.edu" }]);
    const validateSession = vi.fn(async () => ({ sesskey: "fresh-sess", userid: 7 }));

    const client = await createMoodleClient(BASE_URL, {
      homeDir,
      now: () => 1000,
      fetchImpl,
      browserCookieProvider,
      validateSession,
    });

    await expect(client.getSiteInfo()).resolves.toMatchObject({ userid: 7, fullname: "Alice" });
    expect(seen).not.toContain(`${BASE_URL}/my/`);
    expect(browserCookieProvider).not.toHaveBeenCalled();
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("keeps learned disabled services and the profile across an expired cache", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-expired-cache-"));
    const user = { userid: 7, username: "alice", fullname: "Alice", sitename: "Campus", siteurl: BASE_URL, lang: "" };
    await writeCachedSession(
      { baseUrl: BASE_URL, cookieName: "MoodleSessionOld", cookieValue: "old-cookie", sesskey: "old-sess", userid: 7, savedAt: 0, unavailable: ["core_webservice_get_site_info"], user },
      { homeDir },
    );
    const fetchImpl = vi.fn(async () => { throw new Error("no request expected"); });
    const browserCookieProvider = vi.fn(async () => [{ name: "MoodleSession", value: "fresh-cookie", domain: "school.example.edu" }]);
    const validateSession = vi.fn(async () => ({ sesskey: "fresh-sess", userid: 7 }));

    const client = await createMoodleClient(BASE_URL, { homeDir, now: () => 48 * 60 * 60 * 1000, fetchImpl, browserCookieProvider, validateSession });

    await expect(client.getSiteInfo()).resolves.toMatchObject({ userid: 7, fullname: "Alice" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(browserCookieProvider).toHaveBeenCalledTimes(1);
    expect((await readCachedSession(BASE_URL, { homeDir, now: () => 48 * 60 * 60 * 1000 }))).toMatchObject({ cookieValue: "fresh-cookie", unavailable: ["core_webservice_get_site_info"], user: { fullname: "Alice" } });
  });

  it("replaces an unrenewable stored mobile token with a fresh one on a new login", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-token-refetch-"));
    // The prior token lacks a privatetoken, so it can never mint a session.
    await writeCachedSession(
      { baseUrl: BASE_URL, cookieName: "MoodleSession", cookieValue: "old-cookie", sesskey: "old-sess", userid: 7, savedAt: 0, mobileToken: { wstoken: "ws-old" } },
      { homeDir },
    );
    const tokenValue = Buffer.from(["site", "ws-new", "private-new"].join(":::"), "utf8").toString("base64");
    const launch = vi.fn(async () => new Response(null, { status: 302, headers: { location: `moodlecli://token=${tokenValue}` } }));

    // now() is 48h out so the seeded cache is expired: the read misses and the
    // browser cookie yields a genuinely new session, but noCache would also skip
    // the write we are asserting on, so rely on expiry instead.
    const now = () => 48 * 60 * 60 * 1000;
    const session = await getAuthenticatedSession(BASE_URL, {
      homeDir,
      now,
      fetch: launch as unknown as typeof fetch,
      captureMobileToken: true,
      browserCookieProvider: async () => [{ name: "MoodleSession", value: "new-cookie", domain: "school.example.edu" }],
      validateSession: async () => ({ sesskey: "new-sess", userid: 7 }),
    });

    expect(session.cookie.value).toBe("new-cookie");
    // The useless stored token must not suppress fetching a real one.
    expect(launch).toHaveBeenCalled();
    const cached = await readCachedSession(BASE_URL, { homeDir, now });
    expect(cached?.mobileToken).toEqual({ wstoken: "ws-new", privatetoken: "private-new" });
  });

  it("detects an instance without the mobile service, caches it, and stops retrying", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-no-mobile-"));
    let configCalls = 0;
    let launchCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/lib/ajax/service-nologin.php")) {
        configCalls += 1;
        return new Response(JSON.stringify([{ error: false, data: { enablewebservices: 1, enablemobilewebservice: 0 } }]), { status: 200 });
      }
      if (url.includes("/admin/tool/mobile/launch.php")) {
        launchCalls += 1;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });

    const login = (value: string, now: () => number) =>
      getAuthenticatedSession(BASE_URL, {
        homeDir,
        now,
        fetch: fetchImpl as unknown as typeof fetch,
        captureMobileToken: true,
        browserCookieProvider: async () => [{ name: "MoodleSession", value, domain: "school.example.edu" }],
        validateSession: async () => ({ sesskey: "sess", userid: 7 }),
      });

    await login("cookie-1", () => 0);
    expect(configCalls).toBe(1);
    expect(launchCalls).toBe(0); // detected unsupported, never asked for a token
    const cached = await readCachedSession(BASE_URL, { homeDir, now: () => 0 });
    expect(cached?.mobileServiceEnabled).toBe(false);
    expect(cached?.mobileToken).toBeUndefined();

    // A later login (cache expired) reuses the cached capability, so no re-probe.
    await login("cookie-2", () => 48 * 60 * 60 * 1000);
    expect(configCalls).toBe(1);
    expect(launchCalls).toBe(0);
  });

  it("renews from a durable mobile token before reading the OS cookie store", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-token-mint-"));
    await writeCachedSession(
      {
        baseUrl: BASE_URL,
        cookieName: "MoodleSession",
        cookieValue: "old-cookie",
        sesskey: "old-sess",
        userid: 7,
        savedAt: 0,
        mobileToken: { wstoken: "ws", privatetoken: "pt" },
        mobileServiceEnabled: true,
      },
      { homeDir },
    );
    const now = () => 48 * 60 * 60 * 1000; // expire the cached cookie

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/webservice/rest/server.php")) {
        return new Response(JSON.stringify({ key: "k", autologinurl: `${BASE_URL}/admin/tool/mobile/autologin.php` }), { status: 200 });
      }
      if (url.includes("/admin/tool/mobile/autologin.php")) {
        return new Response(null, { status: 303, headers: { "set-cookie": "MoodleSession=minted; path=/; HttpOnly" } });
      }
      // The dashboard confirms a genuine login for the same account.
      return new Response('<html><script>var M = {cfg: {"sesskey":"fresh-sess","userid":7}};</script></html>', { status: 200 });
    });
    // If the cookie store is ever consulted, the token path failed to win.
    const browserCookieProvider = vi.fn(async () => []);

    const session = await getAuthenticatedSession(BASE_URL, {
      homeDir,
      now,
      fetch: fetchImpl as unknown as typeof fetch,
      browserCookieProvider,
    });

    expect(session.cookie).toMatchObject({ value: "minted", source: "mobile-token" });
    expect(session.userid).toBe(7);
    expect(browserCookieProvider).not.toHaveBeenCalled();
  });

  it("invalidates a stale cached AJAX session and retries once", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-stale-cache-"));
    await writeCachedSession(
      { baseUrl: BASE_URL, cookieName: "MoodleSessionOld", cookieValue: "old-cookie", sesskey: "old-sess", userid: 7, savedAt: 1000 },
      { homeDir },
    );
    let ajaxCalls = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      ajaxCalls += 1;
      if (ajaxCalls === 1) {
        expect(init?.headers).toMatchObject({ cookie: "MoodleSessionOld=old-cookie" });
        return jsonResponse([{ error: true, exception: { message: "Login required", errorcode: "servicerequireslogin" } }]);
      }
      expect(init?.headers).toMatchObject({ cookie: "MoodleSessionFresh=fresh-cookie" });
      return jsonResponse([{ error: false, data: { userid: 7, username: "alice", fullname: "Alice", sitename: "Campus", siteurl: BASE_URL } }]);
    });
    const browserCookieProvider = vi.fn(async () => [{ name: "MoodleSessionFresh", value: "fresh-cookie", domain: "school.example.edu" }]);
    const validateSession = vi.fn(async () => ({ sesskey: "fresh-sess", userid: 7 }));

    const client = await createMoodleClient(BASE_URL, {
      homeDir,
      now: () => 1000,
      fetchImpl,
      browserCookieProvider,
      validateSession,
    });

    await expect(client.getSiteInfo()).resolves.toMatchObject({ userid: 7, fullname: "Alice" });
    expect(ajaxCalls).toBe(2);
    expect(browserCookieProvider).toHaveBeenCalledTimes(1);
    expect((await readCachedSession(BASE_URL, { homeDir, now: () => 1000 }))?.cookieValue).toBe("fresh-cookie");
  });
});

describe("agent output contract", () => {
  it("filters fields and rejects unknown fields", () => {
    expect(render([{ id: 1, name: "Course" }], { format: "json", fields: ["id", "name"] })).toBe('[\n  {\n    "id": 1,\n    "name": "Course"\n  }\n]\n');
    expect(resolveFormat({}, false)).toBe("json");
    expect(resolveFormat({}, true)).toBe("table");
  });

  it("auto-emits JSON on a pipe and emits JSON errors", async () => {
    const dashboard = '<script>M.cfg = {"sesskey":"sess","userId":7,"language":"en"};</script><body data-user-id="7"><span class="userfullname">Alice</span></body>';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE_URL}/my/`) {
        return new Response(dashboard, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (init?.method === "POST" && url.includes("/lib/ajax/service.php")) {
        return new Response(JSON.stringify([{ error: false, data: { userid: 7, username: "alice", fullname: "Alice", sitename: "Campus", siteurl: BASE_URL } }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const stdout = buffer();
    const stderr = buffer();
    const code = await runCli(["node", "moodle", "user", "--fields", "user"], {
      env: { [ENV_MOODLE_BASE_URL]: BASE_URL, [ENV_MOODLE_SESSION]: "cookie" },
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-json-pipe-")),
      fetchImpl,
      stdout,
      stderr,
      stdin: { isTTY: false } as NodeJS.ReadStream,
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ user: { id: 7, name: "Alice" } });
    expect(stdout.text().trim()).not.toContain("\n");
    expect(stderr.text()).toBe("");

    const errorStdout = buffer();
    const errorStderr = buffer();
    const errorCode = await runCli(["node", "moodle", "unit"], {
      stdout: errorStdout,
      stderr: errorStderr,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      env: {},
    });
    expect(errorCode).toBe(2);
    expect(JSON.parse(errorStderr.text())).toMatchObject({ ok: false, error: { code: "usage" }, exit_code: 2 });
  });

  it("keeps exit codes stable across success, unexpected, auth/config, usage, and not-found cases", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-exits-"));
    await expect(runCli(["node", "moodle", "-V"], { homeDir, stdout: buffer(), stderr: buffer() })).resolves.toBe(0);

    const configStderr = buffer();
    await expect(runCli(["node", "moodle", "user", "--json"], {
      homeDir,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: buffer(),
      stderr: configStderr,
      env: {},
    })).resolves.toBe(1);
    expect(JSON.parse(configStderr.text())).toMatchObject({ error: { code: "config" }, exit_code: 1 });

    const unexpectedStderr = buffer();
    await expect(runCli(["node", "moodle", "user", "--json"], {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-unexpected-")),
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: buffer(),
      stderr: unexpectedStderr,
      env: { [ENV_MOODLE_BASE_URL]: BASE_URL, [ENV_MOODLE_SESSION]: "cookie" },
      fetchImpl: fetchFor({
        ajax: () => jsonResponse({ unexpected: true }),
      }),
    })).resolves.toBe(1);
    expect(JSON.parse(unexpectedStderr.text())).toMatchObject({ error: { code: "unexpected" }, exit_code: 1 });

    const notFoundStderr = buffer();
    await expect(runCli(["node", "moodle", "units", "Physics", "--json"], {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-not-found-")),
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: buffer(),
      stderr: notFoundStderr,
      env: { [ENV_MOODLE_BASE_URL]: BASE_URL, [ENV_MOODLE_SESSION]: "cookie" },
      fetchImpl: fetchFor({
        ajax: () => jsonResponse([{ error: false, data: [] }]),
      }),
    })).resolves.toBe(4);
    expect(JSON.parse(notFoundStderr.text())).toMatchObject({ error: { code: "not_found" }, exit_code: 4 });
  });

  it("prints auth failure hints with exit 3", async () => {
    const stderr = buffer();
    const code = await runCli(["node", "moodle", "user", "--json"], {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-fail-")),
      env: { [ENV_MOODLE_BASE_URL]: BASE_URL, [ENV_MOODLE_SESSION]: "bad-cookie" },
      fetchImpl: async () => new Response('<input name="username"><input name="password">', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: buffer(),
      stderr,
    });

    expect(code).toBe(3);
    const error = JSON.parse(stderr.text());
    expect(error).toMatchObject({ ok: false, error: { code: "auth" }, exit_code: 3 });
    expect(error.error.hint).toContain("moodle auth login");
    expect(error.error.hint).toContain("moodle auth login --paste");
  });
});

function buffer() {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text() {
      return value;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function fetchFor(options: { ajax: (request: { url: string; init?: RequestInit }) => Response }) {
  const dashboard = '<script>M.cfg = {"sesskey":"sess","userId":7,"language":"en"};</script><body data-user-id="7"><span class="userfullname">Alice</span></body>';
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE_URL}/my/`) {
      return new Response(dashboard, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (init?.method === "POST" && url.includes("/lib/ajax/service.php")) {
      return options.ajax({ url, init });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

vi.mock("../src/session-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/session-cache.js")>();
  const encryptionKey = async () => "synthetic-test-cache-encryption-key";
  return {
    ...actual,
    readCachedSession: (baseUrl: string, options = {}) => actual.readCachedSession(baseUrl, { ...options, encryptionKey }),
    writeCachedSession: (session: import("../src/session-cache.js").CachedSession, options = {}) => actual.writeCachedSession(session, { ...options, encryptionKey }),
    deleteCachedSession: (baseUrl: string, options = {}) => actual.deleteCachedSession(baseUrl, { ...options, encryptionKey }),
  };
});
