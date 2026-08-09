import { hasQueryCredential, verifyBearerToken } from "./auth.js";
import { problemResponse } from "./problems.js";
import { VERSION } from "../version.js";

export const HEALTH_PATH = "/healthz";
export const READY_PATH = "/readyz";
export const MCP_PATH = "/mcp";
export const SESSION_PATH = "/session";
export const SESSION_TOUCH_PATH = "/session/touch";
export const WORKER_SERVICE_ID = "moodle-mcp";
export const WORKER_SERVICE_VERSION = VERSION;

export interface WorkerEnv {
  EXPECTED_HOST?: string;
  MCP_ACCESS_TOKEN_DIGEST: string;
  MCP_ACCESS_TOKEN_PREVIOUS_DIGEST?: string;
  SESSION_SYNC_TOKEN_DIGEST: string;
  SESSION_SYNC_TOKEN_PREVIOUS_DIGEST?: string;
  SESSION_BROKER?: DurableObjectNamespaceLike;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface MoodleMcpServerLike {
  handle(body: unknown, context: { protocolVersion: string; method?: string; toolName?: string }): Promise<unknown | null>;
}

export interface SessionBrokerApi {
  handleMcp(body: unknown, context: { protocolVersion: string; method?: string; toolName?: string }): Promise<unknown | null>;
  ready(): Promise<Response>;
  replaceSession(request: Request): Promise<Response>;
  touch(): Promise<Response>;
}

export interface WorkerDependencies {
  mcpServer: MoodleMcpServerLike | ((env: WorkerEnv) => MoodleMcpServerLike);
  broker?(env: WorkerEnv): SessionBrokerApi;
}

export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnv): Promise<Response>;
}

export function createWorkerHandler(dependencies: WorkerDependencies): WorkerHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const authorityProblem = validateRequestAuthority(request, url, env.EXPECTED_HOST);
      if (authorityProblem) return authorityProblem;
      if (hasQueryCredential(url)) return unauthorized("Bearer credentials are not accepted in the query string.");

      if (url.pathname === HEALTH_PATH && request.method === "GET") {
        return Response.json(
          { status: "pass", serviceId: WORKER_SERVICE_ID, version: WORKER_SERVICE_VERSION },
          { headers: { "content-type": "application/health+json; charset=utf-8" } },
        );
      }

      if (url.pathname === MCP_PATH && request.method !== "POST") {
        return problemResponse(405, "METHOD_NOT_ALLOWED", "Method Not Allowed", "The MCP transport accepts POST requests only.", {
          allow: "POST",
        });
      }

      if (url.pathname === MCP_PATH) {
        if (!await verifyBearerToken(request.headers.get("authorization"), [
          env.MCP_ACCESS_TOKEN_DIGEST,
          env.MCP_ACCESS_TOKEN_PREVIOUS_DIGEST,
        ])) {
          return unauthorized();
        }
        const server = typeof dependencies.mcpServer === "function"
          ? dependencies.mcpServer(env)
          : dependencies.mcpServer;
        return handleMcpRequest(request, server);
      }

      if (url.pathname === READY_PATH && request.method === "GET") {
        if (!await authorizeSessionSync(request, env)) return unauthorized();
        const broker = resolveBroker(dependencies, env);
        if (broker instanceof Response) return broker;
        return broker.ready();
      }

      if (url.pathname === SESSION_PATH && request.method === "PUT") {
        if (!await authorizeSessionSync(request, env)) return unauthorized();
        const broker = resolveBroker(dependencies, env);
        if (broker instanceof Response) return broker;
        return broker.replaceSession(request);
      }

      if (url.pathname === SESSION_TOUCH_PATH && request.method === "POST") {
        if (!await authorizeSessionSync(request, env)) return unauthorized();
        const broker = resolveBroker(dependencies, env);
        if (broker instanceof Response) return broker;
        return broker.touch();
      }

      if (url.pathname === READY_PATH || url.pathname === SESSION_PATH || url.pathname === SESSION_TOUCH_PATH) {
        const method = url.pathname === READY_PATH ? "GET" : url.pathname === SESSION_PATH ? "PUT" : "POST";
        return problemResponse(405, "METHOD_NOT_ALLOWED", "Method Not Allowed", "The session route does not accept this method.", {
          allow: method,
        });
      }

      return problemResponse(404, "NOT_FOUND", "Not Found", "The requested route does not exist.");
    },
  };
}

export function createDurableObjectBrokerApi(namespace: DurableObjectNamespaceLike): SessionBrokerApi {
  const stub = namespace.get(namespace.idFromName("primary"));
  return {
    async handleMcp(body, context) {
      const response = await stub.fetch(new Request("https://session-broker/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: body, context }),
      }));
      if (!response.ok) throw new SessionBrokerMcpError(response.status);
      const envelope = await response.json() as { response?: unknown | null };
      return envelope.response ?? null;
    },
    ready: () => stub.fetch(new Request("https://session-broker/readyz")),
    async replaceSession(request) {
      return stub.fetch(new Request("https://session-broker/session", {
        method: "PUT",
        headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
        body: await request.arrayBuffer(),
      }));
    },
    touch: () => stub.fetch(new Request("https://session-broker/session/touch", { method: "POST" })),
  };
}

class SessionBrokerMcpError extends Error {
  constructor(readonly status: number) {
    super("The session broker could not complete the MCP request.");
    this.name = "SessionBrokerMcpError";
  }
}

function resolveBroker(dependencies: WorkerDependencies, env: WorkerEnv): SessionBrokerApi | Response {
  if (dependencies.broker) return dependencies.broker(env);
  if (env.SESSION_BROKER) return createDurableObjectBrokerApi(env.SESSION_BROKER);
  return problemResponse(503, "SESSION_BROKER_UNAVAILABLE", "Service Unavailable", "The session broker is unavailable.");
}

function validateRequestAuthority(request: Request, url: URL, configuredHost: string | undefined): Response | null {
  const expectedHost = (configuredHost ?? url.host).toLowerCase();
  const requestHost = (request.headers.get("host") ?? url.host).toLowerCase();
  if (requestHost !== expectedHost) {
    return problemResponse(403, "INVALID_HOST", "Forbidden", "The request Host is not allowed.");
  }

  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== url.origin || parsed.host.toLowerCase() !== expectedHost) {
      return problemResponse(403, "INVALID_ORIGIN", "Forbidden", "The request Origin is not allowed.");
    }
  } catch {
    return problemResponse(403, "INVALID_ORIGIN", "Forbidden", "The request Origin is not allowed.");
  }
  return null;
}

function unauthorized(detail = "A valid Bearer token is required."): Response {
  return problemResponse(401, "INVALID_BEARER_TOKEN", "Unauthorized", detail, {
    "www-authenticate": 'Bearer realm="moodle-mcp"',
  });
}

interface JsonRpcRequest {
  method?: unknown;
  params?: unknown;
}

async function handleMcpRequest(request: Request, server: MoodleMcpServerLike): Promise<Response> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return problemResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported Media Type", "MCP requests must use application/json.");
  }

  let body: JsonRpcRequest;
  try {
    body = await request.json() as JsonRpcRequest;
  } catch {
    return problemResponse(400, "INVALID_JSON", "Bad Request", "The request body is not valid JSON.");
  }

  const protocolVersion = request.headers.get("mcp-protocol-version");
  const metadataProblem = validateProtocolMetadata(request.headers, body, protocolVersion);
  if (metadataProblem) return metadataProblem;

  try {
    const response = await server.handle(body, {
      protocolVersion: protocolVersion!,
      method: request.headers.get("mcp-method") ?? undefined,
      toolName: request.headers.get("mcp-name") ?? undefined,
    });
    if (response === null) return new Response(null, { status: 202 });
    if (request.headers.get("accept")?.toLowerCase().includes("text/event-stream")) {
      return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    }
    return Response.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.name === "UnsupportedProtocolVersionError") {
      return problemResponse(400, "UNSUPPORTED_PROTOCOL_VERSION", "Unsupported Protocol Version", "The requested MCP protocol version is not supported.");
    }
    return problemResponse(500, "MCP_REQUEST_FAILED", "Internal Server Error", "The MCP request could not be completed.");
  }
}

function validateProtocolMetadata(headers: Headers, body: JsonRpcRequest, protocolVersion: string | null): Response | null {
  if (!protocolVersion) {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_INVALID", "Bad Request", "MCP-Protocol-Version is required.");
  }

  const params = isRecord(body.params) ? body.params : undefined;
  const metadata = params && isRecord(params._meta) ? params._meta : undefined;
  const bodyVersion = metadata?.["io.modelcontextprotocol/protocolVersion"];
  if (bodyVersion !== undefined && bodyVersion !== protocolVersion) {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_MISMATCH", "Bad Request", "MCP protocol metadata does not match the HTTP headers.");
  }

  if (typeof body.method !== "string") {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_INVALID", "Bad Request", "The JSON-RPC method is required.");
  }
  const headerMethod = headers.get("mcp-method");
  const headerName = headers.get("mcp-name") ?? undefined;
  const paramsName = params && typeof params.name === "string" ? params.name : undefined;
  if (headerMethod !== body.method || headerName !== paramsName) {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_MISMATCH", "Bad Request", "MCP method metadata does not match the JSON-RPC request.");
  }
  return null;
}

function authorizeSessionSync(request: Request, env: WorkerEnv): Promise<boolean> {
  return verifyBearerToken(request.headers.get("authorization"), [
    env.SESSION_SYNC_TOKEN_DIGEST,
    env.SESSION_SYNC_TOKEN_PREVIOUS_DIGEST,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
