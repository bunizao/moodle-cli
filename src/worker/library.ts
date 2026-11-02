// The public `moodle-cli/worker` entry: everything a host Worker needs to serve this
// MCP server under its own path and to read Moodle in-process.
import type { z } from "zod";
import { intentContracts, type ToolName } from "../intent-contract.js";
import type { BrowserRunBinding } from "./browser-login.js";
import { BROKER_INSTANCE_NAME, createWorkerRouter, durableObjectMcpServer, type WorkerEnv } from "./http.js";
import type { AdoptSessionResult, CallToolOptions, SessionCookie, MoodleToolResult, SessionState } from "./session-broker.js";

export { AuthBroker } from "./auth-broker.js";
export { SessionBroker } from "./session-broker.js";
export type { AdoptSessionResult, CallToolOptions, SessionCookie, MoodleToolError, MoodleToolResult, SessionState } from "./session-broker.js";
export { BROKER_INSTANCE_NAME };

/**
 * Every binding, secret and var the embedded Worker reads. `moodle mcp deploy --host-worker`
 * uploads the secrets and vars; the host's wrangler config declares the bindings.
 */
export interface MoodleWorkerEnv {
  // Bindings
  SESSION_BROKER: DurableObjectNamespaceLike;
  AUTH_BROKER: DurableObjectNamespaceLike;
  /** Browser Run, for "Sign in with Moodle" on the authorization page. Optional. */
  BROWSER?: BrowserRunBinding;
  // Uploaded as secrets by the CLI
  MOODLE_ORIGIN: string;
  EXPECTED_HOST?: string;
  EXPECTED_HOSTS?: string;
  MCP_ACCESS_TOKEN_DIGEST: string;
  MCP_ACCESS_TOKEN_PREVIOUS_DIGEST?: string;
  SESSION_SYNC_TOKEN_DIGEST: string;
  SESSION_SYNC_TOKEN_PREVIOUS_DIGEST?: string;
  TOKEN_OVERLAP_EXPIRES_AT?: string;
  SESSION_ENCRYPTION_KEY: string;
  SESSION_ENCRYPTION_KEY_PREVIOUS?: string;
  SESSION_CREDENTIAL_ID?: string;
  /** Comma-separated OAuth client hosts; defaults to the hosted MCP clients. */
  OAUTH_ALLOWED_REDIRECT_HOSTS?: string;
}

// Structural, so a host's typed `DurableObjectNamespace` fits without this package
// depending on @cloudflare/workers-types.
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface MoodleHandlerOptions {
  /** Where the routes live in the host, such as "/moodle". */
  basePath: string;
}

export interface MoodleHandler {
  /** The response for a route under the base path (and its OAuth metadata); null for anything else. */
  fetch(request: Request, env: MoodleWorkerEnv): Promise<Response | null>;
}

export function createMoodleHandler(options: MoodleHandlerOptions): MoodleHandler {
  if (!options.basePath.replace(/\/+$/u, "")) throw new Error("A host Worker must mount Moodle MCP under a base path, such as /moodle.");
  const route = createWorkerRouter({ basePath: options.basePath, mcpServer: durableObjectMcpServer });
  return { fetch: (request, env) => route(request, env as unknown as WorkerEnv) };
}

/** Input and output zod schemas of every MCP tool, keyed by tool name. */
export const toolContracts = intentContracts;
export type { ToolName };
/** Tools a host can call over RPC; submit needs local files and is refused remotely. */
export type ReadToolName = Exclude<ToolName, "submit">;
export type ToolInput<N extends ToolName> = z.input<(typeof intentContracts)[N]["input"]>;
export type ToolOutput<N extends ToolName> = z.output<(typeof intentContracts)[N]["output"]>;

export const unitsOutputSchema = intentContracts.units.output;
export const dueOutputSchema = intentContracts.due.output;
export type UnitsOutput = ToolOutput<"units">;
export type DueOutput = ToolOutput<"due">;
export type MoodleUnit = NonNullable<UnitsOutput["units"]>[number];
export type MoodleDueItem = NonNullable<DueOutput["due"]>[number];

export interface SessionBrokerNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): {
    callTool(name: string, args?: Record<string, unknown>, options?: CallToolOptions): Promise<unknown>;
    adoptCookie(cookie: SessionCookie): Promise<AdoptSessionResult>;
    sessionState(): Promise<SessionState>;
  };
}

// Every route and helper talks to the one broker instance named BROKER_INSTANCE_NAME.
function broker(namespace: SessionBrokerNamespaceLike) {
  return namespace.get(namespace.idFromName(BROKER_INSTANCE_NAME));
}

/**
 * Calls one tool on the session broker over Workers RPC, with no HTTP and no token.
 * The result is what the MCP tool returns: structuredContent, or isError with
 * structuredContent.error.type such as MOODLE_AUTH_REQUIRED.
 */
export async function callMoodleTool<N extends ReadToolName>(
  namespace: SessionBrokerNamespaceLike,
  name: N,
  args: ToolInput<N>,
  options: CallToolOptions = {},
): Promise<MoodleToolResult<ToolOutput<N>>> {
  return await broker(namespace).callTool(name, args as Record<string, unknown>, options) as MoodleToolResult<ToolOutput<N>>;
}

/**
 * Hands the broker a MoodleSession cookie the host obtained itself. Moodle validates
 * it as for a browser sign-in, it must belong to the account already signed in, and
 * the broker captures a mobile token from it for later renewal. Never a first sign-in:
 * a broker with no owner answers no_owner.
 */
export async function adoptSession(env: { SESSION_BROKER: SessionBrokerNamespaceLike }, cookie: SessionCookie): Promise<AdoptSessionResult> {
  return await broker(env.SESSION_BROKER).adoptCookie({ cookieName: cookie.cookieName, cookieValue: cookie.cookieValue });
}

/** Whether the stored session is usable and can renew itself. Never carries cookie or token values. */
export async function sessionState(env: { SESSION_BROKER: SessionBrokerNamespaceLike }): Promise<SessionState> {
  return await broker(env.SESSION_BROKER).sessionState();
}
