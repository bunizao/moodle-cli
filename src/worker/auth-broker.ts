import { createBrowserRunLogin, type BrowserRunBinding, type LoginBrowser } from "./browser-login.js";
import type { DurableObjectNamespaceLike } from "./http.js";
import { createOAuthRouter, LOGIN_PATH, randomSecret, type AccessGrant, type OAuthRouter, type OAuthStorage, type PairingIssue } from "./oauth.js";
import { createOwnerLogin, createSessionAdopter, type OwnerLogin, type OwnerLoginOptions } from "./owner-login.js";

export const OAUTH_ROUTE_PREFIXES = ["/oauth/", "/.well-known/oauth-"] as const;
export const INTERNAL_VERIFY_PATH = "/internal/verify";
export const INTERNAL_PAIR_PATH = "/internal/pair";
// The handler tells the broker where it is mounted. Durable Objects are reachable only
// through the host Worker's own code, and the handler overwrites any value a client sent.
export const BASE_PATH_HEADER = "moodle-base-path";

export interface AuthBrokerStateLike {
  storage: OAuthStorage;
}

export interface AuthBrokerEnv {
  EXPECTED_HOST?: string;
  SESSION_SYNC_TOKEN_DIGEST?: string;
  OAUTH_ALLOWED_REDIRECT_HOSTS?: string;
  MOODLE_ORIGIN?: string;
  BROWSER?: BrowserRunBinding;
  SESSION_BROKER?: DurableObjectNamespaceLike;
}

export interface AuthBrokerDependencies {
  now?: () => number;
  browser?: LoginBrowser;
  adopt?: OwnerLoginOptions["adopt"];
}

// "" or "/a/b": absolute, no trailing slash, plain path segments only.
export function isBasePath(value: string): boolean {
  return /^(?:\/[A-Za-z0-9._~-]+)*$/u.test(value) && !/\/\.\.?(?:\/|$)/u.test(value);
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
  private readonly browser?: LoginBrowser;
  private readonly adopt?: OwnerLoginOptions["adopt"];
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: AuthBrokerStateLike,
    private readonly env: AuthBrokerEnv,
    dependencies: AuthBrokerDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.browser = dependencies.browser ?? (env.BROWSER ? createBrowserRunLogin(env.BROWSER) : undefined);
    this.adopt = dependencies.adopt ?? (env.SESSION_BROKER ? createSessionAdopter(env.SESSION_BROKER) : undefined);
  }

  async fetch(request: Request): Promise<Response> {
    const response = this.pending.then(() => this.route(request));
    this.pending = response.catch(() => undefined);
    return response;
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { router, owner } = this.router(this.issuer(url, request.headers.get(BASE_PATH_HEADER)));
    if (this.env.SESSION_SYNC_TOKEN_DIGEST) {
      const previous = await this.state.storage.get<string>("oauth:owner-credential");
      if (previous !== this.env.SESSION_SYNC_TOKEN_DIGEST) await router.revokeClients();
      if (previous !== this.env.SESSION_SYNC_TOKEN_DIGEST) await this.state.storage.put("oauth:owner-credential", this.env.SESSION_SYNC_TOKEN_DIGEST);
    }
    if (url.pathname === "/internal/clients") {
      if (request.method === "GET") return Response.json({ clients: await router.listClients() });
      if (request.method === "DELETE") {
        const clientId = url.searchParams.get("client_id") ?? undefined;
        await router.revokeClients(clientId);
        // An owner cookie would let the same browser approve a new client at once.
        if (!clientId) await owner.signOutAll();
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

    if (url.pathname === LOGIN_PATH) return owner.handle(request, url);
    const response = await router.handle(request, url);
    return response ?? new Response(null, { status: 404 });
  }

  private issuer(url: URL, basePath: string | null): string {
    const origin = this.env.EXPECTED_HOST ? `https://${this.env.EXPECTED_HOST}` : url.origin;
    return `${origin}${basePath && isBasePath(basePath) ? basePath : ""}`;
  }

  private router(issuer: string): { router: OAuthRouter; owner: OwnerLogin } {
    const allowedRedirectHosts = parseAllowedRedirectHosts(this.env.OAUTH_ALLOWED_REDIRECT_HOSTS);
    // The two need each other: approval asks who the owner is, and claiming a fresh
    // Worker spends the pairing code the router holds.
    const owner = createOwnerLogin({
      storage: this.state.storage,
      mcpUrl: `${issuer}/mcp`,
      now: this.now,
      createSecret: randomSecret,
      pairing: { check: (code) => router.checkPairingCode(code), close: () => router.closePairing() },
      // MOODLE_ORIGIN is the site root, install path included; cutting it to the origin
      // would open sign-in on the wrong page and miss the path-scoped cookie.
      ...(this.env.MOODLE_ORIGIN ? { moodleOrigin: this.env.MOODLE_ORIGIN.replace(/\/+$/u, "") } : {}),
      ...(this.browser ? { browser: this.browser } : {}),
      ...(this.adopt ? { adopt: this.adopt } : {}),
    });
    const router = createOAuthRouter({
      storage: this.state.storage,
      issuer,
      owner,
      now: this.now,
      ...(allowedRedirectHosts ? { allowedRedirectHosts } : {}),
    });
    return { router, owner };
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

export function createAuthBrokerApi(stub: AuthBrokerStubLike, issuer = "https://auth-broker", basePath = ""): AuthBrokerApi {
  const mounted = (headers?: HeadersInit) => {
    const result = new Headers(headers);
    result.delete(BASE_PATH_HEADER);
    if (basePath) result.set(BASE_PATH_HEADER, basePath);
    return result;
  };
  return {
    manageClients: (request) => {
      const url = new URL(request.url);
      return stub.fetch(new Request(`${issuer}/internal/clients${url.search}`, { method: request.method, headers: mounted() }));
    },
    handleOAuth: (request) => stub.fetch(new Request(request, { headers: mounted(request.headers) })),
    async verifyAccessToken(token, resource) {
      const response = await stub.fetch(new Request(issuer + INTERNAL_VERIFY_PATH, {
        method: "POST",
        headers: mounted({ "content-type": "application/json" }),
        body: JSON.stringify({ token, resource }),
      }));
      if (!response.ok) return null;
      const grant = await safeJson(response);
      return typeof grant?.clientId === "string" && typeof grant.scope === "string"
        ? { clientId: grant.clientId, scope: grant.scope }
        : null;
    },
    async createPairing() {
      const response = await stub.fetch(new Request(issuer + INTERNAL_PAIR_PATH, { method: "POST", headers: mounted() }));
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
