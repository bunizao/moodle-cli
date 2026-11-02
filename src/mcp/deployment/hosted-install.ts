import { createHash } from "node:crypto";
import { CliError } from "../../errors.js";
import { createDeploymentCredentials, type DeploymentCredentials } from "../credentials/index.js";
import {
  DeploymentApplyError,
  DeploymentPlanError,
  stageEvent,
  type DeploymentCredentialRepository,
  type DeploymentEvent,
  type DeploymentReceipt,
  type DeploymentReceiptStore,
  type LocalDeploymentIntegration,
  type ManagedWorkerClient,
  type MoodleSessionMaterial,
  type MoodleSessionSource,
} from "./managed-deployment.js";
import type { OnboardingStageId } from "./onboarding.js";

// Appended to the host's own migrations; a tag only has to be unique within that list.
export const HOST_MIGRATION_TAG = "moodle-cli-v1";

export interface HostedInstallIntent {
  profile: string;
  accountId: string;
  /** The existing Worker that imports `moodle-cli/worker`. */
  hostWorker: string;
  /** The host's public origin, such as https://unicorn.example.workers.dev. */
  hostUrl: string;
  basePath: string;
  moodleOrigin: string;
  releaseDigest: string;
  remoteLogin?: boolean;
}

export interface HostedInstallPlan {
  intent: HostedInstallIntent;
  operation: "create" | "update";
  /** Where every CLI command reaches the server: the host URL plus the base path. */
  endpoint: string;
  secretNames: string[];
  wranglerFragment: HostWranglerFragment;
}

export interface HostWranglerFragment {
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  browser: { binding: string };
}

export interface HostSecretUploader {
  checkAccess(accountId: string): Promise<void>;
  hostExists(accountId: string, workerName: string): Promise<boolean>;
  /** Writes every secret in one Wrangler call against the named Worker; never deploys code. */
  putHostSecrets(input: { accountId: string; workerName: string; secrets: Record<string, string> }): Promise<void>;
}

export interface HostedInstallDependencies {
  wrangler: HostSecretUploader;
  credentials: DeploymentCredentialRepository;
  sessions: MoodleSessionSource;
  worker: ManagedWorkerClient;
  renewal: LocalDeploymentIntegration;
  clients: LocalDeploymentIntegration;
  receipts: DeploymentReceiptStore;
  createToken: () => string;
}

const SECRET_NAMES = [
  "MOODLE_ORIGIN",
  "EXPECTED_HOST",
  "EXPECTED_HOSTS",
  "MCP_ACCESS_TOKEN_DIGEST",
  "MCP_ACCESS_TOKEN_PREVIOUS_DIGEST",
  "SESSION_SYNC_TOKEN_DIGEST",
  "SESSION_SYNC_TOKEN_PREVIOUS_DIGEST",
  "TOKEN_OVERLAP_EXPIRES_AT",
  "SESSION_ENCRYPTION_KEY",
  "SESSION_ENCRYPTION_KEY_PREVIOUS",
  "SESSION_CREDENTIAL_ID",
] as const;

// Static on purpose: everything that changes with credentials or the site goes in as
// secrets, so the host commits this once and never edits it on a rotation.
export function hostWranglerFragment(): HostWranglerFragment {
  return {
    durable_objects: {
      bindings: [
        { name: "SESSION_BROKER", class_name: "SessionBroker" },
        { name: "AUTH_BROKER", class_name: "AuthBroker" },
      ],
    },
    migrations: [{ tag: HOST_MIGRATION_TAG, new_sqlite_classes: ["SessionBroker", "AuthBroker"] }],
    browser: { binding: "BROWSER" },
  };
}

export function planHostedInstall(intent: HostedInstallIntent, receipt: DeploymentReceipt | null): HostedInstallPlan {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(intent.hostWorker)) {
    throw new DeploymentPlanError("INVALID_INTENT", "Host Worker name is invalid");
  }
  if (!/^(?:\/[A-Za-z0-9._~-]+)+$/u.test(intent.basePath) || /\/\.\.?(?:\/|$)/u.test(intent.basePath)) {
    throw new DeploymentPlanError("INVALID_INTENT", "The base path must look like /moodle: absolute, no trailing slash");
  }
  let host: URL;
  try {
    host = new URL(intent.hostUrl);
  } catch {
    throw new DeploymentPlanError("INVALID_INTENT", "The host URL is invalid");
  }
  if (host.protocol !== "https:" || host.pathname !== "/" || host.search || host.hash || host.username || host.password) {
    throw new DeploymentPlanError("INVALID_INTENT", "The host URL must be an HTTPS origin, such as https://unicorn.example.workers.dev");
  }
  if (receipt && !receipt.host) {
    throw new DeploymentPlanError("INVALID_INTENT", `Profile ${intent.profile} already has its own Worker ${receipt.workerName}; run moodle mcp remove first`);
  }
  return {
    intent: { ...intent, hostUrl: host.origin },
    operation: receipt ? "update" : "create",
    endpoint: `${host.origin}${intent.basePath}`,
    secretNames: [...SECRET_NAMES],
    wranglerFragment: hostWranglerFragment(),
  };
}

export function hostedSecrets(plan: HostedInstallPlan, credentials: DeploymentCredentials): Record<string, string> {
  const host = new URL(plan.intent.hostUrl).host;
  return {
    MOODLE_ORIGIN: plan.intent.moodleOrigin,
    EXPECTED_HOST: host,
    EXPECTED_HOSTS: host,
    MCP_ACCESS_TOKEN_DIGEST: digest(credentials.mcpAccessToken),
    MCP_ACCESS_TOKEN_PREVIOUS_DIGEST: "",
    SESSION_SYNC_TOKEN_DIGEST: digest(credentials.sessionSyncToken),
    SESSION_SYNC_TOKEN_PREVIOUS_DIGEST: "",
    TOKEN_OVERLAP_EXPIRES_AT: "0",
    SESSION_ENCRYPTION_KEY: credentials.sessionEncryptionKey,
    SESSION_ENCRYPTION_KEY_PREVIOUS: credentials.previousSessionEncryptionKey ?? "",
    SESSION_CREDENTIAL_ID: credentialId(credentials),
  };
}

// Filled in while the install runs, since an event stream has no return value to read.
export interface HostedInstallResult {
  /** False until the host is deployed with the fragment; `moodle mcp login` finishes then. */
  serving: boolean;
  moodleUser: string | null;
}

// Puts secrets into a Worker someone else deploys. If that Worker already serves
// the routes, the Moodle session goes up and the same checks as a standalone deploy run;
// otherwise the receipt is kept so `moodle mcp login` can finish after the host deploys.
export async function* applyHostedInstall(
  plan: HostedInstallPlan,
  dependencies: HostedInstallDependencies,
  result: HostedInstallResult,
): AsyncGenerator<DeploymentEvent> {
  const { intent } = plan;
  let stage: OnboardingStageId = "validate_moodle_session";
  try {
    let session: MoodleSessionMaterial | null = null;
    if (intent.remoteLogin) {
      yield stageEvent(stage, "skipped");
    } else {
      yield stageEvent(stage, "started");
      session = await dependencies.sessions.loadValidated(intent.profile, intent.moodleOrigin);
      yield stageEvent(stage, "completed");
    }

    stage = "check_cloudflare_access";
    yield stageEvent(stage, "started");
    await dependencies.wrangler.checkAccess(intent.accountId);
    if (!await dependencies.wrangler.hostExists(intent.accountId, intent.hostWorker)) {
      throw new DeploymentApplyError("HOST_WORKER_MISSING", `Worker ${intent.hostWorker} does not exist; deploy the host Worker once before installing into it`);
    }
    yield stageEvent(stage, "completed");

    stage = "prepare_worker_release";
    yield stageEvent(stage, "started");
    const previous = await dependencies.receipts.read(intent.profile);
    let credentials = await dependencies.credentials.read(intent.profile);
    if (!credentials) {
      credentials = createDeploymentCredentials(dependencies.createToken);
      await dependencies.credentials.write(intent.profile, credentials);
    }
    const secrets = hostedSecrets(plan, credentials);
    yield stageEvent(stage, "completed");

    stage = "upload_private_credentials";
    yield stageEvent(stage, "started");
    await dependencies.wrangler.putHostSecrets({ accountId: intent.accountId, workerName: intent.hostWorker, secrets });
    const receipt: DeploymentReceipt = {
      profile: intent.profile,
      accountId: intent.accountId,
      workerName: intent.hostWorker,
      moodleOrigin: intent.moodleOrigin,
      deploymentId: `moodle-cli-host:${intent.accountId}:${intent.hostWorker}${intent.basePath}`,
      productionEndpoint: plan.endpoint,
      // The host owns its versions; this CLI never promotes or rolls them back.
      productionVersionId: "",
      releaseDigest: intent.releaseDigest,
      sessionRevision: previous?.sessionRevision ?? 0,
      verified: false,
      host: { url: intent.hostUrl, basePath: intent.basePath },
    };
    // Written now so login, status and renewal know the endpoint even before the host deploys.
    await dependencies.receipts.write(receipt);
    yield stageEvent(stage, "completed");

    stage = "deploy_candidate_version";
    yield stageEvent(stage, "skipped");

    const target = { endpoint: plan.endpoint, sessionSyncToken: credentials.sessionSyncToken };
    result.serving = await dependencies.worker.isServing?.(plan.endpoint) ?? false;

    stage = "upload_moodle_session";
    if (!result.serving || !session) {
      yield stageEvent(stage, "skipped");
    } else {
      yield stageEvent(stage, "started");
      const current = await dependencies.worker.getReadiness(target);
      receipt.sessionRevision = (await dependencies.worker.putSession({ ...target, session, expectedRevision: current.revision })).revision;
      await dependencies.receipts.write(receipt);
      yield stageEvent(stage, "completed");
    }

    stage = "run_release_checks";
    if (!result.serving) {
      yield stageEvent(stage, "skipped");
    } else {
      yield stageEvent(stage, "started");
      const release = { ...target, expectedCredentialId: secrets.SESSION_CREDENTIAL_ID };
      if (session) result.moodleUser = (await dependencies.worker.runSmoke({ ...release, mcpAccessToken: credentials.mcpAccessToken })).moodleUser;
      else await dependencies.worker.checkRemoteLogin(release);
      receipt.verified = true;
      await dependencies.receipts.write(receipt);
      yield stageEvent(stage, "completed", result.moodleUser ? { moodleUser: result.moodleUser } : undefined);
    }

    stage = "install_local_integrations";
    if (intent.remoteLogin) {
      yield stageEvent(stage, "skipped");
    } else {
      yield stageEvent(stage, "started");
      await dependencies.renewal.install(intent.profile);
      await dependencies.clients.install(intent.profile);
      yield stageEvent(stage, "completed");
    }
  } catch (error) {
    const code = error instanceof DeploymentApplyError ? error.code : "DEPLOYMENT_FAILED";
    yield { ...stageEvent(stage, "failed"), code };
    // Auth and config failures already carry their fix in the hint.
    if (error instanceof DeploymentApplyError || error instanceof CliError) throw error;
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new DeploymentApplyError("DEPLOYMENT_FAILED", `Installing into the host Worker failed${detail}`, { cause: error });
  }
}

function credentialId(credentials: DeploymentCredentials): string {
  return digest(`${credentials.mcpAccessToken}:${credentials.sessionSyncToken}`).slice(0, 16);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
