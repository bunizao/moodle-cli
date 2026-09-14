import { describe, expect, it } from "vitest";
import { createCodexConnector, createCursorConnector, type ConnectorFileSystem } from "../src/mcp/connectors/connectors.js";
import { createDefaultClientConnectors } from "../src/mcp/connectors/node-connectors.js";
import { buildRenewalInstallPlan } from "../src/mcp/renewal/installers.js";
import { runtimeCommand, selfCommand } from "../src/mcp/self-command.js";

class MemoryFiles implements ConnectorFileSystem {
  files = new Map<string, string>();
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async readText(path: string): Promise<string> { return this.files.get(path) ?? ""; }
  async writePrivate(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async remove(path: string): Promise<void> { this.files.delete(path); }
}

describe("selfCommand", () => {
  it("spawns the running script through the exact runtime binary", () => {
    expect(selfCommand(["/opt/node", "/opt/moodle/dist/moodle.js"], "/opt/node"))
      .toEqual({ command: "/opt/node", args: ["/opt/moodle/dist/moodle.js"] });
  });

  it("falls back to the bare runtime for single-binary builds", () => {
    expect(selfCommand(["/opt/moodle"], "/opt/moodle")).toEqual({ command: "/opt/moodle", args: [] });
    expect(selfCommand([], "/opt/moodle")).toEqual({ command: "/opt/moodle", args: [] });
  });

  it("prefers an explicit command over the running runtime", () => {
    expect(runtimeCommand("/usr/local/bin/moodle")).toEqual({ command: "/usr/local/bin/moodle", args: [] });
    expect(runtimeCommand(undefined, ["ignored"])).toEqual(selfCommand());
  });
});

describe("bridge connectors with an explicit runtime", () => {
  it("prefixes runtime arguments before the bridge subcommand in JSON clients", async () => {
    const files = new MemoryFiles();
    const connector = createCursorConnector({
      profile: "school",
      configPath: "/cursor.json",
      command: "/opt/node",
      commandArgs: ["/opt/moodle/dist/moodle.js"],
    }, files);
    await connector.apply();
    const parsed = JSON.parse(files.files.get("/cursor.json") ?? "{}") as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers["moodle-school"]).toEqual({
      command: "/opt/node",
      args: ["/opt/moodle/dist/moodle.js", "mcp", "bridge", "--profile", "school"],
    });
    await expect(connector.verify()).resolves.toMatchObject({ configured: true });
  });

  it("prefixes runtime arguments in the Codex TOML block", async () => {
    const files = new MemoryFiles();
    const connector = createCodexConnector({
      profile: "school",
      configPath: "/config.toml",
      command: "/opt/node",
      commandArgs: ["/opt/moodle/dist/moodle.js"],
    }, files);
    await connector.apply();
    const content = files.files.get("/config.toml") ?? "";
    expect(content).toContain('command = "/opt/node"');
    expect(content).toContain('args = ["/opt/moodle/dist/moodle.js","mcp","bridge","--profile","school"]');
  });

  it("defaults to the runtime that is executing the CLI", async () => {
    const files = new MemoryFiles();
    const connectors = createDefaultClientConnectors("school", {
      platform: "darwin",
      homeDirectory: "/Users/alice",
      fileSystem: files,
    });
    for (const connector of connectors) await connector.apply();
    const json = [...files.files.entries()].find(([path]) => path.endsWith(".json"))?.[1] ?? "{}";
    const registration = Object.values(JSON.parse(json) as Record<string, Record<string, { command: string; args: string[] }>>)
      .flatMap((container) => Object.values(container))
      .find((entry) => entry.args?.includes("bridge"));
    expect(registration?.command).toBe(process.execPath);
    expect(registration?.args).toEqual([...selfCommand().args, "mcp", "bridge", "--profile", "school"]);
  });
});

describe("renewal jobs with an explicit runtime", () => {
  it.each(["darwin", "linux", "win32"] as const)("%s puts the script after the runtime binary", (platform) => {
    const plan = buildRenewalInstallPlan({
      platform,
      profile: "school",
      executable: "/opt/node",
      executableArgs: ["/opt/moodle/dist/moodle.js"],
      homeDirectory: platform === "win32" ? "C:\\Users\\Alice" : "/Users/alice",
      uid: 501,
    });
    const content = plan.files.map((file) => file.content).join("\n");
    expect(content.indexOf("/opt/node")).toBeGreaterThan(-1);
    expect(content.indexOf("/opt/node")).toBeLessThan(content.indexOf("/opt/moodle/dist/moodle.js"));
    expect(content.indexOf("/opt/moodle/dist/moodle.js")).toBeLessThan(content.indexOf("--profile"));
  });

  it("rejects newline injection through runtime arguments", () => {
    expect(() => buildRenewalInstallPlan({
      platform: "darwin",
      profile: "school",
      executable: "/opt/node",
      executableArgs: ["/opt/moodle.js\nmalicious"],
      homeDirectory: "/Users/alice",
      uid: 501,
    })).toThrow("Invalid renewal executable arguments");
  });
});
