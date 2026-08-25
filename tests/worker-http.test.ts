import { createWorkerHandler, digestBearerToken, type SessionBrokerApi, type WorkerEnv } from "../src/worker/index.js";
import workerEntrypoint from "../src/worker/entry.js";

const ACCESS_TOKEN = "access-token";
const SYNC_TOKEN = "sync-token";
const ORIGIN = "https://moodle-mcp.example.workers.dev";

async function workerEnv(): Promise<WorkerEnv> {
  return {
    EXPECTED_HOST: "moodle-mcp.example.workers.dev",
    MCP_ACCESS_TOKEN_DIGEST: await digestBearerToken(ACCESS_TOKEN),
    SESSION_SYNC_TOKEN_DIGEST: await digestBearerToken(SYNC_TOKEN),
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "moodle-mcp.example.workers.dev");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function createBroker(): SessionBrokerApi {
  return {
    handleMcp: vi.fn(async () => null),
    ready: vi.fn(async () => new Response(null, { status: 503 })),
    replaceSession: vi.fn(async () => new Response(null, { status: 501 })),
    touch: vi.fn(async () => new Response(null, { status: 501 })),
  };
}

describe("Cloudflare Worker HTTP transport", () => {
  it("serves a public liveness response without touching Moodle", async () => {
    const mcpServer = { handle: vi.fn() };
    const broker = createBroker();
    const worker = createWorkerHandler({ mcpServer, broker: () => broker });

    const response = await worker.fetch(request("/healthz"), await workerEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/health+json; charset=utf-8");
    expect(await response.json()).toEqual({
      status: "pass",
      serviceId: "moodle-mcp",
      version: "0.7.0-alpha.4",
    });
    expect(mcpServer.handle).not.toHaveBeenCalled();
    expect(broker.ready).not.toHaveBeenCalled();
  });

  it("keeps the remote MCP transport POST-only", async () => {
    const worker = createWorkerHandler({ mcpServer: { handle: vi.fn() }, broker: () => createBroker() });

    const response = await worker.fetch(request("/mcp"), await workerEnv());

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 405, code: "METHOD_NOT_ALLOWED" });
  });

  it("rejects missing and invalid Bearer credentials before parsing JSON", async () => {
    const mcpServer = { handle: vi.fn() };
    const worker = createWorkerHandler({ mcpServer, broker: () => createBroker() });
    const env = await workerEnv();

    for (const authorization of [undefined, "Bearer wrong-token", `Bearer ${SYNC_TOKEN}`]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (authorization) headers.authorization = authorization;
      const response = await worker.fetch(request("/mcp", { method: "POST", headers, body: "{" }), env);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="moodle-mcp"');
      expect(await response.json()).toMatchObject({ status: 401, code: "INVALID_BEARER_TOKEN" });
    }
    expect(mcpServer.handle).not.toHaveBeenCalled();
  });

  it("accepts the previous access-token digest during rotation", async () => {
    const mcpServer = { handle: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: {} })) };
    const worker = createWorkerHandler({ mcpServer, broker: () => createBroker() });
    const env = await workerEnv();
    env.MCP_ACCESS_TOKEN_DIGEST = await digestBearerToken("next-token");
    env.MCP_ACCESS_TOKEN_PREVIOUS_DIGEST = await digestBearerToken(ACCESS_TOKEN);
    env.TOKEN_OVERLAP_EXPIRES_AT = String(Date.now() + 60_000);

    const response = await worker.fetch(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ACCESS_TOKEN}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(mcpServer.handle).toHaveBeenCalledOnce();
  });

  it("rejects previous credentials after the rotation overlap expires", async () => {
    const mcpServer = { handle: vi.fn() };
    const broker = createBroker();
    const worker = createWorkerHandler({ mcpServer, broker: () => broker });
    const env = await workerEnv();
    env.MCP_ACCESS_TOKEN_DIGEST = await digestBearerToken("next-access-token");
    env.MCP_ACCESS_TOKEN_PREVIOUS_DIGEST = await digestBearerToken(ACCESS_TOKEN);
    env.SESSION_SYNC_TOKEN_DIGEST = await digestBearerToken("next-sync-token");
    env.SESSION_SYNC_TOKEN_PREVIOUS_DIGEST = await digestBearerToken(SYNC_TOKEN);
    env.TOKEN_OVERLAP_EXPIRES_AT = String(Date.now() - 1);

    const mcpResponse = await worker.fetch(request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    }), env);
    const readinessResponse = await worker.fetch(request("/readyz", {
      headers: { authorization: `Bearer ${SYNC_TOKEN}` },
    }), env);

    expect(mcpResponse.status).toBe(401);
    expect(readinessResponse.status).toBe(401);
    expect(mcpServer.handle).not.toHaveBeenCalled();
    expect(broker.ready).not.toHaveBeenCalled();
  });

  it("rejects query credentials and invalid Origin or Host values", async () => {
    const mcpServer = { handle: vi.fn() };
    const worker = createWorkerHandler({ mcpServer, broker: () => createBroker() });
    const env = await workerEnv();
    const cases = [
      request(`/mcp?access_token=${ACCESS_TOKEN}`, { method: "POST", headers: { authorization: `Bearer ${ACCESS_TOKEN}` } }),
      request("/mcp", { method: "POST", headers: { authorization: `Bearer ${ACCESS_TOKEN}`, origin: "https://evil.example" } }),
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${ACCESS_TOKEN}`, host: "evil.example" },
      }),
    ];

    for (const candidate of cases) {
      const response = await worker.fetch(candidate, env);
      expect(response.status).toBe(candidate.headers.get("host") === "evil.example" || candidate.headers.has("origin") ? 403 : 401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
    }
    expect(mcpServer.handle).not.toHaveBeenCalled();
  });

  it("accepts the pinned candidate preview host", async () => {
    const env = await workerEnv();
    env.EXPECTED_HOSTS = [
      "moodle-mcp.example.workers.dev",
      "moodle-cli-candidate-moodle-mcp.example.workers.dev",
    ].join(",");
    const worker = createWorkerHandler({
      mcpServer: { handle: vi.fn() },
      broker: () => createBroker(),
    });
    const response = await worker.fetch(new Request(
      "https://moodle-cli-candidate-moodle-mcp.example.workers.dev/healthz",
    ), env);

    expect(response.status).toBe(200);
  });

  it("protects readiness with only the session-sync token", async () => {
    const broker = createBroker();
    vi.mocked(broker.ready).mockResolvedValue(
      Response.json({ status: "pass" }, { headers: { "content-type": "application/health+json" } }),
    );
    const worker = createWorkerHandler({ mcpServer: { handle: vi.fn() }, broker: () => broker });
    const env = await workerEnv();

    const denied = await worker.fetch(
      request("/readyz", { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } }),
      env,
    );
    const allowed = await worker.fetch(
      request("/readyz", { headers: { authorization: `Bearer ${SYNC_TOKEN}` } }),
      env,
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(broker.ready).toHaveBeenCalledOnce();
  });

  it("authenticates session upload and touch before forwarding to the broker", async () => {
    const broker = createBroker();
    vi.mocked(broker.replaceSession).mockResolvedValue(Response.json({ revision: 2 }, { status: 201 }));
    vi.mocked(broker.touch).mockResolvedValue(Response.json({ status: "kept_alive" }));
    const worker = createWorkerHandler({ mcpServer: { handle: vi.fn() }, broker: () => broker });
    const env = await workerEnv();
    const sessionBody = JSON.stringify({ cookieValue: "secret" });

    const uploaded = await worker.fetch(request("/session", {
      method: "PUT",
      headers: { authorization: `Bearer ${SYNC_TOKEN}`, "content-type": "application/json" },
      body: sessionBody,
    }), env);
    const touched = await worker.fetch(request("/session/touch", {
      method: "POST",
      headers: { authorization: `Bearer ${SYNC_TOKEN}` },
    }), env);

    expect(uploaded.status).toBe(201);
    expect(touched.status).toBe(200);
    expect(await vi.mocked(broker.replaceSession).mock.calls[0]![0].text()).toBe(sessionBody);
    expect(broker.touch).toHaveBeenCalledOnce();
  });

  it("rejects mismatched protocol metadata before dispatch", async () => {
    const mcpServer = { handle: vi.fn() };
    const worker = createWorkerHandler({ mcpServer, broker: () => createBroker() });
    const response = await worker.fetch(request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
      }),
    }), await workerEnv());

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32_020, message: "HeaderMismatch" },
    });
    expect(mcpServer.handle).not.toHaveBeenCalled();
  });

  it("returns a HeaderMismatch error when the protocol header is missing", async () => {
    const mcpServer = { handle: vi.fn() };
    const worker = createWorkerHandler({ mcpServer, broker: () => createBroker() });
    const response = await worker.fetch(request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "missing-version", method: "tools/list", params: {} }),
    }), await workerEnv());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      id: "missing-version",
      error: { code: -32_020 },
    });
    expect(mcpServer.handle).not.toHaveBeenCalled();
  });

  it("returns unsupported protocol negotiation as an HTTP 400 JSON-RPC error", async () => {
    const mcpServer = { handle: vi.fn(async () => ({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32_022,
        message: "Unsupported protocol version",
        data: {
          supported: ["2026-07-28", "2025-11-25"],
          requested: "1900-01-01",
        },
      },
    })) };
    const worker = createWorkerHandler({ mcpServer, broker: () => createBroker() });
    const response = await worker.fetch(request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "1900-01-01",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    }), await workerEnv());

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      id: 7,
      error: {
        code: -32_022,
        data: { requested: "1900-01-01", supported: ["2026-07-28", "2025-11-25"] },
      },
    });
  });

  it("accepts legacy remote requests without modern method headers", async () => {
    const mcpServer = { handle: vi.fn(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-11-25" },
    })) };
    const worker = createWorkerHandler({ mcpServer, broker: () => createBroker() });
    const response = await worker.fetch(request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      }),
    }), await workerEnv());

    expect(response.status).toBe(200);
    expect(mcpServer.handle).toHaveBeenCalledWith(expect.objectContaining({ method: "initialize" }), {
      protocolVersion: "2025-11-25",
      method: undefined,
      toolName: undefined,
    });
  });

  it("supports request-scoped SSE responses", async () => {
    const mcpServer = { handle: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } })) };
    const worker = createWorkerHandler({ mcpServer, broker: () => createBroker() });
    const response = await worker.fetch(request("/mcp", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    }), await workerEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await response.text()).toBe('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
  });

  it("returns a safe RFC 9457 error when the Durable Object has no session", async () => {
    const env = await workerEnv();
    env.SESSION_BROKER = {
      idFromName: vi.fn(() => "primary"),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => Response.json({ code: "SESSION_MISSING" }, { status: 503 })),
      })),
    };

    const response = await workerEntrypoint.fetch(request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    }), env);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 503, code: "SESSION_MISSING" });
  });
});
