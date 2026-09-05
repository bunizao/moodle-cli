import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FetchManagedWorkerClient,
  NodeDeploymentCommandRunner,
  NodeReleaseMaterializer,
  NodeWranglerDeploymentAdapter,
  PrivateDeploymentReceiptStore,
  WranglerCommandError,
  createBackgroundMoodleSessionSource,
  createDefaultManagedDeployment,
  resolvePackagedWranglerBin,
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
      previousTokensExpireAt: 1_800_000_000_000,
    });

    expect((await stat(release.artifactDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(release.secretsFilePath)).mode & 0o777).toBe(0o600);
    const config = JSON.parse(await readFile(release.wranglerConfigPath, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      name: PLAN.intent.workerName,
      account_id: PLAN.intent.accountId,
      compatibility_date: "2026-08-09",
      preview_urls: true,
      vars: { MOODLE_ORIGIN: PLAN.intent.moodleOrigin },
    });
    const secrets = await readFile(release.secretsFilePath, "utf8");
    expect(secrets).not.toContain("mcp-raw-token");
    expect(secrets).not.toContain("sync-raw-token");
    expect(secrets).toContain("MCP_ACCESS_TOKEN_PREVIOUS_DIGEST");
    expect(secrets).toContain('"TOKEN_OVERLAP_EXPIRES_AT":"1800000000000"');
    expect(secrets).toContain("encryption-raw-key");

    await materializer.cleanup(release);
    await expect(stat(release.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins an existing deployment to its production and candidate hosts", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-release-host-test-"));
    const bundle = join(root, "worker.js");
    await writeFile(bundle, "export default {};\n");
    const materializer = new NodeReleaseMaterializer({
      workerBundlePath: bundle,
      compatibilityDate: "2026-08-09",
      temporaryRoot: root,
    });
    const release = await materializer.prepare({
      ...PLAN,
      operation: "update",
      existing: {
        accountId: "account-1",
        workerName: "moodle-school-mcp",
        deploymentId: "moodle-cli:account-1:moodle-school-mcp",
        ownershipTag: "moodle-cli:account-1:moodle-school-mcp",
        productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
        productionVersionId: "version-current",
        previousHealthyVersionId: "version-previous",
        releaseDigest: "release-current",
      },
    }, {
      mcpAccessToken: "mcp-raw-token",
      sessionSyncToken: "sync-raw-token",
      sessionEncryptionKey: "encryption-raw-key",
    });

    const config = JSON.parse(await readFile(release.wranglerConfigPath, "utf8")) as {
      vars: Record<string, string>;
    };
    expect(config.vars.EXPECTED_HOSTS).toBe(
      "moodle-school-mcp.demo.workers.dev,moodle-cli-candidate-moodle-school-mcp.demo.workers.dev",
    );
    await materializer.cleanup(release);
  });
});

describe("NodeWranglerDeploymentAdapter", () => {
  it("forwards environment overrides to the child process", async () => {
    const runner = new NodeDeploymentCommandRunner();
    const result = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write(process.env.CLOUDFLARE_ACCOUNT_ID ?? '')"],
      { CLOUDFLARE_ACCOUNT_ID: "account-test" },
    );

    expect(result).toEqual({ stdout: "account-test", stderr: "" });
  });

  it("resolves the executable from the installed Wrangler package", () => {
    expect(resolvePackagedWranglerBin()).toMatch(/node_modules[/\\]wrangler[/\\]bin[/\\]wrangler\.js$/u);
  });

  it("invokes only the packaged Wrangler script and parses candidate metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrangler-candidate-test-"));
    const configPath = join(root, "wrangler.json");
    const runner: DeploymentCommandRunner = {
      run: vi.fn(async (_command, args, environment) => {
        if (args.includes("upload")) {
          const outputFilePath = environment?.WRANGLER_OUTPUT_FILE_PATH;
          if (!outputFilePath) {
            throw new Error("Missing Wrangler output path");
          }
          await writeFile(outputFilePath, [
            "not-json",
            JSON.stringify({ type: "build", version: 1 }),
            JSON.stringify({
              type: "version-upload",
              version: 1,
              worker_name: "moodle-school-mcp",
              version_id: "version-next",
              preview_url: "https://version-next-moodle-school-mcp.demo.workers.dev",
              preview_alias_url: "https://moodle-cli-candidate-moodle-school-mcp.demo.workers.dev",
            }),
          ].join("\n"));
          return {
            stdout: "Uploaded Worker Version version-next",
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
      configPath,
      releaseDigest: "release-next",
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
    });
    expect(candidate).toEqual({
      versionId: "version-next",
      previewEndpoint: "https://moodle-cli-candidate-moodle-school-mcp.demo.workers.dev",
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
      deploymentId: "moodle-cli:account-1:moodle-school-mcp",
    });
    expect(runner.run).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        "/package/node_modules/wrangler/bin/wrangler.js",
        "versions",
        "upload",
        "--message",
        "moodle-cli-release:release-next",
      ]),
      {
        CLOUDFLARE_ACCOUNT_ID: "account-1",
        WRANGLER_OUTPUT_FILE_PATH: join(root, "wrangler-version-upload.jsonl"),
      },
    );
    const uploadArgs = vi.mocked(runner.run).mock.calls[0]?.[1] ?? [];
    expect(uploadArgs).not.toContain("--account-id");
    expect(uploadArgs).not.toContain("--json");
    await expect(stat(join(root, "wrangler-version-upload.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(vi.mocked(runner.run).mock.calls)).not.toMatch(/Bearer|mcp-raw-token/);
  });

  it("accepts version uploads without preview URLs for Durable Object Workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrangler-no-preview-test-"));
    const configPath = join(root, "wrangler.json");
    const runner: DeploymentCommandRunner = {
      run: vi.fn(async (_command, args, environment) => {
        if (args.includes("upload")) {
          const outputFilePath = environment?.WRANGLER_OUTPUT_FILE_PATH;
          if (!outputFilePath) throw new Error("Missing Wrangler output path");
          await writeFile(outputFilePath, `${JSON.stringify({
            type: "version-upload",
            version: 1,
            worker_name: "moodle-school-mcp",
            version_id: "version-next",
          })}\n`);
        }
        return { stdout: "Uploaded Worker Version version-next", stderr: "" };
      }),
    };
    const adapter = new NodeWranglerDeploymentAdapter({
      wranglerBinPath: "/package/node_modules/wrangler/bin/wrangler.js",
      runner,
    });

    await expect(adapter.uploadCandidate({
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      configPath,
      releaseDigest: "release-next",
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
    })).resolves.toEqual({
      versionId: "version-next",
      previewEndpoint: null,
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
      deploymentId: "moodle-cli:account-1:moodle-school-mcp",
    });
  });

  it("uses a non-versioned deploy to apply first-release migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrangler-bootstrap-test-"));
    const configPath = join(root, "wrangler.json");
    await writeFile(configPath, JSON.stringify({ vars: { MOODLE_ORIGIN: "https://moodle.example.edu" } }));
    const runner: DeploymentCommandRunner = {
      run: vi.fn(async (_command, args) => args.includes("deployments")
        ? {
            stdout: JSON.stringify([{
              id: "deployment-1",
              versions: [{ version_id: "version-bootstrap", percentage: 100 }],
            }]),
            stderr: "",
          }
        : {
            stdout: "Deployed\nhttps://moodle-school-mcp.demo.workers.dev\n",
            stderr: "",
          }),
    };
    const adapter = new NodeWranglerDeploymentAdapter({
      wranglerBinPath: "/package/node_modules/wrangler/bin/wrangler.js",
      runner,
    });

    await expect(adapter.initializeWorker({
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      configPath,
      releaseDigest: "release-next",
    })).resolves.toMatchObject({
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
    });

    expect(runner.run).toHaveBeenCalledWith(
      process.execPath,
      [
        "/package/node_modules/wrangler/bin/wrangler.js",
        "deploy",
        "--name",
        "moodle-school-mcp",
        "--config",
        configPath,
        "--message",
        "moodle-cli-bootstrap:release-next",
      ],
      { CLOUDFLARE_ACCOUNT_ID: "account-1" },
    );
    const config = JSON.parse(await readFile(configPath, "utf8")) as { vars: Record<string, string> };
    expect(config.vars.EXPECTED_HOSTS).toBe(
      "moodle-school-mcp.demo.workers.dev,moodle-cli-candidate-moodle-school-mcp.demo.workers.dev",
    );
  });

  it("removes a partially created Worker when bootstrap deployment fails", async () => {
    let workerExists = true;
    const runner: DeploymentCommandRunner = {
      run: vi.fn(async (_command, args) => {
        if (args.includes("deploy")) {
          throw new WranglerCommandError(1, "", "Authentication error");
        }
        if (args.includes("deployments")) {
          return workerExists
            ? {
                stdout: JSON.stringify([{
                  id: "deployment-1",
                  versions: [{ version_id: "version-bootstrap", percentage: 100 }],
                }]),
                stderr: "",
              }
            : Promise.reject(new WranglerCommandError(1, "", "Worker not found"));
        }
        if (args.includes("delete")) {
          workerExists = false;
          return { stdout: "Deleted", stderr: "" };
        }
        throw new Error("Unexpected Wrangler command");
      }),
    };
    const adapter = new NodeWranglerDeploymentAdapter({
      wranglerBinPath: "/package/node_modules/wrangler/bin/wrangler.js",
      runner,
    });

    await expect(adapter.initializeWorker({
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      configPath: "/private/release/wrangler.json",
      releaseDigest: "release-next",
    })).rejects.toBeInstanceOf(WranglerCommandError);
    expect(workerExists).toBe(false);
    expect(runner.run).toHaveBeenCalledWith(
      process.execPath,
      ["/package/node_modules/wrangler/bin/wrangler.js", "delete", "moodle-school-mcp", "--force"],
      { CLOUDFLARE_ACCOUNT_ID: "account-1" },
    );
  });

  it("selects the account through the environment for every mutating command", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrangler-mutations-test-"));
    const configPath = join(root, "wrangler.json");
    await writeFile(configPath, JSON.stringify({ vars: { MOODLE_ORIGIN: "https://moodle.example.edu" } }));
    const runner: DeploymentCommandRunner = {
      run: vi.fn(async (_command, args, environment) => {
        if (args.includes("deployments")) {
          return {
            stdout: JSON.stringify([{
              id: "deployment-1",
              url: "https://moodle-school-mcp.demo.workers.dev",
              versions: [{ version_id: "version-bootstrap", percentage: 100 }],
            }]),
            stderr: "",
          };
        }
        if (args.includes("upload")) {
          const outputFilePath = environment?.WRANGLER_OUTPUT_FILE_PATH;
          if (!outputFilePath) {
            throw new Error("Missing Wrangler output path");
          }
          await writeFile(outputFilePath, `${JSON.stringify({
            type: "version-upload",
            version: 1,
            worker_name: "moodle-school-mcp",
            version_id: "version-next",
            preview_url: "https://version-next-moodle-school-mcp.demo.workers.dev",
          })}\n`);
        }
        return { stdout: "{}", stderr: "" };
      }),
    };
    const adapter = new NodeWranglerDeploymentAdapter({ wranglerBinPath: "/package/wrangler.js", runner });

    await adapter.uploadSecrets({
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      configPath: "/private/release/wrangler.json",
      secretsFilePath: "/private/release/secrets.json",
    });
    await adapter.initializeWorker({
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      configPath,
      releaseDigest: "release-next",
    });
    await adapter.uploadCandidate({
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      configPath,
      releaseDigest: "release-next",
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
    });
    await adapter.promote({ accountId: "account-1", workerName: "moodle-school-mcp", versionId: "version-next", releaseDigest: "release-next" });
    expect(vi.mocked(runner.run).mock.calls.at(-1)?.[1]).toEqual([
      "/package/wrangler.js", "versions", "deploy", "version-next@100", "--name", "moodle-school-mcp", "--yes",
      "--message", "moodle-cli-release:release-next",
    ]);
    await adapter.restoreProduction({ accountId: "account-1", workerName: "moodle-school-mcp", previousVersionId: null });
    await adapter.removeWorker({
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      deploymentId: "moodle-cli:account-1:moodle-school-mcp",
    });

    for (const call of vi.mocked(runner.run).mock.calls) {
      expect(call[1]).not.toContain("--account-id");
      expect(call[2]).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: "account-1" });
    }
    const uploadCall = vi.mocked(runner.run).mock.calls.find((call) => call[1].includes("upload"));
    expect(uploadCall?.[1]).not.toContain("--json");
    expect(uploadCall?.[2]).toMatchObject({
      WRANGLER_OUTPUT_FILE_PATH: join(root, "wrangler-version-upload.jsonl"),
    });
    const deleteCalls = vi.mocked(runner.run).mock.calls.filter((call) => call[1].includes("delete"));
    expect(deleteCalls).toHaveLength(2);
    for (const call of deleteCalls) {
      expect(call[1]).toEqual(["/package/wrangler.js", "delete", "moodle-school-mcp", "--force"]);
      expect(call[1]).not.toContain("--name");
    }
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
          stdout: JSON.stringify(DEPLOYMENT_HISTORY),
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
    expect(runner.run).toHaveBeenCalledWith(process.execPath, ["/package/wrangler.js", "login"], undefined);
    await expect(adapter.inspect("account-1", "moodle-school-mcp")).resolves.toMatchObject({
      releaseDigest: "release-next",
      productionEndpoint: "https://moodle-school-mcp.demo.workers.dev",
      productionVersionId: "version-current",
      previousHealthyVersionId: "version-previous",
    });
    expect(runner.run).toHaveBeenLastCalledWith(
      process.execPath,
      ["/package/wrangler.js", "deployments", "list", "--name", "moodle-school-mcp", "--json"],
      { CLOUDFLARE_ACCOUNT_ID: "account-1" },
    );
    expect(vi.mocked(runner.run).mock.calls.flatMap((call) => call[1])).not.toContain("--account-id");
  });
});

// Wrangler lists deployments oldest-first; the release annotation is per deployment.
const DEPLOYMENT_HISTORY = [
  {
    id: "deployment-1",
    created_on: "2026-09-05T05:26:46.035769Z",
    url: "https://moodle-school-mcp.demo.workers.dev",
    annotations: { "workers/message": "moodle-cli-release:release-old", "workers/triggered_by": "upload" },
    versions: [{ version_id: "version-old", percentage: 100 }],
  },
  {
    id: "deployment-2",
    created_on: "2026-09-05T14:08:55.229301Z",
    annotations: { "workers/triggered_by": "secret" },
    versions: [{ version_id: "version-previous", percentage: 100 }],
  },
  {
    id: "deployment-3",
    created_on: "2026-09-05T14:09:01.816567Z",
    annotations: { "workers/message": "moodle-cli-release:release-next", "workers/triggered_by": "deployment" },
    versions: [{ version_id: "version-current", percentage: 100 }],
  },
];

describe("NodeWranglerDeploymentAdapter inspect ordering", () => {
  function inspectAdapter(deployments: unknown[]) {
    const runner = { run: vi.fn(async () => ({ stdout: JSON.stringify(deployments), stderr: "" })) };
    return new NodeWranglerDeploymentAdapter({ wranglerBinPath: "/package/wrangler.js", runner });
  }

  it("treats the newest deployment as production and the one before it as the rollback target", async () => {
    await expect(inspectAdapter(DEPLOYMENT_HISTORY).inspect("account-1", "moodle-school-mcp")).resolves.toMatchObject({
      productionVersionId: "version-current",
      previousHealthyVersionId: "version-previous",
      releaseDigest: "release-next",
    });
  });

  it("does not borrow an older deployment's release digest", async () => {
    const history = [DEPLOYMENT_HISTORY[0], DEPLOYMENT_HISTORY[2], {
      id: "deployment-4",
      created_on: "2026-09-06T00:00:00.000000Z",
      annotations: { "workers/triggered_by": "secret" },
      versions: [{ version_id: "version-secret", percentage: 100 }],
    }];
    await expect(inspectAdapter(history).inspect("account-1", "moodle-school-mcp")).resolves.toMatchObject({
      productionVersionId: "version-secret",
      previousHealthyVersionId: "version-current",
      releaseDigest: "",
    });
  });

  it("falls back to list order when deployments carry no timestamps", async () => {
    const history = DEPLOYMENT_HISTORY.map(({ created_on: _createdOn, ...entry }) => entry);
    await expect(inspectAdapter(history).inspect("account-1", "moodle-school-mcp")).resolves.toMatchObject({
      productionVersionId: "version-current",
      previousHealthyVersionId: "version-previous",
    });
  });
});

describe("FetchManagedWorkerClient", () => {
  it("retries transient Worker propagation failures before uploading the session", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(Response.json({ code: "INVALID_BEARER_TOKEN" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ code: "MOODLE_UNREACHABLE" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ revision: 1 }, { status: 201 }));
    const sleep = vi.fn(async () => undefined);
    const client = new FetchManagedWorkerClient(fetchImpl as unknown as typeof fetch, sleep);

    await expect(client.putSession({
      endpoint: "https://worker.example",
      sessionSyncToken: "sync-token",
      expectedRevision: null,
      session: {
        moodleOrigin: "https://moodle.example.edu",
        cookieName: "MoodleSession",
        cookieValue: "private-cookie",
        fingerprint: "fingerprint",
        remoteRevision: null,
      },
    })).resolves.toEqual({ revision: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(3, 2_000);
  });

  it("retains readiness reason codes and remote revisions", async () => {
    const structured = new FetchManagedWorkerClient(vi.fn(async () => Response.json({
      status: "warn",
      checks: {
        "moodle:session": [{ status: "warn", code: "SESSION_EXPIRING", revision: 12 }],
        "moodle:upstream": [{ status: "pass", code: "MOODLE_REACHABLE" }],
      },
    })) as unknown as typeof fetch);
    const legacy = new FetchManagedWorkerClient(vi.fn(async () => Response.json({ status: "pass" })) as unknown as typeof fetch);

    await expect(structured.getReadiness({ endpoint: "https://worker.example", sessionSyncToken: "sync-token" }))
      .resolves.toEqual({ status: "warn", reasonCode: "SESSION_EXPIRING", revision: 12 });
    await expect(legacy.getReadiness({ endpoint: "https://worker.example", sessionSyncToken: "sync-token" }))
      .resolves.toEqual({ status: "pass", reasonCode: null, revision: null });
  });

  it("retries transient route propagation during release smoke checks", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(Response.json({ status: "pass" }))
      .mockResolvedValueOnce(Response.json({ status: "pass" }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: {} }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [] } }))
      .mockResolvedValueOnce(Response.json({
        jsonrpc: "2.0",
        id: 3,
        result: { structuredContent: { user: { fullname: "Alice Example" } } },
      }));
    const sleep = vi.fn(async () => undefined);
    const client = new FetchManagedWorkerClient(fetchImpl as unknown as typeof fetch, sleep);

    await expect(client.runSmoke({
      endpoint: "https://worker.example",
      mcpAccessToken: "mcp-token",
      sessionSyncToken: "sync-token",
    })).resolves.toEqual({ moodleUser: "Alice Example" });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledWith(500);
  });

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
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "tools/call"
          ? { structuredContent: { user: { fullname: "Alice Example" } } }
          : {},
      });
    });
    const client = new FetchManagedWorkerClient(fetchImpl as unknown as typeof fetch);
    await expect(client.putSession({
      endpoint: "https://worker.example",
      sessionSyncToken: "sync-token",
      expectedRevision: null,
      session: {
        moodleOrigin: "https://moodle.example.edu",
        cookieName: "MoodleSession",
        cookieValue: "private-cookie",
        fingerprint: "fingerprint",
        remoteRevision: null,
      },
    })).resolves.toEqual({ revision: 8 });
    await expect(client.runSmoke({
      endpoint: "https://worker.example",
      mcpAccessToken: "mcp-token",
      sessionSyncToken: "sync-token",
    })).resolves.toEqual({ moodleUser: "Alice Example" });

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
      expectedRevision: null,
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
      "io.modelcontextprotocol/clientInfo": { name: "moodle-cli-deployment-smoke", version: "0.7.0-alpha.6" },
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
  it("persists non-secret receipts with private modes", async () => {
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
