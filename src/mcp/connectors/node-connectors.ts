import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  connectClient,
  createClaudeCodeConnector,
  createClaudeDesktopConnector,
  createCodexConnector,
  createCursorConnector,
  createVsCodeConnector,
  type ConfigFileClientConnector,
  type ConnectorFileSystem,
} from "./connectors.js";

export class NodeConnectorFileSystem implements ConnectorFileSystem {
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writePrivate(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}

export interface DefaultConnectorOptions {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  command?: string;
  fileSystem?: ConnectorFileSystem;
}

export function createDefaultClientConnectors(
  profile: string,
  options: DefaultConnectorOptions = {},
): ConfigFileClientConnector[] {
  const home = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const fileSystem = options.fileSystem ?? new NodeConnectorFileSystem();
  const shared = { profile, command: options.command };
  const claudeDesktop = platform === "darwin"
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : platform === "win32"
      ? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");
  const vscodeUser = platform === "darwin"
    ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
    : platform === "win32"
      ? join(home, "AppData", "Roaming", "Code", "User", "mcp.json")
      : join(home, ".config", "Code", "User", "mcp.json");
  return [
    createCodexConnector({ ...shared, configPath: join(home, ".codex", "config.toml"), detectionPath: join(home, ".codex") }, fileSystem),
    createClaudeDesktopConnector({ ...shared, configPath: claudeDesktop, detectionPath: dirname(claudeDesktop) }, fileSystem),
    createClaudeCodeConnector({ ...shared, configPath: join(home, ".claude.json"), detectionPath: join(home, ".claude") }, fileSystem),
    createVsCodeConnector({ ...shared, configPath: vscodeUser, detectionPath: dirname(vscodeUser) }, fileSystem),
    createCursorConnector({ ...shared, configPath: join(home, ".cursor", "mcp.json"), detectionPath: join(home, ".cursor") }, fileSystem),
  ];
}

export class DefaultClientIntegration {
  constructor(private readonly options: DefaultConnectorOptions = {}) {}

  async install(profile: string): Promise<void> {
    for (const connector of createDefaultClientConnectors(profile, this.options)) {
      if ((await connector.detect()).detected) {
        await connectClient(connector);
      }
    }
  }

  async inspect(profile: string): Promise<boolean> {
    const connectors = createDefaultClientConnectors(profile, this.options);
    const detected = [];
    for (const connector of connectors) {
      if ((await connector.detect()).detected) {
        detected.push(connector);
      }
    }
    if (!detected.length) {
      return true;
    }
    const checks = await Promise.all(detected.map((connector) => connector.verify()));
    return checks.every((check) => check.configured);
  }

  async remove(profile: string): Promise<void> {
    for (const connector of createDefaultClientConnectors(profile, this.options)) {
      await connector.removeRegistration();
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
