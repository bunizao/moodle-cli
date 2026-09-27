import { lstat, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../src/atomic-write.js";
import { DefaultClientIntegration } from "../src/mcp/connectors/node-connectors.js";
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

  it("writes an explicit native remote Codex registration without exposing the token in receipts", async () => {
    const files = new MemoryFiles();
    files.files.set("/codex.toml", "model = \"gpt-5\"\n");
    const connector = createCodexConnector({
      profile: "school",
      configPath: "/codex.toml",
      mode: "remote",
      endpoint: "https://moodle-school.demo.workers.dev/mcp",
      accessToken: "private-access-token",
    }, files);

    const preview = await connector.preview();
    const receipt = await connectClient(connector);
    expect(JSON.stringify({ preview, receipt })).not.toContain("private-access-token");
    expect(files.files.get("/codex.toml")).toContain('url = "https://moodle-school.demo.workers.dev/mcp"');
    expect(files.files.get("/codex.toml")).toContain('http_headers = { Authorization = "Bearer private-access-token" }');
    await expect(connector.verify()).resolves.toMatchObject({ configured: true });
  });

  it("writes an explicit native remote JSON registration and keeps unrelated clients", async () => {
    const files = new MemoryFiles();
    files.files.set("/cursor.json", JSON.stringify({ mcpServers: { github: { command: "github-mcp" } } }));
    const connector = createCursorConnector({
      profile: "school",
      configPath: "/cursor.json",
      mode: "remote",
      endpoint: "https://moodle-school.demo.workers.dev/mcp",
      accessToken: "private-access-token",
    }, files);
    const receipt = await connectClient(connector);
    const parsed = JSON.parse(files.files.get("/cursor.json") ?? "{}") as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.github).toBeDefined();
    expect(parsed.mcpServers["moodle-school"]).toEqual({
      type: "http",
      url: "https://moodle-school.demo.workers.dev/mcp",
      headers: { Authorization: "Bearer private-access-token" },
    });
    expect(JSON.stringify(receipt)).not.toContain("private-access-token");
  });

  it("requires a safe endpoint and token for native remote mode", () => {
    const files = new MemoryFiles();
    expect(() => createCodexConnector({
      profile: "school",
      configPath: "/codex.toml",
      mode: "remote",
      endpoint: "http://worker.example/mcp?token=leak",
      accessToken: "token",
    }, files)).toThrow("HTTPS URL without credentials, query, or fragment");
    expect(() => createCodexConnector({
      profile: "school",
      configPath: "/codex.toml",
      mode: "remote",
      endpoint: "https://worker.example/mcp",
    }, files)).toThrow("requires an endpoint and access token");
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

  it("leaves the file alone when the client rewrote it after our write", async () => {
    const files = new MemoryFiles();
    files.files.set("/client.json", '{"existing":true}\n');
    const connector = createClaudeDesktopConnector({ profile: "school", configPath: "/client.json" }, files);
    vi.spyOn(connector, "verify").mockImplementation(async () => {
      files.files.set("/client.json", '{"rewrittenByClient":true}\n');
      return { client: "claude-desktop", configured: false };
    });

    await expect(connectClient(connector)).rejects.toBeInstanceOf(ClientConnectionError);
    expect(files.files.get("/client.json")).toBe('{"rewrittenByClient":true}\n');
  });

  it("restores the original when the config write itself fails", async () => {
    const files = new MemoryFiles();
    files.files.set("/client.json", '{"existing":true}\n');
    const write = vi.spyOn(files, "writePrivate").mockImplementation(async (path, content) => {
      if (path === "/client.json" && content.includes("moodle-school")) {
        throw new Error("disk full at /client.json");
      }
      files.writes.push(path);
      files.files.set(path, content);
    });
    const connector = createClaudeDesktopConnector({ profile: "school", configPath: "/client.json" }, files);

    await expect(connectClient(connector)).rejects.toBeInstanceOf(ClientConnectionError);
    expect(files.files.get("/client.json")).toBe('{"existing":true}\n');
    expect(write).toHaveBeenCalledWith("/client.json.moodle-mcp.backup", '{"existing":true}\n');
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

describe("DefaultClientIntegration", () => {
  const options = (files: MemoryFiles) => ({ homeDirectory: "/home", platform: "linux" as const, command: "moodle", commandArgs: [], fileSystem: files });

  it("configures every other client when one config cannot be parsed, then names the broken one", async () => {
    const files = new MemoryFiles();
    files.files.set("/home/.codex", "");
    files.files.set("/home/.claude", "");
    files.files.set("/home/.claude.json", "{ not json");
    files.files.set("/home/.cursor", "");

    const error = await new DefaultClientIntegration(options(files)).install("school").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientConnectionError);
    expect((error as ClientConnectionError).clients).toEqual(["claude-code"]);
    expect(files.files.get("/home/.claude.json")).toBe("{ not json");
    expect(files.files.get("/home/.codex/config.toml")).toContain('[mcp_servers."moodle-school"]');
    expect(files.files.get("/home/.cursor/mcp.json")).toContain("moodle-school");
  });

  it("removes the registration from every other client when one config cannot be parsed", async () => {
    const files = new MemoryFiles();
    files.files.set("/home/.claude.json", "{ not json");
    files.files.set("/home/.cursor/mcp.json", JSON.stringify({ mcpServers: { "moodle-school": { command: "moodle" }, github: { command: "gh" } } }));

    await expect(new DefaultClientIntegration(options(files)).remove("school")).rejects.toThrow("claude-code");
    expect(JSON.parse(files.files.get("/home/.cursor/mcp.json") ?? "{}")).toEqual({ mcpServers: { github: { command: "gh" } } });
  });
});

describe("writeFileAtomic", () => {
  it("replaces the file without leaving a temporary behind, keeping its mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moodle-atomic-"));
    try {
      const path = join(dir, "config.yaml");
      await writeFile(path, "old\n", { mode: 0o640 });
      await writeFileAtomic(path, "new\n");
      expect(await readFile(path, "utf8")).toBe("new\n");
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      expect(await readdir(dir)).toEqual(["config.yaml"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes through a symlink instead of replacing it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moodle-atomic-"));
    try {
      const real = join(dir, "dotfiles.json");
      const link = join(dir, "client.json");
      await writeFile(real, "{}");
      await symlink(real, link);
      await writeFileAtomic(link, '{"a":1}', { mode: 0o600 });
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(real);
      expect(await readFile(real, "utf8")).toBe('{"a":1}');
      expect((await stat(real)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
