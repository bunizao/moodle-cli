import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialBackendUnavailableError,
  MacOSKeychainCredentialBackend,
  NodeCredentialCommandRunner,
  SafeCredentialStore,
  WindowsCredentialManagerBackend,
  WindowsDpapiFileCredentialBackend,
  createDefaultCredentialStore,
  rotateCredentials,
  type CredentialCommandRunner,
  type CredentialBackend,
  type DeploymentCredentials,
} from "../src/mcp/credentials/index.js";

const CREDENTIALS: DeploymentCredentials = {
  mcpAccessToken: "mcp-current",
  sessionSyncToken: "sync-current",
  sessionEncryptionKey: "encryption-current",
  previousMcpAccessToken: "mcp-previous",
  previousSessionSyncToken: "sync-previous",
  previousTokensExpireAt: 1_800_000_000_000,
};
const CREDENTIAL_SECRETS = [
  CREDENTIALS.mcpAccessToken,
  CREDENTIALS.sessionSyncToken,
  CREDENTIALS.sessionEncryptionKey,
  CREDENTIALS.previousMcpAccessToken!,
  CREDENTIALS.previousSessionSyncToken!,
];

function backend(overrides: Partial<CredentialBackend> = {}): CredentialBackend {
  return {
    name: "store",
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("SafeCredentialStore", () => {
  it("uses the OS store and clears a stale fallback after a successful write", async () => {
    const preferred = backend();
    const fallback = backend();
    const store = new SafeCredentialStore(preferred, fallback);

    await store.write("school", CREDENTIALS);

    expect(preferred.write).toHaveBeenCalledWith("school", CREDENTIALS);
    expect(fallback.write).not.toHaveBeenCalled();
    expect(fallback.delete).toHaveBeenCalledWith("school");
  });

  it("falls back only when the preferred backend is explicitly unavailable", async () => {
    const preferred = backend({
      write: vi.fn(async () => {
        throw new CredentialBackendUnavailableError("keychain");
      }),
    });
    const fallback = backend();
    const store = new SafeCredentialStore(preferred, fallback);

    await store.write("school", CREDENTIALS);
    expect(fallback.write).toHaveBeenCalledWith("school", CREDENTIALS);

    const permissionError = new Error("permission denied");
    const unsafeStore = new SafeCredentialStore(backend({ write: vi.fn(async () => { throw permissionError; }) }), fallback);
    await expect(unsafeStore.write("school", CREDENTIALS)).rejects.toBe(permissionError);
  });

  it("can read an existing fallback value without hiding preferred-store failures", async () => {
    const fallback = backend({ read: vi.fn(async () => CREDENTIALS) });
    await expect(new SafeCredentialStore(backend(), fallback).read("school")).resolves.toEqual(CREDENTIALS);

    const corrupt = new Error("corrupt keychain entry");
    const preferred = backend({ read: vi.fn(async () => { throw corrupt; }) });
    await expect(new SafeCredentialStore(preferred, fallback).read("school")).rejects.toBe(corrupt);
  });

  it("deletes both stores while ignoring unavailable backends", async () => {
    const preferred = backend({ delete: vi.fn(async () => { throw new CredentialBackendUnavailableError("keychain"); }) });
    const fallback = backend();
    await new SafeCredentialStore(preferred, fallback).delete("school");
    expect(fallback.delete).toHaveBeenCalledWith("school");
  });
});

describe("MacOSKeychainCredentialBackend", () => {
  it("writes credentials through Security.framework without command-line secrets", async () => {
    const runner: CredentialCommandRunner = {
      run: vi.fn(async () => ({ stdout: "" })),
    };
    const store = new MacOSKeychainCredentialBackend(runner);

    await store.write("school", CREDENTIALS);

    expect(runner.run).toHaveBeenCalledOnce();
    const [command, args, input] = vi.mocked(runner.run).mock.calls[0]!;
    expect(command).toBe("osascript");
    expect(args.join(" ")).toContain("SecItemUpdate");
    expect(args.join(" ")).toContain("SecItemAdd");
    for (const secret of CREDENTIAL_SECRETS) expect(JSON.stringify(args)).not.toContain(secret);
    expect(JSON.parse(input ?? "")).toEqual({
      operation: "write",
      service: "moodle-cli-mcp",
      profile: "school",
      credentials: JSON.stringify(CREDENTIALS),
    });
  });

  it("treats the empty entries written by alpha.2 as missing", async () => {
    const runner: CredentialCommandRunner = {
      run: vi.fn(async () => ({ stdout: "\n" })),
    };
    const store = new MacOSKeychainCredentialBackend(runner);

    await expect(store.read("school")).resolves.toBeNull();
  });
});

describe("WindowsCredentialManagerBackend", () => {
  it("sends credentials to PowerShell over stdin instead of command arguments", async () => {
    const runner: CredentialCommandRunner = {
      run: vi.fn(async () => ({ stdout: "" })),
    };
    const store = new WindowsCredentialManagerBackend(runner);

    await store.write("school", CREDENTIALS);

    expect(runner.run).toHaveBeenCalledOnce();
    const [command, args, input] = vi.mocked(runner.run).mock.calls[0]!;
    expect(command).toBe("powershell.exe");
    expect(args.join(" ")).toContain("[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)");
    expect(args.join(" ")).toContain("Windows.Security.Credentials,ContentType=WindowsRuntime");
    expect(args.join(" ")).toContain("New-Object -TypeName Windows.Security.Credentials.PasswordCredential -ArgumentList");
    for (const secret of CREDENTIAL_SECRETS) expect(JSON.stringify(args)).not.toContain(secret);
    expect(JSON.parse(input ?? "")).toEqual({
      service: "moodle-cli-mcp",
      profile: "school",
      credentials: JSON.stringify(CREDENTIALS),
    });
  });
});

describe("WindowsDpapiFileCredentialBackend", () => {
  it("protects fallback credentials for the current user without command-line secrets", async () => {
    const runner: CredentialCommandRunner = {
      run: vi.fn(async () => ({ stdout: "" })),
    };
    const store = new WindowsDpapiFileCredentialBackend("C:\\Users\\张三\\moodle-cli", runner);

    await store.write("school", CREDENTIALS);

    const [command, args, input] = vi.mocked(runner.run).mock.calls[0]!;
    expect(command).toBe("powershell.exe");
    expect(args.join(" ")).toContain("[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)");
    expect(args.join(" ")).toContain("Add-Type -AssemblyName System.Security");
    expect(args.join(" ")).toContain("[System.Security.Cryptography.ProtectedData]::Protect");
    for (const secret of CREDENTIAL_SECRETS) expect(JSON.stringify(args)).not.toContain(secret);
    expect(JSON.parse(input ?? "")).toEqual({
      path: "C:\\Users\\张三\\moodle-cli\\school.bin",
      credentials: JSON.stringify(CREDENTIALS),
    });
  });

  it("is the user-protected fallback when Credential Manager is unavailable", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "moodle-windows-credentials-"));
    let invocation = 0;
    const runner: CredentialCommandRunner = {
      run: vi.fn(async () => {
        invocation += 1;
        if (invocation === 1 || invocation === 3) throw new Error("Credential Manager unavailable");
        return { stdout: invocation === 4 ? JSON.stringify(CREDENTIALS) : "" };
      }),
    };
    const store = createDefaultCredentialStore({ platform: "win32", homeDirectory, runner });

    await store.write("school", CREDENTIALS);
    await expect(store.read("school")).resolves.toEqual(CREDENTIALS);

    expect(runner.run).toHaveBeenCalledTimes(4);
    for (const [, args] of vi.mocked(runner.run).mock.calls) {
      for (const secret of CREDENTIAL_SECRETS) expect(JSON.stringify(args)).not.toContain(secret);
    }
    const fallbackWrite = JSON.parse(vi.mocked(runner.run).mock.calls[1]?.[2] ?? "") as { path: string };
    expect(fallbackWrite.path).toMatch(/AppData\\Local\\moodle-cli\\credentials\\school\.bin$/u);
  });
});

it.runIf(process.platform === "win32")("round-trips credentials through Windows protected stores", async () => {
  const profile = `test-${randomUUID()}`;
  const fallbackDirectory = await mkdtemp(join(tmpdir(), "moodle-dpapi-roundtrip-"));
  const credentialManager = new WindowsCredentialManagerBackend();
  const dpapi = new WindowsDpapiFileCredentialBackend(fallbackDirectory);

  try {
    await credentialManager.write(profile, CREDENTIALS);
    await expect(credentialManager.read(profile)).resolves.toEqual(CREDENTIALS);
    await dpapi.write(profile, CREDENTIALS);
    await expect(dpapi.read(profile)).resolves.toEqual(CREDENTIALS);
  } finally {
    await Promise.allSettled([credentialManager.delete(profile), dpapi.delete(profile)]);
    await rm(fallbackDirectory, { recursive: true, force: true });
  }
}, 30_000);

it.runIf(process.platform === "darwin")("round-trips credentials through the macOS Keychain", async () => {
  const profile = `test-${randomUUID()}`;
  const keychain = new MacOSKeychainCredentialBackend();

  try {
    await keychain.write(profile, CREDENTIALS);
    await expect(keychain.read(profile)).resolves.toEqual(CREDENTIALS);
  } finally {
    await keychain.delete(profile);
  }
}, 30_000);

it.runIf(process.platform === "darwin")("recovers an empty macOS Keychain entry created by alpha.2", async () => {
  const profile = `test-${randomUUID()}`;
  const runner = new NodeCredentialCommandRunner();
  const keychain = new MacOSKeychainCredentialBackend(runner);

  try {
    await runner.run(
      "security",
      ["add-generic-password", "-s", "moodle-cli-mcp", "-a", profile, "-U", "-w"],
      "ignored",
    );
    await expect(keychain.read(profile)).resolves.toBeNull();
    await keychain.write(profile, CREDENTIALS);
    await keychain.delete(profile);
    await expect(keychain.read(profile)).resolves.toBeNull();
  } finally {
    await runner.run("security", ["delete-generic-password", "-s", "moodle-cli-mcp", "-a", profile]).catch(() => undefined);
  }
}, 30_000);

describe("rotateCredentials", () => {
  it("retains the current pair for a two-token overlap window", () => {
    const tokens = ["mcp-next", "sync-next"];
    expect(rotateCredentials(CREDENTIALS, () => tokens.shift() ?? "missing", () => 1_000)).toEqual({
      mcpAccessToken: "mcp-next",
      sessionSyncToken: "sync-next",
      sessionEncryptionKey: "encryption-current",
      previousMcpAccessToken: "mcp-current",
      previousSessionSyncToken: "sync-current",
      previousTokensExpireAt: 601_000,
    });
  });
});
