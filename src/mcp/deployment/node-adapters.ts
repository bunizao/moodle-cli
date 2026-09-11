import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  getAuthenticatedSession,
  getAuthenticatedSessionWithBrowserFallback,
  type BrowserLoginOptions,
} from "../../auth.js";
import { VERSION } from "../../version.js";
import { DefaultClientIntegration, type DefaultConnectorOptions } from "../connectors/index.js";
import { createDefaultCredentialStore, type DeploymentCredentials } from "../credentials/index.js";
import { DefaultRenewalIntegration, type DefaultRenewalOptions } from "../renewal/index.js";
import {
  DeploymentApplyError,
  ManagedMcpDeployment,
  type CandidateRelease,
  type DeploymentPlan,
  type DeploymentReceipt,
  type DeploymentReceiptStore,
  type ManagedMcpDeploymentDependencies,
  type ManagedWorkerClient,
  type MoodleSessionMaterial,
  type MoodleSessionSource,
  type PreparedRelease,
  type ReleaseMaterializer,
  type RemoteWorker,
  type WranglerDeploymentAdapter,
  type WorkerReadiness,
  type WorkerPairing,
  type WorkerSmokeResult,
} from "./managed-deployment.js";

const MODERN_MCP_VERSION = "2026-07-28";
const WORKER_PROPAGATION_ATTEMPTS = 10;
const WORKER_PROPAGATION_MAX_DELAY_MS = 4_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface DeploymentCommandRunner {
  run(command: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<CommandResult>;
}

export class NodeDeploymentCommandRunner implements DeploymentCommandRunner {
  async run(command: string, args: string[], environment: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new WranglerCommandError(code, stdout, stderr));
      });
    });
  }
}

export class WranglerCommandError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super("Packaged Wrangler command failed");
    this.name = "WranglerCommandError";
  }
}

export interface NodeWranglerOptions {
  wranglerBinPath?: string;
  runner?: DeploymentCommandRunner;
}

export interface WranglerAccount {
  id: string;
  name: string;
}

export class NodeWranglerDeploymentAdapter implements WranglerDeploymentAdapter {
  readonly atomicSecrets = true;
  private readonly wranglerBinPath: string;
  private readonly runner: DeploymentCommandRunner;

  constructor(options: NodeWranglerOptions = {}) {
    this.wranglerBinPath = options.wranglerBinPath ?? resolvePackagedWranglerBin();
    this.runner = options.runner ?? new NodeDeploymentCommandRunner();
  }

  async listAccounts(): Promise<WranglerAccount[]> {
    const result = await this.wrangler(["whoami", "--json"]);
    const document = parseJsonOutput(result.stdout);
    return collectAccountObjects(document);
  }

  async login(): Promise<void> {
    await this.wrangler(["login"]);
  }

  async checkAccess(accountId: string): Promise<void> {
    const accountIds = (await this.listAccounts()).map((account) => account.id);
    if (!accountIds.length) {
      throw new DeploymentApplyError("CLOUDFLARE_AUTH_REQUIRED", "Wrangler requires Cloudflare authorization");
    }
    if (!accountIds.includes(accountId)) {
      throw new DeploymentApplyError("CLOUDFLARE_ACCOUNT_MISSING", "Wrangler is not authorized for the selected Cloudflare account");
    }
  }

  async inspect(accountId: string, workerName: string): Promise<RemoteWorker | null> {
    let result: CommandResult;
    try {
      result = await this.wrangler([
        "deployments",
        "list",
        "--name",
        workerName,
        "--json",
      ], accountId);
    } catch (error) {
      if (error instanceof WranglerCommandError && /not found|does not exist|no deployments/iu.test(`${error.stdout}\n${error.stderr}`)) {
        return null;
      }
      throw error;
    }
    const document = parseJsonOutput(result.stdout);
    const history = Array.isArray(document)
      ? [...document].reverse().sort((left, right) => Date.parse(right.created_on ?? "") - Date.parse(left.created_on ?? ""))
      : [document];
    const versionIds = history.flatMap((entry) => deploymentVersionIds(entry));
    if (!versionIds.length) {
      return null;
    }
    const productionEndpoint = firstWorkersDevUrl(document) ?? `https://${workerName}.workers.dev`;
    const deploymentId = ownershipId(accountId, workerName);
    return {
      accountId,
      workerName,
      deploymentId,
      ownershipTag: deploymentId,
      productionEndpoint,
      productionVersionId: versionIds[0]!,
      previousHealthyVersionId: versionIds[1] ?? null,
      releaseDigest: releaseDigestFromDocument(document) ?? "",
    };
  }

  async uploadSecrets(input: {
    accountId: string;
    workerName: string;
    configPath: string;
    secretsFilePath: string;
  }): Promise<void> {
    await this.wrangler([
      "secret",
      "bulk",
      input.secretsFilePath,
      "--name",
      input.workerName,
      "--config",
      input.configPath,
    ], input.accountId);
  }

  async initializeWorker(input: {
    accountId: string;
    workerName: string;
    configPath: string;
    secretsFilePath?: string;
    releaseDigest: string;
  }): Promise<RemoteWorker> {
    let result: CommandResult | null = null;
    try {
      result = await this.wrangler([
        "deploy",
        "--name",
        input.workerName,
        "--config",
        input.configPath,
        "--message",
        `moodle-cli-bootstrap:${input.releaseDigest}`,
        ...(input.secretsFilePath ? ["--secrets-file", input.secretsFilePath] : []),
      ], input.accountId);
      const worker = await this.inspect(input.accountId, input.workerName);
      if (!worker) {
        throw new DeploymentApplyError("INITIAL_WORKER_INVALID", "Wrangler did not return the initialized Worker");
      }
      const productionEndpoint = firstWorkersDevUrl([result.stdout, result.stderr]);
      return productionEndpoint ? { ...worker, productionEndpoint } : worker;
    } catch (error) {
      const worker = await this.inspect(input.accountId, input.workerName).catch(() => null);
      if (worker || result) {
        await this.removeWorker({
          accountId: input.accountId,
          workerName: input.workerName,
          deploymentId: ownershipId(input.accountId, input.workerName),
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async uploadCandidate(input: {
    accountId: string;
    workerName: string;
    configPath: string;
    secretsFilePath?: string;
    releaseDigest: string;
    productionEndpoint: string;
  }): Promise<CandidateRelease> {
    // Durable Object lifecycle changes require an atomic deploy, never versions upload.
    const result = await this.wrangler([
      "deploy", "--name", input.workerName, "--config", input.configPath,
      "--message", `moodle-cli-release:${input.releaseDigest}`,
      ...(input.secretsFilePath ? ["--secrets-file", input.secretsFilePath] : []),
    ], input.accountId);
    const versionFromOutput = result.stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/iu)?.[1];
    const active = versionFromOutput ? null : await this.inspect(input.accountId, input.workerName);
    if (!versionFromOutput && !active) throw new DeploymentApplyError("CANDIDATE_UPLOAD_INVALID", "The deployed Worker version could not be verified");
    return {
      versionId: versionFromOutput ?? active!.productionVersionId,
      previewEndpoint: null,
      alreadyDeployed: true,
      productionEndpoint: firstWorkersDevUrl([result.stdout, result.stderr]) ?? input.productionEndpoint,
      deploymentId: ownershipId(input.accountId, input.workerName),
    };
  }

  async deployRecovery(input: { accountId: string; workerName: string; configPath: string; secretsFilePath: string; releaseDigest: string; productionEndpoint: string }): Promise<CandidateRelease> {
    return this.uploadCandidate(input);
  }

  async promote(input: { accountId: string; workerName: string; versionId: string }): Promise<void> {
    await this.wrangler([
      "versions",
      "deploy",
      `${input.versionId}@100`,
      "--name",
      input.workerName,
      "--yes",
    ], input.accountId);
  }

  async restoreProduction(input: {
    accountId: string;
    workerName: string;
    previousVersionId: string | null;
  }): Promise<void> {
    if (input.previousVersionId) {
      const result = await this.wrangler(["versions", "view", input.previousVersionId, "--name", input.workerName, "--json"], input.accountId);
      const document = parseJsonOutput(result.stdout);
      const binding = (value: unknown, name: string): string | null => {
        let result: string | null = null;
        visit(value, (_key, item) => {
          if (isRecord(item) && item.name === name && typeof item.text === "string") result = item.text;
        });
        return result;
      };
      let compatible = binding(document, "SESSION_SCHEMA_VERSION") === "2";
      if (compatible) {
        const active = await this.inspect(input.accountId, input.workerName);
        if (!active) compatible = false;
        else {
          const current = await this.wrangler(["versions", "view", active.productionVersionId, "--name", input.workerName, "--json"], input.accountId);
          const currentKey = binding(parseJsonOutput(current.stdout), "SESSION_KEY_ID");
          const currentDocument = parseJsonOutput(current.stdout);
          const currentCredentials = binding(currentDocument, "SESSION_CREDENTIAL_ID");
          compatible = Boolean(currentKey && currentKey === binding(document, "SESSION_KEY_ID")
            && currentCredentials && currentCredentials === binding(document, "SESSION_CREDENTIAL_ID"));
        }
      }
      if (!compatible) throw new DeploymentApplyError("ROLLBACK_INCOMPATIBLE", "The previous version cannot read the encrypted session schema. Use deploy --repair to recover without losing session data.");
      await this.promote({
        accountId: input.accountId,
        workerName: input.workerName,
        versionId: input.previousVersionId,
      });
      return;
    }
    await this.wrangler(["delete", input.workerName, "--force"], input.accountId);
  }

  async removeWorker(input: { accountId: string; workerName: string; deploymentId: string }): Promise<void> {
    if (input.deploymentId !== ownershipId(input.accountId, input.workerName)) {
      throw new DeploymentApplyError("REMOVAL_SCOPE_MISMATCH", "The Worker removal receipt is invalid");
    }
    await this.wrangler(["delete", input.workerName, "--force"], input.accountId);
  }

  private wrangler(
    args: string[],
    accountId?: string,
    environmentOverrides: NodeJS.ProcessEnv = {},
  ): Promise<CommandResult> {
    const environment = { ...environmentOverrides };
    if (accountId) {
      environment.CLOUDFLARE_ACCOUNT_ID = accountId;
    }
    return this.runner.run(
      process.execPath,
      [this.wranglerBinPath, ...args],
      Object.keys(environment).length ? environment : undefined,
    );
  }
}

export interface NodeReleaseMaterializerOptions {
  workerBundlePath: string;
  compatibilityDate: string;
  temporaryRoot?: string;
}

export class NodeReleaseMaterializer implements ReleaseMaterializer {
  constructor(private readonly options: NodeReleaseMaterializerOptions) {}

  async prepare(plan: DeploymentPlan, credentials: DeploymentCredentials): Promise<PreparedRelease> {
    const temporaryRoot = this.options.temporaryRoot ?? tmpdir();
    await mkdir(temporaryRoot, { recursive: true });
    const artifactDirectory = await mkdtemp(join(temporaryRoot, "moodle-mcp-"));
    await chmod(artifactDirectory, 0o700);
    const workerFile = join(artifactDirectory, basename(this.options.workerBundlePath));
    await copyFile(this.options.workerBundlePath, workerFile);
    const wranglerConfigPath = join(artifactDirectory, "wrangler.json");
    const secretsFilePath = join(artifactDirectory, "secrets.json");
    const config = {
      $schema: "node_modules/wrangler/config-schema.json",
      name: plan.intent.workerName,
      account_id: plan.intent.accountId,
      main: `./${basename(workerFile)}`,
      compatibility_date: this.options.compatibilityDate,
      preview_urls: false,
      observability: { enabled: false },
      vars: { MOODLE_ORIGIN: plan.intent.moodleOrigin, SESSION_SCHEMA_VERSION: "2", SESSION_KEY_ID: digest(credentials.sessionEncryptionKey).slice(0, 16), SESSION_CREDENTIAL_ID: digest(`${credentials.mcpAccessToken}:${credentials.sessionSyncToken}`).slice(0, 16) },
      durable_objects: {
        bindings: [
          { name: "SESSION_BROKER", class_name: "SessionBroker" },
          { name: "AUTH_BROKER", class_name: "AuthBroker" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["SessionBroker"] },
        { tag: "v2", new_sqlite_classes: ["AuthBroker"] },
      ],
    };
    const secrets: Record<string, string> = {
      MCP_ACCESS_TOKEN_DIGEST: digest(credentials.mcpAccessToken),
      SESSION_SYNC_TOKEN_DIGEST: digest(credentials.sessionSyncToken),
      SESSION_ENCRYPTION_KEY: credentials.sessionEncryptionKey,
      SESSION_ENCRYPTION_KEY_PREVIOUS: credentials.previousSessionEncryptionKey ?? "",
      MCP_ACCESS_TOKEN_PREVIOUS_DIGEST: "",
      SESSION_SYNC_TOKEN_PREVIOUS_DIGEST: "",
      TOKEN_OVERLAP_EXPIRES_AT: "0",
    };
    if (credentials.previousMcpAccessToken) {
      secrets.MCP_ACCESS_TOKEN_PREVIOUS_DIGEST = digest(credentials.previousMcpAccessToken);
    }
    if (credentials.previousSessionSyncToken) {
      secrets.SESSION_SYNC_TOKEN_PREVIOUS_DIGEST = digest(credentials.previousSessionSyncToken);
    }
    if (
      credentials.previousTokensExpireAt !== undefined
      && Number.isFinite(credentials.previousTokensExpireAt)
    ) {
      secrets.TOKEN_OVERLAP_EXPIRES_AT = String(credentials.previousTokensExpireAt);
    }
    await writeFile(wranglerConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await writeFile(secretsFilePath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
    await chmod(wranglerConfigPath, 0o600);
    await chmod(secretsFilePath, 0o600);
    let recoveryConfigPath: string | undefined;
    try {
      const recoveryBundle = join(dirname(this.options.workerBundlePath), "recovery.js");
      await copyFile(recoveryBundle, join(artifactDirectory, "recovery.js"));
      recoveryConfigPath = join(artifactDirectory, "wrangler-recovery.json");
      await writeFile(recoveryConfigPath, `${JSON.stringify({ ...config, main: "./recovery.js" })}\n`, { mode: 0o600 });
    } catch (error) {
      if (!isMissing(error) || plan.existing) throw error;
    }
    return { artifactDirectory, wranglerConfigPath, secretsFilePath, recoveryConfigPath, encryptionKeyId: config.vars.SESSION_KEY_ID, credentialId: config.vars.SESSION_CREDENTIAL_ID };
  }

  async cleanup(release: PreparedRelease): Promise<void> {
    await rm(release.artifactDirectory, { recursive: true, force: true });
  }
}

export interface DefaultMoodleSessionSourceOptions extends BrowserLoginOptions {
  interactive?: boolean;
}

export class DefaultMoodleSessionSource implements MoodleSessionSource {
  constructor(private readonly options: DefaultMoodleSessionSourceOptions = {}) {}

  async loadValidated(_profile: string, moodleOrigin: string): Promise<MoodleSessionMaterial> {
    const session = this.options.interactive === false
      ? await getAuthenticatedSession(moodleOrigin, { ...this.options, nonInteractive: true })
      : await getAuthenticatedSessionWithBrowserFallback(moodleOrigin, this.options);
    return {
      moodleOrigin,
      cookieName: session.cookie.name,
      cookieValue: session.cookie.value,
      fingerprint: digest(`${session.cookie.name}\0${session.cookie.value}`),
      remoteRevision: null,
    };
  }
}

export function createInteractiveMoodleSessionSource(
  options: BrowserLoginOptions = {},
): DefaultMoodleSessionSource {
  return new DefaultMoodleSessionSource({ ...options, interactive: true });
}

export function createBackgroundMoodleSessionSource(
  options: BrowserLoginOptions = {},
): DefaultMoodleSessionSource {
  return new DefaultMoodleSessionSource({ ...options, interactive: false });
}

export class FetchManagedWorkerClient implements ManagedWorkerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    fetchImpl?: typeof fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    const fetcher = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.fetchImpl = (input, init) => fetcher(input, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(30_000) });
  }

  async putSession(input: {
    endpoint: string;
    sessionSyncToken: string;
    session: MoodleSessionMaterial;
    expectedRevision: number | null;
  }): Promise<{ revision: number }> {
    const response = await this.fetchWithRetry(endpointUrl(input.endpoint, "/session"), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${input.sessionSyncToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        moodleOrigin: input.session.moodleOrigin,
        cookieName: input.session.cookieName,
        cookieValue: input.session.cookieValue,
        expectedRevision: input.expectedRevision,
      }),
    }, isRetryableSessionUpload);
    const body = await safeJson(response);
    if (response.ok && isRecord(body) && typeof body.revision === "number") {
      return { revision: body.revision };
    }
    const code = isRecord(body) && typeof body.code === "string" ? body.code : "SESSION_UPLOAD_FAILED";
    throw new DeploymentApplyError(code, "The Worker rejected the Moodle session update");
  }

  async getReadiness(input: { endpoint: string; sessionSyncToken: string }): Promise<WorkerReadiness> {
    const response = await this.fetchWithRetry(endpointUrl(input.endpoint, "/readyz"), {
      headers: { authorization: `Bearer ${input.sessionSyncToken}` },
    }, isRetryableSessionUpload);
    const body = await safeJson(response);
    if (isRecord(body) && (body.status === "pass" || body.status === "warn" || body.status === "fail")) {
      const session = firstHealthCheck(body, "moodle:session");
      const upstream = firstHealthCheck(body, "moodle:upstream");
      return {
        status: body.status,
        reasonCode: upstream?.code === "MOODLE_UNREACHABLE"
          ? "MOODLE_UNREACHABLE"
          : typeof session?.code === "string"
            ? session.code
            : null,
        revision: typeof session?.revision === "number" ? session.revision : null,
        ...(typeof body.sessionSchemaVersion === "number" ? { sessionSchemaVersion: body.sessionSchemaVersion } : {}),
        ...(typeof body.encryptionKeyId === "string" ? { encryptionKeyId: body.encryptionKeyId } : {}),
        ...(typeof body.credentialId === "string" ? { credentialId: body.credentialId } : {}),
      };
    }
    return { status: "fail", reasonCode: null, revision: null };
  }

  async runSmoke(input: {
    endpoint: string;
    mcpAccessToken: string;
    sessionSyncToken: string;
    expectedSessionSchemaVersion?: number;
    expectedEncryptionKeyId?: string;
    expectedCredentialId?: string;
  }): Promise<WorkerSmokeResult> {
    const health = await this.fetchWithRetry(
      endpointUrl(input.endpoint, "/healthz"),
      undefined,
      isRetryableWorkerPropagation,
    );
    const healthBody = await safeJson(health);
    if (!health.ok || !isRecord(healthBody) || healthBody.status !== "pass") {
      throw new DeploymentApplyError("HEALTH_CHECK_FAILED", "Worker liveness check failed");
    }
    let readiness = await this.getReadiness(input);
    const matchesRelease = () => (input.expectedSessionSchemaVersion === undefined || readiness.sessionSchemaVersion === input.expectedSessionSchemaVersion)
      && (input.expectedEncryptionKeyId === undefined || readiness.encryptionKeyId === input.expectedEncryptionKeyId)
      && (input.expectedCredentialId === undefined || readiness.credentialId === input.expectedCredentialId);
    for (let attempt = 0; !matchesRelease() && attempt < 12; attempt += 1) {
      await this.sleep(1_000);
      readiness = await this.getReadiness(input);
    }
    if (!matchesRelease()) throw new DeploymentApplyError("STATE_PROPAGATION_FAILED", "The expected encrypted session and credentials are not active yet");
    if (readiness.status === "fail") {
      throw new DeploymentApplyError("READINESS_CHECK_FAILED", "Moodle session readiness check failed");
    }
    await this.mcpCall(input.endpoint, input.mcpAccessToken, "server/discover", {}, 1);
    await this.mcpCall(input.endpoint, input.mcpAccessToken, "tools/list", {}, 2);
    const userResult = await this.mcpCall(
      input.endpoint,
      input.mcpAccessToken,
      "tools/call",
      { name: "get_user", arguments: {} },
      3,
    );
    const moodleUser = mcpUserFullname(userResult);
    if (!moodleUser) {
      throw new DeploymentApplyError("MCP_SMOKE_FAILED", "MCP get_user check returned no Moodle user");
    }
    return { moodleUser };
  }

  async manageClients(input: { endpoint: string; sessionSyncToken: string; revoke?: boolean; clientId?: string }): Promise<unknown> {
    const url = new URL(endpointUrl(input.endpoint, "/clients"));
    if (input.clientId) url.searchParams.set("client_id", input.clientId);
    const response = await this.fetchImpl(url.toString(), {
      method: input.revoke ? "DELETE" : "GET",
      headers: { authorization: `Bearer ${input.sessionSyncToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new DeploymentApplyError("OAUTH_MANAGEMENT_FAILED", "The Worker could not manage its OAuth clients");
    return input.revoke ? { status: "revoked", clientId: input.clientId ?? null } : response.json();
  }

  async createPairing(input: { endpoint: string; sessionSyncToken: string }): Promise<WorkerPairing> {
    const response = await this.fetchImpl(endpointUrl(input.endpoint, "/pair"), {
      method: "POST",
      headers: { authorization: `Bearer ${input.sessionSyncToken}` },
    });
    const body = await safeJson(response);
    if (!response.ok || !isRecord(body) || typeof body.code !== "string" || typeof body.expiresAt !== "string") {
      throw new DeploymentApplyError("PAIRING_UNAVAILABLE", "The Worker could not open a pairing window");
    }
    return {
      code: body.code,
      expiresAt: body.expiresAt,
      authorizationServer: typeof body.authorizationServer === "string"
        ? body.authorizationServer
        : new URL(endpointUrl(input.endpoint, "/pair")).origin,
    };
  }

  private async mcpCall(
    endpoint: string,
    token: string,
    method: string,
    params: Record<string, unknown>,
    id: number,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": MODERN_MCP_VERSION,
      "mcp-method": method,
    };
    if (typeof params.name === "string") {
      headers["mcp-name"] = params.name;
    }
    const response = await this.fetchWithRetry(endpointUrl(endpoint, "/mcp"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_MCP_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "moodle-cli-deployment-smoke", version: VERSION },
          },
        },
      }),
    }, isRetryableSessionUpload);
    const body = await safeJson(response);
    if (
      !response.ok
      || !isRecord(body)
      || body.jsonrpc !== "2.0"
      || body.id !== id
      || "error" in body
      || !("result" in body)
    ) {
      throw new DeploymentApplyError("MCP_SMOKE_FAILED", `MCP ${method} check failed`);
    }
    return body.result;
  }

  private async fetchWithRetry(
    input: string,
    init: RequestInit | undefined,
    retryable: (status: number) => boolean,
  ): Promise<Response> {
    for (let attempt = 0; attempt < WORKER_PROPAGATION_ATTEMPTS; attempt += 1) {
      const response = await this.fetchImpl(input, init);
      if (!retryable(response.status) || attempt === WORKER_PROPAGATION_ATTEMPTS - 1) {
        return response;
      }
      await this.sleep(Math.min(500 * 2 ** attempt, WORKER_PROPAGATION_MAX_DELAY_MS));
    }
    throw new Error("Worker propagation retry loop exhausted unexpectedly");
  }
}

export class PrivateDeploymentReceiptStore implements DeploymentReceiptStore {
  constructor(private readonly baseDirectory = join(homedir(), ".config", "moodle-cli", "mcp", "deployments")) {}

  async read(profile: string): Promise<DeploymentReceipt | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(profile), "utf8"));
      return isReceipt(parsed) ? parsed : null;
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async write(receipt: DeploymentReceipt): Promise<void> {
    const path = this.path(receipt.profile);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async delete(profile: string): Promise<void> {
    await rm(this.path(profile), { force: true });
  }

  private path(profile: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
      throw new Error("Invalid Moodle MCP profile name");
    }
    return join(this.baseDirectory, `${profile}.json`);
  }
}

export interface DefaultManagedDeploymentOptions {
  workerBundlePath: string;
  compatibilityDate: string;
  wranglerBinPath?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  executable?: string;
  uid?: number;
  fetch?: typeof fetch;
  auth?: BrowserLoginOptions;
  connector?: Omit<DefaultConnectorOptions, "homeDirectory" | "platform" | "command">;
  renewal?: Omit<DefaultRenewalOptions, "homeDirectory" | "platform" | "executable" | "uid">;
  dependencies?: Partial<ManagedMcpDeploymentDependencies>;
}

export function createDefaultManagedDeployment(options: DefaultManagedDeploymentOptions): ManagedMcpDeployment {
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? process.argv[1] ?? process.execPath;
  const defaults: ManagedMcpDeploymentDependencies = {
    wrangler: new NodeWranglerDeploymentAdapter({ wranglerBinPath: options.wranglerBinPath }),
    materializer: new NodeReleaseMaterializer({
      workerBundlePath: options.workerBundlePath,
      compatibilityDate: options.compatibilityDate,
    }),
    credentials: createDefaultCredentialStore({ platform, homeDirectory }),
    sessions: createInteractiveMoodleSessionSource(options.auth),
    worker: new FetchManagedWorkerClient(options.fetch),
    renewal: new DefaultRenewalIntegration({
      ...options.renewal,
      platform,
      homeDirectory,
      executable,
      uid: options.uid,
    }),
    clients: new DefaultClientIntegration({
      ...options.connector,
      platform,
      homeDirectory,
      command: executable,
    }),
    receipts: new PrivateDeploymentReceiptStore(join(homeDirectory, ".config", "moodle-cli", "mcp", "deployments")),
    createToken: () => randomBytes(32).toString("base64url"),
  };
  return new ManagedMcpDeployment({ ...defaults, ...options.dependencies });
}

export function resolvePackagedWranglerBin(): string {
  const require = createRequire(import.meta.url);
  try {
    return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
  } catch {
    throw new Error("The packaged Wrangler binary is unavailable. Reinstall moodle-cli.");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ownershipId(accountId: string, workerName: string): string {
  return `moodle-cli:${accountId}:${workerName}`;
}

function endpointUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/$/u, "")}${path}`;
}

function isRetryableSessionUpload(status: number): boolean {
  return status === 401 || isRetryableWorkerPropagation(status);
}

function isRetryableWorkerPropagation(status: number): boolean {
  return status === 404 || status === 429 || status >= 500;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function firstHealthCheck(body: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const checks = body.checks;
  if (!isRecord(checks) || !Array.isArray(checks[name])) {
    return null;
  }
  const check = checks[name][0];
  return isRecord(check) ? check : null;
}

function mcpUserFullname(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.structuredContent)) {
    return null;
  }
  const user = result.structuredContent.user;
  return isRecord(user) && typeof user.fullname === "string" && user.fullname.trim()
    ? user.fullname.trim()
    : null;
}

function parseJsonOutput(output: string): unknown {
  const candidates = [output.indexOf("{"), output.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b);
  for (const start of candidates) {
    try {
      return JSON.parse(output.slice(start));
    } catch {
      continue;
    }
  }
  throw new DeploymentApplyError("WRANGLER_OUTPUT_INVALID", "Wrangler returned an unsupported response");
}

function collectStrings(value: unknown, keys: Set<string>): string[] {
  const result: string[] = [];
  visit(value, (key, item) => {
    if (keys.has(key) && typeof item === "string") {
      result.push(item);
    }
  });
  return result;
}

function firstStringForKeys(value: unknown, keys: Set<string>): string | null {
  return collectStrings(value, keys)[0] ?? null;
}

function deploymentVersionIds(value: unknown): string[] {
  const ids = collectStrings(value, new Set(["version_id", "versionId"]));
  return [...new Set(ids)];
}

function releaseDigestFromDocument(value: unknown): string | null {
  let digestValue: string | null = null;
  visit(value, (_key, item) => {
    if (!digestValue && typeof item === "string") {
      const match = item.match(/moodle-cli-release:([a-zA-Z0-9._-]+)/u);
      if (match?.[1]) {
        digestValue = match[1];
      }
    }
  });
  return digestValue;
}

function collectAccountObjects(value: unknown): WranglerAccount[] {
  const accounts: WranglerAccount[] = [];
  visit(value, (_key, item) => {
    if (!isRecord(item)) {
      return;
    }
    const id = typeof item.id === "string"
      ? item.id
      : typeof item.account_id === "string"
        ? item.account_id
        : null;
    const name = typeof item.name === "string" ? item.name : null;
    if (id && name && !accounts.some((account) => account.id === id)) {
      accounts.push({ id, name });
    }
  });
  return accounts;
}

function firstWorkersDevUrl(value: unknown): string | null {
  let found: string | null = null;
  visit(value, (_key, item) => {
    if (!found && typeof item === "string") {
      const match = item.match(/https:\/\/[^\s"']+\.workers\.dev/iu);
      if (match) {
        found = match[0];
      }
    }
  });
  return found;
}

function visit(value: unknown, visitor: (key: string, value: unknown) => void, key = ""): void {
  visitor(key, value);
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, visitor);
    }
  } else if (isRecord(value)) {
    for (const [childKey, item] of Object.entries(value)) {
      visit(item, visitor, childKey);
    }
  }
}

function isReceipt(value: unknown): value is DeploymentReceipt {
  if (!isRecord(value)) {
    return false;
  }
  return [
    "profile",
    "accountId",
    "workerName",
    "moodleOrigin",
    "deploymentId",
    "productionEndpoint",
    "productionVersionId",
    "releaseDigest",
  ].every((key) => typeof value[key] === "string") && typeof value.sessionRevision === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
