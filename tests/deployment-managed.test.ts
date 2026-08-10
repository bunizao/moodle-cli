import { describe, expect, it, vi } from "vitest";
import {
  DeploymentApplyError,
  DeploymentPlanError,
  MANAGED_SESSION_ENDPOINTS,
  ManagedMcpDeployment,
  ONBOARDING_COPY,
  ONBOARDING_STAGES,
  type DeploymentEvent,
  type DeploymentIntent,
  type DeploymentReceipt,
  type ManagedMcpDeploymentDependencies,
  type RemoteWorker,
} from "../src/mcp/deployment/index.js";

const INTENT: DeploymentIntent = {
  profile: "school",
  accountId: "account-1",
  workerName: "moodle-school-mcp",
  moodleOrigin: "https://moodle.example.edu/",
  releaseDigest: "release-next",
};

const REMOTE: RemoteWorker = {
  accountId: INTENT.accountId,
  workerName: INTENT.workerName,
  deploymentId: "deployment-1",
  ownershipTag: "deployment-1",
  productionEndpoint: "https://moodle-school-mcp.example.workers.dev",
  productionVersionId: "version-current",
  previousHealthyVersionId: "version-previous",
  releaseDigest: "release-current",
};

const RECEIPT: DeploymentReceipt = {
  profile: INTENT.profile,
  accountId: INTENT.accountId,
  workerName: INTENT.workerName,
  moodleOrigin: INTENT.moodleOrigin,
  deploymentId: REMOTE.deploymentId,
  productionEndpoint: REMOTE.productionEndpoint,
  productionVersionId: REMOTE.productionVersionId,
  releaseDigest: REMOTE.releaseDigest,
  sessionRevision: 4,
};

function dependencies(options: {
  remote?: RemoteWorker | null;
  receipt?: DeploymentReceipt | null;
  releaseDigest?: string;
} = {}): ManagedMcpDeploymentDependencies {
  const remote = options.remote === undefined ? REMOTE : options.remote;
  const receipt = options.receipt === undefined ? RECEIPT : options.receipt;
  return {
    wrangler: {
      checkAccess: vi.fn(async () => undefined),
      inspect: vi.fn(async () => remote),
      uploadSecrets: vi.fn(async () => undefined),
      uploadCandidate: vi.fn(async () => ({
        versionId: "version-next",
        previewEndpoint: "https://version-next.preview.example",
        productionEndpoint: REMOTE.productionEndpoint,
        deploymentId: REMOTE.deploymentId,
      })),
      promote: vi.fn(async () => undefined),
      restoreProduction: vi.fn(async () => undefined),
      removeWorker: vi.fn(async () => undefined),
    },
    materializer: {
      prepare: vi.fn(async () => ({
        artifactDirectory: "/private/tmp/release",
        wranglerConfigPath: "/private/tmp/release/wrangler.json",
        secretsFilePath: "/private/tmp/release/secrets.json",
      })),
      cleanup: vi.fn(async () => undefined),
    },
    credentials: {
      read: vi.fn(async () => ({
        mcpAccessToken: "mcp-current",
        sessionSyncToken: "sync-current",
        sessionEncryptionKey: "encryption-current",
      })),
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    sessions: {
      loadValidated: vi.fn(async () => ({
        moodleOrigin: INTENT.moodleOrigin,
        cookieName: "MoodleSession",
        cookieValue: "private-cookie",
        fingerprint: "fingerprint-current",
        remoteRevision: null,
      })),
    },
    worker: {
      putSession: vi.fn(async () => ({ revision: 5 })),
      getReadiness: vi.fn(async () => ({ status: "pass" as const, reasonCode: "SESSION_VALID", revision: 4 })),
      runSmoke: vi.fn(async () => ({ moodleUser: "Alice Example" })),
    },
    renewal: {
      install: vi.fn(async () => undefined),
      inspect: vi.fn(async () => true),
      remove: vi.fn(async () => undefined),
    },
    clients: {
      install: vi.fn(async () => undefined),
      inspect: vi.fn(async () => true),
      remove: vi.fn(async () => undefined),
    },
    receipts: {
      read: vi.fn(async () => receipt),
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    createToken: vi.fn(() => "new-token"),
  };
}

async function consume(iterable: AsyncIterable<DeploymentEvent>): Promise<DeploymentEvent[]> {
  const events: DeploymentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function consumeFailure(iterable: AsyncIterable<DeploymentEvent>): Promise<{
  events: DeploymentEvent[];
  error: unknown;
}> {
  const events: DeploymentEvent[] = [];
  try {
    for await (const event of iterable) {
      events.push(event);
    }
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

describe("ManagedMcpDeployment planning", () => {
  it("plans creation, update, idempotent reconciliation, and token rotation", async () => {
    const create = dependencies({ remote: null, receipt: null });
    expect((await new ManagedMcpDeployment(create).plan(INTENT)).operation).toBe("create");

    const update = dependencies();
    expect((await new ManagedMcpDeployment(update).plan(INTENT)).operation).toBe("update");

    const current = dependencies({
      remote: { ...REMOTE, releaseDigest: INTENT.releaseDigest },
      receipt: { ...RECEIPT, releaseDigest: INTENT.releaseDigest },
    });
    const reconcile = await new ManagedMcpDeployment(current).plan(INTENT);
    expect(reconcile).toMatchObject({ operation: "reconcile", uploadCandidate: false });

    const rotation = await new ManagedMcpDeployment(current).plan({ ...INTENT, rotateToken: true });
    expect(rotation).toMatchObject({ operation: "rotate", uploadCandidate: true });
  });

  it("rejects invalid roots and workers owned by another deployment", async () => {
    const manager = new ManagedMcpDeployment(dependencies());
    await expect(manager.plan({ ...INTENT, moodleOrigin: "https://moodle.example.edu/login" })).rejects.toMatchObject({
      code: "INVALID_INTENT",
    });

    const conflict = new ManagedMcpDeployment(dependencies({
      remote: { ...REMOTE, ownershipTag: "another-deployment" },
    }));
    await expect(conflict.plan(INTENT)).rejects.toBeInstanceOf(DeploymentPlanError);
    await expect(conflict.plan(INTENT)).rejects.toMatchObject({ code: "WORKER_NAME_CONFLICT" });
  });

  it("replaces a conflicting Moodle MCP Worker only after explicit approval", async () => {
    const deps = dependencies({
      remote: { ...REMOTE, ownershipTag: "another-deployment", releaseDigest: INTENT.releaseDigest },
    });
    const manager = new ManagedMcpDeployment(deps);
    const plan = await manager.plan({ ...INTENT, replaceExisting: true });

    expect(plan).toMatchObject({ operation: "update", uploadCandidate: true, receipt: null });
    await consume(manager.apply(plan));
    expect(deps.worker.getReadiness).toHaveBeenCalledWith({
      endpoint: "https://version-next.preview.example",
      sessionSyncToken: "sync-current",
    });
    expect(deps.worker.putSession).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4 }));
  });

  it("drops a stale receipt when deployment is renamed to a new Worker", async () => {
    const deps = dependencies({ remote: null });
    const manager = new ManagedMcpDeployment(deps);
    const plan = await manager.plan({ ...INTENT, workerName: "moodle-school-alt-mcp" });

    expect(plan).toMatchObject({ operation: "create", receipt: null });
    await consume(manager.apply(plan));
    expect(deps.worker.putSession).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: null }));
  });
});

describe("ManagedMcpDeployment transaction", () => {
  it("uploads a candidate, validates it, promotes it, and records stable stage events", async () => {
    const deps = dependencies();
    const manager = new ManagedMcpDeployment(deps);
    const events = await consume(manager.apply(await manager.plan(INTENT)));

    expect(events).toHaveLength(16);
    expect(events.filter((event) => event.status === "completed").map((event) => event.stageId))
      .toEqual(ONBOARDING_STAGES.map((stage) => stage.id));
    expect(deps.worker.putSession).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "https://version-next.preview.example",
      sessionSyncToken: "sync-current",
      expectedRevision: 4,
    }));
    expect(deps.worker.runSmoke).toHaveBeenNthCalledWith(1, expect.objectContaining({
      endpoint: "https://version-next.preview.example",
    }));
    expect(deps.wrangler.promote).toHaveBeenCalledWith(expect.objectContaining({ versionId: "version-next" }));
    expect(deps.worker.runSmoke).toHaveBeenNthCalledWith(2, expect.objectContaining({
      endpoint: REMOTE.productionEndpoint,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      stageId: "run_release_checks",
      status: "completed",
      moodleUser: "Alice Example",
    }));
    expect(deps.materializer.cleanup).toHaveBeenCalledTimes(1);
    expect(deps.receipts.write).toHaveBeenCalledWith(expect.objectContaining({
      profile: INTENT.profile,
      productionVersionId: "version-next",
    }));
  });

  it("preserves a null CAS revision for the first session uploaded to a new deployment", async () => {
    const deps = dependencies({ remote: null, receipt: null });
    const manager = new ManagedMcpDeployment(deps);
    await consume(manager.apply(await manager.plan(INTENT)));

    expect(deps.worker.putSession).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "https://version-next.preview.example",
      expectedRevision: null,
    }));
    expect(deps.receipts.write).toHaveBeenCalledWith(expect.objectContaining({ sessionRevision: 5 }));
  });

  it("blocks promotion after preview smoke failure and always cleans secret material", async () => {
    const deps = dependencies();
    vi.mocked(deps.worker.runSmoke).mockRejectedValueOnce(new Error("Authorization: Bearer mcp-current"));
    const manager = new ManagedMcpDeployment(deps);
    const result = await consumeFailure(manager.apply(await manager.plan(INTENT)));

    expect(result.error).toBeInstanceOf(DeploymentApplyError);
    expect(result.error).toMatchObject({ code: "CANDIDATE_VALIDATION_FAILED" });
    expect(String(result.error)).not.toContain("mcp-current");
    expect(deps.wrangler.promote).not.toHaveBeenCalled();
    expect(deps.wrangler.restoreProduction).not.toHaveBeenCalled();
    expect(deps.materializer.cleanup).toHaveBeenCalledTimes(1);
    expect(result.events.at(-1)).toMatchObject({ stageId: "run_release_checks", status: "failed" });
    expect(deps.receipts.write).toHaveBeenCalledWith({ ...RECEIPT, sessionRevision: 5 });
  });

  it("restores previous code with current credentials and session after production smoke failure", async () => {
    const deps = dependencies();
    vi.mocked(deps.worker.runSmoke)
      .mockResolvedValueOnce({ moodleUser: "Alice Example" })
      .mockRejectedValueOnce(new Error("production failed"))
      .mockResolvedValueOnce({ moodleUser: "Alice Example" });
    vi.mocked(deps.worker.putSession)
      .mockResolvedValueOnce({ revision: 5 })
      .mockResolvedValueOnce({ revision: 6 });
    const manager = new ManagedMcpDeployment(deps);
    const result = await consumeFailure(manager.apply(await manager.plan(INTENT)));

    expect(result.error).toMatchObject({ code: "PRODUCTION_VALIDATION_FAILED_RESTORED" });
    expect(deps.wrangler.restoreProduction).toHaveBeenCalledWith({
      accountId: INTENT.accountId,
      workerName: INTENT.workerName,
      previousVersionId: REMOTE.productionVersionId,
    });
    expect(deps.worker.putSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      endpoint: REMOTE.productionEndpoint,
      sessionSyncToken: "sync-current",
      expectedRevision: 5,
      session: expect.objectContaining({ cookieValue: "private-cookie" }),
    }));
    expect(deps.worker.runSmoke).toHaveBeenCalledTimes(3);
    expect(deps.materializer.cleanup).toHaveBeenCalledTimes(1);
    expect(deps.receipts.write).toHaveBeenCalledWith({ ...RECEIPT, sessionRevision: 6 });
  });

  it("reconciles an unchanged deployment without uploading or promoting another version", async () => {
    const deps = dependencies({
      remote: { ...REMOTE, releaseDigest: INTENT.releaseDigest },
      receipt: { ...RECEIPT, releaseDigest: INTENT.releaseDigest },
    });
    const manager = new ManagedMcpDeployment(deps);
    await consume(manager.apply(await manager.plan(INTENT)));

    expect(deps.wrangler.uploadSecrets).not.toHaveBeenCalled();
    expect(deps.wrangler.uploadCandidate).not.toHaveBeenCalled();
    expect(deps.wrangler.promote).not.toHaveBeenCalled();
    expect(deps.worker.putSession).toHaveBeenCalledWith(expect.objectContaining({ endpoint: REMOTE.productionEndpoint }));
    expect(deps.worker.putSession).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4 }));
    expect(deps.renewal.install).toHaveBeenCalledWith(INTENT.profile);
    expect(deps.clients.install).toHaveBeenCalledWith(INTENT.profile);
  });

  it("keeps rotated credentials overlapping while the candidate is validated", async () => {
    const deps = dependencies();
    vi.mocked(deps.createToken).mockReturnValueOnce("mcp-next").mockReturnValueOnce("sync-next");
    const manager = new ManagedMcpDeployment(deps);
    await consume(manager.apply(await manager.plan({ ...INTENT, rotateToken: true })));

    expect(deps.credentials.write).toHaveBeenCalledWith(INTENT.profile, expect.objectContaining({
      mcpAccessToken: "mcp-next",
      sessionSyncToken: "sync-next",
      sessionEncryptionKey: "encryption-current",
      previousMcpAccessToken: "mcp-current",
      previousSessionSyncToken: "sync-current",
      previousTokensExpireAt: expect.any(Number),
    }));
    expect(deps.worker.runSmoke).toHaveBeenCalledWith(expect.objectContaining({ mcpAccessToken: "mcp-next" }));
  });

  it("restores local credentials when secret rotation fails before Cloudflare accepts it", async () => {
    const deps = dependencies();
    vi.mocked(deps.createToken).mockReturnValueOnce("mcp-next").mockReturnValueOnce("sync-next");
    vi.mocked(deps.wrangler.uploadSecrets).mockRejectedValueOnce(new Error("authorization expired"));
    const manager = new ManagedMcpDeployment(deps);
    const result = await consumeFailure(manager.apply(await manager.plan({ ...INTENT, rotateToken: true })));

    expect(result.error).toMatchObject({ code: "DEPLOYMENT_FAILED" });
    expect(deps.credentials.write).toHaveBeenLastCalledWith(INTENT.profile, {
      mcpAccessToken: "mcp-current",
      sessionSyncToken: "sync-current",
      sessionEncryptionKey: "encryption-current",
    });
    expect(deps.wrangler.uploadCandidate).not.toHaveBeenCalled();
  });

  it("records the live release before a local integration reports failure", async () => {
    const deps = dependencies();
    vi.mocked(deps.renewal.install).mockRejectedValueOnce(new Error("scheduler unavailable"));
    const manager = new ManagedMcpDeployment(deps);
    const result = await consumeFailure(manager.apply(await manager.plan(INTENT)));

    expect(result.error).toMatchObject({ code: "DEPLOYMENT_FAILED" });
    expect(deps.receipts.write).toHaveBeenCalledWith(expect.objectContaining({
      productionVersionId: "version-next",
      sessionRevision: 5,
    }));
    expect(result.events.at(-1)).toMatchObject({ stageId: "install_local_integrations", status: "failed" });
  });
});

describe("ManagedMcpDeployment lifecycle", () => {
  it("inspects remote and local readiness through the session sync credential", async () => {
    const deps = dependencies();
    const status = await new ManagedMcpDeployment(deps).inspect(INTENT.profile);
    expect(status).toMatchObject({
      profile: INTENT.profile,
      credentialsStored: true,
      renewalInstalled: true,
      clientsConnected: true,
      readiness: "pass",
    });
    expect(deps.worker.getReadiness).toHaveBeenCalledWith({
      endpoint: REMOTE.productionEndpoint,
      sessionSyncToken: "sync-current",
    });
  });

  it("recovers by uploading the current session before falling back to a previous healthy release", async () => {
    const deps = dependencies();
    vi.mocked(deps.worker.runSmoke)
      .mockRejectedValueOnce(new Error("bad code"))
      .mockResolvedValueOnce({ moodleUser: "Alice Example" });
    const result = await new ManagedMcpDeployment(deps).recover(INTENT.profile);

    expect(result).toEqual({ status: "restored", versionId: REMOTE.previousHealthyVersionId });
    expect(deps.wrangler.restoreProduction).toHaveBeenCalledWith(expect.objectContaining({
      previousVersionId: REMOTE.previousHealthyVersionId,
    }));
    expect(deps.worker.putSession).toHaveBeenCalledTimes(2);
    expect(deps.renewal.install).toHaveBeenCalledWith(INTENT.profile);
    expect(deps.worker.putSession).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedRevision: 4 }));
    expect(deps.receipts.write).toHaveBeenCalledWith(expect.objectContaining({
      productionVersionId: REMOTE.previousHealthyVersionId,
      sessionRevision: 5,
    }));
  });

  it("rolls back a healthy current release and restores it if the previous release fails validation", async () => {
    const success = dependencies();
    const manager = new ManagedMcpDeployment(success);

    await expect(manager.rollback(INTENT.profile)).resolves.toEqual({
      status: "restored",
      versionId: REMOTE.previousHealthyVersionId,
    });
    expect(success.wrangler.restoreProduction).toHaveBeenCalledWith({
      accountId: INTENT.accountId,
      workerName: INTENT.workerName,
      previousVersionId: REMOTE.previousHealthyVersionId,
    });
    expect(success.worker.runSmoke).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: REMOTE.productionEndpoint,
      mcpAccessToken: "mcp-current",
      sessionSyncToken: "sync-current",
    }));
    expect(success.receipts.write).toHaveBeenCalledWith(expect.objectContaining({
      productionVersionId: REMOTE.previousHealthyVersionId,
    }));

    const failed = dependencies();
    vi.mocked(failed.worker.runSmoke).mockRejectedValueOnce(new Error("previous release failed"));
    await expect(new ManagedMcpDeployment(failed).rollback(INTENT.profile)).rejects.toMatchObject({
      code: "ROLLBACK_VALIDATION_FAILED_RESTORED",
    });
    expect(failed.wrangler.restoreProduction).toHaveBeenNthCalledWith(2, {
      accountId: INTENT.accountId,
      workerName: INTENT.workerName,
      previousVersionId: REMOTE.productionVersionId,
    });
    expect(failed.receipts.write).not.toHaveBeenCalled();
  });

  it("removes only the Worker recorded by the selected profile receipt", async () => {
    const deps = dependencies();
    const result = await new ManagedMcpDeployment(deps).remove(INTENT.profile);
    expect(result).toEqual({ profile: INTENT.profile, workerRemoved: true, localStateRemoved: true });
    expect(deps.wrangler.removeWorker).toHaveBeenCalledWith({
      accountId: INTENT.accountId,
      workerName: INTENT.workerName,
      deploymentId: RECEIPT.deploymentId,
    });
    expect(deps.credentials.delete).toHaveBeenCalledWith(INTENT.profile);
  });

  it("fails closed when the current Worker ownership no longer matches the receipt", async () => {
    const deps = dependencies({ remote: { ...REMOTE, ownershipTag: "someone-else" } });
    await expect(new ManagedMcpDeployment(deps).remove(INTENT.profile)).rejects.toMatchObject({
      code: "REMOVAL_SCOPE_MISMATCH",
    });
    expect(deps.wrangler.removeWorker).not.toHaveBeenCalled();
    expect(deps.credentials.delete).not.toHaveBeenCalled();
  });
});

describe("stable managed MCP surface", () => {
  it("exports the approved session endpoints and onboarding copy without secrets", () => {
    expect(MANAGED_SESSION_ENDPOINTS).toEqual({
      upload: "/session",
      readiness: "/readyz",
      touch: "/session/touch",
    });
    expect(ONBOARDING_STAGES).toHaveLength(8);
    expect(ONBOARDING_COPY.introduction).toContain("Moodle MCP setup");
    expect(JSON.stringify(ONBOARDING_COPY)).not.toMatch(/cookieValue|Bearer [A-Za-z0-9]/);
  });
});
