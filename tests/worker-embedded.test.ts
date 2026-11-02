import {
  AuthBroker,
  createMoodleHandler,
  type MoodleWorkerEnv,
} from "../src/worker/library.js";
import { createAuthBrokerApi, createWorkerHandler, digestBearerToken, type OAuthStorage } from "../src/worker/index.js";

const HOST = "host.example.workers.dev";
const ORIGIN = `https://${HOST}`;
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

class MemoryStorage implements OAuthStorage {
  private readonly entries = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.entries.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.entries.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.entries.delete(key); }
  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return new Map([...this.entries].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>);
  }
}

// A namespace fake that forwards to one in-process object, as the runtime does for idFromName("primary").
function namespace(target: { fetch(request: Request): Promise<Response> }) {
  return { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => target.fetch(request) }) };
}

async function host() {
  const authBroker = new AuthBroker({ storage: new MemoryStorage() }, { EXPECTED_HOST: HOST });
  const sessionBroker = { fetch: vi.fn(async () => new Response(null, { status: 503 })) };
  const env = {
    MOODLE_ORIGIN: "https://lms.example.edu",
    EXPECTED_HOST: HOST,
    MCP_ACCESS_TOKEN_DIGEST: await digestBearerToken("access-token"),
    SESSION_SYNC_TOKEN_DIGEST: await digestBearerToken("sync-token"),
    SESSION_ENCRYPTION_KEY: "key",
    AUTH_BROKER: namespace(authBroker),
    SESSION_BROKER: namespace(sessionBroker),
  } as unknown as MoodleWorkerEnv;
  return { env, handler: createMoodleHandler({ basePath: "/moodle" }), authBroker };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

describe("createMoodleHandler under a base path", () => {
  it("refuses an empty base path", () => {
    expect(() => createMoodleHandler({ basePath: "" })).toThrow(/base path/u);
    expect(() => createMoodleHandler({ basePath: "/" })).toThrow(/base path/u);
  });

  it("returns null for paths the host owns", async () => {
    const { handler, env } = await host();
    for (const path of ["/", "/other", "/moodlex", "/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      expect(await handler.fetch(request(path), env), path).toBeNull();
    }
  });

  it("serves health under the prefix", async () => {
    const { handler, env } = await host();
    const response = await handler.fetch(request("/moodle/healthz"), env);
    expect(response?.status).toBe(200);
  });

  it("publishes protected-resource metadata at the RFC 9728 path-inserted URL", async () => {
    const { handler, env } = await host();
    const response = await handler.fetch(request("/.well-known/oauth-protected-resource/moodle/mcp"), env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      resource: `${ORIGIN}/moodle/mcp`,
      authorization_servers: [`${ORIGIN}/moodle`],
    });
  });

  it("publishes authorization-server metadata at the RFC 8414 path-inserted URL", async () => {
    const { handler, env } = await host();
    const response = await handler.fetch(request("/.well-known/oauth-authorization-server/moodle"), env);
    expect(response?.status).toBe(200);
    const body = await response?.json() as Record<string, string>;
    expect(body.issuer).toBe(`${ORIGIN}/moodle`);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/moodle/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/moodle/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/moodle/oauth/register`);
  });

  it("points an unauthenticated MCP request at the prefixed metadata", async () => {
    const { handler, env } = await host();
    const response = await handler.fetch(request("/moodle/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), env);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/moodle/mcp"`,
    );
  });

  it("renders the approval form with prefixed actions", async () => {
    const { handler, env } = await host();
    const registered = await handler.fetch(request("/moodle/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
    }), env);
    expect(registered?.status).toBe(201);
    const { client_id: clientId } = await registered?.json() as { client_id: string };

    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "s",
      resource: `${ORIGIN}/moodle/mcp`,
    });
    const page = await handler.fetch(request(`/moodle/oauth/authorize?${query}`), env);
    const html = await page?.text() ?? "";
    expect(html).toContain('action="/moodle/oauth/authorize"');
    expect(html).not.toMatch(/action="\/oauth\//u);
  });

  it("refuses a request for another host", async () => {
    const { handler, env } = await host();
    const response = await handler.fetch(new Request("https://evil.example/moodle/healthz", { headers: { host: "evil.example" } }), env);
    expect(response?.status).toBe(403);
  });
});

describe("standalone Worker", () => {
  it("ignores a client-sent base-path header", async () => {
    const authBroker = new AuthBroker({ storage: new MemoryStorage() }, { EXPECTED_HOST: HOST });
    const worker = createWorkerHandler({
      mcpServer: { handle: vi.fn() },
      authBroker: () => createAuthBrokerApi({ fetch: (forwarded) => authBroker.fetch(forwarded) }, ORIGIN),
    });
    const env = { EXPECTED_HOST: HOST, MCP_ACCESS_TOKEN_DIGEST: "x", SESSION_SYNC_TOKEN_DIGEST: "y" };
    const response = await worker.fetch(request("/.well-known/oauth-authorization-server", { headers: { "moodle-base-path": "/evil" } }), env);
    expect((await response.json() as { issuer: string }).issuer).toBe(ORIGIN);
  });
});
