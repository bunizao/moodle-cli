import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultBrowserCookieProvider } from "./auth.js";
import { loadConfig, userConfigPath } from "./config.js";
import { getAuthStatus } from "./keepalive.js";
import { runtimeCommand, runtimeSupportsCookies } from "./mcp/self-command.js";

export async function ownedJobs(homeDir = homedir()): Promise<Array<{ path: string; profile?: string; interpreter?: string }>> {
  const root = join(homeDir, "Library", "LaunchAgents");
  const files = await readdir(root).catch(() => [] as string[]);
  const jobs = [];
  for (const name of files.filter(n => n === "com.moodle-cli.keepalive.plist" || /^com\.moodle-cli\.mcp-renewal\.[a-z0-9_-]+\.plist$/u.test(n))) {
    const path = join(root, name);
    const content = await readFile(path, "utf8");
    jobs.push({ path, profile: name.match(/mcp-renewal\.(.+)\.plist$/u)?.[1], interpreter: content.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/u)?.[1] });
  }
  return jobs;
}

export async function doctor(options: { homeDir?: string; cwd?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}) {
  const home = options.homeDir ?? homedir();
  const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string; hint?: string }> = [];
  const cookies = runtimeSupportsCookies();
  checks.push({ name: "sqlite", status: cookies ? "pass" : "fail", detail: `${process.versions.bun ? "bun" : "node"} ${process.versions.bun ?? process.versions.node}`, ...(cookies ? {} : { hint: "Install Bun or Node 22.13+; Safari cookie reads do not require SQLite." }) });
  let baseUrl: string | undefined;
  try { baseUrl = (await loadConfig({ ...options, stdin: { isTTY: false } })).baseUrl; checks.push({ name: "config", status: "pass", detail: baseUrl }); }
  catch { checks.push({ name: "config", status: "fail", detail: "No usable Moodle URL configured.", hint: "Run moodle interactively once, or set MOODLE_BASE_URL." }); }
  if (baseUrl) {
    try {
      const status = await getAuthStatus(baseUrl, { homeDir: home, fetchImpl: options.fetchImpl });
      checks.push({ name: "session", status: status.session_alive ? "pass" : "warn", detail: status.session_cached ? `Cache age ${status.cache_age_minutes} minutes; alive: ${status.session_alive}` : "No cached session.", ...(!status.session_alive ? { hint: "Run moodle auth login." } : {}) });
    } catch { checks.push({ name: "session", status: "warn", detail: "Could not read or validate the session cache.", hint: "Run moodle auth login from a regular terminal." }); }
    const warnings: string[] = [];
    try {
      const found = await defaultBrowserCookieProvider(baseUrl, { homeDir: home, onCookieWarnings: items => warnings.push(...items) });
      const blocked = warnings.some(w => /EPERM|EACCES|permission denied|operation not permitted/iu.test(w));
      checks.push({ name: "browser", status: blocked ? "fail" : found.length ? "pass" : "warn", detail: blocked ? "Browser store access was denied." : found.length ? `Cookie sources: ${[...new Set(found.map(c => c.source || "browser"))].join(", ")}` : "No browser session found.", ...(blocked ? { hint: "System Settings > Privacy & Security > Full Disk Access: enable the app running this command, then restart it." } : !found.length ? { hint: "Sign in to Moodle in a supported browser, then run moodle auth login." } : {}) });
    } catch { checks.push({ name: "browser", status: "warn", detail: "Could not inspect browser stores.", hint: "Run moodle auth login from a regular terminal." }); }
  }
  const stores: Array<{ browser: string; path: string; readable: boolean }> = [];
  if (process.platform === "darwin") {
    for (const [browser, directory] of [["Chrome", "Google/Chrome"], ["Edge", "Microsoft Edge"], ["Brave", "BraveSoftware/Brave-Browser"], ["Firefox", "Firefox/Profiles"]]) {
      const root = join(home, "Library/Application Support", directory);
      for (const profile of await readdir(root).catch(() => [] as string[])) {
        if (browser !== "Firefox" && profile !== "Default" && !profile.startsWith("Profile ")) continue;
        for (const name of browser === "Firefox" ? ["cookies.sqlite"] : ["Cookies", "Network/Cookies"]) {
          const file = join(root, profile, name);
          try { await access(file); stores.push({ browser, path: file, readable: await access(file, constants.R_OK).then(() => true, () => false) }); } catch { /* Missing stores are not browser sessions. */ }
        }
      }
    }
    for (const file of [join(home, "Library/Cookies/Cookies.binarycookies"), join(home, "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies")]) {
      try { await access(file); stores.push({ browser: "Safari", path: file, readable: await access(file, constants.R_OK).then(() => true, () => false) }); } catch { /* Safari may not have a cookie store. */ }
    }
  }
  const jobs = await ownedJobs(home);
  for (const job of jobs) {
    const present = job.interpreter ? await access(job.interpreter, constants.X_OK).then(() => true, () => false) : false;
    const supported = present && (job.interpreter === process.execPath && !runtimeCommand().args.length || runtimeSupportsCookies(job.interpreter));
    checks.push({ name: "job", status: supported ? "pass" : "warn", detail: `${job.path}: ${job.interpreter ?? "missing interpreter"}`, ...(!supported ? { hint: job.profile ? "Run moodle mcp deploy to repair renewal." : "Run moodle auth keepalive install." } : {}) });
  }
  const profiles = await readdir(join(home, ".config", "moodle-cli", "mcp", "deployments")).catch(() => [] as string[]);
  checks.push({ name: "mcp", status: profiles.length ? "pass" : "warn", detail: profiles.length ? `${profiles.length} local deployment receipts. Run moodle mcp status for remote readiness.` : "No managed MCP deployment; optional for CLI use." });
  let pin: unknown;
  try { pin = runtimeCommand(); } catch { /* The sqlite check already explains the failure. */ }
  return { runtime: { executable: process.execPath, version: process.versions.bun ?? process.versions.node, cookie_sqlite: cookies }, config_path: userConfigPath(home), browser_stores: stores, pin, checks };
}
