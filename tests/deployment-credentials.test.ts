import { describe, expect, it, vi } from "vitest";
import {
  CredentialBackendUnavailableError,
  SafeCredentialStore,
  rotateCredentials,
  type CredentialBackend,
  type DeploymentCredentials,
} from "../src/mcp/credentials/index.js";

const CREDENTIALS: DeploymentCredentials = {
  mcpAccessToken: "mcp-current",
  sessionSyncToken: "sync-current",
  sessionEncryptionKey: "encryption-current",
};

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

describe("rotateCredentials", () => {
  it("retains the current pair for a two-token overlap window", () => {
    const tokens = ["mcp-next", "sync-next"];
    expect(rotateCredentials(CREDENTIALS, () => tokens.shift() ?? "missing")).toEqual({
      mcpAccessToken: "mcp-next",
      sessionSyncToken: "sync-next",
      sessionEncryptionKey: "encryption-current",
      previousMcpAccessToken: "mcp-current",
      previousSessionSyncToken: "sync-current",
    });
  });
});
