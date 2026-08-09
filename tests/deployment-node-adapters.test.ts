import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultCredentialStore } from "../src/mcp/credentials/index.js";
import {
  FetchManagedWorkerClient,
  NodeReleaseMaterializer,
  NodeWranglerDeploymentAdapter,
  PrivateDeploymentReceiptStore,
  createBackgroundMoodleSessionSource,
  createDefaultManagedDeployment,
  type DeploymentCommandRunner,
  type DeploymentPlan,
  type DeploymentReceipt,
} from "../src/mcp/deployment/index.js";

const PLAN: DeploymentPlan = {
  intent: {
    profile: "school",
    accountId: "account-1",
    workerName: "moodle-school-mcp",
    moodleOrigin: "https://moodle.example.edu/",
    releaseDigest: "release-next",
  },
  operation: "create",
  uploadCandidate: true,
  existing: null,
  receipt: null,
};

describe("NodeReleaseMaterializer", () => {
  it("creates private config and secret files and removes the whole directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-release-test-"));
    const bundle = join(root, "worker.js");
    await writeFile(bundle, "export default {};\n");
    const materializer = new NodeReleaseMaterializer({
      workerBundlePath: bundle,
      compatibilityDate: "2026-08-09",
      temporaryRoot: root,
    });
    const release = await materializer.prepare(PLAN, {
      mcpAccessToken: "mcp-raw-token",
      sessionSyncToken: "sync-raw-token",
      sessionEncryptionKey: "encryption-raw-key",
      previousMcpAccessToken: "mcp-previous",
      previousSessionSyncToken: "sync-previous",
    });

    expect((await stat(release.artifactDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(release.secretsFilePath)).mode & 0o777).toBe(0o600);
    const config = JSON.parse(await readFile(release.wranglerConfigPath, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      name: PLAN.intent.workerName,
      compatibility_date: "2026-08-09",
      vars: { MOODLE_ORIGIN: PLAN.intent.moodleOrigin },
    });
    const secrets = await readFile(release.secretsFilePath, "utf8");
    expect(secrets).not.toContain("mcp-raw-token");
    expect(secrets).not.toContain("sync-raw-token");
    expect(secrets).toContain("MCP_ACCESS_TOKEN_PREVIOUS_DIGEST");
    expect(secrets).toContain("encryption-raw-key");

    await materializer.cleanup(release);
    await expect(stat(release.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("NodeWranglerDeploymentAdapter", () => {
  it("invokes only the packaged Wrangler script and parses candidate metadata", async () => {
    const runner: DeploymentCommandRunner = {
      run: vi.fn(async (_command, args) => {
        if (args.includes("upload")) {
          return {
            stdout: JSON.stringify({
              id: "version-next",
              preview_url: "https://moodle-cli-candidate-moodle-school-mcp.demo.workers.dev",
            }),
            stderr: "",
          };
        }
        return { stdout: "{}", stderr: "" };
      }),
    };
    const adapter = new NodeWranglerDeploymentAdapter({
      wranglerBinPath: "/package/node_modules/wrangler/bin/wrangler.js",
      runner,
    });

    const candidate = await adapter.uploadCandidate({
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      configPath: "/private/release/wrangler.json",
      releaseDigest: "release-next",
    });
    expect(candidate).toEqual({
      versionId: "version-next",
      previewEndpoint: "https://moodle-cli-candidate-moodle-school-mcp.demo.workers.dev",
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
      deploymentId: "moodle-cli:account-1:moodle-school-mcp",
    });
    expect(runner.run).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([
      "/package/node_modules/wrangler/bin/wrangler.js",
      "versions",
      "upload",
      "--message",
      "moodle-cli-release:release-next",
    ]));
    expect(JSON.stringify(vi.mocked(runner.run).mock.calls)).not.toMatch(/Bearer|mcp-raw-token/);
  });

  it("discovers named accounts and reads release metadata for repeated deployment planning", async () => {
    const runner: DeploymentCommandRunner = {
      run: vi.fn(async (_command, args) => {
        if (args.includes("whoami")) {
          return {
            stdout: JSON.stringify({ accounts: [
              { id: "account-1", name: "Personal" },
              { id: "account-2", name: "TuuHub" },
            ] }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify([{
            id: "deployment-1",
            url: "https://moodle-school-mcp.demo.workers.dev",
            message: "moodle-cli-release:release-next",
            versions: [
              { version_id: "version-current", percentage: 100 },
              { version_id: "version-previous", percentage: 0 },
            ],
          }]),
          stderr: "",
        };
      }),
    };
    const adapter = new NodeWranglerDeploymentAdapter({ wranglerBinPath: "/package/wrangler.js", runner });

    await expect(adapter.listAccounts()).resolves.toEqual([
      { id: "account-1", name: "Personal" },
      { id: "account-2", name: "TuuHub" },
    ]);
    await adapter.login();
    expect(runner.run).toHaveBeenCalledWith(process.execPath, ["/package/wrangler.js", "login"]);
    await expect(adapter.inspect("account-1", "moodle-school-mcp")).resolves.toMatchObject({
      releaseDigest: "release-next",
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
      productionVersionId: "version-current",
    });
  });
});

describe("FetchManagedWorkerClient", () => {
  it("uses the approved CAS session endpoint and full release smoke matrix", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/session")) {
        return Response.json({ status: "accepted", revision: 8 }, { status: 201 });
      }
      if (url.endsWith("/healthz")) {
        return Response.json({ status: "pass" });
      }
      if (url.endsWith("/readyz")) {
        return Response.json({ status: "pass" });
      }
      const request = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: {} });
    });
    const client = new FetchManagedWorkerClient(fetchImpl as unknown as typeof fetch);
    await expect(client.putSession({
      endpoint: "https://worker.example",
      sessionSyncToken: "sync-token",
      expectedRevision: 7,
      session: {
        moodleOrigin: "https://moodle.example.edu",
        cookieName: "MoodleSession",
        cookieValue: "private-cookie",
        fingerprint: "fingerprint",
        remoteRevision: 7,
      },
    })).resolves.toEqual({ revision: 8 });
    await client.runSmoke({
      endpoint: "https://worker.example",
      mcpAccessToken: "mcp-token",
      sessionSyncToken: "sync-token",
    });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/session",
      "/healthz",
      "/readyz",
      "/mcp",
      "/mcp",
      "/mcp",
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      moodleOrigin: "https://moodle.example.edu",
      cookieName: "MoodleSession",
      cookieValue: "private-cookie",
      expectedRevision: 7,
    });
    const methods = requests.slice(3).map((request) => JSON.parse(String(request.init?.body)).method);
    expect(methods).toEqual(["server/discover", "tools/list", "tools/call"]);
    expect(new Headers(requests[3]?.init?.headers).get("mcp-method")).toBe("server/discover");
    expect(new Headers(requests[3]?.init?.headers).get("mcp-name")).toBeNull();
    expect(new Headers(requests[5]?.init?.headers).get("mcp-method")).toBe("tools/call");
    expect(new Headers(requests[5]?.init?.headers).get("mcp-name")).toBe("get_user");
    const metadata = JSON.parse(String(requests[3]?.init?.body)).params._meta as Record<string, unknown>;
    expect(metadata).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "moodle-cli-deployment-smoke", version: "0.7.0" },
    });
  });
});

describe("background Moodle session source", () => {
  it("uses cache, browser cookies, and Okta without opening an interactive browser", async () => {
    const openBrowser = vi.fn(async () => undefined);
    const source = createBackgroundMoodleSessionSource({
      noCache: true,
      openBrowser,
      browserCookieProvider: async () => [],
      oktaCookieProvider: async () => [],
    });

    await expect(source.loadValidated("school", "https://moodle.example.edu"))
      .rejects.toThrow("No usable MoodleSession");
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

describe("private Node state adapters", () => {
  it("persists non-secret receipts and Windows fallback credentials with private modes", async () => {
    const home = await mkdtemp(join(tmpdir(), "moodle-state-test-"));
    const receiptStore = new PrivateDeploymentReceiptStore(join(home, "receipts"));
    const receipt: DeploymentReceipt = {
      profile: "school",
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      moodleOrigin: "https://moodle.example.edu/",
      deploymentId: "deployment-1",
      productionEndpoint: "https://worker.example",
      productionVersionId: "version-1",
      releaseDigest: "digest",
      sessionRevision: 3,
    };
    await receiptStore.write(receipt);
    await expect(receiptStore.read("school")).resolves.toEqual(receipt);
    expect(JSON.stringify(await receiptStore.read("school"))).not.toMatch(/cookie|AccessToken|SyncToken/);

    const credentials = createDefaultCredentialStore({ platform: "win32", homeDirectory: home });
    await credentials.write("school", {
      mcpAccessToken: "mcp-token",
      sessionSyncToken: "sync-token",
      sessionEncryptionKey: "encryption-key",
    });
    await expect(credentials.read("school")).resolves.toMatchObject({ mcpAccessToken: "mcp-token" });
    const credentialPath = join(home, "AppData", "Local", "moodle-cli", "credentials", "school.json");
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  it("exposes one default factory while allowing focused adapter replacement", () => {
    const manager = createDefaultManagedDeployment({
      workerBundlePath: "/package/dist/worker.js",
      compatibilityDate: "2026-08-09",
      wranglerBinPath: "/package/node_modules/wrangler/bin/wrangler.js",
      platform: "linux",
      dependencies: {
        createToken: () => "test-token",
      },
    });
    expect(manager).toBeDefined();
  });
});
