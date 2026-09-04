import { z } from "zod";

export const MODERN_PROTOCOL_VERSION = "2026-07-28" as const;
export const LEGACY_PROTOCOL_VERSION = "2025-11-25" as const;
export const COMPAT_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  ...COMPAT_PROTOCOL_VERSIONS,
] as const;

export type McpProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpRequestContext {
  protocolVersion?: string;
  method?: string;
  toolName?: string;
}

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().trim().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

const ModernClientMetadataSchema = z.object({
  "io.modelcontextprotocol/clientCapabilities": z.record(z.string(), z.unknown()),
  "io.modelcontextprotocol/clientInfo": z.object({
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
  }).passthrough(),
  "io.modelcontextprotocol/protocolVersion": z.literal(MODERN_PROTOCOL_VERSION),
}).passthrough();

export class UnsupportedProtocolVersionError extends Error {
  readonly protocolVersion: string;
  readonly supportedVersions = SUPPORTED_PROTOCOL_VERSIONS;

  constructor(protocolVersion: string) {
    super(`Unsupported MCP protocol version: ${protocolVersion}`);
    this.name = "UnsupportedProtocolVersionError";
    this.protocolVersion = protocolVersion;
  }
}

export class RequestMetadataMismatchError extends Error {
  readonly field: "_meta" | "method" | "name" | "protocolVersion";
  readonly expected?: string;
  readonly actual?: string;

  constructor(
    field: RequestMetadataMismatchError["field"],
    expected?: string,
    actual?: string,
  ) {
    super(`MCP request metadata mismatch for ${field}.`);
    this.name = "RequestMetadataMismatchError";
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

export function parseJsonRpcRequest(input: unknown): JsonRpcRequest {
  return JsonRpcRequestSchema.parse(input) as JsonRpcRequest;
}

export function resolveProtocolVersion(
  request: JsonRpcRequest,
  context: McpRequestContext = {},
): McpProtocolVersion {
  const meta = isRecord(request.params?._meta) ? request.params._meta : undefined;
  const initializeVersion = request.method === "initialize" && typeof request.params?.protocolVersion === "string"
    ? request.params.protocolVersion
    : undefined;
  const requested = context.protocolVersion
    ?? stringValue(meta?.["io.modelcontextprotocol/protocolVersion"])
    ?? initializeVersion
    ?? MODERN_PROTOCOL_VERSION;

  if (!isSupportedProtocolVersion(requested)) {
    throw new UnsupportedProtocolVersionError(requested);
  }
  return requested;
}

export function assertRequestMetadata(
  request: JsonRpcRequest,
  protocolVersion: McpProtocolVersion,
  context: McpRequestContext = {},
): void {
  const meta = isRecord(request.params?._meta) ? request.params._meta : undefined;
  const metaVersion = stringValue(meta?.["io.modelcontextprotocol/protocolVersion"]);

  if (protocolVersion === MODERN_PROTOCOL_VERSION) {
    const parsed = ModernClientMetadataSchema.safeParse(meta);
    if (!parsed.success) {
      throw new RequestMetadataMismatchError("_meta", "valid modern client metadata");
    }
  }
  if (context.protocolVersion && metaVersion && context.protocolVersion !== metaVersion) {
    throw new RequestMetadataMismatchError("protocolVersion", context.protocolVersion, metaVersion);
  }
  if (context.method && context.method !== request.method) {
    throw new RequestMetadataMismatchError("method", context.method, request.method);
  }
  const toolName = typeof request.params?.name === "string" ? request.params.name : undefined;
  if (context.toolName && context.toolName !== toolName) {
    throw new RequestMetadataMismatchError("name", context.toolName, toolName);
  }
}

export function isSupportedProtocolVersion(value: string): value is McpProtocolVersion {
  return SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === value);
}

export function usesLegacyInitialize(version: McpProtocolVersion): boolean {
  return version !== MODERN_PROTOCOL_VERSION;
}

export function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcFailure(id: JsonRpcId, error: JsonRpcErrorObject): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
