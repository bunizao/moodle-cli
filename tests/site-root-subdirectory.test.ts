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
