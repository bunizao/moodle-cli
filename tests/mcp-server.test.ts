import { VERSION } from "../src/version.js";
import { describe, expect, it } from "vitest";

import type { MoodleGateway } from "../src/mcp/gateway.js";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/protocol.js";
import { createMoodleMcpServer, TOOL_OUTPUT_SCHEMAS } from "../src/mcp/server.js";
import { UsageError } from "../src/errors.js";

describe("Moodle MCP server", () => {
  it("discovers the modern stateless server without advertising unsupported capabilities", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "moodle", version: VERSION },
        resultType: "complete",
        _meta: { cacheScope: "private" },
      },
    });
    expect((response as { result: Record<string, unknown> }).result).not.toHaveProperty("prompts");
    expect((response as { result: Record<string, unknown> }).result).not.toHaveProperty("resources");
  });

  it("lists the read-only tools in deterministic release order", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
      params: modernParams(),
    });

    expect(response).toMatchObject({
      id: "tools",
      result: {
        resultType: "complete",
        _meta: { cacheScope: "private" },
      },
    });
    const tools = (response as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(["home", "due", "units", "unit", "find", "item", "grades", "news", "thread", "search_forums", "file"]);
    expect(tools).toHaveLength(11);
    expect(tools.every((tool) => (
      (tool.annotations as Record<string, unknown>).readOnlyHint === true
      && (tool.annotations as Record<string, unknown>).destructiveHint === false
      && typeof tool.inputSchema === "object"
      && tool.outputSchema === undefined
    ))).toBe(true);
    for (const tool of tools) {
      const output = TOOL_OUTPUT_SCHEMAS[String(tool.name)] as { properties?: Record<string, { properties?: Record<string, unknown>; items?: unknown }> };
      const [result] = Object.values(output.properties ?? {});
      expect(result, `${String(tool.name)} should describe its structured result`).toSatisfy((schema: unknown) => {
        if (!schema || typeof schema !== "object") return false;
        const value = schema as { properties?: Record<string, unknown>; items?: unknown };
        return Object.keys(value.properties ?? {}).length > 0 || value.items !== undefined;
      });
    }
    const item = TOOL_OUTPUT_SCHEMAS.item as { properties: { item: { properties: Record<string, unknown> } } };
    expect(item.properties.item.properties).toHaveProperty("files");
  });

  it("lists and runs the submit tool only when the gateway can read local files", async () => {
    const readOnly = createMoodleMcpServer(fakeGateway());
    const missing = await readOnly.handle({ jsonrpc: "2.0", id: "no-submit", method: "tools/call", params: modernParams({ name: "submit", arguments: { ref: 555, files: ["essay.pdf"] } }) });
    expect(missing).toMatchObject({ id: "no-submit", error: { code: -32602, data: { type: "TOOL_NOT_FOUND" } } });

    const calls: unknown[] = [];
    const gateway: MoodleGateway = { ...fakeGateway(), submitAssignment: async (input) => { calls.push(input); return receipt(input.dryRun ?? false); } };
    const server = createMoodleMcpServer(gateway);
    const listed = await server.handle({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: modernParams() });
    const tools = (listed as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(["home", "due", "units", "unit", "find", "item", "grades", "news", "thread", "search_forums", "submit", "file"]);
    expect(tools.find((tool) => tool.name === "submit")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tools.filter((tool) => tool.name !== "submit").every((tool) => (tool.annotations as Record<string, unknown>).readOnlyHint === true)).toBe(true);

    const planned = await server.handle({ jsonrpc: "2.0", id: "plan", method: "tools/call", params: modernParams({ name: "submit", arguments: { ref: 555, files: ["essay.pdf"] } }) });
    expect(planned).toMatchObject({ id: "plan", result: { structuredContent: { submission: { id: 555, action: "planned", uploads: [{ name: "essay.pdf", bytes: 5 }] } } } });
    expect(calls).toEqual([{ activityId: 555, files: ["essay.pdf"], final: false, replace: false, acceptStatement: false, dryRun: true }]);

    const legacy = await server.handle({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "vitest", version: "1.0.0" } } });
    expect((legacy as { result: { instructions: string } }).result.instructions).toContain("submit");
  });

  it("keeps the reason when a submission is refused", async () => {
    const gateway: MoodleGateway = { ...fakeGateway(), submitAssignment: async () => { throw new UsageError('Moodle requires you to accept this statement: "My own work."', "Re-run with --accept-statement once you agree."); } };
    const response = await createMoodleMcpServer(gateway).handle({ jsonrpc: "2.0", id: "refused", method: "tools/call", params: modernParams({ name: "submit", arguments: { ref: 555, files: ["essay.pdf"], dry_run: false } }) });
    expect(response).toMatchObject({ id: "refused", result: { isError: true, structuredContent: { error: { type: "MOODLE_INVALID_REQUEST", message: 'Moodle requires you to accept this statement: "My own work."', hint: "Re-run with --accept-statement once you agree." } } } });
  });

  it("returns an authenticated file as an embedded MCP resource", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: "file",
      method: "tools/call",
      params: modernParams({ name: "get_file", arguments: { source: 91234 } }),
    });

    expect(response).toMatchObject({
      id: "file",
      result: {
        content: [
          { type: "text", text: expect.any(String) },
          {
            type: "resource",
            resource: {
              uri: "https://moodle.example.edu/pluginfile.php/1/slides.pdf",
              mimeType: "application/pdf",
              blob: "c2xpZGVz",
            },
          },
        ],
        structuredContent: {
          file: {
            name: "slides.pdf",
            mime_type: "application/pdf",
            bytes: 6,
            uri: "https://moodle.example.edu/pluginfile.php/1/slides.pdf",
          },
        },
        resultType: "complete",
        _meta: { cacheScope: "private" },
      },
    });
    expect(JSON.stringify((response as { result: { structuredContent: unknown } }).result.structuredContent))
      .not.toContain("c2xpZGVz");
  });

  it("calls a tool with typed content and private result metadata", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: modernParams({ name: "list_courses", arguments: { limit: 1 } }),
    });

    expect(response).toMatchObject({
      id: 2,
      result: {
        content: [{ type: "text", text: expect.any(String) }],
        structuredContent: {
          units: [{ id: 101, code: "COMP101", name: "Computing" }],
        },
        resultType: "complete",
        _meta: { cacheScope: "private" },
      },
    });
    expect(textResult(response)).toMatchObject({ units: [{ id: 101, name: "Computing" }] });
  });

  it.each([
    ["resource", [{ name: "slides.pdf", url: "https://moodle.example.edu/pluginfile.php/slides.pdf", requires_authentication: true }]],
    ["folder", [
      { name: "chapter-1.pdf", url: "https://moodle.example.edu/pluginfile.php/chapter-1.pdf", requires_authentication: true },
      { name: "chapter-2.pdf", url: "https://moodle.example.edu/pluginfile.php/chapter-2.pdf", requires_authentication: true },
    ]],
  ])("returns %s file entries through the existing get_activity tool", async (type, fileEntries) => {
    const server = createMoodleMcpServer({
      ...fakeGateway(),
      getActivity: async () => ({ id: 501, name: "Files", type, file_entries: fileEntries }) as never,
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: type,
      method: "tools/call",
      params: modernParams({ name: "get_activity", arguments: { activityId: 501 } }),
    });

    expect(response).toMatchObject({
      result: {
        structuredContent: {
          item: { type, files: fileEntries },
        },
      },
    });
  });

  it("rejects invalid tool input at the public call seam", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: modernParams({ name: "get_course", arguments: { courseId: -1 } }),
    });

    expect(response).toMatchObject({
      id: 3,
      error: {
        code: -32602,
        data: { type: "INVALID_TOOL_ARGUMENTS" },
      },
    });
  });

  it("returns stable typed Moodle errors without failing the protocol", async () => {
    const error = Object.assign(new Error("The Moodle session expired."), {
      code: "auth",
      moodleErrorCode: "servicerequireslogin",
    });
    const server = createMoodleMcpServer({
      ...fakeGateway(),
      getUser: async () => { throw error; },
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: modernParams({ name: "get_user", arguments: {} }),
    });

    expect(response).toMatchObject({
      id: 4,
      result: {
        isError: true,
        structuredContent: {
          error: {
            type: "MOODLE_AUTH_REQUIRED",
            message: "The Moodle session has expired. Sign in again.",
            moodleCode: "servicerequireslogin",
          },
        },
        resultType: "complete",
        _meta: { cacheScope: "private" },
      },
    });
  });

  it("initializes the protocol versions claude.ai negotiates", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const initialize = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } },
    });
    const initialized = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, {
      protocolVersion: "2025-06-18",
    });
    const listed = await server.handle(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { protocolVersion: "2025-06-18" },
    );

    expect(initialize).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } } },
    });
    expect(initialized).toBeNull();
    expect(listed).toMatchObject({ id: 2, result: { tools: expect.any(Array) } });
  });

  it("rejects unsupported protocol versions with retry metadata", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const response = await server.handle(
      { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
      { protocolVersion: "2024-11-05" },
    );

    expect(response).toMatchObject({
      id: 5,
      error: {
        code: -32_022,
        message: "Unsupported protocol version",
        data: {
          requested: "2024-11-05",
          supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        },
      },
    });
  });

  it("keeps the legacy initialize and tool flow stateless", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const initialize = await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "initialize",
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1.0.0" },
      },
    });
    const listed = await server.handle(
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
      { protocolVersion: LEGACY_PROTOCOL_VERSION },
    );
    const called = await server.handle(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "get_user", arguments: {} },
      },
      { protocolVersion: LEGACY_PROTOCOL_VERSION },
    );
    const notification = await server.handle(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { protocolVersion: LEGACY_PROTOCOL_VERSION },
    );

    expect(initialize).toMatchObject({
      result: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "moodle", version: VERSION },
      },
    });
    expect(listed).toMatchObject({ result: { tools: expect.any(Array) } });
    expect(called).toMatchObject({ result: { structuredContent: { user: { id: 7 } } } });
    expect(notification).toBeNull();
  });

  it("rejects modern request metadata that disagrees with HTTP metadata", async () => {
    const server = createMoodleMcpServer(fakeGateway());
    const response = await server.handle(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: modernParams({ name: "get_user", arguments: {} }),
      },
      {
        protocolVersion: MODERN_PROTOCOL_VERSION,
        method: "tools/call",
        toolName: "list_courses",
      },
    );

    expect(response).toMatchObject({
      id: 9,
      error: {
        code: -32602,
        data: { type: "REQUEST_METADATA_MISMATCH", field: "name" },
      },
    });
  });

  it.each([
    ["get_user", {}, "user"],
    ["get_overview", {}, "home"],
    ["list_courses", {}, "units"],
    ["get_course", { courseId: 101 }, "unit"],
    ["list_activities", { courseId: 101 }, "total"],
    ["get_activity", { activityId: 501 }, "item"],
    ["get_grades", { courseId: 101 }, "grades"],
    ["list_forums", { courseId: 101 }, "total"],
    ["search_forums", { query: "exam" }, "total"],
    ["get_thread", { discussionId: 701 }, "thread"],
    ["get_file", { source: 91234 }, "file"],
  ])("exposes the complete %s result to text-only clients", async (name, args, resultKey) => {
    const server = createMoodleMcpServer(fakeGateway());
    const response = await server.handle({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: modernParams({ name, arguments: args }),
    });

    expect(response).toMatchObject({
      id: name,
      result: {
        structuredContent: { [resultKey]: expect.anything() },
        resultType: "complete",
      },
    });
    const result = (response as { result: { structuredContent: unknown } }).result;
    expect(textResult(response)).toEqual(result.structuredContent);
    if (name === "get_file") expect(JSON.stringify(textResult(response))).not.toContain("c2xpZGVz");
  });

  it("includes overview deadlines and forum IDs in model-visible content", async () => {
    const gateway = fakeGateway();
    const overview = await gateway.getOverview({ todoLimit: 5, alertsLimit: 5 });
    overview.courses = await gateway.listCourses();
    overview.todo = [{ id: 501, name: "Assignment", course_id: 101, course_name: "Computing", due_at: 1800000000, url: "https://moodle.example.edu/mod/assign/view.php?id=501" }] as typeof overview.todo;
    gateway.getOverview = async () => overview;
    gateway.listForums = async () => [{ id: 601, name: "Questions", course_id: 101, course_name: "Computing", url: "https://moodle.example.edu/mod/forum/view.php?id=601" }];
    const server = createMoodleMcpServer(gateway);
    const call = async (name: string) => textResult(await server.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: modernParams({ name }) }));
    expect(await call("get_overview")).toMatchObject({ home: { units: [{ id: 101 }, { id: 102 }], due: [{ due_at: 1800000000, unit_id: 101 }] } });
    expect(await call("list_forums")).toMatchObject({ forums: [{ id: 601, unit_id: 101, name: "Questions" }] });
  });

  it("chains course, activity and grade calls using only text content", async () => {
    const gateway = fakeGateway();
    const getCourse = vi.spyOn(gateway, "getCourse");

    const getGrades = vi.spyOn(gateway, "getGrades");
    const server = createMoodleMcpServer(gateway);
    const call = async (name: string, args = {}) => textResult(await server.handle({
      jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args },
    }, { protocolVersion: "2025-06-18" }));
    const courses = (await call("list_courses")).units as Array<{ id: number; name: string }>;
    expect(courses[0]).toMatchObject({ id: 101, name: "Computing" });
    const courseId = courses[0]!.id;
    expect(await call("get_course", { courseId })).toHaveProperty("unit.id", courseId);
    expect(await call("list_activities", { courseId })).toHaveProperty("total", 0);
    expect(await call("get_grades", { courseId })).toHaveProperty("grades.0.unit_id", courseId);
    for (const method of [getCourse, getGrades]) {
      expect(method).toHaveBeenCalledWith(expect.objectContaining({ courseId }));
    }
  });
});

function receipt(dryRun: boolean) {
  return { id: 555, name: "Essay 1", unit_id: 101, url: "https://moodle.example.edu/mod/assign/view.php?id=555", action: dryRun ? "planned" as const : "saved" as const, submission_status: dryRun ? "No submission" : "Draft (not submitted)", grading_status: "Not graded", due: "Friday, 15 May 2026, 5:00 PM", time_remaining: "2 days", last_modified: "", files: [], uploads: [{ name: "essay.pdf", bytes: 5 }], removed: [], limits: { max_files: 1 }, checked_at: "2026-05-13T09:00:00.000Z" };
}

function textResult(response: unknown): Record<string, unknown> {
  const result = (response as { result: { content: Array<{ type: string; text?: string }> } }).result;
  return JSON.parse(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
}

function modernParams(extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    _meta: {
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    },
  };
}

function fakeGateway(): MoodleGateway {
  return {
    getUser: async () => ({
      userid: 7,
      username: "ada",
      fullname: "Ada Lovelace",
      sitename: "Example Moodle",
      siteurl: "https://moodle.example.edu",
    }),
    getOverview: async () => ({
      user: {
        userid: 7,
        username: "ada",
        fullname: "Ada Lovelace",
        sitename: "Example Moodle",
        siteurl: "https://moodle.example.edu",
      },
      courses: [],
      todo: [],
      errors: [],
    }),
    listCourses: async () => [
      {
        id: 101,
        shortname: "COMP101",
        fullname: "Computing",
        category: 1,
        visible: true,
        startdate: 1,
      },
      {
        id: 102,
        shortname: "COMP102",
        fullname: "Advanced Computing",
        category: 1,
        visible: true,
        startdate: 1,
      },
    ],
    getCourse: async () => ({
      course: {
        id: 101,
        shortname: "COMP101",
        fullname: "Computing",
        category: 1,
        visible: true,
        startdate: 1,
      },
      sections: [],
    }),
    listActivities: async () => [],
    getActivity: async () => ({
      id: 501,
      name: "Assignment 1",
      course_id: 101,
      course_name: "Computing",
      section_name: "Week 1",
      due_pretty: "Tomorrow",
      submission_status: "Not submitted",
      grading_status: "Not graded",
      time_remaining: "1 day",
      grade: "-",
      url: "https://moodle.example.edu/mod/assign/view.php?id=501",
      type: "assign",
    }),
    getGrades: async () => ({
      course_id: 101,
      course_name: "Computing",
      learner_name: "Ada Lovelace",
      total_grade: "80",
      total_range: "0-100",
      total_percentage: "80%",
      items: [],
    }),
    listForums: async () => [],
    searchForums: async () => [],
    getThread: async () => ({
      id: 701,
      subject: "Exam",
      course_id: 101,
      forum_id: 601,
      group_id: 0,
      group_name: "",
      url: "https://moodle.example.edu/mod/forum/discuss.php?d=701",
      posts: [],
    }),
    getFile: async () => ({
      name: "slides.pdf",
      mimeType: "application/pdf",
      bytes: 6,
      uri: "https://moodle.example.edu/pluginfile.php/1/slides.pdf",
      blob: "c2xpZGVz",
    }),
  };
}
