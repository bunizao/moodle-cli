import { createOAuthRouter, type AccessGrant, type OAuthRouter, type OAuthStorage, type PairingIssue } from "./oauth.js";

export const OAUTH_ROUTE_PREFIXES = ["/oauth/", "/.well-known/oauth-"] as const;
export const INTERNAL_VERIFY_PATH = "/internal/verify";
export const INTERNAL_PAIR_PATH = "/internal/pair";

export interface AuthBrokerStateLike {
  storage: OAuthStorage;
}

export interface AuthBrokerEnv {
  EXPECTED_HOST?: string;
  SESSION_SYNC_TOKEN_DIGEST?: string;
  OAUTH_ALLOWED_REDIRECT_HOSTS?: string;
}

export interface AuthBrokerDependencies {
  now?: () => number;
}

export function isOAuthRoute(pathname: string): boolean {
  return OAUTH_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function parseAllowedRedirectHosts(value: string | undefined): string[] | undefined {
  const hosts = (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? hosts : undefined;
}

export class AuthBroker {
  private readonly now: () => number;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: AuthBrokerStateLike,
    private readonly env: AuthBrokerEnv,
    dependencies: AuthBrokerDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  async fetch(request: Request): Promise<Response> {
    const response = this.pending.then(() => this.route(request));
    this.pending = response.catch(() => undefined);
    return response;
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const router = this.router(this.issuer(url));
    if (this.env.SESSION_SYNC_TOKEN_DIGEST) {
      const previous = await this.state.storage.get<string>("oauth:owner-credential");
      if (previous !== this.env.SESSION_SYNC_TOKEN_DIGEST) await router.revokeClients();
      if (previous !== this.env.SESSION_SYNC_TOKEN_DIGEST) await this.state.storage.put("oauth:owner-credential", this.env.SESSION_SYNC_TOKEN_DIGEST);
    }
    if (url.pathname === "/internal/clients") {
      if (request.method === "GET") return Response.json({ clients: await router.listClients() });
      if (request.method === "DELETE") {
        await router.revokeClients(url.searchParams.get("client_id") ?? undefined);
        return new Response(null, { status: 204 });
      }
    }

    if (url.pathname === INTERNAL_VERIFY_PATH && request.method === "POST") {
      const input = await safeJson(request);
      const token = typeof input?.token === "string" ? input.token : "";
      const resource = typeof input?.resource === "string" ? input.resource : "";
      const grant = await router.verifyAccessToken(token, resource);
      return grant ? Response.json(grant) : new Response(null, { status: 401 });
    }
    if (url.pathname === INTERNAL_PAIR_PATH && request.method === "POST") {
      return Response.json(await router.createPairing());
    }

    const response = await router.handle(request, url);
    return response ?? new Response(null, { status: 404 });
  }

  private issuer(url: URL): string {
    return this.env.EXPECTED_HOST ? `https://${this.env.EXPECTED_HOST}` : url.origin;
  }

  private router(issuer: string): OAuthRouter {
    const allowedRedirectHosts = parseAllowedRedirectHosts(this.env.OAUTH_ALLOWED_REDIRECT_HOSTS);
    return createOAuthRouter({
      storage: this.state.storage,
      issuer,
      now: this.now,
      ...(allowedRedirectHosts ? { allowedRedirectHosts } : {}),
    });
  }
}

export interface AuthBrokerApi {
  handleOAuth(request: Request, url: URL): Promise<Response>;
  verifyAccessToken(token: string, resource: string): Promise<AccessGrant | null>;
  createPairing(): Promise<PairingIssue>;
  manageClients(request: Request): Promise<Response>;
}

export interface AuthBrokerStubLike {
  fetch(request: Request): Promise<Response>;
}

export function createAuthBrokerApi(stub: AuthBrokerStubLike, issuer = "https://auth-broker"): AuthBrokerApi {
  return {
    manageClients: (request) => {
      const url = new URL(request.url);
      return stub.fetch(new Request(`${issuer}/internal/clients${url.search}`, { method: request.method }));
    },
    handleOAuth: (request) => stub.fetch(new Request(request.url, request)),
    async verifyAccessToken(token, resource) {
      const response = await stub.fetch(new Request(issuer + INTERNAL_VERIFY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, resource }),
      }));
      if (!response.ok) return null;
      const grant = await safeJson(response);
      return typeof grant?.clientId === "string" && typeof grant.scope === "string"
        ? { clientId: grant.clientId, scope: grant.scope }
        : null;
    },
    async createPairing() {
      const response = await stub.fetch(new Request(issuer + INTERNAL_PAIR_PATH, { method: "POST" }));
      const issue = await safeJson(response);
      if (!response.ok || typeof issue?.code !== "string" || typeof issue.expiresAt !== "number") {
        throw new Error("The authorization broker could not create a pairing code.");
      }
      return { code: issue.code, expiresAt: issue.expiresAt };
    },
  };
}

async function safeJson(source: Request | Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await source.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
