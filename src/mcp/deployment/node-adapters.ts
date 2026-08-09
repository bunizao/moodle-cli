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
} from "./managed-deployment.js";

const MODERN_MCP_VERSION = "2026-07-28";

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
    const versionIds = deploymentVersionIds(document);
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

  async uploadCandidate(input: {
    accountId: string;
    workerName: string;
    configPath: string;
    releaseDigest: string;
  }): Promise<CandidateRelease> {
    const outputFilePath = join(dirname(input.configPath), "wrangler-version-upload.jsonl");
    await rm(outputFilePath, { force: true });
    try {
      await this.wrangler([
        "versions",
        "upload",
        "--name",
        input.workerName,
        "--config",
        input.configPath,
        "--preview-alias",
        "moodle-cli-candidate",
        "--message",
        `moodle-cli-release:${input.releaseDigest}`,
      ], input.accountId, { WRANGLER_OUTPUT_FILE_PATH: outputFilePath });
      const document = await readWranglerVersionUpload(outputFilePath, input.workerName);
      const versionId = typeof document.version_id === "string" ? document.version_id : null;
      const previewEndpoint = firstWorkersDevUrl(document.preview_alias_url)
        ?? firstWorkersDevUrl(document.preview_url);
      if (!versionId || !previewEndpoint) {
        throw new DeploymentApplyError("CANDIDATE_UPLOAD_INVALID", "Wrangler did not return a candidate version and preview endpoint");
      }
      return {
        versionId,
        previewEndpoint,
        productionEndpoint: productionEndpointFromPreview(previewEndpoint, input.workerName),
        deploymentId: ownershipId(input.accountId, input.workerName),
      };
    } finally {
      await rm(outputFilePath, { force: true });
    }
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
      vars: { MOODLE_ORIGIN: plan.intent.moodleOrigin },
      durable_objects: {
        bindings: [{ name: "SESSION_BROKER", class_name: "SessionBroker" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["SessionBroker"] }],
    };
    const secrets: Record<string, string> = {
      MCP_ACCESS_TOKEN_DIGEST: digest(credentials.mcpAccessToken),
      SESSION_SYNC_TOKEN_DIGEST: digest(credentials.sessionSyncToken),
      SESSION_ENCRYPTION_KEY: credentials.sessionEncryptionKey,
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
    return { artifactDirectory, wranglerConfigPath, secretsFilePath };
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
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async putSession(input: {
    endpoint: string;
    sessionSyncToken: string;
    session: MoodleSessionMaterial;
    expectedRevision: number | null;
  }): Promise<{ revision: number }> {
    const response = await this.fetchImpl(endpointUrl(input.endpoint, "/session"), {
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
    });
    const body = await safeJson(response);
    if (!response.ok || !isRecord(body) || typeof body.revision !== "number") {
      const code = isRecord(body) && typeof body.code === "string" ? body.code : "SESSION_UPLOAD_FAILED";
      throw new DeploymentApplyError(code, "The Worker rejected the Moodle session update");
    }
    return { revision: body.revision };
  }

  async getReadiness(input: { endpoint: string; sessionSyncToken: string }): Promise<WorkerReadiness> {
    const response = await this.fetchImpl(endpointUrl(input.endpoint, "/readyz"), {
      headers: { authorization: `Bearer ${input.sessionSyncToken}` },
    });
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
      };
    }
    return { status: "fail", reasonCode: null, revision: null };
  }

  async runSmoke(input: {
    endpoint: string;
    mcpAccessToken: string;
    sessionSyncToken: string;
  }): Promise<void> {
    const health = await this.fetchImpl(endpointUrl(input.endpoint, "/healthz"));
    const healthBody = await safeJson(health);
    if (!health.ok || !isRecord(healthBody) || healthBody.status !== "pass") {
      throw new DeploymentApplyError("HEALTH_CHECK_FAILED", "Worker liveness check failed");
    }
    const readiness = await this.getReadiness(input);
    if (readiness.status === "fail") {
      throw new DeploymentApplyError("READINESS_CHECK_FAILED", "Moodle session readiness check failed");
    }
    await this.mcpCall(input.endpoint, input.mcpAccessToken, "server/discover", {}, 1);
    await this.mcpCall(input.endpoint, input.mcpAccessToken, "tools/list", {}, 2);
    await this.mcpCall(input.endpoint, input.mcpAccessToken, "tools/call", { name: "get_user", arguments: {} }, 3);
  }

  private async mcpCall(
    endpoint: string,
    token: string,
    method: string,
    params: Record<string, unknown>,
    id: number,
  ): Promise<void> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": MODERN_MCP_VERSION,
      "mcp-method": method,
    };
    if (typeof params.name === "string") {
      headers["mcp-name"] = params.name;
    }
    const response = await this.fetchImpl(endpointUrl(endpoint, "/mcp"), {
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
            "io.modelcontextprotocol/clientInfo": { name: "moodle-cli-deployment-smoke", version: "0.7.0" },
          },
        },
      }),
    });
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

async function readWranglerVersionUpload(outputFilePath: string, workerName: string): Promise<Record<string, unknown>> {
  let output: string;
  try {
    output = await readFile(outputFilePath, "utf8");
  } catch {
    throw new DeploymentApplyError("CANDIDATE_UPLOAD_INVALID", "Wrangler did not write candidate metadata");
  }
  for (const line of output.trim().split(/\r?\n/u).reverse()) {
    try {
      const entry: unknown = JSON.parse(line);
      if (
        isRecord(entry)
        && entry.type === "version-upload"
        && entry.version === 1
        && entry.worker_name === workerName
      ) {
        return entry;
      }
    } catch {
      continue;
    }
  }
  throw new DeploymentApplyError("CANDIDATE_UPLOAD_INVALID", "Wrangler wrote unsupported candidate metadata");
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

function productionEndpointFromPreview(preview: string, workerName: string): string {
  const url = new URL(preview);
  const labels = url.hostname.split(".");
  if (labels[0] !== workerName && labels[0]?.endsWith(`-${workerName}`)) {
    labels[0] = workerName;
    url.hostname = labels.join(".");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
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
