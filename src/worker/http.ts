import { hasQueryCredential, readBearerToken, verifyBearerToken } from "./auth.js";
import { createAuthBrokerApi, isOAuthRoute, parseAllowedRedirectHosts, type AuthBrokerApi } from "./auth-broker.js";
import { DEFAULT_CLIENT_HOSTS, matchesAllowedHost, PROTECTED_RESOURCE_METADATA_PATH } from "./oauth.js";
import { problemResponse } from "./problems.js";
import { MODERN_PROTOCOL_VERSION } from "../mcp/protocol.js";
import { VERSION } from "../version.js";

export const HEALTH_PATH = "/healthz";
export const READY_PATH = "/readyz";
export const MCP_PATH = "/mcp";
export const SESSION_PATH = "/session";
export const SESSION_TOUCH_PATH = "/session/touch";
export const PAIR_PATH = "/pair";
export const WORKER_SERVICE_ID = "moodle-mcp";
export const WORKER_SERVICE_VERSION = VERSION;

export interface WorkerEnv {
  EXPECTED_HOST?: string;
  MCP_ACCESS_TOKEN_DIGEST: string;
  MCP_ACCESS_TOKEN_PREVIOUS_DIGEST?: string;
  SESSION_SYNC_TOKEN_DIGEST: string;
  SESSION_SYNC_TOKEN_PREVIOUS_DIGEST?: string;
  TOKEN_OVERLAP_EXPIRES_AT?: string;
  OAUTH_ALLOWED_REDIRECT_HOSTS?: string;
  SESSION_BROKER?: DurableObjectNamespaceLike;
  AUTH_BROKER?: DurableObjectNamespaceLike;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface MoodleMcpServerLike {
  handle(body: unknown, context: { protocolVersion?: string; method?: string; toolName?: string }): Promise<unknown | null>;
}

export interface SessionBrokerApi {
  handleMcp(body: unknown, context: { protocolVersion?: string; method?: string; toolName?: string }): Promise<unknown | null>;
  ready(): Promise<Response>;
  replaceSession(request: Request): Promise<Response>;
  touch(): Promise<Response>;
}

export interface WorkerDependencies {
  mcpServer: MoodleMcpServerLike | ((env: WorkerEnv) => MoodleMcpServerLike);
  broker?(env: WorkerEnv): SessionBrokerApi;
  authBroker?(env: WorkerEnv): AuthBrokerApi;
}

export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnv): Promise<Response>;
}

export function createWorkerHandler(dependencies: WorkerDependencies): WorkerHandler {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const authorityProblem = validateRequestAuthority(request, url, env);
        if (authorityProblem) return authorityProblem;
        if (request.body) {
          const bounded = await boundedRequest(request);
          if (bounded instanceof Response) return bounded;
          request = bounded;
        }
        if (hasQueryCredential(url)) {
          return unauthorized(
            "Bearer credentials are not accepted in the query string.",
            url.pathname === MCP_PATH ? resourceMetadataUrl(url, env) : undefined,
          );
        }

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

        if (url.pathname === "/clients") {
          if (url.searchParams.has("client_id") && !/^[A-Za-z0-9_-]{1,128}$/u.test(url.searchParams.get("client_id")!)) return problemResponse(400, "INVALID_CLIENT_ID", "Bad Request", "The client ID is invalid.");
          if (!await verifyBearerToken(request.headers.get("authorization"), [env.SESSION_SYNC_TOKEN_DIGEST])) return unauthorized();
          if (request.method !== "GET" && request.method !== "DELETE") return problemResponse(405, "METHOD_NOT_ALLOWED", "Method Not Allowed", "Use GET or DELETE.");
          const authBroker = resolveAuthBroker(dependencies, env, url);
          if (authBroker instanceof Response) return authBroker;
          const response = await authBroker.manageClients(request);
          const headers = new Headers(response.headers);
          headers.set("cache-control", "no-store");
          return new Response(response.body, { status: response.status, headers });
        }
        if (isOAuthRoute(url.pathname)) {
          const authBroker = resolveAuthBroker(dependencies, env, url);
          if (authBroker instanceof Response) return authBroker;
          return authBroker.handleOAuth(request, url);
        }

        if (url.pathname === PAIR_PATH && request.method === "POST") {
          if (!await verifyBearerToken(request.headers.get("authorization"), [env.SESSION_SYNC_TOKEN_DIGEST])) return unauthorized();
          const authBroker = resolveAuthBroker(dependencies, env, url);
          if (authBroker instanceof Response) return authBroker;
          const pairing = await authBroker.createPairing();
          return Response.json({
            code: pairing.code,
            expiresAt: new Date(pairing.expiresAt).toISOString(),
            authorizationServer: issuerOrigin(url, env),
          }, { headers: { "cache-control": "no-store" } });
        }

        if (url.pathname === PAIR_PATH) {
          return problemResponse(405, "METHOD_NOT_ALLOWED", "Method Not Allowed", "The pairing route accepts POST requests only.", {
            allow: "POST",
          });
        }

        if (url.pathname === MCP_PATH) {
          if (!await authorizeMcpRequest(request, url, env, dependencies)) {
            return unauthorized("A valid Bearer token is required.", resourceMetadataUrl(url, env));
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
      } catch {
        return problemResponse(503, "SERVICE_UNAVAILABLE", "Service Unavailable", "The service could not complete the request.");
      }
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
      if (!response.ok) {
        const problem = await safeProblem(response);
        throw new SessionBrokerMcpError(response.status, problem?.code);
      }
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
  constructor(readonly status: number, readonly code?: string) {
    super("The session broker could not complete the MCP request.");
    this.name = "SessionBrokerMcpError";
  }
}

async function authorizeMcpRequest(
  request: Request,
  url: URL,
  env: WorkerEnv,
  dependencies: WorkerDependencies,
): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (await verifyBearerToken(authorization, [
    env.MCP_ACCESS_TOKEN_DIGEST,
    activePreviousDigest(env.MCP_ACCESS_TOKEN_PREVIOUS_DIGEST, env.TOKEN_OVERLAP_EXPIRES_AT),
  ])) {
    return true;
  }
  const token = readBearerToken(authorization);
  if (!token) return false;
  const authBroker = resolveAuthBroker(dependencies, env, url);
  if (authBroker instanceof Response) return false;
  return Boolean(await authBroker.verifyAccessToken(token, `${issuerOrigin(url, env)}${MCP_PATH}`));
}

function issuerOrigin(url: URL, env: WorkerEnv): string {
  return env.EXPECTED_HOST ? `https://${env.EXPECTED_HOST}` : url.origin;
}

function resourceMetadataUrl(url: URL, env: WorkerEnv): string {
  return `${issuerOrigin(url, env)}${PROTECTED_RESOURCE_METADATA_PATH}`;
}

function resolveAuthBroker(dependencies: WorkerDependencies, env: WorkerEnv, url: URL): AuthBrokerApi | Response {
  if (dependencies.authBroker) return dependencies.authBroker(env);
  if (env.AUTH_BROKER) return createAuthBrokerApi(env.AUTH_BROKER.get(env.AUTH_BROKER.idFromName("primary")), issuerOrigin(url, env));
  return problemResponse(503, "OAUTH_UNAVAILABLE", "Service Unavailable", "The authorization broker is unavailable.");
}

function resolveBroker(dependencies: WorkerDependencies, env: WorkerEnv): SessionBrokerApi | Response {
  if (dependencies.broker) return dependencies.broker(env);
  if (env.SESSION_BROKER) return createDurableObjectBrokerApi(env.SESSION_BROKER);
  return problemResponse(503, "SESSION_BROKER_UNAVAILABLE", "Service Unavailable", "The session broker is unavailable.");
}

function validateRequestAuthority(request: Request, url: URL, env: WorkerEnv): Response | null {
  const expectedHost = (env.EXPECTED_HOST ?? url.host).toLowerCase();
  const requestHost = (request.headers.get("host") ?? url.host).toLowerCase();
  if (requestHost !== expectedHost) {
    return problemResponse(403, "INVALID_HOST", "Forbidden", "The request Host is not allowed.");
  }

  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" && parsed.host.toLowerCase() !== expectedHost) {
      return problemResponse(403, "INVALID_ORIGIN", "Forbidden", "The request Origin is not allowed.");
    }
    const allowed = parsed.host.toLowerCase() === expectedHost
      || matchesAllowedHost(host, allowedClientHosts(env));
    if (!allowed) {
      return problemResponse(403, "INVALID_ORIGIN", "Forbidden", "The request Origin is not allowed.");
    }
  } catch {
    return problemResponse(403, "INVALID_ORIGIN", "Forbidden", "The request Origin is not allowed.");
  }
  return null;
}

function allowedClientHosts(env: WorkerEnv): string[] {
  return parseAllowedRedirectHosts(env.OAUTH_ALLOWED_REDIRECT_HOSTS) ?? [...DEFAULT_CLIENT_HOSTS];
}

function unauthorized(detail = "A valid Bearer token is required.", resourceMetadata?: string): Response {
  const challenge = resourceMetadata
    ? `Bearer realm="moodle-mcp", resource_metadata="${resourceMetadata}"`
    : 'Bearer realm="moodle-mcp"';
  return problemResponse(401, "INVALID_BEARER_TOKEN", "Unauthorized", detail, {
    "www-authenticate": challenge,
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
      ...(protocolVersion ? { protocolVersion } : {}),
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
    if (error instanceof SessionBrokerMcpError) {
      const status = error.status === 503 ? 503 : 500;
      const code = error.code === "SESSION_MISSING" || error.code === "SESSION_EXPIRED"
        ? error.code
        : "SESSION_UNAVAILABLE";
      return problemResponse(status, code, "Service Unavailable", "The Moodle session is not ready.");
    }
    if (error instanceof Error && error.name === "UnsupportedProtocolVersionError") {
      return problemResponse(400, "UNSUPPORTED_PROTOCOL_VERSION", "Unsupported Protocol Version", "The requested MCP protocol version is not supported.");
    }
    return problemResponse(500, "MCP_REQUEST_FAILED", "Internal Server Error", "The MCP request could not be completed.");
  }
}

async function safeProblem(response: Response): Promise<{ code?: string } | null> {
  try {
    const value = await response.json();
    return isRecord(value) && (value.code === undefined || typeof value.code === "string") ? value : null;
  } catch {
    return null;
  }
}

function validateProtocolMetadata(headers: Headers, body: JsonRpcRequest, protocolVersion: string | null): Response | null {
  if (typeof body.method !== "string") {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_INVALID", "Bad Request", "The JSON-RPC method is required.");
  }

  const params = isRecord(body.params) ? body.params : undefined;
  const metadata = params && isRecord(params._meta) ? params._meta : undefined;
  const bodyVersion = metadata?.["io.modelcontextprotocol/protocolVersion"];
  if (protocolVersion && bodyVersion !== undefined && bodyVersion !== protocolVersion) {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_MISMATCH", "Bad Request", "MCP protocol metadata does not match the HTTP headers.");
  }

  const headerMethod = headers.get("mcp-method");
  const headerName = headers.get("mcp-name") ?? undefined;
  const paramsName = params && typeof params.name === "string" ? params.name : undefined;
  const modern = protocolVersion === MODERN_PROTOCOL_VERSION || bodyVersion === MODERN_PROTOCOL_VERSION;
  if (modern && !protocolVersion) {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_INVALID", "Bad Request", "MCP-Protocol-Version is required.");
  }
  if (modern ? headerMethod !== body.method : headerMethod !== null && headerMethod !== body.method) {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_MISMATCH", "Bad Request", "MCP method metadata does not match the JSON-RPC request.");
  }
  if (modern ? headerName !== paramsName : headerName !== undefined && headerName !== paramsName) {
    return problemResponse(400, "MCP_PROTOCOL_METADATA_MISMATCH", "Bad Request", "MCP method metadata does not match the JSON-RPC request.");
  }
  return null;
}

function authorizeSessionSync(request: Request, env: WorkerEnv): Promise<boolean> {
  return verifyBearerToken(request.headers.get("authorization"), [
    env.SESSION_SYNC_TOKEN_DIGEST,
    activePreviousDigest(env.SESSION_SYNC_TOKEN_PREVIOUS_DIGEST, env.TOKEN_OVERLAP_EXPIRES_AT),
  ]);
}

function activePreviousDigest(digest: string | undefined, expiresAt: string | undefined): string | undefined {
  if (!digest || !expiresAt) return undefined;
  const expiration = Number(expiresAt);
  return Number.isFinite(expiration) && Date.now() < expiration ? digest : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedRequest(request: Request): Promise<Request | Response> {
  const limit = 64 * 1024;
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) return problemResponse(413, "REQUEST_TOO_LARGE", "Content Too Large", "Request bodies are limited to 64 KiB.");
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return new Request(request, { body });
  };
  try {
    return await Promise.race([read(), new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(problemResponse(408, "REQUEST_TIMEOUT", "Request Timeout", "The request body was not received in time.")), 30_000);
    })]);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}
