import { describe, expect, it, vi } from "vitest";

import type { MoodleGateway } from "../src/mcp/gateway.js";
import { BRAND_SVG, type McpIcon } from "../src/mcp/icons.js";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "../src/mcp/protocol.js";
import { createMoodleMcpServer, TOOL_CATALOG } from "../src/mcp/server.js";
import { createWorkerHandler, digestBearerToken, type SessionBrokerApi } from "../src/worker/index.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const modernMeta = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
};

function decode(icon: McpIcon): Uint8Array {
  const [header, data] = icon.src.split(",");
  expect(header).toBe(`data:${icon.mimeType};base64`);
  return Uint8Array.from(atob(data!), (char) => char.charCodeAt(0));
}

// Clients render these without a sandbox, so nothing in them may run or fetch.
function expectInertSvg(icon: McpIcon): void {
  expect(icon).toMatchObject({ mimeType: "image/svg+xml", sizes: ["any"] });
  const svg = new TextDecoder().decode(decode(icon));
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24">/u);
  expect(svg).not.toMatch(/<script|<foreignObject|href=|url\(|\son\w+=/iu);
}

describe("MCP icons", () => {
  it("identifies the server with an SVG and a PNG icon in every handshake", async () => {
    const server = createMoodleMcpServer({} as MoodleGateway);
    const discover = await server.handle({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernMeta } });
    const initialize = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "vitest", version: "1.0.0" } } });

    for (const response of [discover, initialize]) {
      const info = (response as { result: { serverInfo: { title: string; icons: McpIcon[] } } }).result.serverInfo;
      expect(info.title).toBe("Moodle");
      const [svg, png] = info.icons;
      expectInertSvg(svg!);
      expect(png).toMatchObject({ mimeType: "image/png", sizes: ["128x128"] });
      expect([...decode(png!).subarray(0, 8)]).toEqual(PNG_MAGIC);
    }
  });

  it("gives every listed tool its own icon and keeps them small", async () => {
    const server = createMoodleMcpServer({ submitAssignment: vi.fn() } as unknown as MoodleGateway);
    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } });
    const tools = (response as { result: { tools: Array<{ name: string; icons: McpIcon[] }> } }).result.tools;

    expect(tools.map((tool) => tool.name)).toEqual(TOOL_CATALOG.map((tool) => tool.name));
    for (const tool of tools) {
      expect(tool.icons).toHaveLength(2);
      expectInertSvg(tool.icons[0]!);
      expect(tool.icons[1]).toMatchObject({ mimeType: "image/png", sizes: ["48x48"] });
      expect([...decode(tool.icons[1]!).subarray(0, 8)]).toEqual(PNG_MAGIC);
    }
    expect(new Set(tools.map((tool) => tool.icons[0]!.src)).size).toBe(tools.length);
    // Every tools/list carries both icon formats.
    expect(JSON.stringify(tools.map((tool) => tool.icons)).length).toBeLessThan(20000);
  });

  it("serves the brand mark as a public favicon from the Worker", async () => {
    const mcpServer = { handle: vi.fn() };
    const worker = createWorkerHandler({ mcpServer, broker: () => ({}) as SessionBrokerApi });
    const env = {
      EXPECTED_HOST: "moodle-mcp.example.workers.dev",
      MCP_ACCESS_TOKEN_DIGEST: await digestBearerToken("access-token"),
      SESSION_SYNC_TOKEN_DIGEST: await digestBearerToken("sync-token"),
    };

    const ico = await worker.fetch(new Request("https://moodle-mcp.example.workers.dev/favicon.ico"), env);
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await ico.arrayBuffer()).subarray(0, 8)]).toEqual(PNG_MAGIC);

    const svg = await worker.fetch(new Request("https://moodle-mcp.example.workers.dev/favicon.svg"), env);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(await svg.text()).toBe(BRAND_SVG);
    const wrongHost = await worker.fetch(new Request("https://other.example/favicon.svg"), env);
    expect(wrongHost.status).toBe(403);
    const queryCredential = await worker.fetch(new Request("https://moodle-mcp.example.workers.dev/favicon.svg?token=secret"), env);
    expect(queryCredential.status).toBe(401);
    expect(mcpServer.handle).not.toHaveBeenCalled();
  });
});
