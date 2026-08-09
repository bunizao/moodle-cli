import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createMoodleClientCore } from "../src/moodle-client-core.js";

const BASE_URL = "https://moodle.example.edu";

describe("runtime-neutral Moodle client core", () => {
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
