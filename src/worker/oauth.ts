import { digestBearerToken, verifySecret } from "./auth.js";

export const OAUTH_SCOPE = "moodle.read";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const REGISTER_PATH = "/oauth/register";
export const TOKEN_PATH = "/oauth/token";
export const REVOKE_PATH = "/oauth/revoke";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONSUMED_REFRESH_RETENTION_MS = REFRESH_TOKEN_TTL_MS;
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_CODE_MAX_ATTEMPTS = 5;
const MAX_REGISTERED_CLIENTS = 20;
const PENDING_CLIENT_TTL_MS = 10 * 60 * 1000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
export const DEFAULT_CLIENT_HOSTS = ["claude.ai", "claude.com"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const CLIENT_PREFIX = "oauth:client:";
const CODE_PREFIX = "oauth:code:";
const ACCESS_PREFIX = "oauth:access:";
const REFRESH_PREFIX = "oauth:refresh:";
const CONSUMED_REFRESH_PREFIX = "oauth:consumed-refresh:";
const PAIRING_KEY = "oauth:pairing";

export interface OAuthStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export interface OAuthRouterOptions {
  storage: OAuthStorage;
  issuer: string;
  allowedRedirectHosts?: readonly string[];
  now?: () => number;
  createSecret?: () => string;
  createPairingCode?: () => string;
}

export interface AccessGrant {
  clientId: string;
  scope: string;
}

export interface PairingIssue {
  code: string;
  expiresAt: number;
}

export interface OAuthRouter {
  handle(request: Request, url: URL): Promise<Response | null>;
  createPairing(): Promise<PairingIssue>;
  verifyAccessToken(token: string, resource: string): Promise<AccessGrant | null>;
  listClients(): Promise<Array<{ clientId: string; clientName: string; approved: boolean }>>;
  revokeClients(clientId?: string): Promise<void>;
}

interface ClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
  approvedAt?: number;
}

interface PairingRecord {
  digest: string;
  expiresAt: number;
  attempts: number;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string;
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  resource: string | null;
  scope: string;
  family: string;
  expiresAt: number;
}

interface AuthorizeRequest {
  clientId: string;
  client: ClientRecord;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string;
  state: string | null;
}

interface AuthorizeRejection {
  fatal: boolean;
  error: string;
  description: string;
  redirectUri?: string;
  state?: string | null;
}

export function createOAuthRouter(options: OAuthRouterOptions): OAuthRouter {
  const storage = options.storage;
  const issuer = options.issuer.replace(/\/$/u, "");
  const resourceUrl = `${issuer}/mcp`;
  const now = options.now ?? Date.now;
  const allowedRedirectHosts = options.allowedRedirectHosts ?? DEFAULT_CLIENT_HOSTS;
  const createSecret = options.createSecret ?? randomSecret;
  const createPairingCode = options.createPairingCode ?? randomPairingCode;

  async function readClient(clientId: string): Promise<ClientRecord | undefined> {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(clientId)) return undefined;
    const client = await storage.get<ClientRecord>(`${CLIENT_PREFIX}${clientId}`);
    if (!client || client.approvedAt !== undefined || client.createdAt + PENDING_CLIENT_TTL_MS > now()) return client;
    for (const prefix of [CODE_PREFIX, ACCESS_PREFIX, REFRESH_PREFIX]) {
      const grants = await storage.list<{ clientId: string; expiresAt: number }>({ prefix });
      if ([...grants.values()].some((grant) => grant.clientId === clientId && grant.expiresAt > now())) {
        const approved = { ...client, approvedAt: client.createdAt };
        await storage.put(`${CLIENT_PREFIX}${clientId}`, approved);
        return approved;
      }
    }
    await storage.delete(`${CLIENT_PREFIX}${clientId}`);
    return undefined;
  }

  function isAllowedRedirectUri(value: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    if (parsed.hash || parsed.username || parsed.password || value.length > 2048) return false;
    if (LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.protocol === "http:" || parsed.protocol === "https:";
    if (parsed.protocol !== "https:") return false;
    return matchesAllowedHost(parsed.hostname, allowedRedirectHosts);
  }

  function matchesRegisteredRedirectUri(client: ClientRecord, value: string): boolean {
    if (client.redirectUris.includes(value)) return true;
    let candidate: URL;
    try {
      candidate = new URL(value);
    } catch {
      return false;
    }
    if (!LOOPBACK_HOSTS.has(candidate.hostname)) return false;
    return client.redirectUris.some((registered) => {
      try {
        const parsed = new URL(registered);
        return LOOPBACK_HOSTS.has(parsed.hostname)
          && parsed.protocol === candidate.protocol
          && parsed.hostname === candidate.hostname
          && parsed.pathname === candidate.pathname;
      } catch {
        return false;
      }
    });
  }

  function normalizeResource(value: string | null): string | null | undefined {
    if (value === null) return resourceUrl;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const normalized = `${parsed.origin}${parsed.pathname.replace(/\/$/u, "")}`;
    if (normalized !== resourceUrl && normalized !== issuer) return undefined;
    return resourceUrl;
  }

  async function resolveAuthorizeRequest(
    params: URLSearchParams,
  ): Promise<{ request: AuthorizeRequest } | { rejection: AuthorizeRejection }> {
    const clientId = params.get("client_id") ?? "";
    const client = await readClient(clientId);
    if (!client) {
      return { rejection: { fatal: true, error: "invalid_client", description: "The client is not registered with this server." } };
    }
    const redirectUri = params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
    if (!redirectUri || !matchesRegisteredRedirectUri(client, redirectUri)) {
      return { rejection: { fatal: true, error: "invalid_request", description: "The redirect URI does not match a registered value." } };
    }
    const state = params.get("state");
    const reject = (error: string, description: string): { rejection: AuthorizeRejection } => ({
      rejection: { fatal: false, error, description, redirectUri, state },
    });

    if (params.get("response_type") !== "code") return reject("unsupported_response_type", "Only the authorization code flow is supported.");
    const codeChallenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256") return reject("invalid_request", "PKCE with S256 is required.");
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) return reject("invalid_request", "The PKCE code challenge is invalid.");
    const resource = normalizeResource(params.get("resource"));
    if (resource === undefined) return reject("invalid_target", "The requested resource is not hosted by this server.");
    const requestedScope = params.get("scope");
    if (requestedScope && requestedScope.split(/\s+/u).some((scope) => scope && scope !== OAUTH_SCOPE)) {
      return reject("invalid_scope", `The only supported scope is ${OAUTH_SCOPE}.`);
    }
    return { request: { clientId, client, redirectUri, codeChallenge, resource, scope: OAUTH_SCOPE, state } };
  }

  async function readPairing(): Promise<PairingRecord | undefined> {
    const pairing = await storage.get<PairingRecord>(PAIRING_KEY);
    if (!pairing) return undefined;
    if (pairing.expiresAt <= now() || pairing.attempts >= PAIRING_CODE_MAX_ATTEMPTS) {
      await storage.delete(PAIRING_KEY);
      return undefined;
    }
    return pairing;
  }

  async function consumePairingAttempt(pairing: PairingRecord, submitted: string): Promise<boolean> {
    const normalized = submitted.replace(/[^0-9A-Za-z]/gu, "").toUpperCase();
    if (normalized && await verifySecret(normalized, [pairing.digest])) {
      await storage.delete(PAIRING_KEY);
      return true;
    }
    const attempts = pairing.attempts + 1;
    if (attempts >= PAIRING_CODE_MAX_ATTEMPTS) await storage.delete(PAIRING_KEY);
    else await storage.put(PAIRING_KEY, { ...pairing, attempts });
    return false;
  }

  async function prune(): Promise<void> {
    const current = now();
    for (const prefix of [CODE_PREFIX, ACCESS_PREFIX, REFRESH_PREFIX, CONSUMED_REFRESH_PREFIX]) {
      const entries = await storage.list<{ expiresAt: number }>({ prefix });
      for (const [key, value] of entries) {
        if (value.expiresAt <= current) await storage.delete(key);
      }
    }
  }

  async function revokeFamily(family: string): Promise<void> {
    for (const prefix of [ACCESS_PREFIX, REFRESH_PREFIX, CONSUMED_REFRESH_PREFIX]) {
      const entries = await storage.list<TokenRecord>({ prefix });
      for (const [key, value] of entries) {
        if (value.family === family) await storage.delete(key);
      }
    }
  }

  async function issueTokens(grant: { clientId: string; resource: string | null; scope: string; family: string }) {
    const accessToken = createSecret();
    const refreshToken = createSecret();
    const issuedAt = now();
    await storage.put<TokenRecord>(`${ACCESS_PREFIX}${await digestBearerToken(accessToken)}`, {
      ...grant,
      expiresAt: issuedAt + ACCESS_TOKEN_TTL_MS,
    });
    await storage.put<TokenRecord>(`${REFRESH_PREFIX}${await digestBearerToken(refreshToken)}`, {
      ...grant,
      expiresAt: issuedAt + REFRESH_TOKEN_TTL_MS,
    });
    return jsonNoStore({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: grant.scope,
    });
  }

  async function handleRegister(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return oauthError(400, "invalid_client_metadata", "Client registration must use application/json.");
    }
    let metadata: unknown;
    try {
      metadata = await request.json();
    } catch {
      return oauthError(400, "invalid_client_metadata", "The registration request is not valid JSON.");
    }
    if (!isRecord(metadata)) return oauthError(400, "invalid_client_metadata", "The registration request is invalid.");
    const authMethod = metadata.token_endpoint_auth_method;
    if (authMethod !== undefined && authMethod !== "none") {
      return oauthError(400, "invalid_client_metadata", "This server registers public clients only.");
    }
    const redirectUris = Array.isArray(metadata.redirect_uris)
      ? metadata.redirect_uris.filter((value): value is string => typeof value === "string")
      : [];
    if (!redirectUris.length || redirectUris.length > 5) {
      return oauthError(400, "invalid_redirect_uri", "One to five redirect URIs are required.");
    }
    const rejected = redirectUris.find((value) => !isAllowedRedirectUri(value));
    if (rejected) {
      return oauthError(400, "invalid_redirect_uri", "A redirect URI is not allowed by this deployment.");
    }

    await prune();
    const clients = await storage.list<ClientRecord>({ prefix: CLIENT_PREFIX });
    const pending: ClientRecord[] = [];
    for (const client of clients.values()) {
      const current = await readClient(client.clientId);
      if (current && current.approvedAt === undefined) pending.push(current);
    }
    if (pending.length >= MAX_REGISTERED_CLIENTS) {
      pending.sort((left, right) => left.createdAt - right.createdAt);
      await storage.delete(`${CLIENT_PREFIX}${pending[0]!.clientId}`);
    }

    const clientId = createSecret();
    const client: ClientRecord = {
      clientId,
      clientName: typeof metadata.client_name === "string" ? metadata.client_name.slice(0, 120) : "MCP client",
      redirectUris,
      createdAt: now(),
    };
    await storage.put(`${CLIENT_PREFIX}${clientId}`, client);
    return jsonNoStore({
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPE,
    }, 201);
  }

  async function handleAuthorize(request: Request, url: URL): Promise<Response> {
    const params = request.method === "POST"
      ? new URLSearchParams(await request.text())
      : url.searchParams;
    if (request.method === "POST" && !request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return htmlResponse(errorPage("The approval form was submitted with an unsupported content type."), 415);
    }

    const resolved = await resolveAuthorizeRequest(params);
    if ("rejection" in resolved) {
      const { rejection } = resolved;
      if (rejection.fatal || !rejection.redirectUri) return htmlResponse(errorPage(rejection.description), 400);
      const target = new URL(rejection.redirectUri);
      target.searchParams.set("error", rejection.error);
      target.searchParams.set("error_description", rejection.description);
      if (rejection.state) target.searchParams.set("state", rejection.state);
      return Response.redirect(target.toString(), 302);
    }

    const authorizeRequest = resolved.request;
    const pairing = await readPairing();
    if (request.method === "GET") {
      return htmlResponse(approvalPage(authorizeRequest, params, {
        pairingOpen: Boolean(pairing),
        ...(pairing ? {} : { message: "No pairing window is open. Run `moodle mcp pair` on your computer, then reload this page." }),
      }), 200, authorizeRequest.redirectUri);
    }

    if (!pairing) {
      return htmlResponse(approvalPage(authorizeRequest, params, {
        pairingOpen: false,
        message: "No pairing window is open. Run `moodle mcp pair` on your computer, then submit the code it prints.",
      }), 403, authorizeRequest.redirectUri);
    }
    const approvedClients = [...(await storage.list<ClientRecord>({ prefix: CLIENT_PREFIX })).values()]
      .filter((client) => client.approvedAt !== undefined);
    if (authorizeRequest.client.approvedAt === undefined && approvedClients.length >= MAX_REGISTERED_CLIENTS) {
      return htmlResponse(errorPage("The approved client limit is reached. Revoke an existing client before pairing."), 409);
    }
    if (!await consumePairingAttempt(pairing, params.get("pairing_code") ?? "")) {
      const remaining = PAIRING_CODE_MAX_ATTEMPTS - pairing.attempts - 1;
      return htmlResponse(approvalPage(authorizeRequest, params, {
        pairingOpen: remaining > 0,
        message: remaining > 0
          ? `That pairing code is not correct. ${remaining} ${remaining === 1 ? "attempt remains" : "attempts remain"}.`
          : "Too many incorrect attempts. Run `moodle mcp pair` again to open a new pairing window.",
      }), 403, authorizeRequest.redirectUri);
    }

    await storage.put(`${CLIENT_PREFIX}${authorizeRequest.clientId}`, { ...authorizeRequest.client, approvedAt: now() });
    await prune();
    const code = createSecret();
    await storage.put<CodeRecord>(`${CODE_PREFIX}${await digestBearerToken(code)}`, {
      clientId: authorizeRequest.clientId,
      redirectUri: authorizeRequest.redirectUri,
      codeChallenge: authorizeRequest.codeChallenge,
      resource: authorizeRequest.resource,
      scope: authorizeRequest.scope,
      expiresAt: now() + AUTHORIZATION_CODE_TTL_MS,
    });
    const target = new URL(authorizeRequest.redirectUri);
    target.searchParams.set("code", code);
    if (authorizeRequest.state) target.searchParams.set("state", authorizeRequest.state);
    return Response.redirect(target.toString(), 302);
  }

  async function handleToken(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return oauthError(400, "invalid_request", "Token requests must use application/x-www-form-urlencoded.");
    }
    const form = new URLSearchParams(await request.text());
    if (request.headers.get("authorization")) {
      return oauthError(401, "invalid_client", "This server registers public clients only.");
    }
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return handleAuthorizationCodeGrant(form);
    if (grantType === "refresh_token") return handleRefreshTokenGrant(form);
    return oauthError(400, "unsupported_grant_type", "The grant type is not supported.");
  }

  async function handleAuthorizationCodeGrant(form: URLSearchParams): Promise<Response> {
    const code = form.get("code") ?? "";
    const key = `${CODE_PREFIX}${await digestBearerToken(code)}`;
    const record = code ? await storage.get<CodeRecord>(key) : undefined;
    if (record) await storage.delete(key);
    if (!record || record.expiresAt <= now()) {
      return oauthError(400, "invalid_grant", "The authorization code is invalid or expired.");
    }
    if (form.get("client_id") !== record.clientId) {
      return oauthError(400, "invalid_grant", "The authorization code was issued to another client.");
    }
    const redirectUri = form.get("redirect_uri");
    if (redirectUri !== null && redirectUri !== record.redirectUri) {
      return oauthError(400, "invalid_grant", "The redirect URI does not match the authorization request.");
    }
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) || await pkceChallenge(verifier) !== record.codeChallenge) {
      return oauthError(400, "invalid_grant", "The PKCE code verifier is invalid.");
    }
    const requestedResource = normalizeResource(form.get("resource"));
    if (requestedResource === undefined) {
      return oauthError(400, "invalid_target", "The requested resource is not hosted by this server.");
    }
    return issueTokens({
      clientId: record.clientId,
      resource: resourceUrl,
      scope: record.scope,
      family: createSecret(),
    });
  }

  async function handleRefreshTokenGrant(form: URLSearchParams): Promise<Response> {
    const refreshToken = form.get("refresh_token") ?? "";
    if (!refreshToken) return oauthError(400, "invalid_request", "A refresh token is required.");
    const requestedResource = normalizeResource(form.get("resource"));
    if (requestedResource === undefined) return oauthError(400, "invalid_target", "The requested resource is not hosted by this server.");
    const digest = await digestBearerToken(refreshToken);
    const record = await storage.get<TokenRecord>(`${REFRESH_PREFIX}${digest}`);
    if (!record) {
      const consumed = await storage.get<TokenRecord>(`${CONSUMED_REFRESH_PREFIX}${digest}`);
      if (consumed) await revokeFamily(consumed.family);
      return oauthError(400, "invalid_grant", "The refresh token is invalid or expired.");
    }
    await storage.delete(`${REFRESH_PREFIX}${digest}`);
    if (record.resource !== resourceUrl) return oauthError(400, "invalid_grant", "The grant must be authorized again for this resource.");
    if (record.expiresAt <= now()) return oauthError(400, "invalid_grant", "The refresh token is invalid or expired.");
    const clientId = form.get("client_id");
    if (clientId !== null && clientId !== record.clientId) {
      return oauthError(400, "invalid_grant", "The refresh token was issued to another client.");
    }
    const requestedScope = form.get("scope");
    if (requestedScope && requestedScope.split(/\s+/u).some((scope) => scope && scope !== record.scope)) {
      return oauthError(400, "invalid_scope", "The requested scope exceeds the original grant.");
    }
    await storage.put<TokenRecord>(`${CONSUMED_REFRESH_PREFIX}${digest}`, {
      ...record,
      expiresAt: now() + CONSUMED_REFRESH_RETENTION_MS,
    });
    await prune();
    return issueTokens({
      clientId: record.clientId,
      resource: record.resource,
      scope: record.scope,
      family: record.family,
    });
  }

  async function handleRevoke(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return oauthError(400, "invalid_request", "Revocation requests must use application/x-www-form-urlencoded.");
    }
    const form = new URLSearchParams(await request.text());
    const token = form.get("token") ?? "";
    if (token) {
      const digest = await digestBearerToken(token);
      for (const prefix of [ACCESS_PREFIX, REFRESH_PREFIX]) {
        const record = await storage.get<TokenRecord>(`${prefix}${digest}`);
        if (record) await revokeFamily(record.family);
      }
    }
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }

  return {
    async handle(request, url) {
      const path = url.pathname.replace(/\/$/u, "") || "/";
      if (path === PROTECTED_RESOURCE_METADATA_PATH || path === `${PROTECTED_RESOURCE_METADATA_PATH}/mcp`) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return jsonPublic({
          resource: resourceUrl,
          authorization_servers: [issuer],
          scopes_supported: [OAUTH_SCOPE],
          bearer_methods_supported: ["header"],
          resource_name: "Moodle MCP",
        });
      }
      if (path === AUTHORIZATION_SERVER_METADATA_PATH || path === `${AUTHORIZATION_SERVER_METADATA_PATH}/mcp`) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return jsonPublic({
          issuer,
          authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
          token_endpoint: `${issuer}${TOKEN_PATH}`,
          registration_endpoint: `${issuer}${REGISTER_PATH}`,
          revocation_endpoint: `${issuer}${REVOKE_PATH}`,
          scopes_supported: [OAUTH_SCOPE],
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (path === REGISTER_PATH) {
        return request.method === "POST" ? handleRegister(request) : methodNotAllowed("POST");
      }
      if (path === AUTHORIZE_PATH) {
        return request.method === "GET" || request.method === "POST"
          ? handleAuthorize(request, url)
          : methodNotAllowed("GET, POST");
      }
      if (path === TOKEN_PATH) {
        return request.method === "POST" ? handleToken(request) : methodNotAllowed("POST");
      }
      if (path === REVOKE_PATH) {
        return request.method === "POST" ? handleRevoke(request) : methodNotAllowed("POST");
      }
      return null;
    },

    async listClients() {
      const result = [];
      for (const client of (await storage.list<ClientRecord>({ prefix: CLIENT_PREFIX })).values()) {
        const current = await readClient(client.clientId);
        if (current) result.push({ clientId: current.clientId, clientName: current.clientName, approved: current.approvedAt !== undefined });
      }
      return result;
    },

    async revokeClients(clientId) {
      await storage.delete(PAIRING_KEY);
      for (const prefix of [CLIENT_PREFIX, CODE_PREFIX, ACCESS_PREFIX, REFRESH_PREFIX, CONSUMED_REFRESH_PREFIX]) {
        for (const [key, record] of await storage.list<{ clientId: string }>({ prefix })) {
          if (!clientId || record.clientId === clientId) await storage.delete(key);
        }
      }
    },

    async createPairing() {
      const code = createPairingCode();
      const expiresAt = now() + PAIRING_CODE_TTL_MS;
      await storage.put<PairingRecord>(PAIRING_KEY, {
        digest: await digestBearerToken(code),
        expiresAt,
        attempts: 0,
      });
      return { code, expiresAt };
    },

    async verifyAccessToken(token, resource) {
      if (!token) return null;
      const key = `${ACCESS_PREFIX}${await digestBearerToken(token)}`;
      const record = await storage.get<TokenRecord>(key);
      if (!record) return null;
      if (record.expiresAt <= now()) {
        await storage.delete(key);
        return null;
      }
      if (record.resource !== resourceUrl || resource !== resourceUrl) return null;
      return { clientId: record.clientId, scope: record.scope };
    },
  };
}

export function randomSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH));
  return Array.from(bytes, (byte) => PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]).join("");
}

export function matchesAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return allowedHosts.some((host) => {
    const normalizedHost = host.toLowerCase();
    return normalizedHostname === normalizedHost || normalizedHostname.endsWith(`.${normalizedHost}`);
  });
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function jsonPublic(body: unknown): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

function jsonNoStore(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });
}

function oauthError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": 'Bearer realm="moodle-mcp"' } : {}),
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return Response.json({ error: "invalid_request", error_description: "The HTTP method is not allowed." }, {
    status: 405,
    headers: { allow, "cache-control": "no-store" },
  });
}

function htmlResponse(body: string, status = 200, redirectUri?: string): Response {
  const callback = redirectUri ? ` ${new URL(redirectUri).origin}` : "";
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callback}; frame-ancestors 'none'`,
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}

const PAGE_STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:3rem 1.25rem;background:#f6f7f9;color:#16181d}
main{max-width:26rem;margin:0 auto;background:#fff;border:1px solid #dfe2e8;border-radius:12px;padding:1.75rem}
h1{font-size:1.15rem;margin:0 0 .75rem}dl{margin:0 0 1.25rem;font-size:.9rem}dt{color:#5b6472;margin-top:.5rem}
dd{margin:0;word-break:break-all}input{width:100%;box-sizing:border-box;font:1.25rem/1 ui-monospace,monospace;
letter-spacing:.18em;text-align:center;padding:.7rem;border:1px solid #c3c8d1;border-radius:8px;text-transform:uppercase}
button{width:100%;margin-top:1rem;padding:.7rem;font-size:1rem;border:0;border-radius:8px;background:#16181d;color:#fff}
.note{font-size:.85rem;color:#5b6472;margin-top:1rem}.error{color:#a3111c;font-size:.9rem;margin:0 0 1rem}`;

function approvalPage(
  request: AuthorizeRequest,
  params: URLSearchParams,
  options: { pairingOpen: boolean; message?: string },
): string {
  const hidden = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"]
    .map((name) => {
      const value = name === "redirect_uri" ? request.redirectUri : params.get(name);
      return value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">` : "";
    })
    .join("");
  const form = options.pairingOpen
    ? `<form method="post" action="${AUTHORIZE_PATH}">${hidden}
<label for="pairing_code">Pairing code</label>
<input id="pairing_code" name="pairing_code" autocomplete="off" autocapitalize="characters" spellcheck="false" autofocus>
<button type="submit">Approve access</button></form>`
    : "";
  return page("Approve MCP access", `
<h1>Approve access to your Moodle</h1>
<dl>
  <dt>Client</dt><dd>${escapeHtml(request.client.clientName)}</dd>
  <dt>Redirect</dt><dd>${escapeHtml(new URL(request.redirectUri).origin)}</dd>
  <dt>Access</dt><dd>Read-only Moodle data (${OAUTH_SCOPE})</dd>
</dl>
${options.message ? `<p class="error">${escapeHtml(options.message)}</p>` : ""}
${form}
<p class="note">Run <code>moodle mcp pair</code> on your computer to get a code. It is valid for 10 minutes and one approval.</p>`);
}

function errorPage(message: string): string {
  return page("Request rejected", `<h1>Request rejected</h1><p class="error">${escapeHtml(message)}</p>`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
