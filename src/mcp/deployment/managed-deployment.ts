import {
  createDeploymentCredentials,
  rotateCredentials,
  type DeploymentCredentials,
} from "../credentials/index.js";
import { ONBOARDING_STAGES, type OnboardingStageId } from "./onboarding.js";

export const MANAGED_SESSION_ENDPOINTS = {
  upload: "/session",
  readiness: "/readyz",
  touch: "/session/touch",
} as const;

export interface DeploymentIntent {
  profile: string;
  accountId: string;
  workerName: string;
  moodleOrigin: string;
  releaseDigest: string;
  rotateToken?: boolean;
  repair?: boolean;
  dryRun?: boolean;
}

export interface RemoteWorker {
  accountId: string;
  workerName: string;
  deploymentId: string;
  ownershipTag: string;
  productionEndpoint: string;
  productionVersionId: string;
  previousHealthyVersionId: string | null;
  releaseDigest: string;
}

export interface DeploymentReceipt {
  profile: string;
  accountId: string;
  workerName: string;
  moodleOrigin: string;
  deploymentId: string;
  productionEndpoint: string;
  productionVersionId: string;
  releaseDigest: string;
  sessionRevision: number;
}

export interface DeploymentPlan {
  intent: DeploymentIntent;
  operation: "create" | "update" | "reconcile" | "rotate";
  uploadCandidate: boolean;
  existing: RemoteWorker | null;
  receipt: DeploymentReceipt | null;
}

export interface MoodleSessionMaterial {
  moodleOrigin: string;
  cookieName: string;
  cookieValue: string;
  fingerprint: string;
  remoteRevision: number | null;
}

export interface WorkerReadiness {
  status: "pass" | "warn" | "fail";
  reasonCode: string | null;
  revision: number | null;
}

export interface PreparedRelease {
  artifactDirectory: string;
  wranglerConfigPath: string;
  secretsFilePath: string;
}

export interface CandidateRelease {
  versionId: string;
  previewEndpoint: string;
  productionEndpoint: string;
  deploymentId: string;
}

export interface WranglerDeploymentAdapter {
  checkAccess(accountId: string): Promise<void>;
  inspect(accountId: string, workerName: string): Promise<RemoteWorker | null>;
  uploadSecrets(input: {
    accountId: string;
    workerName: string;
    configPath: string;
    secretsFilePath: string;
  }): Promise<void>;
  uploadCandidate(input: {
    accountId: string;
    workerName: string;
    configPath: string;
    releaseDigest: string;
  }): Promise<CandidateRelease>;
  promote(input: { accountId: string; workerName: string; versionId: string }): Promise<void>;
  restoreProduction(input: {
    accountId: string;
    workerName: string;
    previousVersionId: string | null;
  }): Promise<void>;
  removeWorker(input: {
    accountId: string;
    workerName: string;
    deploymentId: string;
  }): Promise<void>;
}

export interface ReleaseMaterializer {
  prepare(plan: DeploymentPlan, credentials: DeploymentCredentials): Promise<PreparedRelease>;
  cleanup(release: PreparedRelease): Promise<void>;
}

export interface DeploymentCredentialRepository {
  read(profile: string): Promise<DeploymentCredentials | null>;
  write(profile: string, credentials: DeploymentCredentials): Promise<void>;
  delete(profile: string): Promise<void>;
}

export interface MoodleSessionSource {
  loadValidated(profile: string, moodleOrigin: string): Promise<MoodleSessionMaterial>;
}

export interface ManagedWorkerClient {
  putSession(input: {
    endpoint: string;
    sessionSyncToken: string;
    session: MoodleSessionMaterial;
    expectedRevision: number | null;
  }): Promise<{ revision: number }>;
  getReadiness(input: { endpoint: string; sessionSyncToken: string }): Promise<WorkerReadiness>;
  runSmoke(input: {
    endpoint: string;
    mcpAccessToken: string;
    sessionSyncToken: string;
  }): Promise<void>;
}

export interface LocalDeploymentIntegration {
  install(profile: string): Promise<void>;
  inspect(profile: string): Promise<boolean>;
  remove(profile: string): Promise<void>;
}

export interface DeploymentReceiptStore {
  read(profile: string): Promise<DeploymentReceipt | null>;
  write(receipt: DeploymentReceipt): Promise<void>;
  delete(profile: string): Promise<void>;
}

export interface ManagedMcpDeploymentDependencies {
  wrangler: WranglerDeploymentAdapter;
  materializer: ReleaseMaterializer;
  credentials: DeploymentCredentialRepository;
  sessions: MoodleSessionSource;
  worker: ManagedWorkerClient;
  renewal: LocalDeploymentIntegration;
  clients: LocalDeploymentIntegration;
  receipts: DeploymentReceiptStore;
  createToken: () => string;
}

export interface DeploymentEvent {
  stageId: OnboardingStageId;
  stage: number;
  total: 8;
  label: string;
  status: "started" | "completed" | "failed";
  code?: string;
}

export interface DeploymentStatus {
  profile: string;
  worker: RemoteWorker | null;
  credentialsStored: boolean;
  renewalInstalled: boolean;
  clientsConnected: boolean;
  readiness: "pass" | "warn" | "fail" | "unknown";
  readinessReasonCode: string | null;
  sessionRevision: number | null;
}

export interface RecoveryResult {
  status: "ready" | "restored";
  versionId: string;
}

export interface RollbackResult {
  status: "restored";
  versionId: string;
}

export interface RemovalResult {
  profile: string;
  workerRemoved: boolean;
  localStateRemoved: true;
}

export class DeploymentPlanError extends Error {
  constructor(public readonly code: "INVALID_INTENT" | "WORKER_NAME_CONFLICT", message: string) {
    super(message);
    this.name = "DeploymentPlanError";
  }
}

export class DeploymentApplyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DeploymentApplyError";
  }
}

export class ManagedMcpDeployment {
  constructor(private readonly dependencies: ManagedMcpDeploymentDependencies) {}

  async plan(intent: DeploymentIntent): Promise<DeploymentPlan> {
    validateIntent(intent);
    const [remote, receipt, credentials] = await Promise.all([
      this.dependencies.wrangler.inspect(intent.accountId, intent.workerName),
      this.dependencies.receipts.read(intent.profile),
      this.dependencies.credentials.read(intent.profile),
    ]);

    if (remote && !isOwnedByProfile(remote, receipt, intent.profile)) {
      throw new DeploymentPlanError(
        "WORKER_NAME_CONFLICT",
        `Worker ${intent.workerName} is not owned by Moodle MCP profile ${intent.profile}`,
      );
    }

    const existing = remote && receipt
      ? { ...remote, productionEndpoint: receipt.productionEndpoint, releaseDigest: receipt.releaseDigest }
      : remote;

    const rotate = intent.rotateToken === true && credentials !== null;
    const releaseChanged = existing?.releaseDigest !== intent.releaseDigest;
    const uploadCandidate = !existing || releaseChanged || intent.repair === true || rotate;
    return {
      intent: { ...intent },
      operation: !existing ? "create" : rotate ? "rotate" : uploadCandidate ? "update" : "reconcile",
      uploadCandidate,
      existing,
      receipt,
    };
  }

  async *apply(plan: DeploymentPlan): AsyncIterable<DeploymentEvent> {
    if (plan.intent.dryRun) {
      throw new DeploymentApplyError("DRY_RUN_PLAN", "A dry-run deployment plan cannot be applied");
    }

    let activeStage: OnboardingStageId = "validate_moodle_session";
    let prepared: PreparedRelease | null = null;
    let promoted = false;
    let candidateRevision: number | null = null;
    let session: MoodleSessionMaterial | null = null;
    let credentials: DeploymentCredentials | null = null;
    let credentialsBefore: DeploymentCredentials | null = null;
    let secretsUploaded = false;
    let candidate: CandidateRelease | null = null;
    let appliedReceipt: DeploymentReceipt | null = null;

    try {
      yield started(activeStage);
      session = await this.dependencies.sessions.loadValidated(plan.intent.profile, plan.intent.moodleOrigin);
      session = {
        ...session,
        remoteRevision: plan.receipt?.sessionRevision ?? session.remoteRevision,
      };
      yield completed(activeStage);

      activeStage = "check_cloudflare_access";
      yield started(activeStage);
      await this.dependencies.wrangler.checkAccess(plan.intent.accountId);
      yield completed(activeStage);

      activeStage = "prepare_worker_release";
      yield started(activeStage);
      credentialsBefore = await this.dependencies.credentials.read(plan.intent.profile);
      credentials = await this.resolveCredentials(plan, credentialsBefore);
      prepared = await this.dependencies.materializer.prepare(plan, credentials);
      yield completed(activeStage);

      activeStage = "upload_private_credentials";
      yield started(activeStage);
      if (plan.uploadCandidate) {
        await this.dependencies.wrangler.uploadSecrets({
          accountId: plan.intent.accountId,
          workerName: plan.intent.workerName,
          configPath: prepared.wranglerConfigPath,
          secretsFilePath: prepared.secretsFilePath,
        });
        secretsUploaded = true;
      }
      yield completed(activeStage);

      activeStage = "deploy_candidate_version";
      yield started(activeStage);
      if (plan.uploadCandidate) {
        candidate = await this.dependencies.wrangler.uploadCandidate({
          accountId: plan.intent.accountId,
          workerName: plan.intent.workerName,
          configPath: prepared.wranglerConfigPath,
          releaseDigest: plan.intent.releaseDigest,
        });
      }
      yield completed(activeStage);

      activeStage = "upload_moodle_session";
      yield started(activeStage);
      const sessionEndpoint = candidate?.previewEndpoint ?? plan.existing?.productionEndpoint;
      if (!sessionEndpoint) {
        throw new DeploymentApplyError("MISSING_ENDPOINT", "The Worker did not provide a session endpoint");
      }
      const upload = await this.dependencies.worker.putSession({
        endpoint: sessionEndpoint,
        sessionSyncToken: credentials.sessionSyncToken,
        session,
        expectedRevision: session.remoteRevision,
      });
      candidateRevision = upload.revision;
      yield completed(activeStage);

      activeStage = "run_release_checks";
      yield started(activeStage);
      if (candidate) {
        try {
          await this.dependencies.worker.runSmoke({
            endpoint: candidate.previewEndpoint,
            mcpAccessToken: credentials.mcpAccessToken,
            sessionSyncToken: credentials.sessionSyncToken,
          });
        } catch {
          throw new DeploymentApplyError(
            "CANDIDATE_VALIDATION_FAILED",
            "The candidate Worker failed validation; production traffic was not changed",
          );
        }
        await this.dependencies.wrangler.promote({
          accountId: plan.intent.accountId,
          workerName: plan.intent.workerName,
          versionId: candidate.versionId,
        });
        promoted = true;
      }

      const productionEndpoint = candidate?.productionEndpoint ?? plan.existing?.productionEndpoint;
      if (!productionEndpoint) {
        throw new DeploymentApplyError("MISSING_ENDPOINT", "The Worker did not provide a production endpoint");
      }
      try {
        await this.dependencies.worker.runSmoke({
          endpoint: productionEndpoint,
          mcpAccessToken: credentials.mcpAccessToken,
          sessionSyncToken: credentials.sessionSyncToken,
        });
      } catch {
        if (!promoted) {
          throw new DeploymentApplyError("PRODUCTION_VALIDATION_FAILED", "The existing Worker failed validation");
        }
        candidateRevision = await this.rollbackProduction(
          plan,
          credentials,
          session,
          productionEndpoint,
          candidateRevision,
        );
        throw new DeploymentApplyError(
          "PRODUCTION_VALIDATION_FAILED_RESTORED",
          "The previous healthy release was restored with the current credentials and Moodle session",
        );
      }
      appliedReceipt = makeReceipt(plan, candidate, candidateRevision);
      await this.dependencies.receipts.write(appliedReceipt);
      yield completed(activeStage);

      activeStage = "install_local_integrations";
      yield started(activeStage);
      await this.dependencies.renewal.install(plan.intent.profile);
      await this.dependencies.clients.install(plan.intent.profile);
      yield completed(activeStage);
    } catch (error) {
      if (plan.intent.rotateToken && credentialsBefore && !secretsUploaded) {
        await this.dependencies.credentials.write(plan.intent.profile, credentialsBefore);
      }
      if (!appliedReceipt && plan.receipt && candidateRevision !== null) {
        await this.dependencies.receipts.write({ ...plan.receipt, sessionRevision: candidateRevision });
      }
      const safe = asDeploymentError(error);
      yield failed(activeStage, safe.code);
      throw safe;
    } finally {
      if (prepared) {
        await this.dependencies.materializer.cleanup(prepared);
      }
    }
  }

  async inspect(profile: string): Promise<DeploymentStatus> {
    const receipt = await this.dependencies.receipts.read(profile);
    if (!receipt) {
      return {
        profile,
        worker: null,
        credentialsStored: (await this.dependencies.credentials.read(profile)) !== null,
        renewalInstalled: await this.dependencies.renewal.inspect(profile),
        clientsConnected: await this.dependencies.clients.inspect(profile),
        readiness: "unknown",
        readinessReasonCode: null,
        sessionRevision: null,
      };
    }

    const [worker, credentials, renewalInstalled, clientsConnected] = await Promise.all([
      this.dependencies.wrangler.inspect(receipt.accountId, receipt.workerName),
      this.dependencies.credentials.read(profile),
      this.dependencies.renewal.inspect(profile),
      this.dependencies.clients.inspect(profile),
    ]);
    let readiness: DeploymentStatus["readiness"] = "unknown";
    let readinessReasonCode: string | null = null;
    let sessionRevision: number | null = null;
    if (worker && credentials) {
      const remoteReadiness = await this.dependencies.worker.getReadiness({
        endpoint: receipt.productionEndpoint,
        sessionSyncToken: credentials.sessionSyncToken,
      });
      readiness = remoteReadiness.status;
      readinessReasonCode = remoteReadiness.reasonCode;
      sessionRevision = remoteReadiness.revision;
    }
    const resolvedWorker = worker ? { ...worker, productionEndpoint: receipt.productionEndpoint } : null;
    return {
      profile,
      worker: resolvedWorker,
      credentialsStored: credentials !== null,
      renewalInstalled,
      clientsConnected,
      readiness,
      readinessReasonCode,
      sessionRevision,
    };
  }

  async recover(profile: string): Promise<RecoveryResult> {
    const receipt = await this.dependencies.receipts.read(profile);
    if (!receipt) {
      throw new DeploymentApplyError("DEPLOYMENT_NOT_FOUND", `No Moodle MCP deployment exists for profile ${profile}`);
    }
    const [worker, credentials, session] = await Promise.all([
      this.dependencies.wrangler.inspect(receipt.accountId, receipt.workerName),
      this.dependencies.credentials.read(profile),
      this.dependencies.sessions.loadValidated(profile, receipt.moodleOrigin),
    ]);
    if (!worker || !credentials) {
      throw new DeploymentApplyError("DEPLOYMENT_INCOMPLETE", `Deployment state for profile ${profile} is incomplete`);
    }

    let upload = await this.dependencies.worker.putSession({
      endpoint: receipt.productionEndpoint,
      sessionSyncToken: credentials.sessionSyncToken,
      session,
      expectedRevision: receipt.sessionRevision,
    });
    try {
      await this.dependencies.worker.runSmoke({
        endpoint: receipt.productionEndpoint,
        mcpAccessToken: credentials.mcpAccessToken,
        sessionSyncToken: credentials.sessionSyncToken,
      });
      await this.dependencies.receipts.write({ ...receipt, sessionRevision: upload.revision });
      await this.reconcileLocalIntegrations(profile);
      return { status: "ready", versionId: worker.productionVersionId };
    } catch {
      if (!worker.previousHealthyVersionId) {
        throw new DeploymentApplyError("RECOVERY_FAILED", "No previous healthy Worker release is available");
      }
      await this.dependencies.wrangler.restoreProduction({
        accountId: receipt.accountId,
        workerName: receipt.workerName,
        previousVersionId: worker.previousHealthyVersionId,
      });
      upload = await this.dependencies.worker.putSession({
        endpoint: receipt.productionEndpoint,
        sessionSyncToken: credentials.sessionSyncToken,
        session,
        expectedRevision: upload.revision,
      });
      await this.dependencies.worker.runSmoke({
        endpoint: receipt.productionEndpoint,
        mcpAccessToken: credentials.mcpAccessToken,
        sessionSyncToken: credentials.sessionSyncToken,
      });
      await this.dependencies.receipts.write({
        ...receipt,
        productionVersionId: worker.previousHealthyVersionId,
        sessionRevision: upload.revision,
      });
      await this.reconcileLocalIntegrations(profile);
      return { status: "restored", versionId: worker.previousHealthyVersionId };
    }
  }

  async rollback(profile: string): Promise<RollbackResult> {
    const receipt = await this.dependencies.receipts.read(profile);
    if (!receipt) {
      throw new DeploymentApplyError("DEPLOYMENT_NOT_FOUND", `No Moodle MCP deployment exists for profile ${profile}`);
    }
    const [worker, credentials] = await Promise.all([
      this.dependencies.wrangler.inspect(receipt.accountId, receipt.workerName),
      this.dependencies.credentials.read(profile),
    ]);
    if (!worker || !credentials) {
      throw new DeploymentApplyError("DEPLOYMENT_INCOMPLETE", `Deployment state for profile ${profile} is incomplete`);
    }
    const previousVersionId = worker.previousHealthyVersionId;
    if (!previousVersionId) {
      throw new DeploymentApplyError("ROLLBACK_VERSION_MISSING", "No previous healthy Worker release is available");
    }

    await this.dependencies.wrangler.restoreProduction({
      accountId: receipt.accountId,
      workerName: receipt.workerName,
      previousVersionId,
    });
    try {
      await this.dependencies.worker.runSmoke({
        endpoint: receipt.productionEndpoint,
        mcpAccessToken: credentials.mcpAccessToken,
        sessionSyncToken: credentials.sessionSyncToken,
      });
    } catch {
      await this.dependencies.wrangler.restoreProduction({
        accountId: receipt.accountId,
        workerName: receipt.workerName,
        previousVersionId: worker.productionVersionId,
      });
      throw new DeploymentApplyError(
        "ROLLBACK_VALIDATION_FAILED_RESTORED",
        "The previous release failed validation; the current release was restored",
      );
    }

    await this.dependencies.receipts.write({
      ...receipt,
      productionVersionId: previousVersionId,
    });
    return { status: "restored", versionId: previousVersionId };
  }

  async remove(profile: string): Promise<RemovalResult> {
    const receipt = await this.dependencies.receipts.read(profile);
    if (!receipt) {
      await this.removeLocalState(profile);
      return { profile, workerRemoved: false, localStateRemoved: true };
    }
    const worker = await this.dependencies.wrangler.inspect(receipt.accountId, receipt.workerName);
    if (worker && worker.ownershipTag !== receipt.deploymentId) {
      throw new DeploymentApplyError(
        "REMOVAL_SCOPE_MISMATCH",
        `Worker ${receipt.workerName} no longer belongs to profile ${profile}`,
      );
    }

    await this.dependencies.clients.remove(profile);
    await this.dependencies.renewal.remove(profile);
    if (worker) {
      await this.dependencies.wrangler.removeWorker({
        accountId: receipt.accountId,
        workerName: receipt.workerName,
        deploymentId: receipt.deploymentId,
      });
    }
    await this.dependencies.credentials.delete(profile);
    await this.dependencies.receipts.delete(profile);
    return { profile, workerRemoved: worker !== null, localStateRemoved: true };
  }

  private async resolveCredentials(
    plan: DeploymentPlan,
    existing: DeploymentCredentials | null,
  ): Promise<DeploymentCredentials> {
    const credentials = plan.intent.rotateToken && existing
      ? rotateCredentials(existing, this.dependencies.createToken)
      : existing ?? createDeploymentCredentials(this.dependencies.createToken);
    await this.dependencies.credentials.write(plan.intent.profile, credentials);
    return credentials;
  }

  private async rollbackProduction(
    plan: DeploymentPlan,
    credentials: DeploymentCredentials,
    session: MoodleSessionMaterial,
    productionEndpoint: string,
    revision: number | null,
  ): Promise<number> {
    await this.dependencies.wrangler.restoreProduction({
      accountId: plan.intent.accountId,
      workerName: plan.intent.workerName,
      previousVersionId: plan.existing?.productionVersionId ?? null,
    });
    const upload = await this.dependencies.worker.putSession({
      endpoint: productionEndpoint,
      sessionSyncToken: credentials.sessionSyncToken,
      session,
      expectedRevision: revision,
    });
    await this.dependencies.worker.runSmoke({
      endpoint: productionEndpoint,
      mcpAccessToken: credentials.mcpAccessToken,
      sessionSyncToken: credentials.sessionSyncToken,
    });
    return upload.revision;
  }

  private async reconcileLocalIntegrations(profile: string): Promise<void> {
    await this.dependencies.renewal.install(profile);
    await this.dependencies.clients.install(profile);
  }

  private async removeLocalState(profile: string): Promise<void> {
    await this.dependencies.clients.remove(profile);
    await this.dependencies.renewal.remove(profile);
    await this.dependencies.credentials.delete(profile);
    await this.dependencies.receipts.delete(profile);
  }
}

function validateIntent(intent: DeploymentIntent): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(intent.profile)) {
    throw new DeploymentPlanError("INVALID_INTENT", "Profile names must use letters, numbers, underscores, or hyphens");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(intent.workerName)) {
    throw new DeploymentPlanError("INVALID_INTENT", "Worker name is invalid");
  }
  try {
    const origin = new URL(intent.moodleOrigin);
    if (origin.protocol !== "https:" || origin.pathname !== "/") {
      throw new Error("invalid origin");
    }
  } catch {
    throw new DeploymentPlanError("INVALID_INTENT", "Moodle origin must be an HTTPS root URL");
  }
  if (!intent.accountId || !intent.releaseDigest) {
    throw new DeploymentPlanError("INVALID_INTENT", "Cloudflare account and release digest are required");
  }
}

function isOwnedByProfile(
  worker: RemoteWorker,
  receipt: DeploymentReceipt | null,
  profile: string,
): boolean {
  return receipt
    ? receipt.accountId === worker.accountId
      && receipt.workerName === worker.workerName
      && receipt.deploymentId === worker.ownershipTag
    : worker.ownershipTag === `moodle-cli:${profile}`;
}

function makeReceipt(
  plan: DeploymentPlan,
  candidate: CandidateRelease | null,
  sessionRevision: number | null,
): DeploymentReceipt {
  if (sessionRevision === null) {
    throw new DeploymentApplyError("MISSING_SESSION_REVISION", "The deployment did not produce a session revision");
  }
  if (candidate) {
    return {
      profile: plan.intent.profile,
      accountId: plan.intent.accountId,
      workerName: plan.intent.workerName,
      moodleOrigin: plan.intent.moodleOrigin,
      deploymentId: candidate.deploymentId,
      productionEndpoint: candidate.productionEndpoint,
      productionVersionId: candidate.versionId,
      releaseDigest: plan.intent.releaseDigest,
      sessionRevision,
    };
  }
  if (!plan.existing) {
    throw new DeploymentApplyError("MISSING_RECEIPT", "The deployment did not produce a Worker receipt");
  }
  return {
    profile: plan.intent.profile,
    accountId: plan.existing.accountId,
    workerName: plan.existing.workerName,
    moodleOrigin: plan.intent.moodleOrigin,
    deploymentId: plan.existing.deploymentId,
    productionEndpoint: plan.existing.productionEndpoint,
    productionVersionId: plan.existing.productionVersionId,
    releaseDigest: plan.existing.releaseDigest,
    sessionRevision,
  };
}

function started(stageId: OnboardingStageId): DeploymentEvent {
  return event(stageId, "started");
}

function completed(stageId: OnboardingStageId): DeploymentEvent {
  return event(stageId, "completed");
}

function failed(stageId: OnboardingStageId, code: string): DeploymentEvent {
  return { ...event(stageId, "failed"), code };
}

function event(stageId: OnboardingStageId, status: DeploymentEvent["status"]): DeploymentEvent {
  const stage = ONBOARDING_STAGES.find((item) => item.id === stageId);
  if (!stage) {
    throw new Error(`Unknown onboarding stage: ${stageId}`);
  }
  return { stageId, stage: stage.index, total: 8, label: stage.label, status };
}

function asDeploymentError(error: unknown): DeploymentApplyError {
  if (error instanceof DeploymentApplyError) {
    return error;
  }
  return new DeploymentApplyError("DEPLOYMENT_FAILED", "The managed Moodle MCP deployment failed");
}
