import type { Ui } from "@bunizao/cli-kit";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../src/auth.js";
import { AuthError } from "../src/errors.js";
import { signInInteractively, type OnboardingDeps } from "../src/onboarding.js";

const BASE_URL = "https://moodle.example.edu";
const LOGIN_URL = `${BASE_URL}/login/index.php`;
const session = { baseUrl: BASE_URL, userid: 7 } as AuthenticatedSession;

/** A scripted terminal: every prompt is answered from a queue and every line drawn is kept. */
function terminal(answers: { select?: string[]; confirm?: boolean[] } = {}) {
  const log: string[] = [];
  const selects = [...(answers.select ?? [])];
  const confirms = [...(answers.confirm ?? [])];
  const next = <T>(queue: T[], prompt: string): T => {
    if (!queue.length) throw new Error(`No scripted answer for: ${prompt}`);
    return queue.shift() as T;
  };
  const ui = {
    interactive: true,
    note: (message: string, title?: string) => log.push(`note[${title ?? ""}]: ${message}`),
    info: (message: string) => log.push(`info: ${message}`),
    warn: (message: string) => log.push(`warn: ${message}`),
    step: (message: string) => log.push(`step: ${message}`),
    spinner: () => ({
      start: (message: string) => log.push(`spin: ${message}`),
      message: () => undefined,
      stop: (message?: string) => log.push(`done: ${message ?? ""}`),
      error: (message?: string) => log.push(`fail: ${message ?? ""}`),
    }),
    select: async (message: string, choices: readonly { value: string }[]) => {
      log.push(`select: ${message} [${choices.map(choice => choice.value).join(" ")}]`);
      return next(selects, message);
    },
    confirm: async (message: string) => {
      log.push(`confirm: ${message}`);
      return next(confirms, message);
    },
  } as unknown as Ui;
  return { ui, log };
}

function deps(overrides: Partial<OnboardingDeps> = {}): OnboardingDeps {
  return {
    baseUrl: BASE_URL,
    platform: "darwin",
    showWordmark: () => undefined,
    storesBlocked: async () => false,
    openInBrowser: async () => undefined,
    readBrowserSession: async () => session,
    browserLogin: async () => session,
    pasteLogin: async () => session,
    keepaliveInstalled: async () => false,
    installKeepalive: async () => ({ interval_minutes: 30, plist_path: "/tmp/keepalive.plist" }),
    ...overrides,
  };
}

describe("first-run sign-in", () => {
  it("opens the login page, reads the session after Enter, then installs renewal", async () => {
    const { ui, log } = terminal({ select: ["own-browser"], confirm: [true, true] });
    const openInBrowser = vi.fn(async () => undefined);
    const installKeepalive = vi.fn(async () => ({ interval_minutes: 30, plist_path: "/tmp/keepalive.plist" }));
    expect(await signInInteractively(ui, deps({ openInBrowser, installKeepalive }))).toBe(session);
    expect(openInBrowser).toHaveBeenCalledWith(LOGIN_URL);
    expect(installKeepalive).toHaveBeenCalledOnce();
    expect(log).toEqual([
      expect.stringContaining("note[One-time setup]: No Moodle session for"),
      "select: How do you want to sign in? [own-browser cli-browser paste stop]",
      `confirm: Signed in at ${LOGIN_URL}? Enter reads the session from your browser`,
      "spin: Reading the session from your browser",
      "done: Signed in as userid 7",
      expect.stringContaining("note[Stay signed in]: A background job can renew this session every 30 minutes"),
      "confirm: Renew the session automatically?",
      "step: Renewing every 30 min; agent at /tmp/keepalive.plist",
    ]);
  });

  it("comes back to the menu when the browser has no session yet, and takes a paste instead", async () => {
    const { ui, log } = terminal({ select: ["own-browser", "paste"], confirm: [true, false] });
    const readBrowserSession = vi.fn(async () => { throw new AuthError(`No usable MoodleSession found for ${BASE_URL}.`, "Log in first."); });
    const installKeepalive = vi.fn(async () => ({ interval_minutes: 30, plist_path: "/tmp/keepalive.plist" }));
    expect(await signInInteractively(ui, deps({ readBrowserSession, installKeepalive }))).toBe(session);
    expect(installKeepalive).not.toHaveBeenCalled();
    expect(log).toContain(`fail: No usable MoodleSession found for ${BASE_URL}.`);
    expect(log).toContain(`info: Finish signing in at ${LOGIN_URL} in the browser you use, then choose the first option again.`);
    expect(log).toContain("select: Try another way? [own-browser cli-browser paste stop]");
    expect(log).toContain("step: Signed in as userid 7");
    expect(log).toContain("info: Later: moodle auth keepalive install");
  });

  it("drops the own-browser path when no cookie store can be read, and skips renewal off macOS", async () => {
    const { ui, log } = terminal({ select: ["cli-browser"] });
    const browserLogin = vi.fn(async (onOpened: (url: string) => void) => { onOpened(LOGIN_URL); return session; });
    expect(await signInInteractively(ui, deps({ platform: "linux", storesBlocked: async () => true, browserLogin }))).toBe(session);
    expect(log[0]).toContain("cannot read your browser's cookies");
    expect(log).toContain("select: How do you want to sign in? [cli-browser paste stop]");
    expect(log.some(line => line.startsWith("confirm:"))).toBe(false);
  });

  it("keeps the CLI browser's hint on screen and offers the menu again", async () => {
    const { ui, log } = terminal({ select: ["cli-browser", "stop"] });
    const browserLogin = vi.fn(async () => { throw new AuthError("No Chromium browser was found.", "Install Chrome, or use moodle auth login --paste."); });
    await expect(signInInteractively(ui, deps({ browserLogin }))).rejects.toMatchObject({ hint: "Run moodle auth login when you are ready." });
    expect(log).toContain("fail: No Chromium browser was found.");
    expect(log).toContain("info: Install Chrome, or use moodle auth login --paste.");
  });

  it("does not ask about renewal when the agent is already installed", async () => {
    const { ui, log } = terminal({ select: ["paste"] });
    await signInInteractively(ui, deps({ keepaliveInstalled: async () => true }));
    expect(log.some(line => line.includes("Stay signed in"))).toBe(false);
  });
});
