import { createIntentService } from "../intents.js";
import { activitySchema, intentContracts, intentDescription, type Intent } from "../intent-contract.js";
import { ReferenceError } from "../resolve.js";
import { activityRow, stripEmpty } from "../results.js";
import { z, ZodError } from "zod";

import { VERSION } from "../version.js";
import type { MoodleFile, MoodleGateway } from "./gateway.js";
import {
  jsonRpcFailure,
  jsonRpcSuccess,
  assertRequestMetadata,
  MODERN_PROTOCOL_VERSION,
  parseJsonRpcRequest,
  RequestMetadataMismatchError,
  resolveProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  UnsupportedProtocolVersionError,
  usesLegacyInitialize,
  type JsonRpcId,
  type JsonRpcResponse,
  type McpRequestContext,
} from "./protocol.js";

const RESULT_META = { cacheScope: "private" } as const;
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const aliases: Partial<Record<string, Intent>> = { get_overview: "home", list_courses: "units", get_course: "unit", get_activity: "item", get_grades: "grades", get_thread: "thread", get_file: "file" };
export const TOOL_CATALOG = Object.entries(intentContracts).map(([name, contract]) => ({
  name, description: intentDescription(name as Intent),
  inputSchema: compactSchema(z.toJSONSchema(contract.input, { io: "input" })), annotations: READ_ONLY_ANNOTATIONS,
}));

// Results are parsed against the contract before they are sent, so publishing the
// output schema only adds bytes to every tools/list a client ever reads.
export const TOOL_OUTPUT_SCHEMAS = Object.fromEntries(Object.entries(intentContracts).map(([name, contract]) => [name, compactSchema(z.toJSONSchema(contract.output))]));

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== "$schema" && !(key === "minimum" && item === Number.MIN_SAFE_INTEGER) && !(key === "maximum" && item === Number.MAX_SAFE_INTEGER)).map(([key, item]) => [key, compactSchema(item)]));
  return value;
}

export interface MoodleMcpServerOptions {
  name?: string;
  version?: string;
}

export interface MoodleMcpServer {
  handle(input: unknown, context?: McpRequestContext): Promise<JsonRpcResponse | null>;
}

export function createMoodleMcpServer(
  gateway: MoodleGateway,
  options: MoodleMcpServerOptions = {},
): MoodleMcpServer {
  const serverInfo = {
    name: options.name ?? "moodle",
    version: options.version ?? VERSION,
  };

  return {
    async handle(input, context = {}) {
      let id: JsonRpcId = null;
      try {
        const request = parseJsonRpcRequest(input);
        id = request.id ?? null;
        const protocolVersion = resolveProtocolVersion(request, context);
        assertRequestMetadata(request, protocolVersion, context);
        if (request.id === undefined) {
          return null;
        }
        if (request.method === "server/discover" && protocolVersion === MODERN_PROTOCOL_VERSION) {
          return jsonRpcSuccess(id, {
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            resultType: "complete",
            _meta: RESULT_META,
          });
        }
        if (request.method === "initialize" && usesLegacyInitialize(protocolVersion)) {
          return jsonRpcSuccess(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions: "Read-only access to the authenticated user's Moodle data.",
          });
        }
        if (request.method === "ping") {
          return jsonRpcSuccess(id, {});
        }
        if (request.method === "tools/list") {
          return jsonRpcSuccess(id, {
            tools: TOOL_CATALOG,
            resultType: "complete",
            _meta: RESULT_META,
          });
        }
        if (request.method === "tools/call") {
          return jsonRpcSuccess(id, await callTool(gateway, request.params));
        }
        return jsonRpcFailure(id, { code: -32601, message: `Method not found: ${request.method}` });
      } catch (error) {
        if (error instanceof McpCallError) {
          return jsonRpcFailure(id, {
            code: -32602,
            message: error.message,
            data: { type: error.type, ...(error.details === undefined ? {} : { issues: error.details }) },
          });
        }
        if (error instanceof UnsupportedProtocolVersionError) {
          return jsonRpcFailure(id, {
            code: -32_022,
            message: "Unsupported protocol version",
            data: {
              supported: [...error.supportedVersions],
              requested: error.protocolVersion,
            },
          });
        }
        if (error instanceof RequestMetadataMismatchError) {
          return jsonRpcFailure(id, {
            code: -32602,
            message: error.message,
            data: {
              type: "REQUEST_METADATA_MISMATCH",
              field: error.field,
              ...(error.expected === undefined ? {} : { expected: error.expected }),
              ...(error.actual === undefined ? {} : { actual: error.actual }),
            },
          });
        }
        if (error instanceof ZodError) {
          return jsonRpcFailure(id, {
            code: -32600,
            message: "Invalid JSON-RPC request.",
            data: { type: "INVALID_REQUEST", issues: error.issues },
          });
        }
        const message = "The MCP request could not be completed.";
        return jsonRpcFailure(id, { code: -32603, message });
      }
    },
  };
}

async function callTool(gateway: MoodleGateway, params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const requested = typeof params?.name === "string" ? params.name : "";
  const name = Object.hasOwn(aliases, requested) ? aliases[requested]! : requested;
  if (!Object.hasOwn(intentContracts, name) && !["get_user", "list_activities", "list_forums"].includes(name)) throw new McpCallError("TOOL_NOT_FOUND", `Unknown Moodle tool: ${requested || "<missing>"}`);
  const raw = params?.arguments ?? {};
  if (!isRecord(raw)) throw new McpCallError("INVALID_TOOL_ARGUMENTS", "Tool arguments must be an object.");
  const args = { ...raw };
  if (Object.hasOwn(aliases, requested)) {
    const renames: Record<string, string> = { courseId: "unit", activityId: "ref", discussionId: "discussion_id", source: "ref", todoDays: "days", gradedOnly: "graded_only" };
    for (const [old, key] of Object.entries(renames)) if (old in args) { args[key] = args[old]; delete args[old]; }
    delete args.alertsLimit; delete args.todoLimit;
  }
  const contract = intentContracts[name as Intent];
  if (contract) {
    const checked = contract.input.safeParse(args);
    if (!checked.success) throw new McpCallError("INVALID_TOOL_ARGUMENTS", `Invalid arguments for ${requested}.`, checked.error.issues);
  }
  try {
    const service = createIntentService(gateway);
    let structuredContent: Record<string, unknown>;
    let payload: unknown;
    if (name === "file") {
      const input = intentContracts.file.input.parse(args);
      payload = await gateway.getFile({ source: await service.fileSource(input.ref as string | number) });
      const file = payload as MoodleFile;
      structuredContent = intentContracts.file.output.parse({ file: { name: file.name, mime_type: file.mimeType, bytes: file.bytes, uri: file.uri } });
    } else if (name === "get_user") {
      z.object({}).strict().parse(args);
      const u = await gateway.getUser();
      structuredContent = stripEmpty({ user: { id: u.userid, name: u.fullname, siteurl: u.siteurl, timezone: u.timezone } }) as Record<string, unknown>;
    } else if (name === "list_activities") {
      const input = z.object({ courseId: z.number().int().positive(), sectionId: z.number().int().optional(), includeLabels: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(200) }).strict().parse(args);
      const { sections } = await gateway.getCourse({ courseId: input.courseId });
      const rows = sections.filter(s => input.sectionId === undefined || s.id === input.sectionId).flatMap(s => s.activities.filter(a => input.includeLabels || a.modname !== "label").map(a => activityRow(a, s)));
      structuredContent = stripEmpty({ activities: rows.slice(0, input.limit).map(r => activitySchema.parse(stripEmpty(r))), total: rows.length }) as Record<string, unknown>;
    } else if (name === "list_forums") {
      const input = z.object({ courseId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).default(50) }).strict().parse(args);
      const rows = await gateway.listForums({ courseId: input.courseId });
      structuredContent = stripEmpty({ forums: rows.slice(0, input.limit).map(f => ({ id: f.id, name: f.name, unit_id: f.course_id })), total: rows.length }) as Record<string, unknown>;
    } else {
      structuredContent = await service.run(name as Intent, args);
    }
    return { content: toolContent(name === "file" ? "get_file" : name, payload, structuredContent), structuredContent, resultType: "complete", _meta: RESULT_META };
  } catch (error) {
    if (error instanceof ZodError && !contract) throw new McpCallError("INVALID_TOOL_ARGUMENTS", `Invalid arguments for ${requested}.`, error.issues);
    if (error instanceof ZodError) {
      // Inputs were already validated, so this is the site's data failing the result contract; say so instead of blaming Moodle.
      const mapped = { type: "MOODLE_RESULT_INVALID", message: `Moodle returned ${name} data in an unexpected shape.`, hint: "Retry once; if it persists, run the same command locally with --verbose and report the tool name.", issues: error.issues.slice(0, 5).map(issue => ({ path: issue.path.join("."), message: issue.message })) };
      return { content: [{ type: "text", text: JSON.stringify({ error: mapped }) }], structuredContent: { error: mapped }, isError: true, resultType: "complete", _meta: RESULT_META };
    }
    const mapped = error instanceof ReferenceError ? { type: error.code, code: error.code, message: error.message, hint: error.hint, candidates: error.candidates } : mapMoodleError(error);
    return { content: [{ type: "text", text: JSON.stringify({ error: mapped }) }], structuredContent: { error: mapped }, isError: true, resultType: "complete", _meta: RESULT_META };
  }
}

function toolContent(name: string, payload: unknown, structuredContent: unknown): Array<Record<string, unknown>> {
  // Some hosted clients only expose content to the model. Serialize the validated
  // result here too, so IDs and details remain available for follow-up calls.
  const text = { type: "text", text: JSON.stringify(structuredContent) };
  if (name !== "get_file" || !isMoodleFile(payload)) return [text];
  // Hosted clients render images but silently drop every other binary resource type.
  if (payload.mimeType.startsWith("image/")) {
    return [text, { type: "image", data: payload.blob, mimeType: payload.mimeType }];
  }
  return [
    text,
    {
      type: "resource",
      resource: {
        uri: payload.uri,
        mimeType: payload.mimeType,
        blob: payload.blob,
      },
    },
  ];
}

function mapMoodleError(error: unknown): { type: string; message: string; hint: string; recovery?: Record<string, string>; moodleCode?: string } {
  const record = isRecord(error) ? error : {};
  const code = typeof record.code === "string" ? record.code : "";
  const typeByCode: Record<string, string> = {
    auth: "MOODLE_AUTH_REQUIRED",
    not_found: "MOODLE_NOT_FOUND",
    upstream: "MOODLE_UPSTREAM_ERROR",
    usage: "MOODLE_INVALID_REQUEST",
  };
  const type = code.startsWith("MOODLE_") ? code : typeByCode[code] ?? "MOODLE_UPSTREAM_ERROR";
  const message = type === "MOODLE_AUTH_REQUIRED" ? "The Moodle session has expired. Sign in again."
    : type === "MOODLE_NOT_FOUND" || type === "MOODLE_COURSE_NOT_FOUND" ? "The requested Moodle item was not found."
    : type === "MOODLE_INVALID_REQUEST" ? "The Moodle request is invalid."
    : "Moodle could not complete the request.";
  const moodleCode = typeof record.moodleErrorCode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(record.moodleErrorCode) ? record.moodleErrorCode : undefined;
  return { type, message, hint: type === "MOODLE_AUTH_REQUIRED" ? "Run moodle mcp login for a remote server, or moodle auth login locally; then retry." : "Run moodle doctor, or refine the request using units and find.", ...(type === "MOODLE_AUTH_REQUIRED" ? { recovery: { action: "moodle mcp login", where: "machine running moodle-cli", then: "retry this tool" } } : {}), ...(moodleCode ? { moodleCode } : {}) };
}

class McpCallError extends Error {
  readonly type: string;
  readonly details?: unknown;

  constructor(type: string, message: string, details?: unknown) {
    super(message);
    this.name = "McpCallError";
    this.type = type;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMoodleFile(value: unknown): value is MoodleFile {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.mimeType === "string"
    && typeof value.bytes === "number"
    && typeof value.uri === "string"
    && typeof value.blob === "string";
}
