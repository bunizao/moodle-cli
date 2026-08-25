import { z, ZodError } from "zod";

import { VERSION } from "../version.js";
import type { MoodleFile, MoodleGateway } from "./gateway.js";
import {
  jsonRpcFailure,
  jsonRpcSuccess,
  assertRequestMetadata,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  parseJsonRpcRequest,
  RequestMetadataMismatchError,
  resolveProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  UnsupportedProtocolVersionError,
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

const emptyInput = z.object({}).strict();
const positiveId = z.number().int().positive();
const integer = z.number().int();
const userValue = z.looseObject({
  userid: integer,
  username: z.string(),
  fullname: z.string(),
  sitename: z.string(),
  siteurl: z.string(),
  lang: z.string().optional(),
});
const courseValue = z.looseObject({
  id: integer,
  shortname: z.string(),
  fullname: z.string(),
  category: z.number().int(),
  visible: z.boolean(),
  startdate: z.number(),
  enddate: z.number().optional(),
});
const activityValue = z.looseObject({
  id: integer,
  name: z.string(),
  modname: z.string(),
  url: z.string(),
  visible: z.boolean(),
  description: z.string(),
});
const fileEntryValue = z.looseObject({
  name: z.string(),
  url: z.string(),
  requires_authentication: z.boolean(),
});
const activityDetailValue = z.looseObject({
  id: positiveId,
  name: z.string(),
  type: z.string(),
  url: z.string().optional(),
  target_name: z.string().optional(),
  target_url: z.string().optional(),
  file_entries: z.array(fileEntryValue).optional(),
});
const sectionValue = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  section: z.number().int(),
  visible: z.boolean(),
  summary: z.string(),
  activities: z.array(activityValue),
});
const todoValue = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  course_id: z.number().int(),
  course_name: z.string(),
  due_at: z.number(),
  url: z.string(),
});
const gradeItemValue = z.looseObject({
  name: z.string(),
  item_type: z.string(),
  grade: z.string(),
  range: z.string(),
  percentage: z.string(),
  feedback: z.string(),
  url: z.string(),
});
const gradesValue = z.looseObject({
  course_id: integer,
  course_name: z.string(),
  learner_name: z.string(),
  total_grade: z.string(),
  total_range: z.string(),
  total_percentage: z.string(),
  items: z.array(gradeItemValue),
});
const forumValue = z.looseObject({
  id: integer,
  name: z.string(),
  course_id: integer,
  course_name: z.string(),
  url: z.string(),
});
const forumSearchValue = z.looseObject({
  course_id: integer,
  course_name: z.string(),
  forum_id: integer,
  forum_name: z.string(),
  discussion_id: integer,
  discussion_subject: z.string(),
  post_id: integer,
  snippet: z.string(),
  url: z.string(),
});
const forumPostValue = z.looseObject({
  id: integer,
  discussion_id: integer,
  subject: z.string(),
  message_text: z.string(),
  author: z.looseObject({ id: integer, fullname: z.string() }),
  url: z.string(),
});
const threadValue = z.looseObject({
  id: integer,
  subject: z.string(),
  course_id: integer,
  forum_id: integer,
  group_id: z.number().int(),
  group_name: z.string(),
  url: z.string(),
  posts: z.array(forumPostValue),
});

interface ToolRegistration {
  name: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
}

const TOOL_REGISTRATIONS = [
  {
    name: "get_user",
    description: "Get the authenticated Moodle user and site.",
    input: emptyInput,
    output: z.object({ user: userValue }),
  },
  {
    name: "get_overview",
    description: "Get a bounded dashboard overview with courses, deadlines, and alerts.",
    input: z.object({
      todoLimit: z.number().int().min(1).max(100).optional().default(5),
      todoDays: z.number().int().min(1).max(365).optional(),
      alertsLimit: z.number().int().min(1).max(100).optional().default(5),
    }).strict(),
    output: z.object({
      overview: z.looseObject({
        user: userValue,
        courses: z.array(courseValue),
        todo: z.array(todoValue),
        errors: z.array(z.string()),
      }),
    }),
  },
  {
    name: "list_courses",
    description: "List the authenticated user's Moodle courses.",
    input: z.object({ limit: z.number().int().min(1).max(200).optional().default(100) }).strict(),
    output: z.object({ courses: z.array(courseValue) }),
  },
  {
    name: "get_course",
    description: "Get one Moodle course and its sections.",
    input: z.object({ courseId: positiveId }).strict(),
    output: z.object({
      course: z.looseObject({
        course: courseValue,
        sections: z.array(sectionValue),
      }),
    }),
  },
  {
    name: "list_activities",
    description: "List a bounded set of activities in a Moodle course.",
    input: z.object({
      courseId: positiveId,
      limit: z.number().int().min(1).max(200).optional().default(100),
    }).strict(),
    output: z.object({ activities: z.array(activityValue) }),
  },
  {
    name: "get_activity",
    description: "Get the supported details for one Moodle activity.",
    input: z.object({ activityId: positiveId }).strict(),
    output: z.object({ activity: activityDetailValue }),
  },
  {
    name: "get_grades",
    description: "Get the authenticated user's grades for one Moodle course.",
    input: z.object({ courseId: positiveId }).strict(),
    output: z.object({ grades: gradesValue }),
  },
  {
    name: "list_forums",
    description: "List a bounded set of Moodle forums, optionally for one course.",
    input: z.object({
      courseId: positiveId.optional(),
      limit: z.number().int().min(1).max(100).optional().default(50),
    }).strict(),
    output: z.object({ forums: z.array(forumValue) }),
  },
  {
    name: "search_forums",
    description: "Search a bounded set of Moodle forum discussions and posts.",
    input: z.object({
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(50).optional().default(20),
      courseId: positiveId.optional(),
      forumId: positiveId.optional(),
      includePostText: z.boolean().optional().default(true),
      unreadOnly: z.boolean().optional().default(false),
      sortBy: z.enum(["relevance", "recent"]).optional().default("relevance"),
      maxForums: z.number().int().min(1).max(50).optional(),
      maxDiscussionsPerForum: z.number().int().min(1).max(100).optional(),
    }).strict(),
    output: z.object({ results: z.array(forumSearchValue) }),
  },
  {
    name: "get_thread",
    description: "Get one Moodle forum discussion and its posts.",
    input: z.object({ discussionId: positiveId }).strict(),
    output: z.object({ thread: threadValue }),
  },
  {
    name: "get_file",
    description: "Fetch one authenticated Moodle file and return its content directly (maximum 16 MiB).",
    input: z.object({
      source: z.union([positiveId, z.string().trim().min(1).max(2_048)]),
    }).strict(),
    output: z.object({
      file: z.object({
        name: z.string(),
        mime_type: z.string(),
        bytes: z.number().int().nonnegative(),
        uri: z.string(),
      }),
    }),
  },
] as const satisfies readonly ToolRegistration[];

const TOOL_CATALOG = TOOL_REGISTRATIONS.map(({ name, description, input, output }) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(input),
  outputSchema: z.toJSONSchema(output),
  annotations: READ_ONLY_ANNOTATIONS,
}));

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
        if (request.method === "initialize" && protocolVersion === LEGACY_PROTOCOL_VERSION) {
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
        const message = error instanceof Error ? error.message : String(error);
        return jsonRpcFailure(id, { code: -32603, message });
      }
    },
  };
}

async function callTool(
  gateway: MoodleGateway,
  params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const name = typeof params?.name === "string" ? params.name : "";
  const registration = TOOL_REGISTRATIONS.find((tool) => tool.name === name);
  if (!registration) {
    throw new McpCallError("TOOL_NOT_FOUND", `Unknown Moodle tool: ${name || "<missing>"}`);
  }

  let input: Record<string, unknown>;
  try {
    input = registration.input.parse(params?.arguments ?? {}) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new McpCallError("INVALID_TOOL_ARGUMENTS", `Invalid arguments for ${name}.`, error.issues);
    }
    throw error;
  }

  try {
    const payload = await runGatewayTool(gateway, name, input);
    const structuredContent = registration.output.parse(wrapToolOutput(name, payload));
    return {
      content: toolContent(name, payload),
      structuredContent,
      resultType: "complete",
      _meta: RESULT_META,
    };
  } catch (error) {
    if (error instanceof McpCallError) {
      throw error;
    }
    const mapped = mapMoodleError(error);
    return {
      content: [{ type: "text", text: mapped.message }],
      structuredContent: { error: mapped },
      isError: true,
      resultType: "complete",
      _meta: RESULT_META,
    };
  }
}

async function runGatewayTool(
  gateway: MoodleGateway,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_user":
      return gateway.getUser();
    case "get_overview":
      return gateway.getOverview({
        todoLimit: numberValue(input.todoLimit),
        todoDays: optionalNumber(input.todoDays),
        alertsLimit: numberValue(input.alertsLimit),
      });
    case "list_courses":
      return (await gateway.listCourses()).slice(0, numberValue(input.limit));
    case "get_course":
      return gateway.getCourse({ courseId: numberValue(input.courseId) });
    case "list_activities":
      return gateway.listActivities({
        courseId: numberValue(input.courseId),
        limit: numberValue(input.limit),
      });
    case "get_activity":
      return gateway.getActivity({ activityId: numberValue(input.activityId) });
    case "get_grades":
      return gateway.getGrades({ courseId: numberValue(input.courseId) });
    case "list_forums":
      return gateway.listForums({
        courseId: optionalNumber(input.courseId),
        limit: numberValue(input.limit),
      });
    case "search_forums":
      return gateway.searchForums({
        query: stringValue(input.query),
        limit: numberValue(input.limit),
        courseId: optionalNumber(input.courseId),
        forumId: optionalNumber(input.forumId),
        includePostText: booleanValue(input.includePostText),
        unreadOnly: booleanValue(input.unreadOnly),
        sortBy: enumValue(input.sortBy, ["relevance", "recent"]),
        maxForums: optionalNumber(input.maxForums),
        maxDiscussionsPerForum: optionalNumber(input.maxDiscussionsPerForum),
      });
    case "get_thread":
      return gateway.getThread({ discussionId: numberValue(input.discussionId) });
    case "get_file":
      return gateway.getFile({ source: fileSource(input.source) });
    default:
      throw new McpCallError("TOOL_NOT_FOUND", `Unknown Moodle tool: ${name}`);
  }
}

function wrapToolOutput(name: string, payload: unknown): Record<string, unknown> {
  const keys: Record<string, string> = {
    get_user: "user",
    get_overview: "overview",
    list_courses: "courses",
    get_course: "course",
    list_activities: "activities",
    get_activity: "activity",
    get_grades: "grades",
    list_forums: "forums",
    search_forums: "results",
    get_thread: "thread",
  };
  if (name === "get_file" && isMoodleFile(payload)) {
    return {
      file: {
        name: payload.name,
        mime_type: payload.mimeType,
        bytes: payload.bytes,
        uri: payload.uri,
      },
    };
  }
  return { [keys[name] ?? "result"]: payload };
}

function toolContent(name: string, payload: unknown): Array<Record<string, unknown>> {
  const text = { type: "text", text: summarizeToolOutput(name, payload) };
  if (name !== "get_file" || !isMoodleFile(payload)) return [text];
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

function summarizeToolOutput(name: string, payload: unknown): string {
  if (Array.isArray(payload)) {
    const labels: Record<string, [string, string]> = {
      list_courses: ["Moodle course", "Moodle courses"],
      list_activities: ["activity", "activities"],
      list_forums: ["forum", "forums"],
      search_forums: ["forum result", "forum results"],
    };
    const [singular, plural] = labels[name] ?? ["result", "results"];
    return `Found ${payload.length} ${payload.length === 1 ? singular : plural}.`;
  }
  if (name === "get_user" && isRecord(payload)) {
    return `Authenticated as ${stringValue(payload.fullname)}.`;
  }
  if (name === "get_overview" && isRecord(payload)) {
    const courses = Array.isArray(payload.courses) ? payload.courses.length : 0;
    const todo = Array.isArray(payload.todo) ? payload.todo.length : 0;
    return `Overview includes ${courses} courses and ${todo} upcoming items.`;
  }
  if (name === "get_course" && isRecord(payload) && isRecord(payload.course)) {
    return `Loaded course ${stringValue(payload.course.fullname) || numberValue(payload.course.id)}.`;
  }
  if (name === "get_activity" && isRecord(payload)) {
    return `Loaded activity ${stringValue(payload.name) || numberValue(payload.id)}.`;
  }
  if (name === "get_grades" && isRecord(payload)) {
    return `Loaded grades for ${stringValue(payload.course_name) || numberValue(payload.course_id)}.`;
  }
  if (name === "get_thread" && isRecord(payload)) {
    return `Loaded forum thread ${stringValue(payload.subject) || numberValue(payload.id)}.`;
  }
  if (name === "get_file" && isMoodleFile(payload)) {
    return `Loaded Moodle file ${payload.name} (${payload.bytes} bytes).`;
  }
  return "Moodle request completed.";
}

function mapMoodleError(error: unknown): { type: string; message: string; moodleCode?: string } {
  const record = isRecord(error) ? error : {};
  const code = typeof record.code === "string" ? record.code : "";
  const typeByCode: Record<string, string> = {
    auth: "MOODLE_AUTH_REQUIRED",
    not_found: "MOODLE_NOT_FOUND",
    upstream: "MOODLE_UPSTREAM_ERROR",
    usage: "MOODLE_INVALID_REQUEST",
  };
  const type = code.startsWith("MOODLE_") ? code : typeByCode[code] ?? "MOODLE_UPSTREAM_ERROR";
  const message = error instanceof Error ? error.message : "Moodle could not complete the request.";
  const moodleCode = typeof record.moodleErrorCode === "string" ? record.moodleErrorCode : undefined;
  return { type, message, ...(moodleCode ? { moodleCode } : {}) };
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

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fileSource(value: unknown): number | string {
  return typeof value === "number" || typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function enumValue<const T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : values[0];
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
