import type { Ui } from "@bunizao/cli-kit";
import { loginUrl, type AuthenticatedSession } from "./auth.js";
import { KEEPALIVE_DEFAULT_INTERVAL_MINUTES } from "./constants.js";
import { AuthError, CliError } from "./errors.js";

/**
 * What the first-run sign-in needs from the rest of the CLI. Each function is one
 * of the three sign-in paths or one fact about the machine, so the flow itself is
 * plain control logic and a test can script it with a fake terminal.
 */
export interface OnboardingDeps {
  readonly baseUrl: string;
  readonly platform: NodeJS.Platform;
  showWordmark(ui: Ui): void;
  /** True when no browser cookie store on this machine can be read, so a sign-in in the person's own browser is invisible to us. */
  storesBlocked(): Promise<boolean>;
  openInBrowser(url: string): Promise<void>;
  /** Read the session the person's own browser holds; rejects with an AuthError when there is none yet. */
  readBrowserSession(): Promise<AuthenticatedSession>;
  /** Sign in through a browser window the CLI controls. */
  browserLogin(onOpened: (url: string) => void): Promise<AuthenticatedSession>;
  /** Take the MoodleSession cookie from a prompt. */
  pasteLogin(): Promise<AuthenticatedSession>;
  keepaliveInstalled(): Promise<boolean>;
  installKeepalive(): Promise<{ interval_minutes: number; plist_path: string }>;
}

type Method = "own-browser" | "cli-browser" | "paste" | "stop";

/**
 * The first run with no session: one note, then a menu that comes back after every
 * failed attempt instead of exiting with a hint. A person who is already signed in
 * to Moodle in their own browser only has to press Enter; the CLI-driven browser and
 * the paste are there for a terminal that cannot read the cookie store.
 */
export async function signInInteractively(ui: Ui, deps: OnboardingDeps): Promise<AuthenticatedSession> {
  deps.showWordmark(ui);
  const login = loginUrl(deps.baseUrl);
  let blocked = await deps.storesBlocked();
  ui.note([
    `No Moodle session for ${deps.baseUrl}.`,
    "Sign in once; later commands reuse that session.",
    ...(blocked ? ["", "This terminal cannot read your browser's cookies, so the sign-in happens in a browser window the CLI opens."] : []),
  ].join("\n"), "One-time setup");

  let session: AuthenticatedSession | undefined;
  for (let attempt = 0; !session; attempt++) {
    const method = await ui.select<Method>(attempt ? "Try another way?" : "How do you want to sign in?", [
      ...(blocked ? [] : [{ value: "own-browser" as const, label: "Sign in in my own browser", hint: "the login page opens; press Enter here when done" }]),
      { value: "cli-browser" as const, label: "Open a browser window from here", hint: "a Chrome, Edge or Brave the CLI controls" },
      { value: "paste" as const, label: "Paste the MoodleSession cookie", hint: "from the browser's developer tools" },
      { value: "stop" as const, label: "Not now", hint: "moodle auth login works any time" },
    ]);
    if (method === "stop") throw new AuthError(`No usable MoodleSession found for ${deps.baseUrl}.`, "Run moodle auth login when you are ready.");
    if (method === "own-browser") {
      await deps.openInBrowser(login).catch(() => undefined);
      if (!await ui.confirm(`Signed in at ${login}? Enter reads the session from your browser`, { initial: true })) continue;
      const spin = ui.spinner();
      spin.start("Reading the session from your browser");
      try {
        session = await deps.readBrowserSession();
        spin.stop(`Signed in as userid ${session.userid}`);
      } catch (error) {
        if (!(error instanceof AuthError)) { spin.error("Could not read the browser session"); throw error; }
        spin.error(error.message);
        // A store that turned out to be unreadable cannot succeed on retry; a missing cookie can.
        blocked = await deps.storesBlocked();
        if (blocked) ui.warn(error.hint ?? "The browser cookie store could not be read.");
        else ui.info(`Finish signing in at ${login} in the browser you use, then choose the first option again.`);
      }
    } else if (method === "cli-browser") {
      const spin = ui.spinner();
      spin.start("Opening a browser window");
      try {
        session = await deps.browserLogin(url => spin.message(`Finish signing in at ${url}`));
        spin.stop(`Signed in as userid ${session.userid}`);
      } catch (error) {
        if (!(error instanceof AuthError)) { spin.error("Sign-in did not complete"); throw error; }
        spin.error(error.message);
        if (error.hint) ui.info(error.hint);
      }
    } else {
      try {
        session = await deps.pasteLogin();
        ui.step(`Signed in as userid ${session.userid}`);
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        ui.warn([error.message, error.hint].filter(Boolean).join("\n"));
      }
    }
  }
  await offerRenewal(ui, deps);
  return session;
}

/**
 * A session that is touched every half hour rarely expires, which is the difference
 * between signing in once and signing in every morning. Offered once, on macOS,
 * where the CLI can register the launch agent itself.
 */
async function offerRenewal(ui: Ui, deps: OnboardingDeps): Promise<void> {
  if (deps.platform !== "darwin" || await deps.keepaliveInstalled()) return;
  ui.note([
    `A background job can renew this session every ${KEEPALIVE_DEFAULT_INTERVAL_MINUTES} minutes, so it rarely expires.`,
    "It runs moodle auth keepalive; moodle auth keepalive uninstall removes it.",
  ].join("\n"), "Stay signed in");
  const wanted = await ui.confirm("Renew the session automatically?", { initial: true }).catch((error: unknown) => {
    // Declining here must not throw away the sign-in that just succeeded.
    if (error instanceof CliError && error.code === "cancelled") return false;
    throw error;
  });
  if (!wanted) {
    ui.info("Later: moodle auth keepalive install");
    return;
  }
  try {
    const result = await deps.installKeepalive();
    ui.step(`Renewing every ${result.interval_minutes} min; agent at ${result.plist_path}`);
  } catch (error) {
    ui.warn(`${error instanceof Error ? error.message : String(error)}\nLater: moodle auth keepalive install`);
  }
}
