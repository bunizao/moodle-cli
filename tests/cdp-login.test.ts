import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CdpError, findChromiumBrowser, loginWithCdp, type CdpCookie } from "../src/cdp-login.js";

/**
 * A stand-in for a Chromium process speaking CDP over fds 3 and 4. It answers
 * Browser.getVersion, replays a script of cookie sets for Storage.getCookies,
 * and records Browser.close.
 */
function fakeChrome(cookieScript: CdpCookie[][], exitAfterCookies?: number, ignoreClose = false) {
  const child = new EventEmitter() as EventEmitter & {
    stdio: [null, null, PassThrough, PassThrough, PassThrough];
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => void;
  };
  const toBrowser = new PassThrough(); // fd 3: CLI -> browser
  const fromBrowser = new PassThrough(); // fd 4: browser -> CLI
  child.stdio = [null, null, new PassThrough(), toBrowser, fromBrowser];
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", null, "SIGTERM");
  };

  let getCookieCalls = 0;
  let buffer = "";
  toBrowser.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\0")) !== -1) {
      const message = JSON.parse(buffer.slice(0, index)) as { id: number; method: string };
      buffer = buffer.slice(index + 1);
      const reply = (result: unknown) => fromBrowser.write(`${JSON.stringify({ id: message.id, result })}\0`);
      if (message.method === "Browser.close" && ignoreClose) continue; // simulate a wedged browser
      if (message.method === "Browser.getVersion") reply({ product: "Chrome/999" });
      else if (message.method === "Storage.getCookies") {
        const frame = cookieScript[Math.min(getCookieCalls, cookieScript.length - 1)] ?? [];
        getCookieCalls += 1;
        reply({ cookies: frame });
        // Simulate the profile being locked: the browser dies after answering.
        if (exitAfterCookies !== undefined && getCookieCalls >= exitAfterCookies) {
          setImmediate(() => child.emit("exit", 0));
        }
      } else reply({});
    }
  });

  return { child, spawn: vi.fn(() => child) };
}

describe("findChromiumBrowser", () => {
  it("honours an explicit browser path", async () => {
    await expect(findChromiumBrowser({ browserPath: "/opt/chrome" } as never)).resolves.toEqual({
      name: "Chromium",
      path: "/opt/chrome",
    });
  });

  it("returns null on Linux with an empty PATH", async () => {
    await expect(findChromiumBrowser({ platform: "linux", env: { PATH: "" } } as never)).resolves.toBeNull();
  });
});

describe("loginWithCdp", () => {
  it("reads cookies from the live browser once the login predicate passes", async () => {
    const { child, spawn } = fakeChrome([
      [{ name: "MoodleSession", value: "anon", domain: "school.example.edu" }],
      [{ name: "MoodleSession", value: "live", domain: "school.example.edu" }],
    ]);

    const result = await loginWithCdp({
      url: "https://school.example.edu/login/index.php",
      profileDir: await mkdtemp(join(tmpdir(), "cdp-profile-")),
      browserPath: "/fake/chrome",
      spawn: spawn as never,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      isDone: (cookies) => cookies.some((cookie) => cookie.value === "live"),
    });

    expect(result.cookies.find((cookie) => cookie.name === "MoodleSession")?.value).toBe("live");
    // Best-effort shutdown of the browser we launched.
    expect(child.killed).toBe(true);
  });

  it("returns promptly and kills the process when Browser.close is never acknowledged", async () => {
    const { child, spawn } = fakeChrome(
      [[{ name: "MoodleSession", value: "live", domain: "school.example.edu" }]],
      undefined,
      true, // ignore Browser.close, as a hung browser would
    );

    const result = await loginWithCdp({
      url: "https://school.example.edu/login/index.php",
      profileDir: await mkdtemp(join(tmpdir(), "cdp-profile-")),
      browserPath: "/fake/chrome",
      spawn: spawn as never,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      closeTimeoutMs: 5, // do not wait the real 2s for the unresponsive close
      isDone: (cookies) => cookies.some((cookie) => cookie.value === "live"),
    });

    expect(result.cookies.find((cookie) => cookie.name === "MoodleSession")?.value).toBe("live");
    // The polite close timed out, so we fell through to killing the process.
    expect(child.killed).toBe(true);
  });

  it("surfaces a spawn/pipe error as a CdpError instead of an uncaught exception", async () => {
    const { child, spawn } = fakeChrome([[]]);
    // A failed launch (ENOENT) or broken pipe arrives as an 'error' event on the
    // child. Emit it right after spawn, before the handshake can complete.
    const spawnThenError = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });

    await expect(
      loginWithCdp({
        url: "https://school.example.edu/login/index.php",
        profileDir: await mkdtemp(join(tmpdir(), "cdp-profile-")),
        browserPath: "/fake/chrome",
        spawn: spawnThenError as never,
        handshakeTimeoutMs: 1_000,
        sleep: async () => undefined,
        isDone: () => false,
      }),
    ).rejects.toBeInstanceOf(CdpError);
  });

  it("terminates a live browser after its CDP pipe breaks", async () => {
    const { child, spawn } = fakeChrome([[]]);
    const kill = vi.spyOn(child, "kill");
    await expect(loginWithCdp({
      url: "https://school.example.edu/login/index.php",
      profileDir: await mkdtemp(join(tmpdir(), "cdp-broken-pipe-")),
      browserPath: "/fake/chrome", spawn: spawn as never,
      onOpened: () => child.stdio[3].emit("error", new Error("EPIPE")),
      isDone: () => false,
    })).rejects.toBeInstanceOf(CdpError);
    expect(kill).toHaveBeenCalledOnce();
  });

  it("escalates to SIGKILL when a browser with a broken pipe ignores SIGTERM", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "cdp-broken-stubborn-"));
    const { child, spawn } = fakeChrome([[]]);
    const kill = vi.spyOn(child, "kill").mockImplementation((signal) => {
      child.killed = true;
      if (signal === "SIGKILL") child.emit("exit", null, signal);
    });
    vi.useFakeTimers();
    try {
      await expect(loginWithCdp({
        url: "https://school.example.edu/login/index.php",
        profileDir, browserPath: "/fake/chrome", spawn: spawn as never,
        onOpened: () => child.stdio[4].emit("error", new Error("Pipe failed")),
        isDone: () => false,
      })).rejects.toBeInstanceOf(CdpError);
      expect(kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(kill).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails with a clear error when the browser exits before sign-in", async () => {
    const { spawn } = fakeChrome([[]], 1);

    await expect(
      loginWithCdp({
        url: "https://school.example.edu/login/index.php",
        profileDir: await mkdtemp(join(tmpdir(), "cdp-profile-")),
        browserPath: "/fake/chrome",
        spawn: spawn as never,
        pollIntervalMs: 1,
        // A real macrotask yield, so the simulated exit is observed between polls.
        sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
        timeoutMs: 1_000,
        isDone: () => false,
      }),
    ).rejects.toThrow(/closed before sign-in/);
  });
});
