import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { getAuthenticatedSession } from "../auth.js";
import { createMoodleClient } from "../client.js";
import { loadConfig, type MoodleConfig } from "../config.js";
import { ENV_MOODLE_SESSION, ENV_MOODLE_TOKEN } from "../constants.js";
import { AuthError, UsageError } from "../errors.js";
import { getAuthStatus } from "../keepalive.js";
import { VERSION } from "../version.js";
import { bridgeRemoteMcp } from "./bridge.js";
import { connectClient, type SupportedMcpClient } from "./connectors/connectors.js";
import { createDefaultClientConnectors } from "./connectors/node-connectors.js";
import { createDefaultCredentialStore } from "./credentials/index.js";
import {
  DeploymentApplyError,
  DeploymentPlanError,
  FetchManagedWorkerClient,
  ManagedMcpDeployment,
  NodeWranglerDeploymentAdapter,
  PrivateDeploymentReceiptStore,
  WranglerCommandError,
  createBackgroundMoodleSessionSource,
  createDefaultManagedDeployment,
  successfulDeploymentCopy,
  type DeploymentCredentialRepository,
  type DeploymentEvent,
  type DeploymentIntent,
  type DeploymentPlan,
  type DeploymentReceipt,
  type DeploymentReceiptStore,
  type LocalDeploymentIntegration,
  type ManagedWorkerClient,
  type MoodleSessionMaterial,
  type MoodleSessionSource,
  type WorkerReadiness,
  type WranglerAccount,
} from "./deployment/index.js";
import {
  DefaultRenewalIntegration,
  decideRenewal,
  executeRenewalDecision,
  notifyRenewalSignInRequired,
  type RenewalActionExecutor,
  type RenewalDecision,
  type RenewalSnapshot,
} from "./renewal/index.js";
import { createMoodleGateway } from "./gateway.js";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./protocol.js";
import { createMoodleMcpServer } from "./server.js";
import { serveMoodleMcpStdio } from "./stdio.js";

const WORKER_COMPATIBILITY_DATE = "2026-08-09";

export interface McpCommandOutput {
  data: unknown;
  text: string;
}

export interface McpDeployInput {
  dryRun: boolean;
  repair: boolean;
  rotateToken: boolean;
  rollback: boolean;
  yes: boolean;
}

export interface McpCommandService {
  deploy(input: McpDeployInput): Promise<McpCommandOutput>;
  status(input: { verbose: boolean; logs: boolean }): Promise<McpCommandOutput>;
  login(): Promise<McpCommandOutput>;
  connect(input: { client?: string; mode: "bridge" | "remote"; showToken: boolean }): Promise<McpCommandOutput>;
  remove(input: { yes: boolean }): Promise<McpCommandOutput>;
  serveStdio(): Promise<void>;
  bridge(profile?: string): Promise<void>;
  renew(profile: string): Promise<McpCommandOutput>;
  pushSessionFromStdin(): Promise<McpCommandOutput>;
}

export interface McpCommandServiceOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
  workerBundlePath?: string;
  compatibilityDate?: string;
  wrangler?: NodeWranglerDeploymentAdapter;
  receipts?: DeploymentReceiptStore;
  credentials?: DeploymentCredentialRepository;
  worker?: ManagedWorkerClient;
  renewal?: LocalDeploymentIntegration;
  sessions?: MoodleSessionSource;
  notifyRenewalSignIn?: () => Promise<void>;
  configLoader?: () => Promise<MoodleConfig>;
  createDeployment?: (background: boolean) => ManagedMcpDeployment;
  prompt?: (question: string) => Promise<string>;
}

export function createMcpCommandService(options: McpCommandServiceOptions = {}): McpCommandService {
  return new DefaultMcpCommandService(options);
}

export function deriveMcpProfile(moodleOrigin: string): string {
  const host = new URL(moodleOrigin).hostname.toLowerCase();
  const profile = host.replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return truncateName(profile || "moodle", 64);
}

export function deriveMcpWorkerName(moodleOrigin: string): string {
  const host = new URL(moodleOrigin).hostname.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return truncateName(`moodle-${host || "site"}-mcp`, 63);
}

class DefaultMcpCommandService implements McpCommandService {
  private readonly homeDirectory: string;
  private wranglerInstance: NodeWranglerDeploymentAdapter | undefined;
  private readonly receipts: DeploymentReceiptStore;
  private readonly credentials: DeploymentCredentialRepository;
  private readonly worker: ManagedWorkerClient;
  private readonly renewal: LocalDeploymentIntegration;
  private readonly sessions: MoodleSessionSource;
  private readonly notifyRenewalSignIn: () => Promise<void>;

  constructor(private readonly options: McpCommandServiceOptions) {
    this.homeDirectory = options.homeDir ?? homedir();
    this.wranglerInstance = options.wrangler;
    this.receipts = options.receipts
      ?? new PrivateDeploymentReceiptStore(join(this.homeDirectory, ".config", "moodle-cli", "mcp", "deployments"));
    this.credentials = options.credentials
      ?? createDefaultCredentialStore({ platform: process.platform, homeDirectory: this.homeDirectory });
    this.worker = options.worker ?? new FetchManagedWorkerClient(options.fetchImpl);
    this.renewal = options.renewal ?? new DefaultRenewalIntegration({
      platform: process.platform,
      homeDirectory: this.homeDirectory,
    });
    this.sessions = options.sessions ?? createBackgroundMoodleSessionSource({
      env: options.env,
      fetch: options.fetchImpl,
      homeDir: this.homeDirectory,
    });
    this.notifyRenewalSignIn = options.notifyRenewalSignIn
      ?? (() => notifyRenewalSignInRequired(process.platform));
  }

  async deploy(input: McpDeployInput): Promise<McpCommandOutput> {
    const identity = await this.resolveDeploymentIdentity(input.yes);
    const deployment = this.deployment(false);
    if (input.rollback) {
      const recovery = await deployment.rollback(identity.profile);
      return {
        data: recovery,
        text: `Moodle MCP restored release ${recovery.versionId}.`,
      };
    }

    const plan = await this.planDeployment(deployment, {
      ...identity,
      releaseDigest: await this.releaseDigest(),
      repair: input.repair,
      rotateToken: input.rotateToken,
      dryRun: input.dryRun,
    });
    if (input.dryRun) {
      return {
        data: {
          operation: plan.operation,
          workerName: plan.intent.workerName,
          accountId: plan.intent.accountId,
          moodleOrigin: plan.intent.moodleOrigin,
          uploadCandidate: plan.uploadCandidate,
        },
        text: [
          "Moodle MCP deployment plan",
          `Operation: ${plan.operation}`,
          `Worker: ${plan.intent.workerName}`,
          `Candidate upload: ${plan.uploadCandidate ? "yes" : "no"}`,
        ].join("\n"),
      };
    }

    const events: DeploymentEvent[] = [];
    for await (const event of deployment.apply(plan)) events.push(event);
    const status = await deployment.inspect(identity.profile);
    const receipt = await this.receipts.read(identity.profile);
    const endpoint = status.worker?.productionEndpoint ?? receipt?.productionEndpoint;
    if (!endpoint) {
      throw new DeploymentApplyError("MISSING_ENDPOINT", "The deployed Worker endpoint is unavailable");
    }
    return {
      data: { events, status },
      text: renderDeploymentSuccess(events, {
        endpoint: `${endpoint.replace(/\/$/u, "")}/mcp`,
        moodleSite: identity.moodleOrigin,
        moodleUser: events.find((event) => event.moodleUser)?.moodleUser ?? "Unknown Moodle user",
        clients: await this.connectedClientNames(identity.profile),
      }),
    };
  }

  private async planDeployment(
    deployment: ManagedMcpDeployment,
    initialIntent: DeploymentIntent,
  ): Promise<DeploymentPlan> {
    let intent = initialIntent;
    while (true) {
      try {
        return await deployment.plan(intent);
      } catch (error) {
        if (!(error instanceof DeploymentPlanError) || error.code !== "WORKER_NAME_CONFLICT") {
          throw error;
        }
        if (!this.isInteractive()) {
          throw new UsageError(
            `A Worker named ${intent.workerName} already exists. Run \`moodle mcp deploy\` interactively to update it or choose another name.`,
          );
        }
        const selection = (await this.prompt([
          `A Worker named ${intent.workerName} already exists.`,
          "",
          "  1. Update the existing Moodle MCP deployment",
          "  2. Choose another Worker name",
          "  3. Cancel",
          "",
          "Selection: ",
        ].join("\n"))).trim();
        if (selection === "1") {
          intent = { ...intent, replaceExisting: true };
          continue;
        }
        if (selection === "2") {
          const workerName = (await this.prompt("Worker name: ")).trim();
          if (!workerName) throw new UsageError("Worker name cannot be empty.");
          intent = { ...intent, workerName, replaceExisting: false };
          continue;
        }
        if (selection === "3") throw new UsageError("Moodle MCP deployment was cancelled.");
        throw new UsageError("Worker conflict selection is invalid.");
      }
    }
  }

  async status(input: { verbose: boolean; logs: boolean }): Promise<McpCommandOutput> {
    const config = await this.config();
    const profile = deriveMcpProfile(config.baseUrl);
    const managed = await this.deployment(false).inspect(profile);
    let localAuthentication: unknown = { status: "unknown" };
    try {
      localAuthentication = await getAuthStatus(config.baseUrl, {
        homeDir: this.homeDirectory,
        fetchImpl: this.options.fetchImpl,
      });
    } catch {
      localAuthentication = { status: "unknown" };
    }
    const data = {
      profile,
      localAuthentication,
      managed,
      protocols: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
      ...(input.verbose ? { serviceVersion: VERSION } : {}),
      ...(input.logs ? { logs: { available: false, reason: "live_tail_required" } } : {}),
    };
    return {
      data,
      text: [
        `Moodle MCP: ${managed.readiness}`,
        `Worker: ${managed.worker?.workerName ?? "not deployed"}`,
        `Credentials: ${managed.credentialsStored ? "stored" : "missing"}`,
        `Renewal: ${managed.renewalInstalled ? "installed" : "missing"}`,
        `Clients: ${managed.clientsConnected ? "connected" : "not connected"}`,
        ...(input.logs ? ["Logs: use a live sanitized tail from an interactive terminal"] : []),
      ].join("\n"),
    };
  }

  async login(): Promise<McpCommandOutput> {
    const profile = deriveMcpProfile((await this.config()).baseUrl);
    const recovery = await this.deployment(false).recover(profile);
    return {
      data: recovery,
      text: "✓ New Moodle session acquired.\n✓ Remote session updated.\n✓ MCP readiness restored.",
    };
  }

  async connect(input: { client?: string; mode: "bridge" | "remote"; showToken: boolean }): Promise<McpCommandOutput> {
    if (input.showToken && !this.isInteractive()) {
      throw new UsageError("--show-token requires an interactive TTY.");
    }
    const profile = deriveMcpProfile((await this.config()).baseUrl);
    const [receipt, credentials] = await Promise.all([
      this.receipts.read(profile),
      this.credentials.read(profile),
    ]);
    if (!receipt || !credentials) throw new UsageError(`No managed Moodle MCP deployment exists for profile ${profile}.`);

    const endpoint = `${receipt.productionEndpoint.replace(/\/$/u, "")}/mcp`;
    const connectors = createDefaultClientConnectors(profile, {
      homeDirectory: this.homeDirectory,
      platform: process.platform,
      mode: input.mode,
      ...(input.mode === "remote" ? { endpoint, accessToken: credentials.mcpAccessToken } : {}),
    });
    const selected = await selectConnectors(connectors, input.client);
    if (!selected.length) {
      throw new UsageError(input.client ? `Unsupported MCP client '${input.client}'.` : "No supported MCP clients were detected.");
    }
    const connected = [];
    for (const connector of selected) connected.push(await connectClient(connector));
    const text = [
      ...connected.map((item) => `✓ ${item.client}`),
      ...(input.showToken ? ["", "MCP access token", credentials.mcpAccessToken] : []),
    ].join("\n");
    return {
      data: { profile, mode: input.mode, connected: connected.map(({ client, configPath, changed }) => ({ client, configPath, changed })) },
      text,
    };
  }

  async remove(input: { yes: boolean }): Promise<McpCommandOutput> {
    const profile = deriveMcpProfile((await this.config()).baseUrl);
    const receipt = await this.receipts.read(profile);
    if (receipt && !input.yes) {
      if (!this.isInteractive()) throw new UsageError("Moodle MCP removal requires --yes when stdin is not interactive.");
      const answer = await this.prompt(`Type ${receipt.workerName} to confirm removal: `);
      if (answer.trim() !== receipt.workerName) throw new UsageError("Moodle MCP removal was cancelled.");
    }
    const result = await this.deployment(false).remove(profile);
    return {
      data: result,
      text: [
        "Moodle MCP has been removed.",
        `Worker: ${result.workerRemoved ? "deleted" : "not present"}`,
        "Local renewal, client registrations, and deployment credentials: deleted",
        "Local Moodle configuration and authentication cache: kept",
      ].join("\n"),
    };
  }

  async serveStdio(): Promise<void> {
    const stdin = this.options.stdin ?? process.stdin;
    const stdout = this.options.stdout ?? process.stdout;
    const baseUrl = (await this.config()).baseUrl;
    const client = await createMoodleClient(baseUrl, {
      env: this.options.env,
      fetchImpl: this.options.fetchImpl,
      homeDir: this.homeDirectory,
    });
    const server = createMoodleMcpServer(createMoodleGateway(client), { version: VERSION });
    await serveMoodleMcpStdio(server, { input: stdin, output: stdout });
  }

  async bridge(profile?: string): Promise<void> {
    const resolvedProfile = profile ?? deriveMcpProfile((await this.config()).baseUrl);
    const [receipt, credentials] = await Promise.all([
      this.receipts.read(resolvedProfile),
      this.credentials.read(resolvedProfile),
    ]);
    if (!receipt || !credentials) throw new UsageError(`No managed Moodle MCP deployment exists for profile ${resolvedProfile}.`);
    await bridgeRemoteMcp({
      endpoint: receipt.productionEndpoint,
      accessToken: credentials.mcpAccessToken,
      input: this.options.stdin ?? process.stdin,
      output: this.options.stdout ?? process.stdout,
      fetchImpl: this.options.fetchImpl,
    });
  }

  async renew(profile: string): Promise<McpCommandOutput> {
    const [storedReceipt, credentials] = await Promise.all([
      this.receipts.read(profile),
      this.credentials.read(profile),
    ]);
    if (!storedReceipt || !credentials) {
      throw new UsageError(`No managed Moodle MCP deployment exists for profile ${profile}.`);
    }

    let receipt = storedReceipt;
    const target = { endpoint: receipt.productionEndpoint, sessionSyncToken: credentials.sessionSyncToken };
    await this.worker.touchSession(target);
    const readiness = await this.worker.getReadiness(target);
    if (readiness.revision !== null && readiness.revision !== receipt.sessionRevision) {
      receipt = await this.writeRenewalRevision(receipt, readiness.revision);
    }
    let expectedRevision = readiness.reasonCode === "SESSION_MISSING"
      ? null
      : readiness.revision ?? receipt.sessionRevision;

    const snapshot: RenewalSnapshot = {
      remote: renewalRemoteState(readiness),
      replacement: { source: "none" },
      upload: "idle",
      agentInstalled: await this.renewal.inspect(profile),
    };
    let replacement: MoodleSessionMaterial | null = null;
    let signInDetail: string | undefined;
    if (snapshot.remote === "expiring" || snapshot.remote === "expired") {
      try {
        replacement = await this.sessions.loadValidated(profile, receipt.moodleOrigin);
        snapshot.replacement = { source: "browser", valid: true, fingerprintChanged: true };
      } catch (error) {
        if (!(error instanceof AuthError)) {
          throw error;
        }
        snapshot.replacement = { source: "mfa_required" };
        signInDetail = [error.message, error.hint].filter(Boolean).join(" ");
      }
    }

    let uploaded = false;
    const upload = async (): Promise<void> => {
      if (!replacement) {
        throw new Error("Renewal selected an upload without a replacement session");
      }
      try {
        const result = await this.worker.putSession({
          endpoint: receipt.productionEndpoint,
          sessionSyncToken: credentials.sessionSyncToken,
          session: replacement,
          expectedRevision,
        });
        receipt = await this.writeRenewalRevision(receipt, result.revision);
        expectedRevision = result.revision;
        uploaded = true;
      } catch (error) {
        throw new RenewalUploadError(error);
      }
    };

    const executor: RenewalActionExecutor = {
      installAgent: async () => {
        await this.renewal.install(profile);
        snapshot.agentInstalled = true;
      },
      validateAndUpload: upload,
      retryUpload: upload,
      refreshRemoteRevision: async () => {
        const refreshed = await this.worker.getReadiness({
          endpoint: receipt.productionEndpoint,
          sessionSyncToken: credentials.sessionSyncToken,
        });
        if (refreshed.revision === null) {
          if (refreshed.reasonCode === "SESSION_MISSING") {
            expectedRevision = null;
            return;
          }
          throw new DeploymentApplyError("SESSION_REVISION_UNAVAILABLE", "The remote session revision is unavailable");
        }
        receipt = await this.writeRenewalRevision(receipt, refreshed.revision);
        expectedRevision = refreshed.revision;
      },
      notifySignIn: this.notifyRenewalSignIn,
    };

    const decision = await executeRenewalWithRecovery(decideRenewal(snapshot), snapshot, executor);
    if (uploaded) {
      return {
        data: { profile, state: "healthy", reasonCode: "SESSION_VALID", revision: receipt.sessionRevision },
        text: "Moodle MCP session renewed.",
      };
    }
    // A background job cannot open a browser, so record why no replacement cookie was found.
    const detail = decision.state === "needs_sign_in" && signInDetail ? { detail: signInDetail } : {};
    return {
      data: { profile, state: decision.state, reasonCode: decision.reasonCode, revision: receipt.sessionRevision, ...detail },
      text: [renewalResultText(decision), signInDetail].filter(Boolean).join("\n"),
    };
  }

  private async writeRenewalRevision(receipt: DeploymentReceipt, revision: number): Promise<DeploymentReceipt> {
    const updated = { ...receipt, sessionRevision: revision };
    await this.receipts.write(updated);
    return updated;
  }

  async pushSessionFromStdin(): Promise<McpCommandOutput> {
    const config = await this.config();
    const profile = deriveMcpProfile(config.baseUrl);
    const raw = (await readAll(this.options.stdin ?? process.stdin)).trim();
    const cookieValue = raw.startsWith("MoodleSession=") ? raw.slice("MoodleSession=".length).trim() : raw;
    if (!cookieValue || /[\r\n]/u.test(cookieValue)) throw new UsageError("Standard input did not contain one Moodle session cookie.");
    const session = await getAuthenticatedSession(config.baseUrl, {
      env: {
        ...(this.options.env ?? process.env),
        [ENV_MOODLE_TOKEN]: undefined,
        [ENV_MOODLE_SESSION]: cookieValue,
      },
      fetch: this.options.fetchImpl,
      homeDir: this.homeDirectory,
      noCache: true,
    });
    const [receipt, credentials] = await Promise.all([
      this.receipts.read(profile),
      this.credentials.read(profile),
    ]);
    if (!receipt || !credentials) throw new UsageError(`No managed Moodle MCP deployment exists for profile ${profile}.`);
    const uploaded = await this.worker.putSession({
      endpoint: receipt.productionEndpoint,
      sessionSyncToken: credentials.sessionSyncToken,
      expectedRevision: receipt.sessionRevision,
      session: {
        moodleOrigin: config.baseUrl,
        cookieName: session.cookie.name,
        cookieValue: session.cookie.value,
        fingerprint: sha256(`${session.cookie.name}\0${session.cookie.value}`),
        remoteRevision: receipt.sessionRevision,
      },
    });
    await this.receipts.write({ ...receipt, sessionRevision: uploaded.revision });
    return { data: { profile, revision: uploaded.revision }, text: "Moodle MCP session updated." };
  }

  private deployment(background: boolean): ManagedMcpDeployment {
    if (this.options.createDeployment) return this.options.createDeployment(background);
    return createDefaultManagedDeployment({
      workerBundlePath: this.workerBundlePath(),
      compatibilityDate: this.options.compatibilityDate ?? WORKER_COMPATIBILITY_DATE,
      homeDirectory: this.homeDirectory,
      platform: process.platform,
      fetch: this.options.fetchImpl,
      auth: {
        env: this.options.env,
        fetch: this.options.fetchImpl,
        homeDir: this.homeDirectory,
      },
      dependencies: {
        wrangler: this.wrangler(),
        receipts: this.receipts,
        credentials: this.credentials,
        worker: this.worker,
        ...(background ? {
          sessions: createBackgroundMoodleSessionSource({
            env: this.options.env,
            fetch: this.options.fetchImpl,
            homeDir: this.homeDirectory,
          }),
        } : {}),
      },
    });
  }

  private async resolveDeploymentIdentity(yes: boolean): Promise<{
    profile: string;
    accountId: string;
    workerName: string;
    moodleOrigin: string;
  }> {
    const config = await this.config();
    const profile = deriveMcpProfile(config.baseUrl);
    const receipt = await this.receipts.read(profile);
    if (receipt) {
      return {
        profile,
        accountId: receipt.accountId,
        workerName: receipt.workerName,
        moodleOrigin: receipt.moodleOrigin,
      };
    }
    let accounts: WranglerAccount[];
    try {
      accounts = await this.wrangler().listAccounts();
    } catch (error) {
      if (!isWranglerAuthRequired(error)) {
        throw error;
      }
      accounts = [];
    }
    if (!accounts.length) {
      if (!this.isInteractive()) {
        throw new UsageError("Cloudflare sign-in requires an interactive terminal. Run `moodle mcp deploy` interactively first.");
      }
      await this.wrangler().login();
      accounts = await this.wrangler().listAccounts();
    }
    if (!accounts.length) throw new UsageError("No Cloudflare account is available to Wrangler.");
    const account = accounts.length === 1 || yes ? accounts[0]! : await this.chooseAccount(accounts);
    return {
      profile,
      accountId: account.id,
      workerName: deriveMcpWorkerName(config.baseUrl),
      moodleOrigin: config.baseUrl,
    };
  }

  private async chooseAccount(accounts: WranglerAccount[]): Promise<WranglerAccount> {
    if (!this.isInteractive()) throw new UsageError("Several Cloudflare accounts are available; rerun interactively to select one.");
    const choices = accounts.map((account, index) => `${index + 1}. ${account.name} (${account.id})`).join("\n");
    const answer = Number((await this.prompt(`Choose a Cloudflare account:\n${choices}\nSelection: `)).trim());
    const account = Number.isInteger(answer) ? accounts[answer - 1] : undefined;
    if (!account) throw new UsageError("Cloudflare account selection is invalid.");
    return account;
  }

  private async connectedClientNames(profile: string): Promise<string[]> {
    const connectors = createDefaultClientConnectors(profile, {
      homeDirectory: this.homeDirectory,
      platform: process.platform,
    });
    const clients: string[] = [];
    for (const connector of connectors) {
      const detection = await connector.detect();
      if (detection.detected && (await connector.verify()).configured) {
        clients.push(displayClientName(detection.client));
      }
    }
    return clients;
  }

  private config(): Promise<MoodleConfig> {
    if (this.options.configLoader) return this.options.configLoader();
    return loadConfig({
      env: this.options.env,
      cwd: this.options.cwd,
      homeDir: this.homeDirectory,
      stdin: this.options.stdin,
      stderr: this.options.stderr,
      fetch: this.options.fetchImpl,
    });
  }

  private prompt(question: string): Promise<string> {
    if (this.options.prompt) return this.options.prompt(question);
    const input = this.options.stdin ?? process.stdin;
    const output = this.options.stderr ?? process.stderr;
    const readline = createInterface({ input, output });
    return readline.question(question).finally(() => readline.close());
  }

  private workerBundlePath(): string {
    return this.options.workerBundlePath ?? fileURLToPath(new URL("./worker/worker.js", import.meta.url));
  }

  private wrangler(): NodeWranglerDeploymentAdapter {
    this.wranglerInstance ??= new NodeWranglerDeploymentAdapter();
    return this.wranglerInstance;
  }

  private releaseDigest(): Promise<string> {
    return readFile(this.workerBundlePath()).then((content) => sha256(content));
  }

  private isInteractive(): boolean {
    return Boolean((this.options.stdin ?? process.stdin).isTTY);
  }
}

class RenewalUploadError extends Error {
  constructor(readonly cause: unknown) {
    super("The Moodle session upload did not complete");
    this.name = "RenewalUploadError";
  }
}

async function executeRenewalWithRecovery(
  decision: RenewalDecision,
  snapshot: RenewalSnapshot,
  executor: RenewalActionExecutor,
): Promise<RenewalDecision> {
  try {
    await executeRenewalDecision(decision, executor);
    return decision;
  } catch (error) {
    if (!(error instanceof RenewalUploadError)) {
      throw error;
    }
    if (isRevisionConflict(error.cause)) {
      const conflict = decideRenewal({ ...snapshot, upload: "revision_conflict" });
      await executeRenewalDecision(conflict, executor);
      return conflict;
    }

    const retry = decideRenewal({ ...snapshot, upload: "interrupted" });
    try {
      await executeRenewalDecision(retry, executor);
      return retry;
    } catch (retryError) {
      if (retryError instanceof RenewalUploadError && isRevisionConflict(retryError.cause)) {
        const conflict = decideRenewal({ ...snapshot, upload: "revision_conflict" });
        await executeRenewalDecision(conflict, executor);
        return conflict;
      }
      throw retryError instanceof RenewalUploadError ? retryError.cause : retryError;
    }
  }
}

function renewalRemoteState(readiness: WorkerReadiness): RenewalSnapshot["remote"] {
  if (readiness.reasonCode === "MOODLE_UNREACHABLE") return "unreachable";
  if (readiness.reasonCode === "SESSION_EXPIRED" || readiness.reasonCode === "SESSION_MISSING") return "expired";
  if (readiness.reasonCode === "SESSION_EXPIRING" || readiness.reasonCode === "SESSION_SYNC_STALE") return "expiring";
  if (readiness.status === "pass") return "valid";
  return readiness.status === "warn" ? "expiring" : "expired";
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof DeploymentApplyError && error.code === "SESSION_REVISION_CONFLICT";
}

function isWranglerAuthRequired(error: unknown): boolean {
  return error instanceof WranglerCommandError
    && /not authenticated|not logged in|wrangler login/iu.test(`${error.stdout}\n${error.stderr}`);
}

function renewalResultText(decision: RenewalDecision): string {
  if (decision.state === "offline") return "Moodle is unreachable. The remote session was preserved.";
  if (decision.state === "needs_sign_in") return "Moodle MCP needs sign-in. Run `moodle mcp login`.";
  if (decision.state === "conflict") return "Moodle MCP refreshed the remote session revision without overwriting it.";
  if (decision.reasonCode === "RENEWAL_AGENT_MISSING") return "Moodle MCP renewal agent installed.";
  return "Moodle MCP session is ready.";
}

async function selectConnectors(
  connectors: ReturnType<typeof createDefaultClientConnectors>,
  requested?: string,
): Promise<ReturnType<typeof createDefaultClientConnectors>> {
  const normalized = normalizeClientName(requested);
  const selected = [];
  for (const connector of connectors) {
    const detection = await connector.detect();
    if (normalized ? detection.client === normalized : detection.detected) selected.push(connector);
  }
  return selected;
}

function normalizeClientName(value?: string): SupportedMcpClient | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, SupportedMcpClient> = {
    codex: "codex",
    claude: "claude-desktop",
    "claude-desktop": "claude-desktop",
    "claude-code": "claude-code",
    vscode: "vscode",
    "vs-code": "vscode",
    cursor: "cursor",
  };
  return aliases[normalized] ?? (normalized as SupportedMcpClient);
}

function displayClientName(client: SupportedMcpClient): string {
  const names: Record<SupportedMcpClient, string> = {
    codex: "Codex",
    "claude-desktop": "Claude Desktop",
    "claude-code": "Claude Code",
    vscode: "VS Code",
    cursor: "Cursor",
  };
  return names[client];
}

function renderDeploymentSuccess(
  events: DeploymentEvent[],
  summary: Parameters<typeof successfulDeploymentCopy>[0],
): string {
  const completed = events
    .filter((event) => event.status === "completed")
    .map((event) => `[${event.stage}/${event.total}] ✓ ${event.label}`);
  return [
    ...completed,
    "",
    successfulDeploymentCopy(summary),
  ].join("\n");
}

async function readAll(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let value = "";
  for await (const chunk of input) value += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  return value + decoder.decode();
}

function truncateName(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const suffix = sha256(value).slice(0, 8);
  return `${value.slice(0, maximum - suffix.length - 1).replace(/-+$/u, "")}-${suffix}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
