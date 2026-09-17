import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findChromiumBrowser, loginWithCdp, type CdpCookie } from "../src/cdp-login.js";

/**
 * A stand-in for a Chromium process speaking CDP over fds 3 and 4. It answers
 * Browser.getVersion, replays a script of cookie sets for Storage.getCookies,
 * and records Browser.close.
 */
function fakeChrome(cookieScript: CdpCookie[][], exitAfterCookies?: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdio: [null, null, PassThrough, PassThrough, PassThrough];
    killed: boolean;
    kill: () => void;
  };
  const toBrowser = new PassThrough(); // fd 3: CLI -> browser
  const fromBrowser = new PassThrough(); // fd 4: browser -> CLI
  child.stdio = [null, null, new PassThrough(), toBrowser, fromBrowser];
  child.killed = false;
  child.kill = () => {
    child.killed = true;
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
