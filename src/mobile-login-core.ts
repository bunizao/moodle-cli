import { fetchWithSession } from "./session-fetch.js";
import {
  FUNC_MOBILE_AUTOLOGIN_KEY,
  FUNC_MOBILE_PUBLIC_CONFIG,
  MOBILE_AUTOLOGIN_PATH,
  MOBILE_LAUNCH_PATH,
  MOBILE_SERVICE_SHORTNAME,
  MOBILE_URL_SCHEME,
  MOBILE_USER_AGENT,
  MOODLE_SESSION_COOKIE_PREFIX,
  SERVICE_NOLOGIN_PATH,
  WEBSERVICE_REST_PATH,
} from "./constants.js";

/**
 * Moodle's own mobile-app login bridge, used here as a durable renewal channel.
 *
 * A one-time browser sign-in yields a MoodleSession cookie. While it is valid we
 * ask `launch.php` for a Web Service token, which does not expire the way a
 * session does. From then on `tool_mobile_get_autologin_key` plus `autologin.php`
 * mint a fresh MoodleSession cookie on demand with no browser and no cookie
 * store involved. That is the unattended renewal a cookie reader can never do.
 *
 * The whole path is HTTP only, so it lives in a runtime-neutral module the
 * Worker can share. It only works where the site enables the mobile web service;
 * every call degrades to null rather than throwing so callers can fall back.
 */

export interface MobileToken {
  wstoken: string;
  privatetoken?: string;
}

export interface MintedSession {
  cookie: { name: string; value: string; source: string };
}

export interface MobilePublicConfig {
  webserviceEnabled: boolean;
  mobileServiceEnabled: boolean;
}

type Fetcher = typeof fetch;

/**
 * `launch.php` base64-encodes `siteid:::wstoken[:::privatetoken]` into the token
 * redirect. Parse both tokens back out; the private token is what later unlocks
 * the autologin key.
 */
export function parseLaunchToken(location: string): MobileToken | null {
  const match = /token=([^&#]+)/.exec(location);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(decodeURIComponent(match[1]), "base64").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":::");
  // [siteid, wstoken] or [siteid, wstoken, privatetoken].
  if (parts.length < 2 || !parts[1]) return null;
  return { wstoken: parts[1], privatetoken: parts[2] || undefined };
}

/** Read whether the site exposes the mobile web service, without signing in. */
export async function readMobilePublicConfig(
  baseUrl: string,
  fetchImpl: Fetcher = fetch,
): Promise<MobilePublicConfig | null> {
  const url = new URL(SERVICE_NOLOGIN_PATH, ensureTrailingSlash(baseUrl));
  url.searchParams.set("info", FUNC_MOBILE_PUBLIC_CONFIG);
  const body = JSON.stringify([{ index: 0, methodname: FUNC_MOBILE_PUBLIC_CONFIG, args: {} }]);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const data = Array.isArray(payload) ? (payload[0] as { error?: unknown; data?: unknown } | undefined) : undefined;
  if (!data || data.error) return null;
  const config = data.data as Record<string, unknown> | undefined;
  if (!config) return null;
  return {
    webserviceEnabled: config.enablewebservices === 1 || config.enablewebservices === true,
    mobileServiceEnabled: config.enablemobilewebservice === 1 || config.enablemobilewebservice === true,
  };
}

/**
 * Trade a live MoodleSession cookie for a durable mobile Web Service token.
 * Returns null when the site does not offer the mobile service.
 */
export async function fetchMobileToken(
  baseUrl: string,
  cookie: { name: string; value: string },
  fetchImpl: Fetcher = fetch,
): Promise<MobileToken | null> {
  const url = new URL(MOBILE_LAUNCH_PATH, ensureTrailingSlash(baseUrl));
  url.searchParams.set("service", MOBILE_SERVICE_SHORTNAME);
  url.searchParams.set("passport", randomPassport());
  url.searchParams.set("urlscheme", MOBILE_URL_SCHEME);

  let response: Response;
  try {
    // A MoodleMobile user agent keeps us on Moodle's Android redirect branch,
    // which returns the token in a Location header instead of an HTML page.
    response = await fetchWithSession(
      url.toString(),
      { headers: { "user-agent": MOBILE_USER_AGENT } },
      baseUrl,
      cookie,
      fetchImpl,
    );
  } catch {
    return null;
  }

  const location = response.headers.get("location");
  if (location) {
    await response.body?.cancel();
    return parseLaunchToken(location);
  }
  // Some builds render the launch link inline instead of redirecting.
  const html = await response.text().catch(() => "");
  const inline = new RegExp(`${MOBILE_URL_SCHEME}://[^"'\\s]*token=[^"'\\s]+`).exec(html);
  return inline ? parseLaunchToken(inline[0]) : null;
}

/**
 * Mint a fresh MoodleSession cookie from a stored mobile token, no browser
 * involved. Returns null when the site has since disabled the mobile service or
 * the token was revoked, so the caller can fall back to a real login.
 */
export async function mintSessionFromMobileToken(
  baseUrl: string,
  userid: number,
  token: MobileToken,
  fetchImpl: Fetcher = fetch,
): Promise<MintedSession | null> {
  if (!token.privatetoken) return null;
  const key = await requestAutologinKey(baseUrl, token, fetchImpl);
  if (!key) return null;
  return exchangeAutologinKey(baseUrl, userid, key, fetchImpl);
}

async function requestAutologinKey(
  baseUrl: string,
  token: MobileToken,
  fetchImpl: Fetcher,
): Promise<string | null> {
  const url = new URL(WEBSERVICE_REST_PATH, ensureTrailingSlash(baseUrl));
  url.searchParams.set("moodlewsrestformat", "json");
  url.searchParams.set("wsfunction", FUNC_MOBILE_AUTOLOGIN_KEY);
  url.searchParams.set("wstoken", token.wstoken);

  const form = new URLSearchParams({ privatetoken: token.privatetoken ?? "" });
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": MOBILE_USER_AGENT },
      body: form.toString(),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  // A REST fault comes back as { exception, errorcode, message }; a success as { key, autologinurl }.
  if (!payload || typeof payload !== "object" || "exception" in payload) return null;
  const key = (payload as { key?: unknown }).key;
  return typeof key === "string" && key ? key : null;
}

async function exchangeAutologinKey(
  baseUrl: string,
  userid: number,
  key: string,
  fetchImpl: Fetcher,
): Promise<MintedSession | null> {
  const url = new URL(MOBILE_AUTOLOGIN_PATH, ensureTrailingSlash(baseUrl));
  url.searchParams.set("userid", String(userid));
  url.searchParams.set("key", key);

  let response: Response;
  try {
    // autologin.php replies with a 3xx and Set-Cookie; read the header directly
    // rather than following the redirect so we can capture the new cookie.
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { "user-agent": MOBILE_USER_AGENT },
      redirect: "manual",
    });
  } catch {
    return null;
  }

  const value = extractSessionCookie(response);
  return value ? { cookie: { name: value.name, value: value.value, source: "mobile-token" } } : null;
}

function extractSessionCookie(response: Response): { name: string; value: string } | null {
  const headers = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const header of headers) {
    const match = new RegExp(`(${MOODLE_SESSION_COOKIE_PREFIX}\\w*)=([^;\\s]+)`).exec(header);
    // Moodle clears the old cookie with a "deleted" value before setting the
    // real one; skip that sentinel so we keep the live session.
    if (match && match[2] && match[2] !== "deleted") {
      return { name: match[1], value: match[2] };
    }
  }
  return null;
}

function ensureTrailingSlash(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/`;
}

function randomPassport(): string {
  // The app generates a random passport per launch; any value works for us.
  return (Math.random() * 1_000).toFixed(10);
}
