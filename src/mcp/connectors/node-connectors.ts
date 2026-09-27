import { writeFileAtomic } from "../../atomic-write.js";
import { runtimeCommand } from "../self-command.js";
import { readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ClientConnectionError,
  connectClient,
  createClaudeCodeConnector,
  createClaudeDesktopConnector,
  createCodexConnector,
  createCursorConnector,
  createVsCodeConnector,
  type ConfigFileClientConnector,
  type ConnectorFileSystem,
  type SupportedMcpClient,
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
    await writeFileAtomic(path, content, { mode: 0o600, directoryMode: 0o700 });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}

export interface DefaultConnectorOptions {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  command?: string;
  commandArgs?: string[];
  fileSystem?: ConnectorFileSystem;
  mode?: "bridge" | "remote";
  endpoint?: string;
  accessToken?: string;
}

export function createDefaultClientConnectors(
  profile: string,
  options: DefaultConnectorOptions = {},
): ConfigFileClientConnector[] {
  const home = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const fileSystem = options.fileSystem ?? new NodeConnectorFileSystem();
  const runtime = runtimeCommand(options.command, options.commandArgs);
  const shared = {
    profile,
    command: runtime.command,
    commandArgs: runtime.args,
    mode: options.mode,
    endpoint: options.endpoint,
    accessToken: options.accessToken,
  };
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

  // One unreadable client config must not leave the clients after it unconfigured, so every
  // client is tried and the failures are reported together.
  async install(profile: string): Promise<void> {
    const failed: SupportedMcpClient[] = [];
    for (const connector of createDefaultClientConnectors(profile, this.options)) {
      try {
        if ((await connector.detect()).detected) {
          await connectClient(connector);
        }
      } catch {
        failed.push(connector.client);
      }
    }
    if (failed.length) {
      throw new ClientConnectionError(failed);
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
    const failed: SupportedMcpClient[] = [];
    for (const connector of createDefaultClientConnectors(profile, this.options)) {
      await connector.removeRegistration().catch(() => failed.push(connector.client));
    }
    if (failed.length) {
      throw new Error(
        `Could not remove moodle-${profile} from the ${failed.join(", ")} configuration. Delete that entry from the file by hand.`,
      );
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
