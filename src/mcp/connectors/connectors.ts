export type SupportedMcpClient = "codex" | "claude-desktop" | "claude-code" | "vscode" | "cursor";

export interface ClientDetection {
  client: SupportedMcpClient;
  detected: boolean;
  configPath: string;
}

export interface ClientChange {
  client: SupportedMcpClient;
  configPath: string;
  changed: boolean;
  registration: string;
}

export interface ClientReceipt {
  client: SupportedMcpClient;
  configPath: string;
  backupPath: string | null;
  changed: boolean;
}

export interface ClientVerification {
  client: SupportedMcpClient;
  configured: boolean;
}

export interface ClientConnector {
  detect(): Promise<ClientDetection>;
  preview(): Promise<ClientChange>;
  apply(): Promise<ClientReceipt>;
  verify(): Promise<ClientVerification>;
  rollback(): Promise<void>;
}

export interface ConnectorFileSystem {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writePrivate(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ClientConnectorOptions {
  profile: string;
  configPath: string;
  detectionPath?: string;
  command?: string;
}

interface ConnectorCodec {
  update(content: string, registration: string, command: string, profile: string): string;
  contains(content: string, registration: string, command: string, profile: string): boolean;
  remove(content: string, registration: string): string;
}

export class ConfigFileClientConnector implements ClientConnector {
  private readonly registration: string;
  private readonly command: string;
  private original: string | null | undefined;
  private lastReceipt: ClientReceipt | null = null;

  constructor(
    private readonly client: SupportedMcpClient,
    private readonly options: ClientConnectorOptions,
    private readonly fileSystem: ConnectorFileSystem,
    private readonly codec: ConnectorCodec,
  ) {
    validateProfile(options.profile);
    this.registration = `moodle-${options.profile}`;
    this.command = options.command ?? "moodle";
  }

  async detect(): Promise<ClientDetection> {
    const detectionPath = this.options.detectionPath ?? this.options.configPath;
    return {
      client: this.client,
      detected: await this.fileSystem.exists(detectionPath),
      configPath: this.options.configPath,
    };
  }

  async preview(): Promise<ClientChange> {
    const before = await this.readConfig();
    const after = this.codec.update(before ?? "", this.registration, this.command, this.options.profile);
    return {
      client: this.client,
      configPath: this.options.configPath,
      changed: before !== after,
      registration: this.registration,
    };
  }

  async apply(): Promise<ClientReceipt> {
    const before = await this.readConfig();
    const after = this.codec.update(before ?? "", this.registration, this.command, this.options.profile);
    this.original = before;
    const changed = before !== after;
    const backupPath = before === null ? null : `${this.options.configPath}.moodle-mcp.backup`;
    if (changed) {
      if (backupPath && before !== null) {
        await this.fileSystem.writePrivate(backupPath, before);
      }
      await this.fileSystem.writePrivate(this.options.configPath, after);
    }
    this.lastReceipt = {
      client: this.client,
      configPath: this.options.configPath,
      backupPath,
      changed,
    };
    return this.lastReceipt;
  }

  async verify(): Promise<ClientVerification> {
    const content = await this.readConfig();
    return {
      client: this.client,
      configured: content !== null
        && this.codec.contains(content, this.registration, this.command, this.options.profile),
    };
  }

  async rollback(): Promise<void> {
    if (!this.lastReceipt?.changed || this.original === undefined) {
      return;
    }
    if (this.original === null) {
      await this.fileSystem.remove(this.options.configPath);
    } else {
      await this.fileSystem.writePrivate(this.options.configPath, this.original);
    }
  }

  async removeRegistration(): Promise<void> {
    const before = await this.readConfig();
    if (before === null) {
      return;
    }
    const after = this.codec.remove(before, this.registration);
    if (after === before) {
      return;
    }
    await this.fileSystem.writePrivate(`${this.options.configPath}.moodle-mcp.backup`, before);
    await this.fileSystem.writePrivate(this.options.configPath, after);
  }

  private async readConfig(): Promise<string | null> {
    return (await this.fileSystem.exists(this.options.configPath))
      ? this.fileSystem.readText(this.options.configPath)
      : null;
  }
}

export class ClientConnectionError extends Error {
  constructor(public readonly client: SupportedMcpClient) {
    super(`The MCP server is ready, but ${client} configuration could not be updated`);
    this.name = "ClientConnectionError";
  }
}

export async function connectClient(connector: ClientConnector): Promise<ClientReceipt> {
  const receipt = await connector.apply();
  try {
    const verification = await connector.verify();
    if (!verification.configured) {
      throw new Error("verification failed");
    }
    return receipt;
  } catch {
    await connector.rollback();
    throw new ClientConnectionError(receipt.client);
  }
}

export function createCodexConnector(
  options: ClientConnectorOptions,
  fileSystem: ConnectorFileSystem,
): ConfigFileClientConnector {
  return new ConfigFileClientConnector("codex", options, fileSystem, tomlCodec);
}

export function createClaudeDesktopConnector(
  options: ClientConnectorOptions,
  fileSystem: ConnectorFileSystem,
): ConfigFileClientConnector {
  return new ConfigFileClientConnector("claude-desktop", options, fileSystem, jsonCodec("mcpServers"));
}

export function createClaudeCodeConnector(
  options: ClientConnectorOptions,
  fileSystem: ConnectorFileSystem,
): ConfigFileClientConnector {
  return new ConfigFileClientConnector("claude-code", options, fileSystem, jsonCodec("mcpServers"));
}

export function createVsCodeConnector(
  options: ClientConnectorOptions,
  fileSystem: ConnectorFileSystem,
): ConfigFileClientConnector {
  return new ConfigFileClientConnector("vscode", options, fileSystem, jsonCodec("servers"));
}

export function createCursorConnector(
  options: ClientConnectorOptions,
  fileSystem: ConnectorFileSystem,
): ConfigFileClientConnector {
  return new ConfigFileClientConnector("cursor", options, fileSystem, jsonCodec("mcpServers"));
}

const tomlCodec: ConnectorCodec = {
  update(content, registration, command, profile) {
    const without = removeTomlBlock(content, registration).trimEnd();
    const block = tomlBlock(registration, command, profile);
    return without ? `${without}\n\n${block}` : block;
  },
  contains(content, registration, command, profile) {
    return content.includes(tomlBlock(registration, command, profile));
  },
  remove: removeTomlBlock,
};

function jsonCodec(container: "mcpServers" | "servers"): ConnectorCodec {
  return {
    update(content, registration, command, profile) {
      const document = parseJsonObject(content);
      const registrations = objectAt(document, container);
      registrations[registration] = bridgeRegistration(command, profile);
      document[container] = registrations;
      return `${JSON.stringify(document, null, 2)}\n`;
    },
    contains(content, registration, command, profile) {
      try {
        const document = parseJsonObject(content);
        return JSON.stringify(objectAt(document, container)[registration])
          === JSON.stringify(bridgeRegistration(command, profile));
      } catch {
        return false;
      }
    },
    remove(content, registration) {
      const document = parseJsonObject(content);
      const registrations = objectAt(document, container);
      if (!(registration in registrations)) {
        return content;
      }
      delete registrations[registration];
      document[container] = registrations;
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  };
}

function bridgeRegistration(command: string, profile: string): Record<string, unknown> {
  return { command, args: ["mcp", "bridge", "--profile", profile] };
}

function tomlBlock(registration: string, command: string, profile: string): string {
  return [
    `# >>> moodle-cli mcp:${registration}`,
    `[mcp_servers.${JSON.stringify(registration)}]`,
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(["mcp", "bridge", "--profile", profile])}`,
    `# <<< moodle-cli mcp:${registration}`,
    "",
  ].join("\n");
}

function removeTomlBlock(content: string, registration: string): string {
  const start = `# >>> moodle-cli mcp:${registration}`;
  const end = `# <<< moodle-cli mcp:${registration}`;
  const startIndex = content.indexOf(start);
  if (startIndex < 0) {
    return content;
  }
  const endIndex = content.indexOf(end, startIndex);
  if (endIndex < 0) {
    throw new Error(`Incomplete Moodle MCP block for ${registration}`);
  }
  const afterEnd = endIndex + end.length;
  return `${content.slice(0, startIndex)}${content.slice(afterEnd).replace(/^\r?\n/u, "")}`;
}

function parseJsonObject(content: string): Record<string, unknown> {
  if (!content.trim()) {
    return {};
  }
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP client configuration must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function objectAt(document: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = document[key];
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP client configuration field ${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateProfile(profile: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
    throw new Error("Invalid MCP connector profile name");
  }
}
