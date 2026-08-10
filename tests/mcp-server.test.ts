import { describe, expect, it } from "vitest";

import type { MoodleGateway } from "../src/mcp/gateway.js";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "../src/mcp/protocol.js";
import { createMoodleMcpServer } from "../src/mcp/server.js";

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
        supportedVersions: ["2026-07-28", "2025-11-25"],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "moodle", version: "0.7.0-alpha.1" },
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
    expect(tools.map((tool) => tool.name)).toEqual([
      "get_user",
      "get_overview",
      "list_courses",
      "get_course",
      "list_activities",
      "get_activity",
      "get_grades",
      "list_forums",
      "search_forums",
      "get_thread",
    ]);
    expect(tools).toHaveLength(10);
    expect(tools.every((tool) => (
      (tool.annotations as Record<string, unknown>).readOnlyHint === true
      && (tool.annotations as Record<string, unknown>).destructiveHint === false
      && typeof tool.inputSchema === "object"
      && typeof tool.outputSchema === "object"
    ))).toBe(true);
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
        content: [{ type: "text", text: "Found 1 Moodle course." }],
        structuredContent: {
          courses: [{ id: 101, shortname: "COMP101", fullname: "Computing" }],
        },
        resultType: "complete",
        _meta: { cacheScope: "private" },
      },
    });
    expect(JSON.stringify((response as { result: { content: unknown } }).result.content)).not.toContain("Computing");
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
          activity: { type, file_entries: fileEntries },
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
      params: modernParams({ name: "get_course", arguments: { courseId: "101" } }),
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
            message: "The Moodle session expired.",
            moodleCode: "servicerequireslogin",
          },
        },
        resultType: "complete",
        _meta: { cacheScope: "private" },
      },
    });
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
        code: -32602,
        data: {
          type: "UNSUPPORTED_PROTOCOL_VERSION",
          protocolVersion: "2024-11-05",
          supportedVersions: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
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
        serverInfo: { name: "moodle", version: "0.7.0-alpha.1" },
      },
    });
    expect(listed).toMatchObject({ result: { tools: expect.any(Array) } });
    expect(called).toMatchObject({ result: { structuredContent: { user: { userid: 7 } } } });
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
    ["get_overview", {}, "overview"],
    ["list_courses", {}, "courses"],
    ["get_course", { courseId: 101 }, "course"],
    ["list_activities", { courseId: 101 }, "activities"],
    ["get_activity", { activityId: 501 }, "activity"],
    ["get_grades", { courseId: 101 }, "grades"],
    ["list_forums", { courseId: 101 }, "forums"],
    ["search_forums", { query: "exam" }, "results"],
    ["get_thread", { discussionId: 701 }, "thread"],
  ])("dispatches %s through its public result shape", async (name, args, resultKey) => {
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
  });
});

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
  };
}
