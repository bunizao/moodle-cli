import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  authFailureHint,
  braveProfilePaths,
  cookieAccessBlocked,
  getAuthenticatedSession,
  getAuthenticatedSessionWithBrowserFallback,
  loadSessionFromEnv,
  matchingMoodleSessionCookies,
} from "../src/auth.js";
import { loadConfig, normalizeBaseUrl } from "../src/config.js";
import { ENV_MOODLE_BASE_URL, ENV_MOODLE_CONFIG, ENV_MOODLE_SESSION, ENV_MOODLE_TOKEN, ENV_MOODLE_URL } from "../src/constants.js";
import { readCachedSession, writeCachedSession } from "../src/session-cache.js";
import { render, resolveFormat } from "@bunizao/cli-kit";
import { runCli } from "../src/cli.js";
import { createMoodleClient } from "../src/client.js";

const BASE_URL = "https://school.example.edu";

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

  it("does not open a browser when automatic extraction succeeds", async () => {
    const openBrowser = vi.fn(async () => undefined);

    const session = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-auto-")),
      browserCookieProvider: async () => [
        { name: "MoodleSession", value: "browser-cookie", domain: "school.example.edu" },
      ],
      oktaCookieProvider: async () => [],
      validateSession: async () => ({ sesskey: "sess", userid: 7 }),
      openBrowser,
    });

    expect(session.cookie.value).toBe("browser-cookie");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("opens Moodle login and retries extraction when no session is available", async () => {
    let reads = 0;
    const openBrowser = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);

    const session = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-browser-")),
      browserCookieProvider: async () => {
        reads += 1;
        return reads === 1
          ? []
          : [{ name: "MoodleSessionSSO", value: "fresh-cookie", domain: ".school.example.edu" }];
      },
      oktaCookieProvider: async () => [],
      validateSession: async (_baseUrl, cookie) =>
        cookie.value === "fresh-cookie" ? { sesskey: "fresh-sess", userid: 9 } : null,
      openBrowser,
      sleep,
      browserLoginTimeoutMs: 2_000,
      browserLoginPollIntervalMs: 100,
    });

    expect(openBrowser).toHaveBeenCalledWith(`${BASE_URL}/login/index.php`);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(session).toMatchObject({ userid: 9, sesskey: "fresh-sess" });
  });

  it("ignores a stale environment session during browser fallback", async () => {
    let browserReads = 0;
    const openBrowser = vi.fn(async () => undefined);

    const session = await getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
      env: { [ENV_MOODLE_SESSION]: "stale-cookie" },
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-stale-env-")),
      browserCookieProvider: async () => {
        browserReads += 1;
        return browserReads === 1
          ? []
          : [{ name: "MoodleSession", value: "fresh-cookie", domain: "school.example.edu" }];
      },
      oktaCookieProvider: async () => [],
      validateSession: async (_baseUrl, cookie) =>
        cookie.value === "fresh-cookie" ? { sesskey: "fresh-sess", userid: 9 } : null,
      openBrowser,
      sleep: async () => undefined,
      browserLoginTimeoutMs: 1_000,
      browserLoginPollIntervalMs: 100,
    });

    expect(openBrowser).toHaveBeenCalledOnce();
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

  it("reports a blocked cookie store instead of looping on a browser login", async () => {
    const openBrowser = vi.fn(async () => undefined);
    const blocked = "Failed to read Safari cookies: EPERM: operation not permitted, open '/Users/x/Cookies.binarycookies'";

    await expect(
      getAuthenticatedSessionWithBrowserFallback(BASE_URL, {
        homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-auth-blocked-")),
        platform: "darwin",
        browserCookieProvider: async (_baseUrl, options) => {
          options.onCookieWarnings?.([blocked]);
          return [];
        },
        oktaCookieProvider: async () => [],
        validateSession: async () => null,
        openBrowser,
      }),
    ).rejects.toThrow(/Cannot read browser cookies/);

    // A login cannot produce a cookie we are still not allowed to read.
    expect(openBrowser).not.toHaveBeenCalled();
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
    expect(missing).toContain("okta-auth");
    expect(missing).toContain("Chrome cookies database not found.");
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

  it("persists warm sessions with 0600 permissions and honors no-cache reads", async () => {
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
    expect(JSON.parse(raw).sesskey).toBe("sess");
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
    const code = await runCli(["node", "moodle", "user", "--fields", "userid,fullname"], {
      env: { [ENV_MOODLE_BASE_URL]: BASE_URL, [ENV_MOODLE_SESSION]: "cookie" },
      homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-json-pipe-")),
      fetchImpl,
      stdout,
      stderr,
      stdin: { isTTY: false } as NodeJS.ReadStream,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toBe('{\n  "userid": 7,\n  "fullname": "Alice"\n}\n');
    expect(stderr.text()).toBe("");

    const errorStdout = buffer();
    const errorStderr = buffer();
    const errorCode = await runCli(["node", "moodle", "not-a-command"], {
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
    expect(error.error.hint).toContain("MOODLE_SESSION");
    expect(error.error.hint).toContain("okta-auth");
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
