import { describe, expect, it } from "vitest";
import { candidateRoots, discoverSite, parseSiteInput } from "../src/site-discovery.js";
import { isSiteUrl, sameSiteRoot, sitePath, siteUrl } from "../src/site-root.js";

const HOST = "https://school.example.edu";
const ROOT = `${HOST}/elearning/moodle`;
const IDP = "https://idp.example.org";

interface FakeSite {
  root?: string;
  /** What Moodle reports as wwwroot; defaults to root. */
  wwwroot?: string;
  publicConfig?: boolean;
  /** The host's own front page: a redirect into Moodle, or an unrelated page. */
  front?: "redirect" | "login" | "refresh" | "other";
  /** Signed-out visitors go from the login page straight on to a sign-in provider. */
  sso?: boolean;
  /** An SSO plugin's pre-login hook sends signed-out visitors to the provider from any page. */
  ssoEverywhere?: boolean;
}

function fakeMoodle(site: FakeSite = {}): { fetch: typeof fetch; calls: string[] } {
  const root = site.root ?? ROOT;
  const wwwroot = site.wwwroot ?? root;
  const calls: string[] = [];
  const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    const path = `${url.origin}${url.pathname}`;
    if (path === `${root}/lib/ajax/service-nologin.php` && init?.method === "POST") {
      if (site.publicConfig === false) return new Response("Forbidden", { status: 403 });
      return Response.json([{ error: false, data: { wwwroot, sitename: "<b>School</b> Moodle" } }]);
    }
    if (url.origin === IDP) return html("<html><form>Sign in</form></html>");
    if (path === `${root}/login/index.php` || path === `${root}/login/`) {
      return site.sso ? redirect(`${IDP}/authorize`) : html(`<script>M.cfg = {"wwwroot":"${wwwroot}","theme":"boost"};</script>`);
    }
    if (path.startsWith(`${root}/`)) return redirect(site.ssoEverywhere ? `${IDP}/authorize` : `${root}/login/index.php`);
    if (url.pathname === "/" && site.front === "redirect") return redirect(`${root}/`);
    if (url.pathname === "/" && site.front === "login") return redirect(`${root}/login/`);
    if (url.pathname === "/" && site.front === "refresh") {
      return html(`<html><head><META CONTENT="0; URL='${new URL(root).pathname}/'" HTTP-EQUIV="Refresh"></head></html>`);
    }
    if (url.pathname === "/" && site.front === "other") return html("<html>University home</html>");
    return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("site root helpers", () => {
  it("joins paths without losing the install path", () => {
    expect(siteUrl(ROOT, "/lib/ajax/service.php?info=x")).toBe(`${ROOT}/lib/ajax/service.php?info=x`);
    expect(siteUrl(`${ROOT}/`, "my/")).toBe(`${ROOT}/my/`);
    expect(siteUrl(HOST, "/my/")).toBe(`${HOST}/my/`);
  });

  it("matches pages inside the install, not siblings sharing a prefix", () => {
    expect(isSiteUrl(ROOT, `${ROOT}/course/view.php?id=1`)).toBe(true);
    expect(isSiteUrl(ROOT, ROOT)).toBe(true);
    expect(isSiteUrl(ROOT, `${HOST}/elearning/moodle2/course/view.php`)).toBe(false);
    expect(isSiteUrl(ROOT, `${HOST}/course/view.php`)).toBe(false);
    expect(isSiteUrl(ROOT, "https://other.example.edu/elearning/moodle/my/")).toBe(false);
    expect(isSiteUrl(HOST, `${HOST}/anything`)).toBe(true);
    expect(sitePath(ROOT, `${ROOT}/mod/forum/view.php?id=2`)).toBe("/mod/forum/view.php");
    expect(sameSiteRoot(`${ROOT}/`, ROOT)).toBe(true);
    expect(sameSiteRoot(HOST, ROOT)).toBe(false);
  });
});

describe("parseSiteInput and candidateRoots", () => {
  it("assumes https when the scheme is missing", () => {
    expect(parseSiteInput("school.example.edu/elearning/moodle").href).toBe(`${ROOT}`);
    expect(() => parseSiteInput("  ")).toThrow(/address/u);
    expect(() => parseSiteInput("ftp://school.example.edu")).toThrow(/https/u);
  });

  it("lists every directory prefix, deepest first, and never the script itself", () => {
    expect(candidateRoots(new URL(`${ROOT}/course/view.php?id=3`))).toEqual([
      `${ROOT}/course`,
      ROOT,
      `${HOST}/elearning`,
      HOST,
    ]);
  });

  it("tries https before a plain http address", () => {
    expect(candidateRoots(new URL("http://school.example.edu/moodle"))).toEqual([
      `${HOST}/moodle`,
      HOST,
      "http://school.example.edu/moodle",
      "http://school.example.edu",
    ]);
  });
});

describe("discoverSite", () => {
  it("finds a deep install from any page address via the public config", async () => {
    const { fetch } = fakeMoodle();
    for (const pasted of [`${ROOT}/course/view.php?id=3`, `${ROOT}/my/`, `${ROOT}/login/index.php`, ROOT, `${ROOT}/`]) {
      await expect(discoverSite(pasted, { fetch })).resolves.toEqual({
        kind: "found",
        site: { root: ROOT, sitename: "School Moodle", source: "site_config" },
      });
    }
  });

  it("finds a root install", async () => {
    const { fetch } = fakeMoodle({ root: HOST });
    await expect(discoverSite("school.example.edu", { fetch })).resolves.toMatchObject({ kind: "found", site: { root: HOST } });
  });

  it("follows a bare host into its Moodle subdirectory", async () => {
    const { fetch } = fakeMoodle({ front: "redirect" });
    await expect(discoverSite(HOST, { fetch })).resolves.toMatchObject({ kind: "found", site: { root: ROOT, source: "site_config" } });
  });

  it("follows a bare host whose front page points at the login directory before forced sign-in", async () => {
    const { fetch } = fakeMoodle({ front: "login", sso: true });
    await expect(discoverSite(HOST, { fetch })).resolves.toMatchObject({ kind: "found", site: { root: ROOT, source: "site_config" } });
    const blocked = fakeMoodle({ front: "login", sso: true, publicConfig: false });
    await expect(discoverSite(HOST, { fetch: blocked.fetch })).resolves.toEqual({
      kind: "found",
      site: { root: ROOT, source: "login_redirect" },
    });
  });

  it("asks the paths a bare host passed through when an SSO plugin skips the login page", async () => {
    const { fetch } = fakeMoodle({ front: "redirect", ssoEverywhere: true });
    await expect(discoverSite(HOST, { fetch })).resolves.toMatchObject({ kind: "found", site: { root: ROOT, source: "site_config" } });
    const blocked = fakeMoodle({ front: "redirect", ssoEverywhere: true, publicConfig: false });
    await expect(discoverSite(HOST, { fetch: blocked.fetch })).resolves.toEqual({ kind: "redirected", host: "idp.example.org" });
  });

  it("follows a front page that forwards with a meta refresh", async () => {
    const { fetch } = fakeMoodle({ front: "refresh" });
    await expect(discoverSite(HOST, { fetch })).resolves.toMatchObject({ kind: "found", site: { root: ROOT, source: "site_config" } });
  });

  it("reads the login redirect when the anonymous service is blocked and sign-in is forced", async () => {
    const { fetch } = fakeMoodle({ publicConfig: false, sso: true });
    await expect(discoverSite(`${ROOT}/course/view.php?id=3`, { fetch })).resolves.toEqual({
      kind: "found",
      site: { root: ROOT, source: "login_redirect" },
    });
  });

  it("reads M.cfg.wwwroot from a page when the anonymous service is blocked", async () => {
    const { fetch } = fakeMoodle({ publicConfig: false });
    await expect(discoverSite(`${ROOT}/login/index.php`, { fetch })).resolves.toEqual({
      kind: "found",
      site: { root: ROOT, source: "page" },
    });
  });

  it("offers, rather than takes, a root Moodle reports on another host", async () => {
    const { fetch } = fakeMoodle({ wwwroot: "https://moodle.example.edu" });
    await expect(discoverSite(`${ROOT}/my/`, { fetch })).resolves.toMatchObject({
      kind: "elsewhere",
      site: { root: "https://moodle.example.edu" },
    });
  });

  it("offers, rather than takes, a root that drops https for http", async () => {
    const { fetch } = fakeMoodle({ wwwroot: ROOT.replace("https:", "http:") });
    await expect(discoverSite(`${ROOT}/my/`, { fetch })).resolves.toMatchObject({
      kind: "elsewhere",
      site: { root: ROOT.replace("https:", "http:") },
    });
  });

  it("reports a bare host that is not Moodle", async () => {
    const { fetch } = fakeMoodle({ front: "other" });
    await expect(discoverSite(HOST, { fetch })).resolves.toMatchObject({ kind: "not_found" });
  });

  it("reports a sign-in provider address as leading elsewhere", async () => {
    const { fetch } = fakeMoodle({ publicConfig: false });
    const viaRedirect = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://sso.example.edu")
        ? new Response(null, { status: 302, headers: { location: `${IDP}/login` } })
        : fetch(input, init)) as typeof globalThis.fetch;
    await expect(discoverSite("https://sso.example.edu/start", { fetch: viaRedirect })).resolves.toEqual({ kind: "redirected", host: "idp.example.org" });
  });

  it("explains a host that does not resolve", async () => {
    const failing = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as typeof fetch;
    await expect(discoverSite("https://nowhere.example.edu", { fetch: failing })).resolves.toEqual({
      kind: "unreachable",
      message: "nowhere.example.edu does not resolve. Check the spelling, or your network or VPN.",
    });
  });

  it("names the network cause instead of fetch's generic failure", async () => {
    const failingWith = (cause: object) => (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause });
    }) as typeof fetch;
    const reason = async (cause: object) => {
      const result = await discoverSite("https://nowhere.example.edu", { fetch: failingWith(cause) });
      return result.kind === "unreachable" ? result.message : result.kind;
    };
    expect(await reason({ code: "ECONNRESET" })).toMatch(/dropped the connection.*proxy or VPN/u);
    expect(await reason({ code: "ECONNREFUSED" })).toBe("Nothing is answering at nowhere.example.edu.");
    expect(await reason({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe("nowhere.example.edu has a certificate this computer does not trust.");
    expect(await reason({ message: "bad port" })).toBe("Could not reach nowhere.example.edu: bad port");
  });

  it("asks each prefix once and never posts to a script path", async () => {
    const { fetch, calls } = fakeMoodle();
    await discoverSite(`${ROOT}/mod/forum/view.php?id=9`, { fetch });
    const posts = calls.filter(call => call.startsWith("POST"));
    expect(posts).toHaveLength(5);
    expect(posts.some(call => call.includes("view.php/"))).toBe(false);
  });
});

describe("interactive setup", () => {
  it("saves the discovered install root, not the page that was pasted", async () => {
    const { loadConfig } = await import("../src/config.js");
    const written: Array<{ path: string; content: string }> = [];
    const answers = ["not a url ::", `${HOST}/`, `${ROOT}/course/view.php?id=3`];
    const asked: string[] = [];
    const { fetch } = fakeMoodle({ front: "other" });
    const config = await loadConfig({
      env: {},
      homeDir: "/home/student",
      cwd: "/work",
      stdin: { isTTY: true },
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
      prompt: async (label) => {
        asked.push(label);
        return answers.shift() ?? "";
      },
      fetch,
      fs: {
        readFile: (async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }) as never,
        write: async (path, content) => {
          written.push({ path, content });
        },
      },
    });
    expect(config.baseUrl).toBe(ROOT);
    expect(asked).toEqual(["Moodle address", "Moodle address", "Moodle address"]);
    expect(written).toEqual([{ path: "/home/student/.config/moodle-cli/config.yaml", content: `base_url: ${ROOT}\n` }]);
  });

  it("asks before using a root on another host", async () => {
    const { promptForBaseUrl } = await import("../src/config.js");
    const answers = [`${ROOT}/my/`, "n", `${ROOT}/my/`, "y"];
    const { fetch } = fakeMoodle({ wwwroot: "https://moodle.example.edu" });
    await expect(promptForBaseUrl({
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
      prompt: async () => answers.shift() ?? "",
      fetch,
    })).resolves.toBe("https://moodle.example.edu");
    expect(answers).toEqual([]);
  });
});

describe("correctBaseUrl", () => {
  const quietFs = (initial: string, written: Array<{ path: string; content: string }>) => ({
    readFile: (async (path: string) => {
      if (path === "/home/student/.config/moodle-cli/config.yaml") return initial;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }) as never,
    write: async (path: string, content: string) => {
      written.push({ path, content });
    },
  });

  it("repairs a saved page address to the install root", async () => {
    const { correctBaseUrl } = await import("../src/config.js");
    const written: Array<{ path: string; content: string }> = [];
    const { fetch } = fakeMoodle();
    await expect(correctBaseUrl(`${ROOT}/my`, {
      env: {},
      cwd: "/work",
      homeDir: "/home/student",
      fetch,
      fs: quietFs(`base_url: ${ROOT}/my\nbrowser: chrome\n`, written),
    })).resolves.toEqual({ kind: "moved", from: `${ROOT}/my`, to: ROOT, savedTo: "/home/student/.config/moodle-cli/config.yaml" });
    expect(written[0].content).toBe(`base_url: ${ROOT}\nbrowser: chrome\n`);
  });

  it("leaves a correct address alone and never rewrites the environment", async () => {
    const { correctBaseUrl } = await import("../src/config.js");
    const written: Array<{ path: string; content: string }> = [];
    const { fetch } = fakeMoodle({ front: "redirect" });
    await expect(correctBaseUrl(ROOT, { env: {}, homeDir: "/home/student", cwd: "/work", fetch, fs: quietFs(`base_url: ${ROOT}\n`, written) })).resolves.toBeNull();
    await expect(correctBaseUrl(HOST, { env: { MOODLE_BASE_URL: HOST }, fetch })).resolves.toEqual({
      kind: "moved",
      from: HOST,
      to: ROOT,
      savedTo: null,
      envVar: "MOODLE_BASE_URL",
    });
    expect(written).toEqual([]);
  });

  it("reports an address where nothing answers as Moodle", async () => {
    const { correctBaseUrl } = await import("../src/config.js");
    const fetchImpl = (async () => new Response("Forbidden", { status: 403, headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(correctBaseUrl(`${HOST}/elearning`, { env: {}, fetch: fetchImpl })).resolves.toEqual({ kind: "absent", from: `${HOST}/elearning` });
  });
});

describe("scheme fallback", () => {
  it("finds a plain-http site only when no scheme was typed", async () => {
    const plainRoot = "http://lab.example.test/moodle";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.protocol === "https:") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return url.pathname === "/moodle/lib/ajax/service-nologin.php"
        ? Response.json([{ error: false, data: { wwwroot: plainRoot } }])
        : new Response("Not found", { status: 404 });
    }) as typeof fetch;
    await expect(discoverSite("lab.example.test/moodle/my/", { fetch: fetchImpl })).resolves.toMatchObject({ kind: "found", site: { root: plainRoot } });
    await expect(discoverSite("https://lab.example.test/moodle/my/", { fetch: fetchImpl })).resolves.toMatchObject({ kind: "unreachable" });
  });
});
