import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { authFailureHint, getAuthenticatedSession, type AuthOptions } from "../src/auth.js";
import { readConfigSetting, saveConfigSetting } from "../src/config.js";
import { AuthError } from "../src/errors.js";
import { parseOktaCookies, type OktaCli, type OktaCookie } from "../src/okta.js";

const BASE_URL = "https://learning.example.edu";
const LOGIN_URL = `${BASE_URL}/login/index.php`;

function fakeOkta(saved: OktaCookie[], afterLogin: OktaCookie[] = [], outcome: "ok" | "rejected" | "failed" = "ok") {
  let current = saved;
  const cli = {
    cookies: vi.fn(async () => current),
    login: vi.fn(async () => {
      if (outcome === "ok") current = afterLogin;
      return outcome;
    }),
  } satisfies OktaCli;
  return cli;
}

function moodleCookie(value: string): OktaCookie {
  return { name: "MoodleSession", value, domain: "learning.example.edu", path: "/" };
}

async function options(overrides: AuthOptions = {}): Promise<AuthOptions> {
  return {
    env: {},
    cwd: await mkdtemp(join(tmpdir(), "moodle-okta-cwd-")),
    homeDir: await mkdtemp(join(tmpdir(), "moodle-okta-home-")),
    browserCookieProvider: async () => [],
    validateSession: async (_baseUrl, cookie) => (cookie.value === "fresh" ? { sesskey: "sess", userid: 7 } : null),
    ...overrides,
  };
}

describe("okta-auth CLI session source", () => {
  it("reuses a saved okta session without being enabled, and never signs in by itself", async () => {
    const okta = fakeOkta([moodleCookie("fresh")]);

    const session = await getAuthenticatedSession(BASE_URL, await options({ oktaCli: okta }));

    expect(session).toMatchObject({ userid: 7, cookie: { value: "fresh", source: "okta" } });
    expect(okta.cookies).toHaveBeenCalledWith(LOGIN_URL);
    expect(okta.login).not.toHaveBeenCalled();
  });

  it("does not run okta login for a stale saved session unless the user opted in", async () => {
    const okta = fakeOkta([moodleCookie("stale")], [moodleCookie("fresh")]);

    await expect(getAuthenticatedSession(BASE_URL, await options({ oktaCli: okta }))).rejects.toBeInstanceOf(AuthError);
    expect(okta.login).not.toHaveBeenCalled();
  });

  it("falls back to okta login once the config opts in", async () => {
    const okta = fakeOkta([moodleCookie("stale")], [moodleCookie("fresh")]);
    const auth = await options({ oktaCli: okta });
    await saveConfigSetting("okta", true, { env: auth.env, cwd: auth.cwd, homeDir: auth.homeDir });

    const session = await getAuthenticatedSession(BASE_URL, auth);

    expect(okta.login).toHaveBeenCalledWith(LOGIN_URL);
    expect(session.cookie).toMatchObject({ value: "fresh", source: "okta" });
  });

  it("never signs in from a background run, even when opted in", async () => {
    const okta = fakeOkta([], [moodleCookie("fresh")]);
    const auth = await options({ oktaCli: okta, nonInteractive: true });
    await saveConfigSetting("okta", true, { env: auth.env, cwd: auth.cwd, homeDir: auth.homeDir });

    await expect(getAuthenticatedSession(BASE_URL, auth)).rejects.toBeInstanceOf(AuthError);
    expect(okta.login).not.toHaveBeenCalled();
  });

  it("signs in when the user asks with --okta, even from the non-interactive first pass", async () => {
    const okta = fakeOkta([], [moodleCookie("fresh")]);

    const session = await getAuthenticatedSession(BASE_URL, await options({ oktaCli: okta, okta: true, nonInteractive: true }));

    expect(okta.login).toHaveBeenCalledTimes(1);
    expect(session.cookie.value).toBe("fresh");
  });

  it("stops after Okta rejects the password until the user asks again", async () => {
    const okta = fakeOkta([], [], "rejected");
    const auth = await options({ oktaCli: okta });
    await saveConfigSetting("okta", true, { env: auth.env, cwd: auth.cwd, homeDir: auth.homeDir });

    const first = await getAuthenticatedSession(BASE_URL, auth).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(AuthError);
    expect((first as AuthError).message).toContain("rejected");
    expect((first as AuthError).hint).toContain("moodle auth login --okta");

    // An ordinary command does not spend another attempt.
    await expect(getAuthenticatedSession(BASE_URL, auth)).rejects.toThrow("not run again");
    expect(okta.login).toHaveBeenCalledTimes(1);

    // `moodle auth login --okta` does, and a success lifts the stop.
    const fixed = fakeOkta([], [moodleCookie("fresh")]);
    await getAuthenticatedSession(BASE_URL, { ...auth, oktaCli: fixed, okta: true });
    expect(fixed.login).toHaveBeenCalledTimes(1);
    const later = fakeOkta([], [moodleCookie("fresh")]);
    await getAuthenticatedSession(BASE_URL, { ...auth, oktaCli: later, noCache: true });
    expect(later.login).toHaveBeenCalledTimes(1);
  });

  it("never consults okta once the user opts out", async () => {
    const okta = fakeOkta([moodleCookie("fresh")]);
    const auth = await options({ oktaCli: okta });
    await saveConfigSetting("okta", false, { env: auth.env, cwd: auth.cwd, homeDir: auth.homeDir });

    await expect(getAuthenticatedSession(BASE_URL, auth)).rejects.toBeInstanceOf(AuthError);
    expect(okta.cookies).not.toHaveBeenCalled();
  });

  it("keeps the generic sign-in hint Okta-free when okta is not installed", async () => {
    const error = await getAuthenticatedSession(BASE_URL, await options({ oktaCli: null })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).hint).not.toMatch(/okta/i);
    expect(authFailureHint(BASE_URL, [], "darwin")).not.toMatch(/okta/i);
  });

  it("runs the okta executable on PATH with stdin closed and reads its JSON", async () => {
    const bin = await mkdtemp(join(tmpdir(), "moodle-okta-bin-"));
    const log = join(bin, "calls.log");
    const state = join(bin, "signed-in");
    // Python's okta prints {cookies: [...]} and exits 77 on a rejected password.
    await writeFile(join(bin, "okta"), [
      "#!/bin/sh",
      `echo "$*" >> "${log}"`,
      'read -r line && exit 3',
      `if [ "$1" = login ]; then touch "${state}"; echo '{"success": true}'; exit 0; fi`,
      `if [ -f "${state}" ]; then echo '{"count": 1, "cookies": [{"name": "MoodleSession", "value": "fresh", "domain": "learning.example.edu", "path": "/"}]}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"));
    await chmod(join(bin, "okta"), 0o755);
    const auth = await options({ env: { PATH: bin }, okta: true });

    const session = await getAuthenticatedSession(BASE_URL, auth);

    expect(session.cookie).toMatchObject({ value: "fresh", source: "okta" });
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      `cookies ${LOGIN_URL} --json`,
      `login ${LOGIN_URL} --json`,
      `cookies ${LOGIN_URL} --json`,
    ]);
  });

  it("reads both okta CLIs' cookie output", () => {
    const cookie = { name: "MoodleSession", value: "v", domain: "learning.example.edu", path: "/", secure: true };
    expect(parseOktaCookies(JSON.stringify([cookie]))).toEqual([{ name: "MoodleSession", value: "v", domain: "learning.example.edu", path: "/" }]);
    expect(parseOktaCookies(JSON.stringify({ count: 1, cookies: [cookie], url: BASE_URL }))).toHaveLength(1);
    expect(parseOktaCookies("not json")).toEqual([]);
    expect(parseOktaCookies(JSON.stringify({ error: "No stored session" }))).toEqual([]);
  });

  it("remembers the choice in the config file", async () => {
    const home = await mkdtemp(join(tmpdir(), "moodle-okta-config-"));
    const cwd = await mkdtemp(join(tmpdir(), "moodle-okta-config-cwd-"));
    await mkdir(join(home, ".config/moodle-cli"), { recursive: true });
    await writeFile(join(home, ".config/moodle-cli/config.yaml"), "base_url: https://learning.example.edu\n");

    await saveConfigSetting("okta", true, { env: {}, cwd, homeDir: home });

    expect(await readConfigSetting("okta", { env: {}, cwd, homeDir: home })).toBe(true);
    expect(await readFile(join(home, ".config/moodle-cli/config.yaml"), "utf8")).toContain("base_url: https://learning.example.edu");
  });
});
