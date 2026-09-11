import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildKeepalivePlist,
  getAuthStatus,
  keepAliveOnce,
  keepaliveProgramArguments,
  touchMoodleSession,
} from "../src/keepalive.js";
import { readCachedSession, writeCachedSession } from "../src/session-cache.js";

const BASE_URL = "https://school.example.edu";
const COOKIE = { name: "MoodleSession", value: "cookie" };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function cacheDir(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-keepalive-"));
  await writeCachedSession(
    { baseUrl: BASE_URL, cookieName: COOKIE.name, cookieValue: COOKIE.value, sesskey: "sess", userid: 7, savedAt: 1000 },
    { homeDir },
  );
  return homeDir;
}

describe("touchMoodleSession", () => {
  it("reports a live session with the remaining server time", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("core_session_touch,core_session_time_remaining");
      expect(init?.headers).toMatchObject({ cookie: "MoodleSession=cookie" });
      return jsonResponse([
        { error: false, data: true },
        { error: false, data: { userid: 7, timeremaining: 14400 } },
      ]);
    });

    const result = await touchMoodleSession(BASE_URL, COOKIE, "sess", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ alive: true, timeRemainingSeconds: 14400 });
  });

  it("reports an expired session on servicerequireslogin", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ error: true, exception: { errorcode: "servicerequireslogin", message: "expired" } }]));
    const result = await touchMoodleSession(BASE_URL, COOKIE, "sess", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ alive: false, timeRemainingSeconds: null });
  });

  it("treats an SSO redirect to HTML as expired and network failure as unknown", async () => {
    const ssoFetch = vi.fn(async () => new Response("<html>okta</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await touchMoodleSession(BASE_URL, COOKIE, "sess", ssoFetch as unknown as typeof fetch)).alive).toBe(false);

    const downFetch = vi.fn(async () => {
      throw new Error("offline");
    });
    expect((await touchMoodleSession(BASE_URL, COOKIE, "sess", downFetch as unknown as typeof fetch)).alive).toBeNull();
  });
});

describe("keepAliveOnce", () => {
  it("renews the cache timestamp when the session is alive", async () => {
    const homeDir = await cacheDir();
    const fetchImpl = vi.fn(async () => jsonResponse([
      { error: false, data: true },
      { error: false, data: { userid: 7, timeremaining: 7200 } },
    ]));

    const result = await keepAliveOnce(BASE_URL, { homeDir, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 5000 });
    expect(result).toEqual({ status: "renewed", time_remaining_seconds: 7200 });
    expect((await readCachedSession(BASE_URL, { homeDir, now: () => 5000 }))?.savedAt).toBe(5000);
  });

  it("re-authenticates when the session is expired", async () => {
    const homeDir = await cacheDir();
    const fetchImpl = vi.fn(async () => jsonResponse([{ error: true, exception: { errorcode: "servicerequireslogin" } }]));
    const authenticate = vi.fn(async () => ({}));

    const result = await keepAliveOnce(BASE_URL, { homeDir, fetchImpl: fetchImpl as unknown as typeof fetch, authenticate });
    expect(result.status).toBe("reauthenticated");
    expect(authenticate).toHaveBeenCalledWith(BASE_URL);
  });

  it("reports expired when re-authentication fails and honors --no-renew", async () => {
    const homeDir = await cacheDir();
    const fetchImpl = vi.fn(async () => jsonResponse([{ error: true, exception: { errorcode: "servicerequireslogin" } }]));

    const failed = await keepAliveOnce(BASE_URL, {
      homeDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authenticate: async () => {
        throw new Error("no cookies");
      },
    });
    expect(failed.status).toBe("expired");

    const skipped = await keepAliveOnce(BASE_URL, { homeDir, fetchImpl: fetchImpl as unknown as typeof fetch, renewOnExpiry: false });
    expect(skipped.status).toBe("expired");
  });

  it("reports no_session without a cache and unreachable when the site is down", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "moodle-cli-keepalive-empty-"));
    expect((await keepAliveOnce(BASE_URL, { homeDir: emptyHome })).status).toBe("no_session");

    const homeDir = await cacheDir();
    const downFetch = vi.fn(async () => {
      throw new Error("offline");
    });
    expect((await keepAliveOnce(BASE_URL, { homeDir, fetchImpl: downFetch as unknown as typeof fetch })).status).toBe("unreachable");
  });
});

describe("getAuthStatus", () => {
  it("summarizes cache age and server session state without extending the session", async () => {
    const homeDir = await cacheDir();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toContain("info=core_session_time_remaining");
      expect(String(url)).not.toContain("core_session_touch");
      return jsonResponse([{ error: false, data: { userid: 7, timeremaining: 600 } }]);
    });

    const status = await getAuthStatus(BASE_URL, { homeDir, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1000 + 10 * 60_000 });
    expect(status).toMatchObject({
      session_cached: true,
      cache_age_minutes: 10,
      session_alive: true,
      session_time_remaining_seconds: 600,
      keepalive_installed: false,
    });
  });
});

describe("keepalive launch agent", () => {
  it("builds a plist that runs the CLI entry through node", () => {
    const args = keepaliveProgramArguments("/usr/local/bin/node", "/opt/moodle-cli/dist/moodle.js");
    expect(args).toEqual(["/usr/local/bin/node", "/opt/moodle-cli/dist/moodle.js", "auth", "keepalive", "--json"]);

    const plist = buildKeepalivePlist(args, 30, "/tmp/keepalive & log.txt");
    expect(plist).toContain("<string>com.moodle-cli.keepalive</string>");
    expect(plist).toContain("<integer>1800</integer>");
    expect(plist).toContain("/tmp/keepalive &amp; log.txt");
    expect(plist).toContain("<string>auth</string>");
  });

  it("omits argv1 for standalone binaries", () => {
    expect(keepaliveProgramArguments("/usr/local/bin/moodle", "/usr/local/bin/moodle")).toEqual([
      "/usr/local/bin/moodle",
      "auth",
      "keepalive",
      "--json",
    ]);
  });
});

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
