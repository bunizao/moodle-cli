import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CredentialBackendUnavailableError,
  SafeCredentialStore,
  type CredentialBackend,
  type DeploymentCredentials,
} from "./store.js";

const SERVICE = "moodle-cli-mcp";

export interface CredentialCommandRunner {
  run(command: string, args: string[], input?: string): Promise<{ stdout: string }>;
}

export class NodeCredentialCommandRunner implements CredentialCommandRunner {
  async run(command: string, args: string[], input?: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout });
          return;
        }
        const error = new Error(`Credential command failed: ${command}`) as Error & { code: number | null; stderr: string };
        error.code = code;
        error.stderr = stderr;
        reject(error);
      });
      child.stdin.end(input);
    });
  }
}

export class MacOSKeychainCredentialBackend implements CredentialBackend {
  readonly name = "macOS Login Keychain";

  constructor(private readonly runner: CredentialCommandRunner = new NodeCredentialCommandRunner()) {}

  async read(profile: string): Promise<DeploymentCredentials | null> {
    try {
      const result = await this.runner.run("security", ["find-generic-password", "-s", SERVICE, "-a", profile, "-w"]);
      return parseCredentials(result.stdout.trim());
    } catch (error) {
      if (commandNotFound(error)) {
        throw new CredentialBackendUnavailableError(this.name, error);
      }
      if (commandExitCode(error) === 44) {
        return null;
      }
      throw error;
    }
  }

  async write(profile: string, credentials: DeploymentCredentials): Promise<void> {
    try {
      await this.runner.run(
        "security",
        ["add-generic-password", "-s", SERVICE, "-a", profile, "-U", "-w"],
        JSON.stringify(credentials),
      );
    } catch (error) {
      if (commandNotFound(error)) {
        throw new CredentialBackendUnavailableError(this.name, error);
      }
      throw error;
    }
  }

  async delete(profile: string): Promise<void> {
    try {
      await this.runner.run("security", ["delete-generic-password", "-s", SERVICE, "-a", profile]);
    } catch (error) {
      if (commandNotFound(error)) {
        throw new CredentialBackendUnavailableError(this.name, error);
      }
      if (commandExitCode(error) !== 44) {
        throw error;
      }
    }
  }
}

export class LinuxSecretServiceCredentialBackend implements CredentialBackend {
  readonly name = "Linux Secret Service";

  constructor(private readonly runner: CredentialCommandRunner = new NodeCredentialCommandRunner()) {}

  async read(profile: string): Promise<DeploymentCredentials | null> {
    try {
      const result = await this.runner.run("secret-tool", ["lookup", "service", SERVICE, "profile", profile]);
      return result.stdout.trim() ? parseCredentials(result.stdout.trim()) : null;
    } catch (error) {
      if (commandNotFound(error) || commandExitCode(error) === 1) {
        if (commandNotFound(error)) {
          throw new CredentialBackendUnavailableError(this.name, error);
        }
        return null;
      }
      throw error;
    }
  }

  async write(profile: string, credentials: DeploymentCredentials): Promise<void> {
    try {
      await this.runner.run(
        "secret-tool",
        ["store", "--label", `Moodle MCP (${profile})`, "service", SERVICE, "profile", profile],
        JSON.stringify(credentials),
      );
    } catch (error) {
      if (commandNotFound(error)) {
        throw new CredentialBackendUnavailableError(this.name, error);
      }
      throw error;
    }
  }

  async delete(profile: string): Promise<void> {
    try {
      await this.runner.run("secret-tool", ["clear", "service", SERVICE, "profile", profile]);
    } catch (error) {
      if (commandNotFound(error)) {
        throw new CredentialBackendUnavailableError(this.name, error);
      }
      if (commandExitCode(error) !== 1) {
        throw error;
      }
    }
  }
}

export class UnavailableCredentialBackend implements CredentialBackend {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async read(): Promise<DeploymentCredentials | null> {
    throw new CredentialBackendUnavailableError(this.name);
  }

  async write(): Promise<void> {
    throw new CredentialBackendUnavailableError(this.name);
  }

  async delete(): Promise<void> {
    throw new CredentialBackendUnavailableError(this.name);
  }
}

export class PrivateFileCredentialBackend implements CredentialBackend {
  readonly name = "private credential file";

  constructor(private readonly baseDirectory = join(homedir(), ".config", "moodle-cli", "mcp", "credentials")) {}

  async read(profile: string): Promise<DeploymentCredentials | null> {
    const path = this.path(profile);
    try {
      return parseCredentials(await readFile(path, "utf8"));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async write(profile: string, credentials: DeploymentCredentials): Promise<void> {
    const path = this.path(profile);
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  async delete(profile: string): Promise<void> {
    await rm(this.path(profile), { force: true });
  }

  private path(profile: string): string {
    validateProfile(profile);
    return join(this.baseDirectory, `${profile}.json`);
  }
}

export function createDefaultCredentialStore(options: {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  runner?: CredentialCommandRunner;
} = {}): SafeCredentialStore {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? new NodeCredentialCommandRunner();
  const preferred: CredentialBackend = platform === "darwin"
    ? new MacOSKeychainCredentialBackend(runner)
    : platform === "linux"
      ? new LinuxSecretServiceCredentialBackend(runner)
      : new UnavailableCredentialBackend("Windows Credential Manager");
  const home = options.homeDirectory ?? homedir();
  const fallbackDirectory = platform === "win32"
    ? join(home, "AppData", "Local", "moodle-cli", "credentials")
    : join(home, ".config", "moodle-cli", "mcp", "credentials");
  return new SafeCredentialStore(preferred, new PrivateFileCredentialBackend(fallbackDirectory));
}

function parseCredentials(value: string): DeploymentCredentials {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Stored Moodle MCP credentials are invalid");
  }
  const credentials = parsed as Partial<DeploymentCredentials>;
  if (
    typeof credentials.mcpAccessToken !== "string"
    || typeof credentials.sessionSyncToken !== "string"
    || typeof credentials.sessionEncryptionKey !== "string"
  ) {
    throw new Error("Stored Moodle MCP credentials are invalid");
  }
  return {
    mcpAccessToken: credentials.mcpAccessToken,
    sessionSyncToken: credentials.sessionSyncToken,
    sessionEncryptionKey: credentials.sessionEncryptionKey,
    ...(typeof credentials.previousMcpAccessToken === "string"
      ? { previousMcpAccessToken: credentials.previousMcpAccessToken }
      : {}),
    ...(typeof credentials.previousSessionSyncToken === "string"
      ? { previousSessionSyncToken: credentials.previousSessionSyncToken }
      : {}),
  };
}

function validateProfile(profile: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
    throw new Error("Invalid Moodle MCP profile name");
  }
}

function commandNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function commandExitCode(error: unknown): number | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
    ? error.code
    : null;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
