import { describe, expect, it, vi } from "vitest";
import {
  ClientConnectionError,
  connectClient,
  createClaudeCodeConnector,
  createClaudeDesktopConnector,
  createCodexConnector,
  createCursorConnector,
  createVsCodeConnector,
  type ConnectorFileSystem,
} from "../src/mcp/connectors/index.js";

class MemoryFiles implements ConnectorFileSystem {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readText(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`missing ${path}`);
    }
    return value;
  }

  async writePrivate(path: string, content: string): Promise<void> {
    this.writes.push(path);
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

describe("MCP config-file connectors", () => {
  it("adds a marker-bounded Codex bridge and preserves unrelated TOML", async () => {
    const files = new MemoryFiles();
    files.files.set("/home/.codex/config.toml", "model = \"gpt-5\"\n");
    const connector = createCodexConnector({ profile: "school", configPath: "/home/.codex/config.toml" }, files);

    expect(await connector.preview()).toMatchObject({ client: "codex", changed: true, registration: "moodle-school" });
    await connectClient(connector);

    const content = files.files.get("/home/.codex/config.toml") ?? "";
    expect(content).toContain("model = \"gpt-5\"");
    expect(content).toContain('[mcp_servers."moodle-school"]');
    expect(content).toContain('args = ["mcp","bridge","--profile","school"]');
    expect(files.files.get("/home/.codex/config.toml.moodle-mcp.backup")).toBe("model = \"gpt-5\"\n");
    expect(content).not.toMatch(/Bearer|mcpAccessToken/);
  });

  it.each([
    ["Claude Desktop", createClaudeDesktopConnector, "mcpServers"],
    ["Claude Code", createClaudeCodeConnector, "mcpServers"],
    ["VS Code", createVsCodeConnector, "servers"],
    ["Cursor", createCursorConnector, "mcpServers"],
  ] as const)("configures %s through the secret-free local bridge", async (_name, create, container) => {
    const files = new MemoryFiles();
    files.files.set("/client.json", '{"existing":{"kept":true}}\n');
    const connector = create({ profile: "school", configPath: "/client.json" }, files);
    await connectClient(connector);

    const parsed = JSON.parse(files.files.get("/client.json") ?? "{}") as Record<string, Record<string, unknown>>;
    expect(parsed.existing).toEqual({ kept: true });
    expect(parsed[container]?.["moodle-school"]).toEqual({
      command: "moodle",
      args: ["mcp", "bridge", "--profile", "school"],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/token|cookie|Authorization/i);
    await expect(connector.verify()).resolves.toMatchObject({ configured: true });
  });

  it("is idempotent after the first connection", async () => {
    const files = new MemoryFiles();
    const first = createCursorConnector({ profile: "school", configPath: "/cursor.json" }, files);
    await connectClient(first);
    const writes = files.writes.length;

    const second = createCursorConnector({ profile: "school", configPath: "/cursor.json" }, files);
    expect(await second.preview()).toMatchObject({ changed: false });
    expect(await second.apply()).toMatchObject({ changed: false });
    expect(files.writes).toHaveLength(writes);
  });

  it("restores the backup when verification fails", async () => {
    const files = new MemoryFiles();
    files.files.set("/client.json", '{"existing":true}\n');
    const connector = createClaudeDesktopConnector({ profile: "school", configPath: "/client.json" }, files);
    const verify = vi.spyOn(connector, "verify").mockResolvedValue({ client: "claude-desktop", configured: false });

    await expect(connectClient(connector)).rejects.toBeInstanceOf(ClientConnectionError);
    expect(verify).toHaveBeenCalledOnce();
    expect(files.files.get("/client.json")).toBe('{"existing":true}\n');
  });

  it("removes only the selected Moodle profile registration", async () => {
    const files = new MemoryFiles();
    files.files.set("/client.json", JSON.stringify({
      mcpServers: {
        "moodle-school": { command: "moodle", args: ["mcp", "bridge", "--profile", "school"] },
        "moodle-other": { command: "moodle", args: ["mcp", "bridge", "--profile", "other"] },
        github: { command: "github-mcp" },
      },
    }));
    const connector = createClaudeDesktopConnector({ profile: "school", configPath: "/client.json" }, files);
    await connector.removeRegistration();
    const parsed = JSON.parse(files.files.get("/client.json") ?? "{}") as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers["moodle-school"]).toBeUndefined();
    expect(parsed.mcpServers["moodle-other"]).toBeDefined();
    expect(parsed.mcpServers.github).toBeDefined();
  });

  it("detects an installed client separately from a missing config file", async () => {
    const files = new MemoryFiles();
    files.files.set("/Applications/Cursor.app", "");
    const connector = createCursorConnector({
      profile: "school",
      configPath: "/home/.cursor/mcp.json",
      detectionPath: "/Applications/Cursor.app",
    }, files);
    await expect(connector.detect()).resolves.toMatchObject({ detected: true, configPath: "/home/.cursor/mcp.json" });
  });
});
