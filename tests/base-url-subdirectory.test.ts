import { describe, expect, it, vi } from "vitest";
import { isLoginRedirect, loginUrl } from "../src/auth.js";
import { loadConfig, normalizeBaseUrl, probeBaseUrl } from "../src/config.js";
import { ENV_MOODLE_BASE_URL } from "../src/constants.js";
import { fetchMobileToken, readSiteAuthProfile } from "../src/mobile-login-core.js";

const HOST = "https://school.example.edu";
const SUBDIR = `${HOST}/moodle`;

describe("normalizeBaseUrl with an install subdirectory", () => {
  it("keeps the subdirectory and drops a trailing slash", () => {
    expect(normalizeBaseUrl(SUBDIR)).toBe(SUBDIR);
    expect(normalizeBaseUrl(`${SUBDIR}/`)).toBe(SUBDIR);
    expect(normalizeBaseUrl(`${SUBDIR}//`)).toBe(SUBDIR);
    expect(normalizeBaseUrl(`${HOST}/elearning/moodle`)).toBe(`${HOST}/elearning/moodle`);
  });

  it("leaves a root install unchanged", () => {
    expect(normalizeBaseUrl(HOST)).toBe(HOST);
    expect(normalizeBaseUrl(`${HOST}/`)).toBe(HOST);
    expect(normalizeBaseUrl(`  ${HOST}  `)).toBe(HOST);
  });

  it("still rejects a page instead of an install root", () => {
    const pages = ["/login/index.php", "/my/", "/my", "/course/view.php", "/mod/forum/view.php", "/index.php"];
    for (const page of pages) {
      expect(() => normalizeBaseUrl(`${HOST}${page}`)).toThrow(/install root/u);
      expect(() => normalizeBaseUrl(`${SUBDIR}${page}`)).toThrow(/install root/u);
    }
  });

  it("rejects a query, fragment, or wrong scheme", () => {
    expect(() => normalizeBaseUrl(`${SUBDIR}?id=1`)).toThrow(/query parameters/u);
    expect(() => normalizeBaseUrl(`${SUBDIR}#top`)).toThrow(/query parameters/u);
    expect(() => normalizeBaseUrl("ftp://school.example.edu/moodle")).toThrow(/http/u);
  });

  it("loads a subdirectory base URL from the environment", async () => {
    await expect(loadConfig({ env: { [ENV_MOODLE_BASE_URL]: SUBDIR } })).resolves.toEqual({ baseUrl: SUBDIR });
  });
});

describe("login URLs inside a subdirectory", () => {
  it("builds the login page under the install path", () => {
    expect(loginUrl(SUBDIR)).toBe(`${SUBDIR}/login/index.php`);
    expect(loginUrl(HOST)).toBe(`${HOST}/login/index.php`);
  });

  it("recognises a login redirect under the install path", () => {
    expect(isLoginRedirect(`${SUBDIR}/login/index.php`, SUBDIR)).toBe(true);
    expect(isLoginRedirect(`${SUBDIR}/login/index.php?wantsurl=%2Fmoodle%2Fmy%2F`, SUBDIR)).toBe(true);
    expect(isLoginRedirect(`${SUBDIR}/my/`, SUBDIR)).toBe(false);
  });

  it("still recognises a login redirect for a root install", () => {
    expect(isLoginRedirect(`${HOST}/login/index.php`, HOST)).toBe(true);
    expect(isLoginRedirect(`${HOST}/my/`, HOST)).toBe(false);
  });

  it("is not fooled by a sibling directory sharing a prefix", () => {
    expect(isLoginRedirect(`${HOST}/moodle2/login/index.php`, SUBDIR)).toBe(false);
  });
});

describe("request URLs keep the install path", () => {
  it("probes the token endpoint under the subdirectory", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"errorcode":"missingparam"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(probeBaseUrl(SUBDIR, { fetch: fetchImpl as unknown as typeof fetch })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(`${SUBDIR}/login/token.php`, { redirect: "follow" });
  });

  it("reads the mobile public config under the subdirectory", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    await readSiteAuthProfile(SUBDIR, fetchImpl as unknown as typeof fetch);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`${SUBDIR}/lib/ajax/service-nologin.php`);
  });

  it("launches the mobile sign-in under the subdirectory", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 200 }));
    await fetchMobileToken(SUBDIR, { name: "MoodleSession", value: "live" }, fetchImpl as unknown as typeof fetch);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`${SUBDIR}/admin/tool/mobile/launch.php`);
  });
});
