import { ConfigError } from "./errors.js";
import { LOGIN_PATH } from "./constants.js";
import { fetchPublicConfig } from "./mobile-login-core.js";
import { parseMoodleConfig } from "./scraper.js";

/**
 * Find a Moodle install root (Moodle's own `wwwroot`) from whatever address a person
 * pastes: the bare host, the dashboard, a course page, the login page.
 *
 * Moodle can live under any path, so nothing here guesses one. Every Moodle page is
 * `{wwwroot}/something.php`, which means the root is always a prefix of a pasted page
 * address. We ask each prefix, deepest first, for the public site config, and Moodle
 * answers with its own `wwwroot`. When that finds nothing (the person pasted only a host,
 * or the site blocks the anonymous service) we follow the pasted address the way a
 * browser would: Moodle's first redirect for a signed-out visitor is always
 * `{wwwroot}/login/index.php`, and any Moodle page it lands on prints `M.cfg.wwwroot`.
 */

export type DiscoverySource = "site_config" | "login_redirect" | "page";

export interface DiscoveredSite {
  root: string;
  sitename?: string;
  source: DiscoverySource;
}

export type Discovery =
  /** A Moodle install on the host the person gave. */
  | { kind: "found"; site: DiscoveredSite }
  /** Moodle answered, but says its address is on another host; ask before using it. */
  | { kind: "elsewhere"; site: DiscoveredSite }
  /** The address led to another host that is not Moodle, usually a sign-in provider. */
  | { kind: "redirected"; host: string }
  | { kind: "unreachable"; message: string }
  /** Nothing Moodle-shaped at the address; `status` is the HTTP status it ended on. */
  | { kind: "not_found"; status?: number };

export interface DiscoveryOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// An install path is rarely more than three segments and a page path rarely more than
// five, so ten prefixes covers real sites while bounding what one paste can trigger.
const MAX_CANDIDATES = 10;
const MAX_REDIRECTS = 8;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Parse what a person typed. A missing scheme means https; query and fragment are kept for following. */
export function parseSiteInput(value: string): URL {
  const raw = value.trim();
  if (!raw) throw new ConfigError("Enter the address of your Moodle site.");
  const withScheme = hasScheme(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ConfigError(`"${raw}" is not a web address.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("The address must start with https:// or http://.");
  }
  if (!parsed.hostname) throw new ConfigError("The address must include a host name.");
  return parsed;
}

/** Install-root candidates for a pasted address, deepest first, ending with the bare origin. */
export function candidateRoots(input: URL): string[] {
  const segments = input.pathname.split("/").filter(Boolean);
  // The last segment of a page address is a script, never a directory.
  if (segments.length && /\.php$/iu.test(segments[segments.length - 1])) segments.pop();
  const origins = input.protocol === "http:" ? [`https://${input.host}`, input.origin] : [input.origin];
  const paths: string[] = [];
  for (let count = segments.length; count >= 0; count -= 1) {
    paths.push(count ? `/${segments.slice(0, count).join("/")}` : "");
  }
  // Too deep to be real: keep the shallow end, where install roots live.
  const kept = paths.slice(-MAX_CANDIDATES);
  return origins.flatMap(origin => kept.map(path => `${origin}${path}`));
}

export async function discoverSite(value: string, options: DiscoveryOptions = {}): Promise<Discovery> {
  const input = parseSiteInput(value);
  const result = await discoverAt(input, options);
  // An address typed without a scheme was assumed https; a site that only speaks http
  // is still found, but only when the person did not ask for https themselves.
  if (result.kind === "unreachable" && !hasScheme(value)) {
    const plain = new URL(input.href);
    plain.protocol = "http:";
    const fallback = await discoverAt(plain, options);
    if (fallback.kind !== "unreachable") return fallback;
  }
  return result;
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value.trim());
}

async function discoverAt(input: URL, options: DiscoveryOptions): Promise<Discovery> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Probes run together: each is one small POST and a person is waiting on the answer.
  const candidates = candidateRoots(input);
  const probes = await Promise.allSettled(candidates.map(root => askSite(root, fetcher, timeoutMs)));
  for (const probe of probes) {
    if (probe.status === "fulfilled" && probe.value) {
      return classify(input, probe.value.root, probe.value.sitename, "site_config");
    }
  }
  if (probes.every(probe => probe.status === "rejected")) {
    return { kind: "unreachable", message: describeFailure(input.host, (probes[0] as PromiseRejectedResult).reason) };
  }

  return followAddress(input, fetcher, timeoutMs);
}

async function askSite(root: string, fetcher: typeof fetch, timeoutMs: number): Promise<{ root: string; sitename?: string } | null> {
  const config = await fetchPublicConfig(root, fetcher, AbortSignal.timeout(timeoutMs));
  const declared = typeof config?.wwwroot === "string" ? cleanRoot(config.wwwroot) : null;
  if (!declared) return null;
  const sitename = typeof config?.sitename === "string" && config.sitename.trim() ? stripTags(config.sitename) : undefined;
  return { root: declared, ...(sitename ? { sitename } : {}) };
}

async function followAddress(input: URL, fetcher: typeof fetch, timeoutMs: number): Promise<Discovery> {
  let current = new URL(input.href);
  current.hash = "";
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetcher(current.href, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return hop === 0 ? { kind: "unreachable", message: describeFailure(current.host, error) } : { kind: "redirected", host: current.host };
    }

    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location) {
      await response.body?.cancel();
      const next = new URL(location, current);
      // require_login always sends a signed-out visitor to {wwwroot}/login/index.php first;
      // a sign-in provider, if the site forces one, only comes after that.
      if (next.pathname.endsWith(LOGIN_PATH)) {
        const root = `${next.origin}${next.pathname.slice(0, -LOGIN_PATH.length)}`;
        return confirm(input, root, fetcher, timeoutMs, "login_redirect");
      }
      current = next;
      continue;
    }

    const type = response.headers.get("content-type") ?? "";
    const html = response.ok && type.includes("html") ? await response.text() : "";
    if (!html) await response.body?.cancel();
    const wwwroot = parseMoodleConfig(html).wwwroot;
    const declared = typeof wwwroot === "string" ? cleanRoot(wwwroot) : null;
    if (declared) return confirm(input, declared, fetcher, timeoutMs, "page");
    return current.host === input.host ? { kind: "not_found", status: response.status } : { kind: "redirected", host: current.host };
  }
  return { kind: "redirected", host: current.host };
}

/** Prefer Moodle's own answer at a root found by following; keep the evidence when the service is off. */
async function confirm(input: URL, root: string, fetcher: typeof fetch, timeoutMs: number, source: DiscoverySource): Promise<Discovery> {
  const answer = await askSite(root, fetcher, timeoutMs).catch(() => null);
  if (answer) return classify(input, answer.root, answer.sitename, "site_config");
  return classify(input, root, undefined, source);
}

function classify(input: URL, root: string, sitename: string | undefined, source: DiscoverySource): Discovery {
  const site: DiscoveredSite = { root, ...(sitename ? { sitename } : {}), source };
  // The session cookie is later sent wherever this points, so a host the person did not
  // name is only ever offered, never taken silently.
  return new URL(root).host === input.host ? { kind: "found", site } : { kind: "elsewhere", site };
}

function cleanRoot(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim();
}

function describeFailure(host: string, error: unknown): string {
  // fetch reports every network failure as "fetch failed"; the useful part is the cause.
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause as { code?: unknown; message?: unknown } : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (error instanceof Error && error.name === "TimeoutError") return `${host} did not answer in time.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${host} does not resolve. Check the spelling, or your network or VPN.`;
  if (code === "ECONNREFUSED") return `Nothing is answering at ${host}.`;
  // A proxy or VPN that fakes DNS turns an unknown host into a reset connection.
  if (code === "ECONNRESET") return `${host} dropped the connection. Check the spelling, or your network, proxy or VPN.`;
  if (/CERT|SSL|SIGNATURE/u.test(code)) return `${host} has a certificate this computer does not trust.`;
  const detail = typeof cause?.message === "string" && cause.message ? cause.message : error instanceof Error ? error.message : String(error);
  return `Could not reach ${host}: ${detail}`;
}
