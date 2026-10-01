import { digestBearerToken } from "./auth.js";
import type { LoginBrowser, LoginBrowserHandle, MoodleCookie } from "./browser-login.js";
import type { DurableObjectNamespaceLike } from "./http.js";
import { AUTHORIZE_PATH, LOGIN_PATH, type OAuthStorage, type OwnerVerifier } from "./oauth.js";
import { escapeHtml, htmlResponse, page } from "./pages.js";

// The owner proves who they are by signing in to Moodle in a remote browser. The
// session broker only accepts the account the Worker already belongs to, or, for a
// fresh deployment, a sign-in that came with the pairing code from the deploy.

const OWNER_COOKIE = "__Host-moodle_owner";
const LOGIN_COOKIE = "__Host-moodle_login";
const OWNER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 5 * 60 * 1000;
const POLL_SECONDS = 3;
// Moodle normally issues a new cookie at sign-in, but a site that keeps the anonymous
// one would otherwise never be checked again.
const RECHECK_SAME_COOKIE_MS = 15_000;
// Anyone who finds the Worker URL can reach the sign-in page, and every launch spends
// the owner's Browser Run allowance (10 browser minutes a day on the free plan). The
// waiting page keeps a launch alive for its whole window, so anonymous launches times
// that window must stay well under the allowance. A request with the owner cookie or
// a pairing code is trusted; the one anonymous launch is for the owner on a new device.
const TRUSTED_LAUNCHES_PER_DAY = 20;
const ANONYMOUS_LAUNCHES_PER_DAY = 1;
const OWNER_PREFIX = "owner:session:";
const LOGIN_KEY = "owner:login";
const LAUNCH_KEY = "owner:launches";

export type AdoptResult = "adopted" | "not_signed_in" | "wrong_account" | "claim_required" | "unavailable";

export interface OwnerLoginOptions {
  storage: OAuthStorage;
  moodleOrigin?: string;
  mcpUrl: string;
  browser?: LoginBrowser;
  adopt?(cookie: MoodleCookie, allowNewOwner: boolean): Promise<AdoptResult>;
  pairing: { check(code: string): Promise<boolean>; close(): Promise<void> };
  now: () => number;
  createSecret: () => string;
}

export interface OwnerLogin extends OwnerVerifier {
  handle(request: Request, url: URL): Promise<Response>;
  signOutAll(): Promise<void>;
}

interface LoginRecord {
  digest: string;
  browser: LoginBrowserHandle;
  liveViewUrl: string;
  expiresAt: number;
  returnTo: string;
  claim: boolean;
  trusted: boolean;
  seenCookie?: string;
  seenAt?: number;
}

interface OwnerSession {
  expiresAt: number;
  csrf: string;
}

interface LaunchCount {
  day: string;
  trusted: number;
  anonymous: number;
}

export function createOwnerLogin(options: OwnerLoginOptions): OwnerLogin {
  const { storage, browser, adopt, moodleOrigin, now } = options;
  const signInAvailable = Boolean(browser && adopt && moodleOrigin);

  async function readOwner(request: Request): Promise<OwnerSession | null> {
    const secret = readCookie(request, OWNER_COOKIE);
    if (!secret) return null;
    const key = `${OWNER_PREFIX}${await digestBearerToken(secret)}`;
    const session = await storage.get<OwnerSession>(key);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      await storage.delete(key);
      return null;
    }
    return session;
  }

  async function readLogin(request: Request): Promise<{ record?: LoginRecord; mine: boolean }> {
    const record = await storage.get<LoginRecord>(LOGIN_KEY);
    if (!record) return { mine: false };
    const secret = readCookie(request, LOGIN_COOKIE);
    return { record, mine: Boolean(secret) && await digestBearerToken(secret!) === record.digest };
  }

  async function endLogin(record: LoginRecord): Promise<void> {
    await storage.delete(LOGIN_KEY);
    await browser?.close(record.browser);
  }

  // Counts the launch and reports whether it fits today's (UTC) allowance.
  async function spendLaunch(trusted: boolean): Promise<boolean> {
    const day = new Date(now()).toISOString().slice(0, 10);
    const stored = await storage.get<LaunchCount>(LAUNCH_KEY);
    const count = stored?.day === day ? stored : { day, trusted: 0, anonymous: 0 };
    if (trusted ? count.trusted >= TRUSTED_LAUNCHES_PER_DAY : count.anonymous >= ANONYMOUS_LAUNCHES_PER_DAY) return false;
    await storage.put<LaunchCount>(LAUNCH_KEY, trusted
      ? { ...count, trusted: count.trusted + 1 }
      : { ...count, anonymous: count.anonymous + 1 });
    return true;
  }

  async function start(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return htmlResponse(noticePage("Sign-in failed", "The sign-in form was submitted with an unsupported content type."), 415);
    }
    const form = new URLSearchParams(await request.text());
    if (!signInAvailable) {
      return htmlResponse(noticePage("Browser sign-in unavailable", "This deployment cannot start a remote browser. Run `moodle mcp deploy` to update it, or approve with `moodle mcp pair`."), 503);
    }
    const returnTo = safeReturnTo(form.get("return_to"));
    const { record, mine } = await readLogin(request);
    if (record && mine) return redirect(LOGIN_PATH);

    const code = form.get("pairing_code")?.trim() ?? "";
    const claim = code ? await options.pairing.check(code) : false;
    if (code && !claim) {
      return htmlResponse(startPage({ returnTo, askCode: true, message: "That code is not correct, or its window has closed. Run `moodle mcp pair` for a new one." }), 403);
    }
    const trusted = claim || Boolean(await readOwner(request));
    // A trusted request may take over an anonymous attempt, so a stranger holding
    // the only slot cannot keep the owner out.
    if (record && record.expiresAt > now() && !(trusted && !record.trusted)) {
      const minutes = Math.max(1, Math.ceil((record.expiresAt - now()) / 60_000));
      return htmlResponse(noticePage("Sign-in already running", `Another sign-in is in progress. It ends within ${minutes} ${minutes === 1 ? "minute" : "minutes"}; try again then.`), 429);
    }
    if (!await spendLaunch(trusted)) {
      return htmlResponse(noticePage("Sign-in paused for today", "Remote sign-ins are paused for today to protect this server's Browser Run allowance. Try again tomorrow, or sign in with a code from `moodle mcp pair`."), 429);
    }
    if (record) await endLogin(record);

    let opened: Awaited<ReturnType<LoginBrowser["open"]>>;
    try {
      opened = await browser!.open(`${moodleOrigin}/my/`, LOGIN_TTL_MS);
    } catch {
      return htmlResponse(noticePage("Remote browser unavailable", "Cloudflare could not start the remote browser. Its free plan allows 10 browser minutes a day; try again later, or approve with `moodle mcp pair`."), 503);
    }
    const secret = options.createSecret();
    await storage.put<LoginRecord>(LOGIN_KEY, {
      digest: await digestBearerToken(secret),
      browser: { sessionId: opened.sessionId, targetId: opened.targetId },
      liveViewUrl: opened.liveViewUrl,
      expiresAt: now() + LOGIN_TTL_MS,
      returnTo,
      claim,
      trusted,
    });
    return redirect(LOGIN_PATH, [cookie(LOGIN_COOKIE, secret, LOGIN_TTL_MS)]);
  }

  async function poll(request: Request, url: URL): Promise<Response> {
    const { record, mine } = await readLogin(request);
    if (!record || !mine) {
      const owner = await readOwner(request);
      if (owner) return htmlResponse(signedInPage(options.mcpUrl));
      const pairing = url.searchParams.get("pairing") ?? undefined;
      return htmlResponse(startPage({ pairing, unavailable: !signInAvailable }));
    }
    if (record.expiresAt <= now()) {
      await endLogin(record);
      return withCookies(htmlResponse(startPage({ returnTo: record.returnTo, message: "The sign-in window closed before Moodle finished. Start again." }), 408), [cookie(LOGIN_COOKIE, "", 0)]);
    }

    let found: MoodleCookie | null;
    try {
      found = await browser!.readMoodleCookie(record.browser, moodleOrigin!);
    } catch {
      await endLogin(record);
      return withCookies(htmlResponse(startPage({ returnTo: record.returnTo, message: "The remote browser closed. Start again." }), 410), [cookie(LOGIN_COOKIE, "", 0)]);
    }
    if (!found) return htmlResponse(waitingPage(record, now()));

    const seen = await digestBearerToken(`${found.name}=${found.value}`);
    if (seen === record.seenCookie && now() - (record.seenAt ?? 0) < RECHECK_SAME_COOKIE_MS) {
      return htmlResponse(waitingPage(record, now()));
    }
    const result = await adopt!(found, record.claim);
    if (result === "adopted") {
      await endLogin(record);
      if (record.claim) await options.pairing.close();
      const ownerSecret = options.createSecret();
      await storage.put<OwnerSession>(`${OWNER_PREFIX}${await digestBearerToken(ownerSecret)}`, {
        expiresAt: now() + OWNER_SESSION_TTL_MS,
        csrf: options.createSecret(),
      });
      return redirect(record.returnTo, [cookie(OWNER_COOKIE, ownerSecret, OWNER_SESSION_TTL_MS), cookie(LOGIN_COOKIE, "", 0)]);
    }
    if (result === "wrong_account" || result === "claim_required") {
      await endLogin(record);
      const message = result === "wrong_account"
        ? "That Moodle account does not own this server. Sign in with the account it was set up for."
        : "This server has no owner yet. Enter the code from `moodle mcp deploy` or `moodle mcp pair` to claim it.";
      return withCookies(htmlResponse(startPage({ returnTo: record.returnTo, askCode: result === "claim_required", message }), 403), [cookie(LOGIN_COOKIE, "", 0)]);
    }
    // Not signed in yet, or Moodle blipped: keep waiting, and only remember a cookie
    // Moodle actually looked at.
    if (result === "not_signed_in") await storage.put<LoginRecord>(LOGIN_KEY, { ...record, seenCookie: seen, seenAt: now() });
    return htmlResponse(waitingPage(record, now()));
  }

  return {
    signInAvailable,
    async verifyOwner(request) {
      const owner = await readOwner(request);
      return owner ? { csrf: owner.csrf } : null;
    },
    async handle(request, url) {
      if (request.method === "POST") return start(request);
      if (request.method === "GET") return poll(request, url);
      return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    },
    async signOutAll() {
      for (const key of (await storage.list({ prefix: OWNER_PREFIX })).keys()) await storage.delete(key);
      const record = await storage.get<LoginRecord>(LOGIN_KEY);
      if (record) await endLogin(record);
    },
  };
}

export function createSessionAdopter(namespace: DurableObjectNamespaceLike): NonNullable<OwnerLoginOptions["adopt"]> {
  const stub = namespace.get(namespace.idFromName("primary"));
  return async (cookie, allowNewOwner) => {
    const response = await stub.fetch(new Request("https://session-broker/session/adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookieName: cookie.name, cookieValue: cookie.value, allowNewOwner }),
    }));
    if (response.status === 201) return "adopted";
    if (response.status === 422) return "not_signed_in";
    const code = await response.json().then((body: { code?: unknown }) => body?.code).catch(() => undefined);
    if (code === "SESSION_ACCOUNT_MISMATCH") return "wrong_account";
    if (code === "OWNER_CLAIM_REQUIRED") return "claim_required";
    return "unavailable";
  };
}

// Only the authorization endpoint may be a return target, so the sign-in cannot be
// turned into an open redirect.
function safeReturnTo(value: string | null): string {
  if (!value) return LOGIN_PATH;
  try {
    const parsed = new URL(value, "https://worker.invalid");
    return parsed.origin === "https://worker.invalid" && parsed.pathname === AUTHORIZE_PATH
      ? `${parsed.pathname}${parsed.search}`
      : LOGIN_PATH;
  } catch {
    return LOGIN_PATH;
  }
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || undefined;
  }
  return undefined;
}

function cookie(name: string, value: string, maxAgeMs: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

function redirect(location: string, cookies: string[] = []): Response {
  return withCookies(new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } }), cookies);
}

function withCookies(response: Response, cookies: string[]): Response {
  for (const value of cookies) response.headers.append("set-cookie", value);
  return response;
}

function startPage(options: { returnTo?: string; pairing?: string; askCode?: boolean; message?: string; unavailable?: boolean }): string {
  if (options.unavailable) {
    return noticePage("Browser sign-in unavailable", "This deployment cannot start a remote browser. Run `moodle mcp deploy` to update it, or approve with `moodle mcp pair`.");
  }
  const codeField = options.pairing
    ? `<input type="hidden" name="pairing_code" value="${escapeHtml(options.pairing)}">`
    : options.askCode
      ? `<label for="pairing_code">Setup code</label>
<input id="pairing_code" name="pairing_code" placeholder="XXXX-XXXX" maxlength="9" required autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false">`
      : "";
  const returnField = options.returnTo && options.returnTo !== LOGIN_PATH
    ? `<input type="hidden" name="return_to" value="${escapeHtml(options.returnTo)}">`
    : "";
  return page("Sign in with Moodle", `<h1>Sign in with Moodle</h1>
${options.message ? `<p class="error">${escapeHtml(options.message)}</p>` : ""}
<p>This opens a private browser in your Cloudflare account on your Moodle sign-in page. Sign in as usual, including MFA.</p>
<form method="post" action="${LOGIN_PATH}">${returnField}${codeField}
<button type="submit">Sign in with Moodle</button></form>
<p class="note">This server never reads what you type there. Once Moodle's dashboard loads, it keeps the Moodle session and closes the browser.</p>`);
}

function waitingPage(record: LoginRecord, now: number): string {
  const minutes = Math.max(1, Math.ceil((record.expiresAt - now) / 60_000));
  return page("Waiting for Moodle", `<h1>Waiting for Moodle</h1>
<p>Open the sign-in browser and sign in as usual. This page continues by itself once Moodle's dashboard appears.</p>
<a class="button" href="${escapeHtml(record.liveViewUrl)}" target="_blank" rel="noopener noreferrer">Open Moodle sign-in</a>
<p class="note">${minutes} ${minutes === 1 ? "minute" : "minutes"} left. Keep this tab open.</p>`).replace("<head>", `<head><meta http-equiv="refresh" content="${POLL_SECONDS}">`);
}

function signedInPage(mcpUrl: string): string {
  return page("Moodle MCP is ready", `<h1>Moodle MCP is ready</h1>
<p class="open">You are signed in as this server's owner.</p>
<dl><dt>Connector URL</dt><dd><code>${escapeHtml(mcpUrl)}</code></dd></dl>
<p>Add it as a custom connector in your MCP client. In Claude: Settings → Connectors → Add custom connector.</p>
<form method="post" action="${LOGIN_PATH}"><button type="submit" class="quiet">Sign in again to renew the Moodle session</button></form>`);
}

function noticePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p class="error">${escapeHtml(message)}</p>`);
}
