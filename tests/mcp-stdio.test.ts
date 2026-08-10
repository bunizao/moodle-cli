import { describe, expect, it } from "vitest";

import type { MoodleGateway } from "../src/mcp/gateway.js";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "../src/mcp/protocol.js";
import { createMoodleMcpServer } from "../src/mcp/server.js";
import { serveMoodleMcpStdio } from "../src/mcp/stdio.js";

describe("Moodle MCP stdio transport", () => {
  it("serves newline-delimited modern requests across arbitrary chunks", async () => {
    const output = outputBuffer();
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_user",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "stdio-test", version: "1.0.0" },
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        },
      },
    });

    await serveMoodleMcpStdio(createMoodleMcpServer(gateway()), {
      input: chunks(request.slice(0, 17), `${request.slice(17)}\n`),
      output,
    });

    expect(output.lines()).toHaveLength(1);
    expect(output.lines()[0]).toMatchObject({
      id: 1,
      result: { structuredContent: { user: { fullname: "Ada Lovelace" } } },
    });
  });

  it("negotiates a legacy version once and keeps later requests stateless", async () => {
    const output = outputBuffer();
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "legacy-stdio", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map((request) => JSON.stringify(request)).join("\n");

    await serveMoodleMcpStdio(createMoodleMcpServer(gateway()), {
      input: chunks(`${requests}\n`),
      output,
    });

    expect(output.lines()).toHaveLength(2);
    expect(output.lines()[0]).toMatchObject({ result: { protocolVersion: LEGACY_PROTOCOL_VERSION } });
    expect(output.lines()[1]).toMatchObject({ result: { tools: expect.any(Array) } });
  });

  it("reports malformed JSON and continues with the next line", async () => {
    const output = outputBuffer();
    const legacyList = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    await serveMoodleMcpStdio(createMoodleMcpServer(gateway()), {
      input: chunks(`{bad json}\n${legacyList}\n`),
      output,
      protocolVersion: LEGACY_PROTOCOL_VERSION,
    });

    expect(output.lines()[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(output.lines()[1]).toMatchObject({ id: 2, result: { tools: expect.any(Array) } });
  });
});

async function* chunks(...values: string[]): AsyncIterable<string> {
  for (const value of values) {
    yield value;
  }
}

function outputBuffer() {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    lines() {
      return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

function gateway(): MoodleGateway {
  const user = {
    userid: 7,
    username: "ada",
    fullname: "Ada Lovelace",
    sitename: "Example Moodle",
    siteurl: "https://moodle.example.edu",
  };
  return {
    getUser: async () => user,
    getOverview: async () => ({ user, courses: [], todo: [], errors: [] }),
    listCourses: async () => [],
    getCourse: async () => { throw new Error("not used"); },
    listActivities: async () => [],
    getActivity: async () => { throw new Error("not used"); },
    getGrades: async () => ({
      course_id: 1,
      course_name: "",
      learner_name: "",
      total_grade: "",
      total_range: "",
      total_percentage: "",
      items: [],
    }),
    listForums: async () => [],
    searchForums: async () => [],
    getThread: async () => { throw new Error("not used"); },
  };
}
