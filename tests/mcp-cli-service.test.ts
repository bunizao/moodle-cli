import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AuthError } from "../src/errors.js";
import type {
  DeploymentIntent,
  ManagedMcpDeployment,
  NodeWranglerDeploymentAdapter,
  WorkerReadiness,
} from "../src/mcp/deployment/index.js";
import { DeploymentApplyError, DeploymentPlanError } from "../src/mcp/deployment/index.js";
import {
  createMcpCommandService,
  deriveMcpProfile,
  deriveMcpWorkerName,
} from "../src/mcp/cli.js";

describe("managed MCP CLI service", () => {
  it("derives stable Cloudflare-safe profile and Worker names", () => {
    expect(deriveMcpProfile("https://lms.example.edu")).toBe("lms-example-edu");
    expect(deriveMcpWorkerName("https://lms.example.edu")).toBe("moodle-lms-example-edu-mcp");

    const long = deriveMcpWorkerName(`https://${"long-segment-".repeat(8)}example.edu`);
    expect(long).toMatch(/^moodle-[a-z0-9-]+-[a-f0-9]{8}$/u);
    expect(long.length).toBeLessThanOrEqual(63);
  });

  it("builds a sanitized dry-run plan without acquiring or uploading a Moodle session", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-cli-service-"));
    const bundle = join(root, "worker.js");
    await writeFile(bundle, "export default {};\n");
    const receipt = deploymentReceipt();
    const plan = vi.fn(async (intent) => ({
      intent,
      operation: "reconcile" as const,
      uploadCandidate: false,
      existing: null,
      receipt,
    }));
    const deployment = { plan } as unknown as ManagedMcpDeployment;
    const service = createMcpCommandService({
      workerBundlePath: bundle,
      configLoader: async () => ({ baseUrl: "https://lms.example.edu" }),
      receipts: receiptStore(receipt),
      credentials: credentialStore(),
      worker: workerClient(),
      createDeployment: () => deployment,
    });

    try {
      const result = await service.deploy({ dryRun: true, repair: false, rotateToken: false, rollback: false, yes: true });
      expect(result.data).toMatchObject({
        operation: "reconcile",
        workerName: receipt.workerName,
        accountId: receipt.accountId,
        uploadCandidate: false,
      });
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({
        profile: receipt.profile,
        releaseDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        dryRun: true,
      }));
      expect(JSON.stringify(result)).not.toMatch(/cookie|Bearer|access-token|sync-token/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the explicit rollback operation for --rollback", async () => {
    const receipt = deploymentReceipt();
    const rollback = vi.fn(async () => ({ status: "restored" as const, versionId: "version-previous" }));
    const service = createMcpCommandService({
      receipts: receiptStore(receipt),
      credentials: credentialStore(),
      worker: workerClient(),
      createDeployment: () => ({ rollback } as unknown as ManagedMcpDeployment),
      configLoader: async () => ({ baseUrl: receipt.moodleOrigin }),
    });

    const result = await service.deploy({
      dryRun: false,
      repair: false,
      rotateToken: false,
      rollback: true,
      yes: true,
    });

    expect(rollback).toHaveBeenCalledWith(receipt.profile);
    expect(result.data).toEqual({ status: "restored", versionId: "version-previous" });
  });

  it("renders the complete first-run success report from verified deployment data", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-cli-success-"));
    const bundle = join(root, "worker.js");
    await writeFile(bundle, "export default {};\n");
    const receipt = deploymentReceipt();
    const deployment = {
      plan: vi.fn(async (intent: DeploymentIntent) => ({
        intent,
        operation: "create" as const,
        uploadCandidate: true,
        existing: null,
        receipt: null,
      })),
      apply: async function* () {
        yield {
          stageId: "run_release_checks" as const,
          stage: 7,
          total: 8 as const,
          label: "Running MCP and Moodle checks",
          status: "completed" as const,
          moodleUser: "Alice Example",
        };
      },
      inspect: vi.fn(async () => ({
        profile: receipt.profile,
        worker: {
          accountId: receipt.accountId,
          workerName: receipt.workerName,
          deploymentId: receipt.deploymentId,
          ownershipTag: receipt.deploymentId,
          productionEndpoint: receipt.productionEndpoint,
          productionVersionId: receipt.productionVersionId,
          previousHealthyVersionId: null,
          releaseDigest: receipt.releaseDigest,
        },
        credentialsStored: true,
        renewalInstalled: true,
        clientsConnected: true,
        readiness: "pass" as const,
        readinessReasonCode: "SESSION_VALID",
        sessionRevision: receipt.sessionRevision,
      })),
    } as unknown as ManagedMcpDeployment;
    const service = createMcpCommandService({
      homeDir: root,
      workerBundlePath: bundle,
      configLoader: async () => ({ baseUrl: receipt.moodleOrigin }),
      receipts: receiptStore(receipt),
      credentials: credentialStore(),
      worker: workerClient(),
      createDeployment: () => deployment,
    });

    try {
      const result = await service.deploy({
        dryRun: false,
        repair: false,
        rotateToken: false,
        rollback: false,
        yes: true,
      });
      expect(result.text).toContain("Moodle MCP is ready.");
      expect(result.text).toContain(`  ${receipt.productionEndpoint}/mcp`);
      expect(result.text).toContain(`  Site: ${receipt.moodleOrigin}`);
      expect(result.text).toContain("  User: Alice Example");
      expect(result.text).toContain("  Next check: within 30 minutes");
      expect(result.text).toContain("Connected clients\n  No supported clients detected");
      expect(result.text).not.toMatch(/Bearer|MoodleSession|private-token/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("offers update, rename, and cancel for a conflicting Worker name", async () => {
    const update = await collisionHarness(["1"]);
    const rename = await collisionHarness(["2", "moodle-school-alt-mcp"]);
    const cancel = await collisionHarness(["3"]);

    try {
      await update.service.deploy(deployDryRun());
      expect(update.plan).toHaveBeenLastCalledWith(expect.objectContaining({ replaceExisting: true }));

      await rename.service.deploy(deployDryRun());
      expect(rename.plan).toHaveBeenLastCalledWith(expect.objectContaining({
        workerName: "moodle-school-alt-mcp",
        replaceExisting: false,
      }));

      await expect(cancel.service.deploy(deployDryRun())).rejects.toThrow("deployment was cancelled");
    } finally {
      await Promise.all([update.root, rename.root, cancel.root].map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("does not overwrite a conflicting Worker in non-interactive mode", async () => {
    const harness = await collisionHarness([], false);
    try {
      await expect(harness.service.deploy(deployDryRun())).rejects.toThrow("Run `moodle mcp deploy` interactively");
      expect(harness.plan).toHaveBeenCalledOnce();
      expect(harness.prompt).not.toHaveBeenCalled();
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("runs the credential bridge from private receipt state", async () => {
    const receipt = deploymentReceipt();
    const output = outputBuffer();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mcp-private-token");
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    });
    const service = createMcpCommandService({
      stdin: stream(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`) as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WritableStream,
      receipts: receiptStore(receipt),
      credentials: credentialStore(),
      worker: workerClient(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.bridge(receipt.profile);

    expect(output.lines()).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
    expect(output.raw()).not.toContain("mcp-private-token");
  });

  it("opens a pairing window and prints the connector URL without the sync token", async () => {
    const receipt = deploymentReceipt();
    const worker = workerClient();
    const service = createMcpCommandService({
      configLoader: async () => ({ baseUrl: "https://lms.example.edu" }),
      receipts: receiptStore(receipt),
      credentials: credentialStore(),
      worker,
    });

    const result = await service.pair();

    expect(worker.createPairing).toHaveBeenCalledWith({
      endpoint: receipt.productionEndpoint,
      sessionSyncToken: "sync-private-token",
    });
    expect(result.data).toMatchObject({
      profile: receipt.profile,
      endpoint: `${receipt.productionEndpoint}/mcp`,
      code: "ABCD2345",
      authorizationServer: "https://moodle-school-mcp.demo.workers.dev",
    });
    expect(result.text).toContain(`${receipt.productionEndpoint}/mcp`);
    expect(result.text).toContain("ABCD-2345");
    expect(result.text).not.toContain("sync-private-token");
  });

  it("rejects token reveal outside an interactive TTY at the service boundary", async () => {
    const service = createMcpCommandService({ stdin: { isTTY: false } as NodeJS.ReadStream });

    await expect(service.connect({ mode: "bridge", showToken: true }))
      .rejects.toThrow("--show-token requires an interactive TTY");
  });

  it("installs a missing renewal agent while leaving a valid remote session unchanged", async () => {
    const receipt = deploymentReceipt();
    const renewal = renewalIntegration(false);
    const sessions = sessionSource();
    const worker = workerClient({ status: "pass", reasonCode: "SESSION_VALID", revision: 4 });
    const service = createMcpCommandService({
      receipts: receiptStore(receipt),
      credentials: credentialStore(),
      worker,
      renewal,
      sessions,
    });

    const result = await service.renew(receipt.profile);

    expect(result.data).toEqual({
      profile: receipt.profile,
      state: "healthy",
      reasonCode: "RENEWAL_AGENT_MISSING",
      revision: 4,
    });
    expect(renewal.install).toHaveBeenCalledWith(receipt.profile);
    expect(sessions.loadValidated).not.toHaveBeenCalled();
    expect(worker.putSession).not.toHaveBeenCalled();
  });

  it("preserves the remote session when Moodle is unreachable", async () => {
    const receipt = deploymentReceipt();
    const receipts = receiptStore(receipt);
    const sessions = sessionSource();
    const worker = workerClient({ status: "fail", reasonCode: "MOODLE_UNREACHABLE", revision: 4 });
    const service = createMcpCommandService({
      receipts,
      credentials: credentialStore(),
      worker,
      renewal: renewalIntegration(true),
      sessions,
    });

    const result = await service.renew(receipt.profile);

    expect(result.data).toEqual({
      profile: receipt.profile,
      state: "offline",
      reasonCode: "MOODLE_UNREACHABLE",
      revision: 4,
    });
    expect(sessions.loadValidated).not.toHaveBeenCalled();
    expect(worker.putSession).not.toHaveBeenCalled();
    expect(receipts.write).not.toHaveBeenCalled();
  });

  it("recovers an expiring session from non-interactive local sources", async () => {
    const receipt = deploymentReceipt();
    const receipts = receiptStore(receipt);
    const sessions = sessionSource();
    const worker = workerClient({ status: "warn", reasonCode: "SESSION_EXPIRING", revision: 7 });
    vi.mocked(worker.putSession).mockResolvedValueOnce({ revision: 8 });
    const service = createMcpCommandService({
      receipts,
      credentials: credentialStore(),
      worker,
      renewal: renewalIntegration(true),
      sessions,
    });

    const result = await service.renew(receipt.profile);

    expect(sessions.loadValidated).toHaveBeenCalledWith(receipt.profile, receipt.moodleOrigin);
    expect(worker.putSession).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: receipt.productionEndpoint,
      expectedRevision: 7,
      session: expect.objectContaining({ cookieValue: "replacement-cookie" }),
    }));
    expect(receipts.write).toHaveBeenLastCalledWith(expect.objectContaining({ sessionRevision: 8 }));
    expect(result.data).toEqual({
      profile: receipt.profile,
      state: "healthy",
      reasonCode: "SESSION_VALID",
      revision: 8,
    });
  });

  it("notifies instead of opening a browser when background authentication needs MFA", async () => {
    const receipt = deploymentReceipt();
    const sessions = sessionSource();
    vi.mocked(sessions.loadValidated).mockRejectedValueOnce(new AuthError("MFA required"));
    const notify = vi.fn(async () => undefined);
    const worker = workerClient({ status: "fail", reasonCode: "SESSION_EXPIRED", revision: 4 });
    const service = createMcpCommandService({
      receipts: receiptStore(receipt),
      credentials: credentialStore(),
      worker,
      renewal: renewalIntegration(true),
      sessions,
      notifyRenewalSignIn: notify,
    });

    const result = await service.renew(receipt.profile);

    expect(notify).toHaveBeenCalledOnce();
    expect(worker.putSession).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      profile: receipt.profile,
      state: "needs_sign_in",
      reasonCode: "SESSION_EXPIRED",
      revision: 4,
    });
  });

  it("creates the first remote session with a null expected revision", async () => {
    const receipt = deploymentReceipt();
    const receipts = receiptStore(receipt);
    const worker = workerClient({ status: "fail", reasonCode: "SESSION_MISSING", revision: null });
    vi.mocked(worker.putSession).mockResolvedValueOnce({ revision: 1 });
    const service = createMcpCommandService({
      receipts,
      credentials: credentialStore(),
      worker,
      renewal: renewalIntegration(true),
      sessions: sessionSource(),
    });

    const result = await service.renew(receipt.profile);

    expect(worker.putSession).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: null }));
    expect(receipts.write).toHaveBeenCalledOnce();
    expect(receipts.write).toHaveBeenCalledWith(expect.objectContaining({ sessionRevision: 1 }));
    expect(result.data).toMatchObject({ state: "healthy", reasonCode: "SESSION_VALID", revision: 1 });
  });

  it("retries one interrupted session upload and persists the accepted revision", async () => {
    const receipt = deploymentReceipt();
    const receipts = receiptStore(receipt);
    const worker = workerClient({ status: "fail", reasonCode: "SESSION_EXPIRED", revision: 4 });
    vi.mocked(worker.putSession)
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ revision: 5 });
    const service = createMcpCommandService({
      receipts,
      credentials: credentialStore(),
      worker,
      renewal: renewalIntegration(true),
      sessions: sessionSource(),
    });

    const result = await service.renew(receipt.profile);

    expect(worker.putSession).toHaveBeenCalledTimes(2);
    expect(receipts.write).toHaveBeenLastCalledWith(expect.objectContaining({ sessionRevision: 5 }));
    expect(result.data).toMatchObject({ state: "healthy", reasonCode: "SESSION_VALID", revision: 5 });
  });

  it("refreshes the remote revision without overwriting after a revision conflict", async () => {
    const receipt = deploymentReceipt();
    const receipts = receiptStore(receipt);
    const worker = workerClient({ status: "fail", reasonCode: "SESSION_EXPIRED", revision: 8 });
    vi.mocked(worker.putSession).mockRejectedValueOnce(
      new DeploymentApplyError("SESSION_REVISION_CONFLICT", "remote session is newer"),
    );
    vi.mocked(worker.getReadiness)
      .mockResolvedValueOnce({ status: "fail", reasonCode: "SESSION_EXPIRED", revision: 8 })
      .mockResolvedValueOnce({ status: "warn", reasonCode: "SESSION_SYNC_STALE", revision: 9 });
    const service = createMcpCommandService({
      receipts,
      credentials: credentialStore(),
      worker,
      renewal: renewalIntegration(true),
      sessions: sessionSource(),
    });

    const result = await service.renew(receipt.profile);

    expect(worker.putSession).toHaveBeenCalledOnce();
    expect(receipts.write).toHaveBeenLastCalledWith(expect.objectContaining({ sessionRevision: 9 }));
    expect(result.data).toEqual({
      profile: receipt.profile,
      state: "conflict",
      reasonCode: "SESSION_SYNC_STALE",
      revision: 9,
    });
  });
});

function deploymentReceipt() {
  return {
    profile: "lms-example-edu",
    accountId: "account-1",
    workerName: "moodle-lms-example-edu-mcp",
    moodleOrigin: "https://lms.example.edu",
    deploymentId: "deployment-1",
    productionEndpoint: "https://moodle-lms-example-edu-mcp.example.workers.dev",
    productionVersionId: "version-1",
    releaseDigest: "digest-1",
    sessionRevision: 4,
  };
}

function deployDryRun() {
  return { dryRun: true, repair: false, rotateToken: false, rollback: false, yes: true };
}

async function collisionHarness(answers: string[], interactive = true) {
  const root = await mkdtemp(join(tmpdir(), "moodle-cli-conflict-"));
  const bundle = join(root, "worker.js");
  await writeFile(bundle, "export default {};\n");
  const remainingAnswers = [...answers];
  const prompt = vi.fn(async () => remainingAnswers.shift() ?? "");
  const plan = vi.fn(async (intent: DeploymentIntent) => ({
    intent,
    operation: "update" as const,
    uploadCandidate: true,
    existing: null,
    receipt: null,
  }));
  plan.mockRejectedValueOnce(new DeploymentPlanError("WORKER_NAME_CONFLICT", "conflict"));
  const deployment = { plan } as unknown as ManagedMcpDeployment;
  const wrangler = {
    listAccounts: vi.fn(async () => [{ id: "account-1", name: "Personal" }]),
  } as unknown as NodeWranglerDeploymentAdapter;
  const service = createMcpCommandService({
    homeDir: root,
    workerBundlePath: bundle,
    stdin: { isTTY: interactive } as NodeJS.ReadStream,
    configLoader: async () => ({ baseUrl: "https://lms.example.edu" }),
    receipts: {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    credentials: credentialStore(),
    worker: workerClient(),
    wrangler,
    createDeployment: () => deployment,
    prompt,
  });
  return { root, service, plan, prompt };
}

function receiptStore(receipt: ReturnType<typeof deploymentReceipt>) {
  return {
    read: vi.fn(async () => receipt),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function credentialStore() {
  return {
    read: vi.fn(async () => ({
      mcpAccessToken: "mcp-private-token",
      sessionSyncToken: "sync-private-token",
      sessionEncryptionKey: "encryption-private-key",
    })),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function workerClient(
  readiness: WorkerReadiness = { status: "pass", reasonCode: "SESSION_VALID", revision: 4 },
) {
  return {
    putSession: vi.fn(async () => ({ revision: 5 })),
    getReadiness: vi.fn(async () => readiness),
    runSmoke: vi.fn(async () => ({ moodleUser: "Alice Example" })),
    manageClients: vi.fn(async () => ({ clients: [] })),
    createPairing: vi.fn(async () => ({
      code: "ABCD2345",
      expiresAt: "2026-09-04T00:10:00.000Z",
      authorizationServer: "https://moodle-school-mcp.demo.workers.dev",
    })),
  };
}

function renewalIntegration(installed: boolean) {
  return {
    install: vi.fn(async () => undefined),
    inspect: vi.fn(async () => installed),
    remove: vi.fn(async () => undefined),
  };
}

function sessionSource() {
  return {
    loadValidated: vi.fn(async () => ({
      moodleOrigin: "https://lms.example.edu",
      cookieName: "MoodleSession",
      cookieValue: "replacement-cookie",
      fingerprint: "replacement-fingerprint",
      remoteRevision: null,
    })),
  };
}

async function* stream(value: string): AsyncIterable<string> {
  yield value;
}

function outputBuffer() {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    raw() {
      return value;
    },
    lines() {
      return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}
