import { describe, expect, it, vi } from "vitest";
import {
  DeploymentApplyError,
  DeploymentPlanError,
  HOST_MIGRATION_TAG,
  ManagedMcpDeployment,
  applyHostedInstall,
  planHostedInstall,
  type DeploymentEvent,
  type DeploymentReceipt,
  type HostedInstallIntent,
  type HostedInstallResult,
  type ManagedMcpDeploymentDependencies,
} from "../src/mcp/deployment/index.js";

const INTENT: HostedInstallIntent = {
  profile: "school",
  accountId: "account-1",
  hostWorker: "unicorn",
  hostUrl: "https://unicorn.example.workers.dev",
  basePath: "/moodle",
  moodleOrigin: "https://moodle.example.edu",
  releaseDigest: "release-next",
};

const HOSTED_RECEIPT: DeploymentReceipt = {
  profile: "school",
  accountId: "account-1",
  workerName: "unicorn",
  moodleOrigin: INTENT.moodleOrigin,
  deploymentId: "moodle-cli-host:account-1:unicorn/moodle",
  productionEndpoint: "https://unicorn.example.workers.dev/moodle",
  productionVersionId: "",
  releaseDigest: "release-next",
  sessionRevision: 2,
  verified: true,
  host: { url: INTENT.hostUrl, basePath: "/moodle" },
};

function dependencies(options: { serving?: boolean; receipt?: DeploymentReceipt | null; hostExists?: boolean } = {}) {
  const deps = {
    wrangler: {
      checkAccess: vi.fn(async () => undefined),
      hostExists: vi.fn(async () => options.hostExists ?? true),
      putHostSecrets: vi.fn(async (_input: { accountId: string; workerName: string; secrets: Record<string, string> }) => undefined),
      uploadSecrets: vi.fn(),
      inspect: vi.fn(),
      initializeWorker: vi.fn(),
      uploadCandidate: vi.fn(),
      promote: vi.fn(),
      restoreProduction: vi.fn(),
      removeWorker: vi.fn(async () => undefined),
    },
    materializer: { prepare: vi.fn(), cleanup: vi.fn(async () => undefined) },
    credentials: {
      read: vi.fn(async () => ({ mcpAccessToken: "mcp-current", sessionSyncToken: "sync-current", sessionEncryptionKey: "encryption-current" })),
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    sessions: {
      loadValidated: vi.fn(async () => ({
        moodleOrigin: INTENT.moodleOrigin,
        cookieName: "MoodleSession",
        cookieValue: "private-cookie",
        fingerprint: "fingerprint",
        remoteRevision: null,
      })),
    },
    worker: {
      isServing: vi.fn(async () => options.serving ?? false),
      putSession: vi.fn(async () => ({ revision: 3 })),
      getReadiness: vi.fn(async () => ({ status: "fail" as const, reasonCode: "SESSION_MISSING", revision: 2 })),
      touchSession: vi.fn(async () => undefined),
      runSmoke: vi.fn(async () => ({ moodleUser: "Alice Example" })),
      checkRemoteLogin: vi.fn(async () => undefined),
      manageClients: vi.fn(),
      createPairing: vi.fn(),
    },
    renewal: { install: vi.fn(async () => undefined), inspect: vi.fn(async () => true), remove: vi.fn(async () => undefined) },
    clients: { install: vi.fn(async () => undefined), inspect: vi.fn(async () => true), remove: vi.fn(async () => undefined) },
    receipts: {
      read: vi.fn(async () => options.receipt ?? null),
      write: vi.fn(async (_receipt: DeploymentReceipt) => undefined),
      delete: vi.fn(async () => undefined),
    },
    createToken: vi.fn(() => "new-token"),
  };
  return deps;
}

async function consume(iterable: AsyncIterable<DeploymentEvent>): Promise<DeploymentEvent[]> {
  const events: DeploymentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("planHostedInstall", () => {
  it("targets the host URL plus base path and returns a static wrangler fragment", () => {
    const plan = planHostedInstall({ ...INTENT, hostUrl: "https://unicorn.example.workers.dev/" }, null);

    expect(plan.operation).toBe("create");
    expect(plan.endpoint).toBe("https://unicorn.example.workers.dev/moodle");
    expect(plan.secretNames).toContain("SESSION_ENCRYPTION_KEY");
    expect(plan.wranglerFragment).toEqual({
      durable_objects: {
        bindings: [
          { name: "SESSION_BROKER", class_name: "SessionBroker" },
          { name: "AUTH_BROKER", class_name: "AuthBroker" },
        ],
      },
      migrations: [{ tag: HOST_MIGRATION_TAG, new_sqlite_classes: ["SessionBroker", "AuthBroker"] }],
      browser: { binding: "BROWSER" },
    });
  });

  it.each([
    { basePath: "" },
    { basePath: "moodle" },
    { basePath: "/moodle/" },
    { basePath: "/../x" },
    { hostUrl: "http://unicorn.example.workers.dev" },
    { hostUrl: "https://unicorn.example.workers.dev/app" },
    { hostWorker: "Unicorn_Worker" },
  ])("rejects %o", (override) => {
    expect(() => planHostedInstall({ ...INTENT, ...override }, null)).toThrow(DeploymentPlanError);
  });

  it("refuses a profile that already owns a standalone Worker", () => {
    const standalone = { ...HOSTED_RECEIPT, host: undefined, workerName: "moodle-school-mcp" };
    expect(() => planHostedInstall(INTENT, standalone)).toThrow(/run moodle mcp remove first/u);
  });
});

describe("applyHostedInstall", () => {
  it("uploads secrets and records the endpoint when the host does not serve the routes yet", async () => {
    const deps = dependencies({ serving: false });
    const result: HostedInstallResult = { serving: false, moodleUser: null };

    const events = await consume(applyHostedInstall(planHostedInstall(INTENT, null), deps, result));

    expect(deps.wrangler.putHostSecrets).toHaveBeenCalledOnce();
    const [{ workerName, secrets }] = deps.wrangler.putHostSecrets.mock.calls[0]!;
    expect(workerName).toBe("unicorn");
    expect(secrets).toMatchObject({ MOODLE_ORIGIN: INTENT.moodleOrigin, EXPECTED_HOST: "unicorn.example.workers.dev" });
    expect(Object.values(secrets)).not.toContain("mcp-current");
    expect(deps.receipts.write).toHaveBeenLastCalledWith(expect.objectContaining({
      workerName: "unicorn",
      productionEndpoint: "https://unicorn.example.workers.dev/moodle",
      host: { url: INTENT.hostUrl, basePath: "/moodle" },
      verified: false,
    }));
    expect(deps.worker.putSession).not.toHaveBeenCalled();
    expect(result.serving).toBe(false);
    expect(events.filter((event) => event.status === "skipped").map((event) => event.stageId))
      .toEqual(["deploy_candidate_version", "upload_moodle_session", "run_release_checks"]);
  });

  it("uploads the session and runs the smoke check once the host serves the routes", async () => {
    const deps = dependencies({ serving: true });
    const result: HostedInstallResult = { serving: false, moodleUser: null };

    await consume(applyHostedInstall(planHostedInstall(INTENT, null), deps, result));

    expect(deps.worker.putSession).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "https://unicorn.example.workers.dev/moodle",
      expectedRevision: 2,
    }));
    expect(deps.worker.runSmoke).toHaveBeenCalledOnce();
    expect(result).toEqual({ serving: true, moodleUser: "Alice Example" });
    expect(deps.receipts.write).toHaveBeenLastCalledWith(expect.objectContaining({ sessionRevision: 3, verified: true }));
    expect(deps.renewal.install).toHaveBeenCalledWith("school");
  });

  it("stops before writing anything when the host Worker does not exist", async () => {
    const deps = dependencies({ hostExists: false });
    const iterable = applyHostedInstall(planHostedInstall(INTENT, null), deps, { serving: false, moodleUser: null });

    await expect(consume(iterable)).rejects.toMatchObject({ code: "HOST_WORKER_MISSING" });
    expect(deps.wrangler.putHostSecrets).not.toHaveBeenCalled();
    expect(deps.receipts.write).not.toHaveBeenCalled();
  });
});

describe("ManagedMcpDeployment with a hosted profile", () => {
  function deployment(deps = dependencies({ receipt: HOSTED_RECEIPT })) {
    return { deps, service: new ManagedMcpDeployment(deps as unknown as ManagedMcpDeploymentDependencies) };
  }

  it("refuses a standalone deploy over the hosted profile", async () => {
    const { service } = deployment();
    await expect(service.plan({
      profile: "school",
      accountId: "account-1",
      workerName: "moodle-school-mcp",
      moodleOrigin: INTENT.moodleOrigin,
      releaseDigest: "release-next",
    })).rejects.toMatchObject({ code: "HOSTED_PROFILE" });
  });

  it("refuses to roll back a Worker it does not own", async () => {
    const { service } = deployment();
    await expect(service.rollback("school")).rejects.toBeInstanceOf(DeploymentApplyError);
  });

  it("removes only local state", async () => {
    const { deps, service } = deployment();
    const removed = await service.remove("school");
    expect(removed.workerRemoved).toBe(false);
    expect(deps.wrangler.removeWorker).not.toHaveBeenCalled();
    expect(deps.receipts.delete).toHaveBeenCalledWith("school");
  });
});
