import { describe, expect, it, vi } from "vitest";

import { bridgeRemoteMcp } from "../src/mcp/bridge.js";

const TOKEN = "private-access-token";

describe("remote MCP credential bridge", () => {
  it("forwards modern JSON requests with credentials and metadata outside client configuration", async () => {
    const output = outputBuffer();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
      expect(headers.get("mcp-method")).toBe("tools/list");
      expect(headers.get("mcp-name")).toBeNull();
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    });

    await bridgeRemoteMcp({
      endpoint: "https://moodle.example.workers.dev/mcp",
      accessToken: TOKEN,
      input: chunks(`${JSON.stringify(modernRequest(1, "tools/list"))}\n`),
      output,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(output.lines()).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
    expect(output.raw()).not.toContain(TOKEN);
  });

  it("converts request-scoped SSE messages back to stdio JSON lines", async () => {
    const output = outputBuffer();
    const fetchImpl = vi.fn(async () => new Response([
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,"result":{"status":"ok"}}',
      "",
      "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } }));

    await bridgeRemoteMcp({
      endpoint: "https://moodle.example.workers.dev/mcp",
      accessToken: TOKEN,
      input: chunks(`${JSON.stringify(modernRequest(2, "server/discover"))}\n`),
      output,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(output.lines()).toEqual([{ jsonrpc: "2.0", id: 2, result: { status: "ok" } }]);
  });

  it("keeps later legacy requests on the initialized protocol version", async () => {
    const output = outputBuffer();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("mcp-protocol-version")).toBe("2025-11-25");
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (request.method === "initialize") {
        return new Response([
          "event: message",
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "moodle", version: "0.7.0" } },
          })}`,
          "",
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    });

    await bridgeRemoteMcp({
      endpoint: "https://moodle.example.workers.dev/mcp",
      accessToken: TOKEN,
      input: chunks(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
        })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      ),
      output,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(output.lines()).toEqual([
      expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: "2025-11-25" }) }),
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
  });

  it("returns sanitized JSON-RPC errors without exposing the remote response or credential", async () => {
    const output = outputBuffer();
    const fetchImpl = vi.fn(async () => new Response(`Authorization: Bearer ${TOKEN}`, { status: 401 }));

    await bridgeRemoteMcp({
      endpoint: "https://moodle.example.workers.dev/mcp",
      accessToken: TOKEN,
      input: chunks(`${JSON.stringify(modernRequest("denied", "tools/list"))}\n`),
      output,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(output.lines()[0]).toMatchObject({
      id: "denied",
      error: { code: -32000, data: { type: "REMOTE_MCP_ERROR", status: 401 } },
    });
    expect(output.raw()).not.toContain(TOKEN);
  });

  it("forwards the bounded unsupported-version negotiation error", async () => {
    const output = outputBuffer();
    const fetchImpl = vi.fn(async () => Response.json({
      jsonrpc: "2.0",
      id: "version",
      error: {
        code: -32_022,
        message: "Unsupported protocol version",
        data: { supported: ["2026-07-28", "2025-11-25"], requested: "1900-01-01" },
      },
    }, { status: 400 }));

    await bridgeRemoteMcp({
      endpoint: "https://moodle.example.workers.dev/mcp",
      accessToken: TOKEN,
      input: chunks(`${JSON.stringify(modernRequest("version", "tools/list"))}\n`),
      output,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(output.lines()).toEqual([{
      jsonrpc: "2.0",
      id: "version",
      error: {
        code: -32_022,
        message: "Unsupported protocol version",
        data: { supported: ["2026-07-28", "2025-11-25"], requested: "1900-01-01" },
      },
    }]);
  });
});

function modernRequest(id: string | number, method: string) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    },
  };
}

async function* chunks(...values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

function outputBuffer() {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    raw() {
      return value;
    },
    lines() {
      return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}
