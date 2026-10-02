import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createMoodleClientCore } from "../src/moodle-client-core.js";

const BASE_URL = "https://moodle.example.edu";

describe("runtime-neutral Moodle client core", () => {
  it("calls the runtime global fetch without binding a receiver", async () => {
    const originalFetch = globalThis.fetch;
    const bindingSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new Error("Illegal invocation");
      return Promise.resolve(new Response("ok"));
    });
    vi.stubGlobal("fetch", bindingSensitiveFetch);
    try {
      const client = createMoodleClientCore(BASE_URL, {
        cookie: { name: "MoodleSession", value: "secret-cookie" },
        sesskey: "session-key",
        userid: 7,
      });
      await expect((await client.requestAbsolute(`${BASE_URL}/my/`)).text()).resolves.toBe("ok");
      expect(bindingSensitiveFetch).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("returns authenticated responses and keeps Moodle cookies on the configured origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const cookie = new Headers(init?.headers).get("cookie");
      expect(cookie).toBe(url.startsWith(BASE_URL) ? "MoodleSession=secret-cookie" : null);
      return new Response(url.endsWith("slides.pdf") ? "slides" : "public");
    });
    const client = createMoodleClientCore(BASE_URL, {
      cookie: { name: "MoodleSession", value: "secret-cookie" },
      sesskey: "session-key",
      userid: 7,
      fetchImpl,
    });

    await expect((await client.requestAbsolute(`${BASE_URL}/pluginfile.php/slides.pdf`)).text()).resolves.toBe("slides");
    await expect((await client.requestAbsolute("https://cdn.example.edu/public.pdf")).text()).resolves.toBe("public");
  });

  it("retries an authenticated response once after login and then reports expiry", async () => {
    const onLoginRequired = vi.fn(async () => ({
      cookie: { name: "MoodleSession", value: "renewed-cookie" },
      pageContext: {
        sesskey: "renewed-key",
        user_info: {
          userid: 8,
          username: "grace",
          fullname: "Grace Hopper",
          sitename: "Example Moodle",
          siteurl: BASE_URL,
        },
      },
    }));
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const response = new Response("login", { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: `${BASE_URL}/login/index.php` });
      return response;
    });
    const client = createMoodleClientCore(BASE_URL, {
      cookie: { name: "MoodleSession", value: "expired-cookie" },
      sesskey: "expired-key",
      userid: 7,
      fetchImpl,
      onLoginRequired,
    });

    await expect(client.requestAbsolute(`${BASE_URL}/pluginfile.php/slides.pdf`)).rejects.toMatchObject({
      code: "auth",
    });
    expect(onLoginRequired).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the requested response after one successful reauthentication", async () => {
    const onLoginRequired = vi.fn(async () => ({
      cookie: { name: "MoodleSession", value: "renewed-cookie" },
      pageContext: {
        sesskey: "renewed-key",
        user_info: {
          userid: 8,
          username: "grace",
          fullname: "Grace Hopper",
          sitename: "Example Moodle",
          siteurl: BASE_URL,
        },
      },
    }));
    let request = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      request += 1;
      const cookie = new Headers(init?.headers).get("cookie");
      if (request === 1) {
        expect(cookie).toBe("MoodleSession=expired-cookie");
        const login = new Response("login", { headers: { "content-type": "text/html" } });
        Object.defineProperty(login, "url", { value: `${BASE_URL}/login/index.php` });
        return login;
      }
      expect(cookie).toBe("MoodleSession=renewed-cookie");
      return new Response("slides", { headers: { "content-type": "application/pdf" } });
    });
    const client = createMoodleClientCore(BASE_URL, {
      cookie: { name: "MoodleSession", value: "expired-cookie" },
      sesskey: "expired-key",
      userid: 7,
      fetchImpl,
      onLoginRequired,
    });

    const response = await client.requestAbsolute(`${BASE_URL}/pluginfile.php/slides.pdf`);

    await expect(response.text()).resolves.toBe("slides");
    expect(onLoginRequired).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  describe("concurrent reads that are rejected as signed out", () => {
    const renewed = {
      cookie: { name: "MoodleSession", value: "renewed-cookie" },
      pageContext: {
        sesskey: "renewed-key",
        user_info: { userid: 7, username: "ada", fullname: "Ada", sitename: "Example Moodle", siteurl: BASE_URL },
      },
    };
    const loginPage = () => {
      const response = new Response("login", { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: `${BASE_URL}/login/index.php` });
      return response;
    };

    it("joins one in-flight reauthentication and retries each read with the new session", async () => {
      let finish!: () => void;
      const onLoginRequired = vi.fn(() => new Promise<typeof renewed>((resolve) => { finish = () => resolve(renewed); }));
      const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
        const cookie = new Headers(init?.headers).get("cookie");
        return cookie === "MoodleSession=renewed-cookie" ? new Response("slides") : loginPage();
      });
      const client = createMoodleClientCore(BASE_URL, {
        cookie: { name: "MoodleSession", value: "expired-cookie" },
        sesskey: "expired-key",
        userid: 7,
        fetchImpl,
        onLoginRequired,
      });

      const reads = [client.requestAbsolute(`${BASE_URL}/a`), client.requestAbsolute(`${BASE_URL}/b`)];
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(onLoginRequired).toHaveBeenCalledOnce());
      finish();

      for (const read of reads) await expect((await read).text()).resolves.toBe("slides");
      expect(onLoginRequired).toHaveBeenCalledOnce();
    });

    it("retries a read that was rejected before recovery finished without a second recovery", async () => {
      const onLoginRequired = vi.fn(async () => renewed);
      let releaseSlow!: () => void;
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const cookie = new Headers(init?.headers).get("cookie");
        if (cookie === "MoodleSession=renewed-cookie") return new Response("slides");
        // The slow read was sent with the old cookie and is only rejected after the fast read recovered.
        if (String(input).endsWith("/slow")) await new Promise<void>((resolve) => { releaseSlow = resolve; });
        return loginPage();
      });
      const client = createMoodleClientCore(BASE_URL, {
        cookie: { name: "MoodleSession", value: "expired-cookie" },
        sesskey: "expired-key",
        userid: 7,
        fetchImpl,
        onLoginRequired,
      });

      const slow = client.requestAbsolute(`${BASE_URL}/slow`);
      await vi.waitFor(() => expect(releaseSlow).toBeTypeOf("function"));
      await expect((await client.requestAbsolute(`${BASE_URL}/fast`)).text()).resolves.toBe("slides");
      releaseSlow();

      await expect((await slow).text()).resolves.toBe("slides");
      expect(onLoginRequired).toHaveBeenCalledOnce();
    });

    it("rejects every joined read when the shared reauthentication fails", async () => {
      const onLoginRequired = vi.fn(async () => { throw new Error("no session"); });
      const fetchImpl = vi.fn<typeof fetch>(async () => loginPage());
      const client = createMoodleClientCore(BASE_URL, {
        cookie: { name: "MoodleSession", value: "expired-cookie" },
        sesskey: "expired-key",
        userid: 7,
        fetchImpl,
        onLoginRequired,
      });

      const results = await Promise.allSettled([client.requestAbsolute(`${BASE_URL}/a`), client.requestAbsolute(`${BASE_URL}/b`)]);

      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(onLoginRequired).toHaveBeenCalledOnce();
    });
  });

  it("does not forward the Moodle cookie across an actual cross-origin redirect", async () => {
    let redirectedCookie: string | undefined;
    const target = createServer((request, response) => {
      redirectedCookie = request.headers.cookie;
      response.end("slides");
    });
    const targetUrl = await listen(target);
    const source = createServer((request, response) => {
      expect(request.headers.cookie).toBe("MoodleSession=secret-cookie");
      response.writeHead(302, { location: `${targetUrl}/slides.pdf` });
      response.end();
    });
    const sourceUrl = await listen(source);
    const client = createMoodleClientCore(sourceUrl, {
      cookie: { name: "MoodleSession", value: "secret-cookie" },
      sesskey: "session-key",
      userid: 7,
    });

    try {
      const response = await client.requestAbsolute(`${sourceUrl}/resource`);
      await expect(response.text()).resolves.toBe("slides");
      expect(redirectedCookie).toBeUndefined();
    } finally {
      await Promise.all([close(source), close(target)]);
    }
  });

  it("runs existing Moodle operations from an injected Worker session", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const info = new URL(String(input)).searchParams.get("info");
      const data = info === "core_webservice_get_site_info"
        ? {
            userid: 7,
            username: "ada",
            fullname: "Ada Lovelace",
            sitename: "Example Moodle",
            siteurl: BASE_URL,
            sesskey: "session-key",
          }
        : [{
            id: 101,
            shortname: "COMP101",
            fullname: "Computing",
            category: 1,
            visible: true,
            startdate: 1,
          }];
      expect(new Headers(init?.headers).get("cookie")).toBe("MoodleSession=secret-cookie");
      return new Response(JSON.stringify([{ error: false, data }]));
    });
    const client = createMoodleClientCore(BASE_URL, {
      cookie: { name: "MoodleSession", value: "secret-cookie" },
      sesskey: "session-key",
      userid: 7,
      fetchImpl,
    });

    await expect(client.getSiteInfo()).resolves.toMatchObject({ userid: 7, fullname: "Ada Lovelace" });
    await expect(client.getCourses()).resolves.toEqual([
      expect.objectContaining({ id: 101, shortname: "COMP101" }),
    ]);
  });

  it("injects reauthentication and persistence without importing Node cache code", async () => {
    const clearSessionCache = vi.fn(async () => undefined);
    const writeSessionCache = vi.fn(async () => undefined);
    const onLoginRequired = vi.fn(async () => ({
      cookie: { name: "MoodleSession", value: "renewed-cookie" },
      pageContext: {
        sesskey: "renewed-key",
        user_info: {
          userid: 8,
          username: "grace",
          fullname: "Grace Hopper",
          sitename: "Example Moodle",
          siteurl: BASE_URL,
        },
      },
    }));
    let request = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      request += 1;
      const cookie = new Headers(init?.headers).get("cookie");
      if (request === 1) {
        expect(cookie).toBe("MoodleSession=expired-cookie");
        return new Response(JSON.stringify([{
          error: true,
          exception: { message: "Login required", errorcode: "servicerequireslogin" },
        }]));
      }
      expect(cookie).toBe("MoodleSession=renewed-cookie");
      return new Response(JSON.stringify([{ error: false, data: [] }]));
    });
    const client = createMoodleClientCore(BASE_URL, {
      cookie: { name: "MoodleSession", value: "expired-cookie" },
      sesskey: "expired-key",
      userid: 7,
      fetchImpl,
      clearSessionCache,
      writeSessionCache,
      onLoginRequired,
    });

    await expect(client.getCourses()).resolves.toEqual([]);
    expect(clearSessionCache).toHaveBeenCalledOnce();
    expect(onLoginRequired).toHaveBeenCalledOnce();
    expect(writeSessionCache).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: BASE_URL,
      cookieValue: "renewed-cookie",
      sesskey: "renewed-key",
      userid: 8,
    }));
  });

  it("keeps the complete core import graph Worker-safe", () => {
    const files = localImportGraph(resolve("src/moodle-client-core.ts"));
    const graph = files.map((file) => `${file}\n${readFileSync(file, "utf8")}`).join("\n");

    expect(graph).not.toMatch(/(?:^|["'/])auth\.js/);
    expect(graph).not.toMatch(/session-cache\.js/);
    expect(graph).not.toMatch(/@steipete\/sweet-cookie/);
    expect(graph).not.toMatch(/(?:from\s+|import\s*)["']node:/);
  });
});

function localImportGraph(entry: string): string[] {
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["'](\.[^"']+)["']/g)) {
      const imported = resolve(dirname(file), match[1].replace(/\.js$/, ".ts"));
      visit(imported);
    }
  };
  visit(entry);
  return [...visited];
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
