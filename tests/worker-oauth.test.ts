import {
  AuthBroker,
  createAuthBrokerApi,
  createWorkerHandler,
  digestBearerToken,
  type OAuthStorage,
  type SessionBrokerApi,
  type WorkerEnv,
} from "../src/worker/index.js";

const SYNC_TOKEN = "sync-token";
const ACCESS_TOKEN = "access-token";
const HOST = "moodle-mcp.example.workers.dev";
const ORIGIN = `https://${HOST}`;
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "verifier-verifier-verifier-verifier-verifier";

class MemoryStorage implements OAuthStorage {
  private readonly entries = new Map<string, unknown>();

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
    return new Map(
      [...this.entries].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
    );
  }
}

function createBroker(): SessionBrokerApi {
  return {
    handleMcp: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: {} })),
    ready: vi.fn(async () => new Response(null, { status: 503 })),
    replaceSession: vi.fn(async () => new Response(null, { status: 501 })),
    touch: vi.fn(async () => new Response(null, { status: 501 })),
  };
}

async function harness(options: { now?: () => number } = {}) {
  const env: WorkerEnv = {
    EXPECTED_HOST: HOST,
    MCP_ACCESS_TOKEN_DIGEST: await digestBearerToken(ACCESS_TOKEN),
    SESSION_SYNC_TOKEN_DIGEST: await digestBearerToken(SYNC_TOKEN),
  };
  const storage = new MemoryStorage();
  const broker = new AuthBroker({ storage }, { EXPECTED_HOST: HOST }, options);
  const mcpServer = { handle: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } })) };
  const worker = createWorkerHandler({
    mcpServer,
    broker: () => createBroker(),
    authBroker: () => createAuthBrokerApi({ fetch: (request) => broker.fetch(request) }),
  });
  return { env, worker, mcpServer, storage };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function form(values: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  };
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function registerClient(worker: Awaited<ReturnType<typeof harness>>["worker"], env: WorkerEnv, redirectUris = [REDIRECT_URI]) {
  const response = await worker.fetch(request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
  }), env);
  return { response, body: await response.json() as Record<string, unknown> };
}

async function openPairing(worker: Awaited<ReturnType<typeof harness>>["worker"], env: WorkerEnv): Promise<string> {
  const response = await worker.fetch(request("/pair", {
    method: "POST",
    headers: { authorization: `Bearer ${SYNC_TOKEN}` },
  }), env);
  expect(response.status).toBe(200);
  const body = await response.json() as { code: string };
  return body.code;
}

async function authorize(
  worker: Awaited<ReturnType<typeof harness>>["worker"],
  env: WorkerEnv,
  clientId: string,
  pairingCode: string,
): Promise<Response> {
  return worker.fetch(request("/oauth/authorize", form({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    state: "state-value",
    resource: `${ORIGIN}/mcp`,
    pairing_code: pairingCode,
  })), env);
}

async function exchangeCode(
  worker: Awaited<ReturnType<typeof harness>>["worker"],
  env: WorkerEnv,
  clientId: string,
  code: string,
): Promise<Record<string, unknown>> {
  const response = await worker.fetch(request("/oauth/token", form({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
    resource: `${ORIGIN}/mcp`,
  })), env);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

function mcpRequest(token: string): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  };
}

describe("Worker OAuth authorization server", () => {
  it("publishes protected-resource and authorization-server metadata", async () => {
    const { worker, env } = await harness();

    const resource = await worker.fetch(request("/.well-known/oauth-protected-resource"), env);
    const server = await worker.fetch(request("/.well-known/oauth-authorization-server/mcp"), env);

    expect(await resource.json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ["moodle.read"],
    });
    expect(await server.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("points unauthenticated MCP clients at the protected-resource metadata", async () => {
    const { worker, env } = await harness();

    const response = await worker.fetch(request("/mcp", mcpRequest("not-a-token")), env);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="moodle-mcp", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
  });

  it("registers public clients and rejects unapproved redirect targets", async () => {
    const { worker, env } = await harness();

    const registered = await registerClient(worker, env);
    const foreign = await registerClient(worker, env, ["https://evil.example/callback"]);
    const confidential = await worker.fetch(request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "client_secret_post" }),
    }), env);

    expect(registered.response.status).toBe(201);
    expect(registered.body).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [REDIRECT_URI] });
    expect(registered.body.client_id).toEqual(expect.any(String));
    expect(registered.body).not.toHaveProperty("client_secret");
    expect(foreign.response.status).toBe(400);
    expect(foreign.body).toMatchObject({ error: "invalid_redirect_uri" });
    expect(confidential.status).toBe(400);
  });

  it("reclaims pending slots without evicting approved clients", async () => {
    const { worker, env } = await harness();
    const first = await registerClient(worker, env);
    await authorize(worker, env, first.body.client_id as string, await openPairing(worker, env));
    for (let index = 1; index < 20; index += 1) await registerClient(worker, env);

    const overflow = await registerClient(worker, env);
    const existing = await worker.fetch(request(`/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: first.body.client_id as string,
      redirect_uri: REDIRECT_URI,
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp`,
    })}`), env);

    expect(overflow.response.status).toBe(201);
    expect(existing.status).toBe(200);
  });

  it("refuses to approve access while no pairing window is open", async () => {
    const { worker, env } = await harness();
    const { body } = await registerClient(worker, env);

    const response = await authorize(worker, env, body.client_id as string, "ABCD2345");

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("moodle mcp pair");
  });

  it("completes the pairing, code, and token exchange that claude.ai performs", async () => {
    const { worker, env, mcpServer } = await harness();
    const { body } = await registerClient(worker, env);
    const clientId = body.client_id as string;
    const pairingCode = await openPairing(worker, env);

    const approved = await authorize(worker, env, clientId, pairingCode);
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("state-value");

    const tokens = await exchangeCode(worker, env, clientId, location.searchParams.get("code")!);
    expect(tokens).toMatchObject({ token_type: "Bearer", scope: "moodle.read", expires_in: 3600 });

    const called = await worker.fetch(request("/mcp", mcpRequest(tokens.access_token as string)), env);
    expect(called.status).toBe(200);
    expect(mcpServer.handle).toHaveBeenCalledOnce();
  });

  it("burns the pairing code and the authorization code after one use", async () => {
    const { worker, env } = await harness();
    const { body } = await registerClient(worker, env);
    const clientId = body.client_id as string;
    const pairingCode = await openPairing(worker, env);

    const approved = await authorize(worker, env, clientId, pairingCode);
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    await exchangeCode(worker, env, clientId, code);

    const replayedCode = await worker.fetch(request("/oauth/token", form({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
    })), env);
    const replayedPairing = await authorize(worker, env, clientId, pairingCode);

    expect(replayedCode.status).toBe(400);
    expect(await replayedCode.json()).toMatchObject({ error: "invalid_grant" });
    expect(replayedPairing.status).toBe(403);
  });

  it("rejects a mismatched PKCE verifier", async () => {
    const { worker, env } = await harness();
    const { body } = await registerClient(worker, env);
    const clientId = body.client_id as string;
    const approved = await authorize(worker, env, clientId, await openPairing(worker, env));

    const response = await worker.fetch(request("/oauth/token", form({
      grant_type: "authorization_code",
      code: new URL(approved.headers.get("location")!).searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: "another-verifier-another-verifier-another-ver",
    })), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("closes the pairing window after repeated wrong codes", async () => {
    const { worker, env } = await harness();
    const { body } = await registerClient(worker, env);
    const clientId = body.client_id as string;
    const pairingCode = await openPairing(worker, env);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await authorize(worker, env, clientId, "WRONGWRONG")).status).toBe(403);
    }

    expect((await authorize(worker, env, clientId, pairingCode)).status).toBe(403);
  });

  it("rotates refresh tokens and revokes the family when one is replayed", async () => {
    const { worker, env } = await harness();
    const { body } = await registerClient(worker, env);
    const clientId = body.client_id as string;
    const approved = await authorize(worker, env, clientId, await openPairing(worker, env));
    const first = await exchangeCode(worker, env, clientId, new URL(approved.headers.get("location")!).searchParams.get("code")!);

    const refreshed = await worker.fetch(request("/oauth/token", form({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token as string,
      client_id: clientId,
    })), env);
    const rotated = await refreshed.json() as Record<string, unknown>;
    expect(refreshed.status).toBe(200);
    expect(rotated.refresh_token).not.toBe(first.refresh_token);

    const replayed = await worker.fetch(request("/oauth/token", form({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token as string,
      client_id: clientId,
    })), env);
    const afterReplay = await worker.fetch(request("/mcp", mcpRequest(rotated.access_token as string)), env);

    expect(replayed.status).toBe(400);
    expect(afterReplay.status).toBe(401);
  });

  it("retains refresh replay detection for the refresh-token lifetime", async () => {
    let currentTime = 1_000_000;
    const { worker, env } = await harness({ now: () => currentTime });
    const { body } = await registerClient(worker, env);
    const clientId = body.client_id as string;
    const approved = await authorize(worker, env, clientId, await openPairing(worker, env));
    const first = await exchangeCode(worker, env, clientId, new URL(approved.headers.get("location")!).searchParams.get("code")!);
    const firstRefresh = await worker.fetch(request("/oauth/token", form({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token as string,
      client_id: clientId,
    })), env);
    const rotated = await firstRefresh.json() as Record<string, unknown>;

    currentTime += 25 * 60 * 60 * 1000;
    const secondRefresh = await worker.fetch(request("/oauth/token", form({
      grant_type: "refresh_token",
      refresh_token: rotated.refresh_token as string,
      client_id: clientId,
    })), env);
    const latest = await secondRefresh.json() as Record<string, unknown>;
    const replayed = await worker.fetch(request("/oauth/token", form({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token as string,
      client_id: clientId,
    })), env);
    const afterReplay = await worker.fetch(request("/mcp", mcpRequest(latest.access_token as string)), env);

    expect(replayed.status).toBe(400);
    expect(afterReplay.status).toBe(401);
  });

  it("accepts approved client origins and still rejects unknown ones", async () => {
    const { worker, env } = await harness();

    const approved = await worker.fetch(request("/.well-known/oauth-protected-resource", {
      headers: { origin: "https://claude.ai" },
    }), env);
    const rejected = await worker.fetch(request("/.well-known/oauth-protected-resource", {
      headers: { origin: "https://evil.example" },
    }), env);

    expect(approved.status).toBe(200);
    expect(rejected.status).toBe(403);
  });

  it("rejects access tokens issued for another resource", async () => {
    const { worker, env } = await harness();
    const { body } = await registerClient(worker, env);
    const clientId = body.client_id as string;

    const rejected = await worker.fetch(request("/oauth/authorize", form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: await pkceChallenge(VERIFIER),
      code_challenge_method: "S256",
      resource: "https://other.example/mcp",
      pairing_code: await openPairing(worker, env),
    })), env);

    expect(rejected.status).toBe(302);
    expect(new URL(rejected.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("OAuth lifecycle hardening", () => {
  it("expires pending registrations and preserves approved clients", async () => {
    let now = 1_000;
    const { worker, env } = await harness({ now: () => now });
    const approved = (await registerClient(worker, env)).body.client_id as string;
    await authorize(worker, env, approved, await openPairing(worker, env));
    const pending = (await registerClient(worker, env)).body.client_id as string;
    now += 11 * 60 * 1000;
    const list = await worker.fetch(request("/clients", { headers: { authorization: `Bearer ${SYNC_TOKEN}` } }), env);
    const body = await list.json() as { clients: Array<{ clientId: string }> };
    expect(body.clients.map((client) => client.clientId)).toEqual([approved]);
    expect(body.clients.some((client) => client.clientId === pending)).toBe(false);
  });

  it("owner revocation invalidates access, refresh, pending codes and pairing", async () => {
    const { worker, env } = await harness();
    const clientId = (await registerClient(worker, env)).body.client_id as string;
    const granted = await authorize(worker, env, clientId, await openPairing(worker, env));
    const tokens = await exchangeCode(worker, env, clientId, new URL(granted.headers.get("location")!).searchParams.get("code")!);
    const pending = await authorize(worker, env, clientId, await openPairing(worker, env));
    const pendingCode = new URL(pending.headers.get("location")!).searchParams.get("code")!;
    const pairing = await openPairing(worker, env);
    expect((await worker.fetch(request("/clients", { method: "DELETE", headers: { authorization: `Bearer ${tokens.access_token}` } }), env)).status).toBe(401);
    expect((await worker.fetch(request("/clients", { method: "DELETE", headers: { authorization: `Bearer ${SYNC_TOKEN}` } }), env)).status).toBe(204);
    expect((await worker.fetch(request("/mcp", mcpRequest(tokens.access_token as string)), env)).status).toBe(401);
    expect((await worker.fetch(request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token as string })), env)).status).toBe(400);
    expect((await worker.fetch(request("/oauth/token", form({ grant_type: "authorization_code", code: pendingCode, client_id: clientId, code_verifier: VERIFIER })), env)).status).toBe(400);
    expect((await authorize(worker, env, clientId, pairing)).status).not.toBe(302);
  });

  it("keeps browser consent policies compatible with the validated callback", async () => {
    const { worker, env } = await harness();
    const clientId = (await registerClient(worker, env)).body.client_id as string;
    await openPairing(worker, env);
    const page = await worker.fetch(request(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge_method: "S256", code_challenge: await pkceChallenge(VERIFIER) })}`), env);
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai;");
  });
});
