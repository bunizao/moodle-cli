import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CDP_PROFILE_DIR_NAME } from "./constants.js";

/**
 * Sign-in by driving a Chromium browser the CLI owns, instead of reading the
 * user's browser cookie store off disk. This sidesteps every failure of the
 * store path at once: macOS Full Disk Access, the Chrome Safe Storage keychain
 * prompt, Windows app-bound cookie encryption, and sandboxed agent terminals
 * that cannot open the store at all. We launch our own browser with remote
 * debugging over a pipe, let the user complete whatever SSO the site uses, then
 * read the resulting cookies straight from the live browser over CDP.
 *
 * The profile persists between runs, so a later headless renewal reuses the
 * identity-provider session the interactive login established.
 */

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface ChromiumBrowser {
  path: string;
  name: string;
}

export interface CdpLoginOptions {
  /** The page to open; the site's login URL for an interactive sign-in. */
  url: string;
  /** Stop as soon as this returns true for the live cookie set. */
  isDone: (cookies: CdpCookie[]) => boolean | Promise<boolean>;
  /** true renders no window; use it only when a session already exists. */
  headless?: boolean;
  profileDir?: string;
  browserPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once the browser window is up, so the CLI can prompt the user. */
  onOpened?: () => void;
}

export interface CdpLoginResult {
  cookies: CdpCookie[];
  browserName: string;
}

export class CdpError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "CdpError";
  }
}

export const NO_CHROMIUM_HINT =
  "Install Google Chrome, Microsoft Edge, Brave, or Chromium, or run `moodle auth login --paste` to hand over the cookie yourself.";

const DEFAULT_INTERACTIVE_TIMEOUT_MS = 300_000;
const DEFAULT_HEADLESS_TIMEOUT_MS = 45_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export function cdpProfileDir(homeDir = homedir()): string {
  return join(homeDir, CDP_PROFILE_DIR_NAME);
}

/**
 * Chromium refuses remote debugging on the default profile since v136, and we
 * never want to read the user's own cookies here anyway, so we always launch
 * against a private profile directory the CLI created.
 */
function launchFlags(profileDir: string, url: string, headless: boolean): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    // macOS: use an in-memory key so decrypting cookies never prompts Keychain.
    "--use-mock-keychain",
    // Linux: avoid a gnome-keyring/kwallet unlock prompt for the same reason.
    "--password-store=basic",
    ...(headless ? ["--headless=new"] : []),
    url,
  ];
}

const MAC_BROWSERS: ChromiumBrowser[] = [
  { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
  { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
  { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
];

const LINUX_BROWSERS: ChromiumBrowser[] = [
  { name: "Google Chrome", path: "google-chrome" },
  { name: "Google Chrome", path: "google-chrome-stable" },
  { name: "Chromium", path: "chromium" },
  { name: "Chromium", path: "chromium-browser" },
  { name: "Microsoft Edge", path: "microsoft-edge" },
  { name: "Brave", path: "brave-browser" },
];

function windowsBrowsers(env: NodeJS.ProcessEnv): ChromiumBrowser[] {
  const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean) as string[];
  const relative: Array<[string, string]> = [
    ["Google Chrome", "Google/Chrome/Application/chrome.exe"],
    ["Microsoft Edge", "Microsoft/Edge/Application/msedge.exe"],
    ["Brave", "BraveSoftware/Brave-Browser/Application/brave.exe"],
    ["Chromium", "Chromium/Application/chrome.exe"],
  ];
  return roots.flatMap((root) => relative.map(([name, tail]) => ({ name, path: join(root, tail) })));
}

/** The first installed Chromium-family browser, or null when none is present. */
export async function findChromiumBrowser(options: CdpLoginOptions = {} as CdpLoginOptions): Promise<ChromiumBrowser | null> {
  if (options.browserPath) {
    return { name: "Chromium", path: options.browserPath };
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "linux") {
    for (const candidate of LINUX_BROWSERS) {
      const resolved = resolveFromPath(candidate.path, env, platform);
      if (resolved) return { name: candidate.name, path: resolved };
    }
    return null;
  }
  const candidates = platform === "win32" ? windowsBrowsers(env) : MAC_BROWSERS;
  for (const candidate of candidates) {
    if (await isExecutable(candidate.path)) return candidate;
  }
  return null;
}

export async function loginWithCdp(options: CdpLoginOptions): Promise<CdpLoginResult> {
  const browser = await findChromiumBrowser(options);
  if (!browser) {
    throw new CdpError("No Chromium-family browser is installed.", NO_CHROMIUM_HINT);
  }

  const profileDir = options.profileDir ?? cdpProfileDir(options.homeDir);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const headless = options.headless ?? false;
  const spawnImpl = options.spawn ?? spawn;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? (headless ? DEFAULT_HEADLESS_TIMEOUT_MS : DEFAULT_INTERACTIVE_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  const child = spawnImpl(browser.path, launchFlags(profileDir, options.url, headless), {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });

  const connection = new CdpConnection(child);
  try {
    await connection.handshake(HANDSHAKE_TIMEOUT_MS);
    options.onOpened?.();

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (connection.closed) {
        throw new CdpError(
          "The browser closed before sign-in completed.",
          "Another moodle login or renewal may be using the same browser profile. Wait for it to finish, then retry.",
        );
      }
      const cookies = await connection.getCookies();
      if (await options.isDone(cookies)) {
        return { cookies, browserName: browser.name };
      }
      await sleep(pollIntervalMs);
    }
    throw new CdpError(
      headless ? "Timed out renewing the session in the background browser." : "Timed out waiting for sign-in.",
      headless ? "Run `moodle auth login` to sign in again." : "Complete the sign-in in the browser window, then retry.",
    );
  } finally {
    await connection.close();
  }
}

/** A minimal Chrome DevTools Protocol client over the --remote-debugging-pipe fds. */
class CdpConnection {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  closed = false;

  constructor(private readonly child: ChildProcess) {
    child.on("exit", () => {
      this.closed = true;
      for (const resolve of this.pending.values()) resolve({ error: { message: "browser exited" } });
      this.pending.clear();
    });
    const fromBrowser = child.stdio[4] as NodeJS.ReadableStream | null;
    fromBrowser?.on("data", (chunk: Buffer) => this.consume(chunk));
  }

  private consume(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index: number;
    while ((index = this.buffer.indexOf("\0")) !== -1) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        continue;
      }
      if (typeof message.id === "number") {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    }
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    if (this.closed) return Promise.resolve({ error: { message: "browser exited" } });
    const id = this.nextId++;
    const toBrowser = this.child.stdio[3] as NodeJS.WritableStream | null;
    return new Promise<CdpMessage>((resolve) => {
      this.pending.set(id, resolve);
      toBrowser?.write(`${JSON.stringify({ id, method, params })}\0`);
    });
  }

  async handshake(timeoutMs: number): Promise<void> {
    const version = await Promise.race([
      this.call("Browser.getVersion"),
      new Promise<CdpMessage>((resolve) => setTimeout(() => resolve({ error: { message: "timeout" } }), timeoutMs)),
    ]);
    if (version.error || this.closed) {
      throw new CdpError(
        "Could not talk to the browser over remote debugging.",
        "Update the browser, or run `moodle auth login --paste` instead.",
      );
    }
  }

  async getCookies(): Promise<CdpCookie[]> {
    const response = await this.call("Storage.getCookies");
    const cookies = (response.result?.cookies ?? []) as Array<Record<string, unknown>>;
    return cookies.map((cookie) => ({
      name: String(cookie.name ?? ""),
      value: String(cookie.value ?? ""),
      domain: String(cookie.domain ?? ""),
      path: typeof cookie.path === "string" ? cookie.path : undefined,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    }));
  }

  async close(): Promise<void> {
    if (!this.closed) {
      await this.call("Browser.close");
    }
    // Browser.close is best-effort; make sure the process is gone.
    if (!this.child.killed) this.child.kill();
  }
}

interface CdpMessage {
  id?: number;
  result?: { cookies?: unknown };
  error?: { message?: string };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (name.includes("/")) return null;
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(separator).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      // Synchronous existence check keeps discovery ordering simple and cheap.
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
