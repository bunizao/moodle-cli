import { describe, expect, it } from "vitest";
import { isLoginRedirect, loginUrl, matchingMoodleSessionCookies } from "../src/auth.js";
import { fetchWithSession } from "../src/session-fetch.js";
import { resolveTopLevelUrl } from "../src/url-resolver.js";

const HOST = "https://school.example.edu";
const ROOT = `${HOST}/elearning/moodle`;

describe("a Moodle install under a path", () => {
  it("builds and recognises the login page inside the install", () => {
    expect(loginUrl(ROOT)).toBe(`${ROOT}/login/index.php`);
    expect(loginUrl(HOST)).toBe(`${HOST}/login/index.php`);
    expect(isLoginRedirect(`${ROOT}/login/index.php?wantsurl=x`, ROOT)).toBe(true);
    expect(isLoginRedirect(`${HOST}/login/index.php`, ROOT)).toBe(false);
    expect(isLoginRedirect(`${ROOT}/my/`, ROOT)).toBe(false);
    expect(isLoginRedirect(`${HOST}/login/index.php`, HOST)).toBe(true);
  });

  it("picks the session cookie scoped to this install, not a sibling's", () => {
    const cookie = (path: string, value: string) => ({ name: "MoodleSession", value, domain: "school.example.edu", path });
    const cookies = [cookie("/other/", "sibling"), cookie("/", "host-wide"), cookie("/elearning/moodle/", "ours")];
    expect(matchingMoodleSessionCookies(cookies, ROOT).map(c => c.value)).toEqual(["ours", "host-wide"]);
    expect(matchingMoodleSessionCookies(cookies, HOST).map(c => c.value)).toEqual(["host-wide"]);
  });

  it("sends the session cookie only to pages inside the install", async () => {
    const sent: boolean[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(Boolean((init?.headers as Record<string, string>).cookie));
      return new Response("ok");
    }) as typeof fetch;
    for (const url of [`${ROOT}/my/`, `${HOST}/elearning/moodle2/my/`, `${HOST}/`]) {
      await fetchWithSession(url, {}, ROOT, { name: "MoodleSession", value: "live" }, fetchImpl);
    }
    expect(sent).toEqual([true, false, false]);
  });

  it("resolves page links only when they are inside the install", () => {
    expect(resolveTopLevelUrl(ROOT, `${ROOT}/course/view.php?id=3`)).toEqual({ commandName: "course", args: ["3"] });
    expect(resolveTopLevelUrl(ROOT, `http://school.example.edu/elearning/moodle/course/view.php?id=3`)).toEqual({ commandName: "course", args: ["3"] });
    expect(() => resolveTopLevelUrl(ROOT, `${HOST}/course/view.php?id=3`)).toThrow(/not part of the configured Moodle site/u);
  });
});

describe("a saved address that is a page, not the install root", () => {
  it("is repaired from the site's own answer and the command still succeeds", async () => {
    const { mkdtemp, mkdir, readFile, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runCli } = await import("../src/cli.js");
    const home = await mkdtemp(join(tmpdir(), "moodle-subdir-"));
    const configPath = join(home, ".config/moodle-cli/config.yaml");
    await mkdir(join(home, ".config/moodle-cli"), { recursive: true });
    await writeFile(configPath, `base_url: ${ROOT}/course\n`);

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = `${url.origin}${url.pathname}`;
      if (path === `${ROOT}/lib/ajax/service-nologin.php`) return Response.json([{ error: false, data: { wwwroot: ROOT, sitename: "School" } }]);
      if (path === `${ROOT}/my/`) return new Response('<html><script>M.cfg={"sesskey":"fixture","userid":7}</script></html>');
      if (path === `${ROOT}/lib/ajax/service.php`) {
        const batch = JSON.parse(String(init?.body)) as Array<{ methodname: string }>;
        return Response.json(batch.map(() => ({ error: false, data: { siteurl: ROOT, sitename: "School", userid: 7, username: "student", fullname: "Alex Student", lang: "en" } })));
      }
      // Anything else under the install bounces to sign-in, as Moodle does.
      if (path.startsWith(`${ROOT}/`)) return new Response(null, { status: 303, headers: { location: `${ROOT}/login/index.php` } });
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["node", "moodle", "user", "--json", "--no-cache"], {
      env: { MOODLE_SESSION: "fixture", MOODLE_NO_UPDATE_CHECK: "1" },
      homeDir: home,
      cwd: home,
      fetchImpl,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { write: (text: string) => stdout.push(text) } as unknown as NodeJS.WriteStream,
      stderr: { write: (text: string) => stderr.push(text) } as unknown as NodeJS.WriteStream,
    });

    expect(stderr.join("")).toContain(`Moodle lives at ${ROOT}; updated ${configPath}.`);
    expect(code).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(`base_url: ${ROOT}\n`);
  });
});

describe("moodle auth site", () => {
  it("saves the install root found from a pasted course link", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runCli } = await import("../src/cli.js");
    const home = await mkdtemp(join(tmpdir(), "moodle-auth-site-"));
    const fetchImpl = (async (input: RequestInfo | URL) => String(input).startsWith(`${ROOT}/lib/ajax/service-nologin.php`)
      ? Response.json([{ error: false, data: { wwwroot: ROOT, sitename: "School" } }])
      : new Response("Not found", { status: 404 })) as typeof fetch;
    const stdout: string[] = [];
    const code = await runCli(["node", "moodle", "auth", "site", `${ROOT}/course/view.php?id=3`, "--json"], {
      env: { MOODLE_NO_UPDATE_CHECK: "1" },
      homeDir: home,
      cwd: home,
      fetchImpl,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { write: (text: string) => stdout.push(text) } as unknown as NodeJS.WriteStream,
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    });
    const configPath = join(home, ".config/moodle-cli/config.yaml");
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({ base_url: ROOT, sitename: "School", found_by: "site_config", saved_to: configPath });
    expect(await readFile(configPath, "utf8")).toBe(`base_url: ${ROOT}\n`);
  });
});
