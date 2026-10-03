import {
  AuthBroker,
  createAuthBrokerApi,
  createWorkerHandler,
  digestBearerToken,
  type AdoptResult,
  type LoginBrowser,
  type MoodleCookie,
  type OAuthStorage,
  type SessionBrokerApi,
  type WorkerEnv,
} from "../src/worker/index.js";

const SYNC_TOKEN = "sync-token";
const HOST = "moodle-mcp.example.workers.dev";
const ORIGIN = `https://${HOST}`;
const MOODLE_ORIGIN = "https://lms.example.edu";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const LIVE_VIEW_URL = "https://live.browser.example/view?jwt=live-view-secret";
const SIGNED_IN: MoodleCookie = { name: "MoodleSession", value: "signed-in-cookie" };

class MemoryStorage implements OAuthStorage {
  readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, JSON.parse(JSON.stringify(value)));
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return new Map([...this.entries].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>);
  }
}

function sessionBroker(): SessionBrokerApi {
  return {
    handleMcp: vi.fn(async () => null),
    ready: vi.fn(async () => new Response(null, { status: 503 })),
    replaceSession: vi.fn(async () => new Response(null, { status: 501 })),
    touch: vi.fn(async () => new Response(null, { status: 501 })),
  };
}

async function harness() {
  let clock = 1_800_000_000_000;
  const browser = {
    open: vi.fn<LoginBrowser["open"]>(async () => ({ sessionId: "session-1", targetId: "target-1", liveViewUrl: LIVE_VIEW_URL })),
    readMoodleCookie: vi.fn<LoginBrowser["readMoodleCookie"]>(async () => null),
    close: vi.fn<LoginBrowser["close"]>(async () => undefined),
  };
  const adopt = vi.fn<(cookie: MoodleCookie, allowNewOwner: boolean) => Promise<AdoptResult>>(async () => "adopted");
  const storage = new MemoryStorage();
  const broker = new AuthBroker({ storage }, { EXPECTED_HOST: HOST, MOODLE_ORIGIN }, { now: () => clock, browser, adopt });
  const env: WorkerEnv = {
    EXPECTED_HOST: HOST,
    MCP_ACCESS_TOKEN_DIGEST: await digestBearerToken("access-token"),
    SESSION_SYNC_TOKEN_DIGEST: await digestBearerToken(SYNC_TOKEN),
  };
  const worker = createWorkerHandler({
    mcpServer: { handle: vi.fn(async () => null) },
    broker: () => sessionBroker(),
    authBroker: () => createAuthBrokerApi({ fetch: (request) => broker.fetch(request) }),
  });
  const send = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", HOST);
    return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env);
  };
  return { send, browser, adopt, storage, advance: (ms: number) => { clock += ms; } };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function post(values: Record<string, string>, cookies: string[] = [], headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...cookieHeader(cookies), ...headers },
    body: new URLSearchParams(values).toString(),
  };
}

function cookieHeader(cookies: string[]): Record<string, string> {
  return cookies.length ? { cookie: cookies.join("; ") } : {};
}

// Keeps what a browser would send back: name=value of every cookie still alive.
function jar(response: Response, previous: string[] = []): string[] {
  const kept = new Map(previous.map((item) => [item.split("=")[0], item]));
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [name, value] = pair.split("=");
    if (!value || /Max-Age=0/u.test(header)) kept.delete(name);
    else kept.set(name, pair);
  }
  return [...kept.values()];
}

async function registerClient(h: Harness): Promise<string> {
  const response = await h.send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  return (await response.json() as { client_id: string }).client_id;
}

async function openPairing(h: Harness): Promise<string> {
  const response = await h.send("/pair", { method: "POST", headers: { authorization: `Bearer ${SYNC_TOKEN}` } });
  return (await response.json() as { code: string }).code;
}

function authorizeQuery(clientId: string): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "state-value",
    resource: `${ORIGIN}/mcp`,
  }).toString();
}

// Starts a sign-in and walks the waiting page until Moodle accepts the cookie.
async function signIn(h: Harness, values: Record<string, string>, cookies: string[] = []): Promise<{ response: Response; cookies: string[] }> {
  const started = await h.send("/oauth/login", post(values, cookies));
  expect(started.status).toBe(303);
  expect(started.headers.get("location")).toBe("/oauth/login");
  let jarred = jar(started, cookies);

  const waiting = await h.send("/oauth/login", { headers: cookieHeader(jarred) });
  expect(waiting.status).toBe(200);
  const html = await waiting.text();
  expect(html).toContain('<meta http-equiv="refresh"');
  expect(html).toContain(LIVE_VIEW_URL.replace("&", "&amp;"));

  h.browser.readMoodleCookie.mockResolvedValue(SIGNED_IN);
  const finished = await h.send("/oauth/login", { headers: cookieHeader(jarred) });
  jarred = jar(finished, jarred);
  return { response: finished, cookies: jarred };
}

function csrfFrom(html: string): string {
  const match = html.match(/name="owner_csrf" value="([^"]+)"/u);
  expect(match).not.toBeNull();
  return match![1];
}

describe("Worker owner sign-in through a remote browser", () => {
  it("claims a fresh Worker with the setup code and then approves a client in one click", async () => {
    const h = await harness();
    const code = await openPairing(h);
    const clientId = await registerClient(h);

    const landing = await h.send(`/oauth/login?pairing=${code}`);
    expect(await landing.text()).toContain(`name="pairing_code" value="${code}"`);

    const { response, cookies } = await signIn(h, { pairing_code: code });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/oauth/login");
    expect(h.adopt).toHaveBeenCalledWith(SIGNED_IN, true);
    expect(h.browser.open).toHaveBeenCalledWith(`${MOODLE_ORIGIN}/my/`, expect.any(Number));
    expect(h.browser.close).toHaveBeenCalledWith({ sessionId: "session-1", targetId: "target-1" });
    expect(cookies.map((item) => item.split("=")[0])).toEqual(["__Host-moodle_owner"]);
    expect(response.headers.getSetCookie()[0]).toMatch(/HttpOnly; SameSite=Lax/u);

    const ready = await h.send("/oauth/login", { headers: cookieHeader(cookies) });
    expect(await ready.text()).toContain(`${ORIGIN}/mcp`);

    const approval = await h.send(`/oauth/authorize?${authorizeQuery(clientId)}`, { headers: cookieHeader(cookies) });
    const approved = await h.send("/oauth/authorize", post({
      ...Object.fromEntries(new URLSearchParams(authorizeQuery(clientId))),
      owner_csrf: csrfFrom(await approval.text()),
    }, cookies));
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.get("location")!).searchParams.get("code")).toBeTruthy();

    // The claim spent the setup code.
    const replay = await h.send("/oauth/authorize", post({ ...Object.fromEntries(new URLSearchParams(authorizeQuery(clientId))), pairing_code: code }));
    expect(replay.status).not.toBe(302);
  });

  it("returns to the authorization request the owner started from", async () => {
    const h = await harness();
    const clientId = await registerClient(h);
    const approval = await h.send(`/oauth/authorize?${authorizeQuery(clientId)}`);
    const html = await approval.text();
    expect(html).toContain('action="/oauth/login"');
    const returnTo = html.match(/name="return_to" value="([^"]+)"/u)![1].replaceAll("&amp;", "&");

    const { response } = await signIn(h, { return_to: returnTo });

    expect(h.adopt).toHaveBeenCalledWith(SIGNED_IN, false);
    expect(response.headers.get("location")).toBe(returnTo);
  });

  it("never redirects outside the authorization endpoint", async () => {
    const h = await harness();

    const { response } = await signIn(h, { return_to: "https://evil.example/oauth/authorize?x=1" });

    expect(response.headers.get("location")).toBe("/oauth/login");
  });

  it("refuses an approval without the owner's current CSRF value", async () => {
    const h = await harness();
    const clientId = await registerClient(h);
    const { cookies } = await signIn(h, {});

    const forged = await h.send("/oauth/authorize", post({
      ...Object.fromEntries(new URLSearchParams(authorizeQuery(clientId))),
      owner_csrf: "guessed",
    }, cookies));
    const anonymous = await h.send("/oauth/authorize", post({
      ...Object.fromEntries(new URLSearchParams(authorizeQuery(clientId))),
      owner_csrf: "guessed",
    }));

    expect(forged.status).toBe(403);
    expect(anonymous.status).toBe(403);
  });

  it("ends the attempt when a different Moodle account signs in", async () => {
    const h = await harness();
    h.adopt.mockResolvedValue("wrong_account");

    const { response, cookies } = await signIn(h, {});

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("does not own this server");
    expect(cookies).toEqual([]);
    expect(h.browser.close).toHaveBeenCalled();
    expect(h.storage.entries.get("owner:login")).toBeUndefined();
  });

  it("keeps waiting while Moodle still rejects the cookie, and rechecks it only occasionally", async () => {
    const h = await harness();
    h.adopt.mockResolvedValue("not_signed_in");
    const started = await h.send("/oauth/login", post({}));
    const cookies = jar(started);
    h.browser.readMoodleCookie.mockResolvedValue({ name: "MoodleSession", value: "anonymous" });

    expect((await h.send("/oauth/login", { headers: cookieHeader(cookies) })).status).toBe(200);
    expect((await h.send("/oauth/login", { headers: cookieHeader(cookies) })).status).toBe(200);
    expect(h.adopt).toHaveBeenCalledTimes(1);

    h.advance(20_000);
    await h.send("/oauth/login", { headers: cookieHeader(cookies) });
    expect(h.adopt).toHaveBeenCalledTimes(2);
  });

  it("runs one sign-in at a time and frees the slot when it expires", async () => {
    const h = await harness();
    const first = jar(await h.send("/oauth/login", post({})));

    const second = await h.send("/oauth/login", post({}));
    expect(second.status).toBe(429);
    expect(h.browser.open).toHaveBeenCalledTimes(1);

    h.advance(6 * 60 * 1000);
    const expired = await h.send("/oauth/login", { headers: cookieHeader(first) });
    expect(expired.status).toBe(408);
    expect(h.browser.close).toHaveBeenCalledTimes(1);
    // Today's one anonymous launch is spent; a trusted one still gets the freed slot.
    expect((await h.send("/oauth/login", post({ pairing_code: await openPairing(h) }))).status).toBe(303);
  });

  it("keeps anonymous launches inside half the free Browser Run allowance without locking out the owner", async () => {
    const h = await harness();
    const { cookies: owner } = await signIn(h, {});
    h.browser.readMoodleCookie.mockResolvedValue(null);
    h.advance(6 * 60 * 1000);

    const paused = await h.send("/oauth/login", post({}));
    expect(paused.status).toBe(429);
    expect(await paused.text()).toContain("paused for today");
    expect(h.browser.open).toHaveBeenCalledTimes(1);
    expect((await h.send("/oauth/login", post({}, owner))).status).toBe(303);

    h.advance(24 * 60 * 60 * 1000);
    expect((await h.send("/oauth/login", post({}))).status).toBe(303);
  });

  it("lets the owner take over a sign-in a stranger left running, but not the reverse", async () => {
    const h = await harness();
    const { cookies: owner } = await signIn(h, { pairing_code: await openPairing(h) });
    h.browser.readMoodleCookie.mockResolvedValue(null);
    expect((await h.send("/oauth/login", post({}))).status).toBe(303);

    const takeover = await h.send("/oauth/login", post({}, owner));
    const stranger = await h.send("/oauth/login", post({}));

    expect(takeover.status).toBe(303);
    expect(h.browser.close).toHaveBeenCalledTimes(2);
    expect(stranger.status).toBe(429);
  });

  it("refuses a wrong setup code without starting a browser", async () => {
    const h = await harness();
    await openPairing(h);

    const response = await h.send("/oauth/login", post({ pairing_code: "WRONG-CODE" }));

    expect(response.status).toBe(403);
    expect(h.browser.open).not.toHaveBeenCalled();
  });

  it("accepts a sign-in form whose Origin Chromium serialized as null", async () => {
    const h = await harness();

    const response = await h.send("/oauth/login", post({}, [], { origin: "null" }));

    expect(response.status).toBe(303);
  });

  it("signs every owner out when all clients are revoked", async () => {
    const h = await harness();
    const { cookies } = await signIn(h, {});

    await h.send("/clients", { method: "DELETE", headers: { authorization: `Bearer ${SYNC_TOKEN}` } });

    const after = await h.send("/oauth/login", { headers: cookieHeader(cookies) });
    expect(await after.text()).toContain("Sign in with Moodle");
  });

  it("keeps neither the Moodle cookie nor the Live View URL once sign-in ends", async () => {
    const h = await harness();

    await signIn(h, {});

    const state = JSON.stringify([...h.storage.entries]);
    expect(state).not.toContain(SIGNED_IN.value);
    expect(state).not.toContain("live-view-secret");
  });
});
