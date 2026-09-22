import { createTheme, type Theme } from "@bunizao/cli-kit";

import { deleteCachedSession } from "../session-cache.js";
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
  ONBOARDING_COPY,
  PrivateDeploymentReceiptStore,
  WranglerCommandError,
  createBackgroundMoodleSessionSource,
  createDefaultManagedDeployment,
  createProgressReporter,
  formatOnboardingStage,
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
  type ProgressReporter,
  type WorkerReadiness,
  type WranglerAccount,
} from "./deployment/index.js";
import {
  DefaultRenewalIntegration,
  decideRenewal,
  describeRenewalJob,
  executeRenewalDecision,
  notifyRenewalSignInRequired,
  type RenewalActionExecutor,
  type RenewalDecision,
  type RenewalJobDescription,
  type RenewalSnapshot,
} from "./renewal/index.js";
import { createMoodleGateway } from "./gateway.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.js";
import { createMoodleMcpServer } from "./server.js";
import { serveMoodleMcpStdio } from "./stdio.js";

const WORKER_COMPATIBILITY_DATE = "2026-08-09";

export interface McpCommandOutput {
  data: unknown;
  text: string;
  /** Commands worth typing next; the CLI prints them under "Try" instead of its generic footer. */
  next?: string[];
}

export interface McpDeployInput {
  dryRun: boolean;
  repair: boolean;
  rotateToken: boolean;
  rotateKey?: boolean;
  rollback: boolean;
  yes: boolean;
}

export interface McpCommandService {
  deploy(input: McpDeployInput): Promise<McpCommandOutput>;
  status(input: { verbose: boolean; logs: boolean }): Promise<McpCommandOutput>;
  login(): Promise<McpCommandOutput>;
  connect(input: { client?: string; mode: "bridge" | "remote"; showToken: boolean }): Promise<McpCommandOutput>;
  pair(): Promise<McpCommandOutput>;
  manageClients(input: { revoke?: boolean; clientId?: string }): Promise<McpCommandOutput>;
  remove(input: { yes: boolean }): Promise<McpCommandOutput>;
  serveStdio(): Promise<void>;
  bridge(profile?: string): Promise<void>;
  renew(profile: string): Promise<McpCommandOutput>;
  pushSessionFromStdin(): Promise<McpCommandOutput>;
  /** Null without a deployment receipt; otherwise whether the Worker is behind this package and answering. */
  workerState(): Promise<{ behind: boolean; ready: boolean } | null>;
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
  /** The CLI decides whether this run is coloured; the service only asks. */
  color?: () => boolean;
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
  private progressReporter: ProgressReporter | undefined;

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
    // Every step here waits on Wrangler, Cloudflare, or Moodle, so the terminal reports
    // the running step instead of staying blank until the whole run finishes.
    await this.prepareToolchain(input.yes);
    const theme = this.theme();
    const progress = this.progress();
    try {
      progress.begin("Reading Cloudflare account and deployment state");
      const identity = await this.resolveDeploymentIdentity(input.yes);
      const deployment = this.deployment(false);
      if (input.rollback) {
        progress.begin("Restoring the previous release");
        const recovery = await deployment.rollback(identity.profile);
        return {
          data: recovery,
          text: `${theme.tone("success", "Moodle MCP restored release")} ${theme.key(recovery.versionId)}.`,
          next: ["moodle mcp status"],
        };
      }

      progress.begin("Planning the deployment");
      const plan = await this.planDeployment(deployment, {
        ...identity,
        releaseDigest: await this.releaseDigest(),
        repair: input.repair,
        rotateToken: input.rotateToken,
        rotateKey: input.rotateKey,
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
            theme.subject("Moodle MCP deployment plan"),
            `  ${theme.dim("Operation:")} ${plan.operation}`,
            `  ${theme.dim("Worker:")} ${theme.key(plan.intent.workerName)}`,
            `  ${theme.dim("Candidate upload:")} ${plan.uploadCandidate ? "yes" : "no"}`,
          ].join("\n"),
          next: ["moodle mcp deploy"],
        };
      }

      const events: DeploymentEvent[] = [];
      for await (const event of deployment.apply(plan)) {
        events.push(event);
        if (event.status === "started") progress.begin(formatOnboardingStage(event.stageId, "pending", theme));
        else if (event.status === "completed") progress.end(formatOnboardingStage(event.stageId, "completed", theme));
        else progress.clear();
      }
      progress.begin("Reading deployment status");
      const status = await deployment.inspect(identity.profile);
      return await this.deploymentSuccess(identity, events, status);
    } finally {
      // A failure must not leave a half-drawn spinner in front of the error message.
      progress.clear();
    }
  }

  private async deploymentSuccess(
    identity: { profile: string; moodleOrigin: string },
    events: DeploymentEvent[],
    status: Awaited<ReturnType<ManagedMcpDeployment["inspect"]>>,
  ): Promise<McpCommandOutput> {
    const receipt = await this.receipts.read(identity.profile);
    const endpoint = status.worker?.productionEndpoint ?? receipt?.productionEndpoint;
    if (!endpoint) {
      throw new DeploymentApplyError("MISSING_ENDPOINT", "The deployed Worker endpoint is unavailable");
    }
    return {
      data: { events, status },
      text: successfulDeploymentCopy({
        endpoint: `${endpoint.replace(/\/$/u, "")}/mcp`,
        moodleSite: identity.moodleOrigin,
        moodleUser: events.find((event) => event.moodleUser)?.moodleUser ?? "Unknown Moodle user",
        clients: await this.connectedClientNames(identity.profile),
        renewal: this.renewalJob(identity.profile),
      }, this.theme()),
      next: ["moodle mcp status", "moodle mcp pair"],
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
    await this.prepareToolchain();
    const progress = this.progress();
    let managed;
    try {
      // inspect() asks the Worker to touch the live Moodle session before answering.
      progress.begin("Checking the remote Worker and Moodle session");
      managed = await this.deployment(false).inspect(profile);
    } finally {
      progress.clear();
    }
    let localAuthentication: unknown = { status: "unknown" };
    try {
      localAuthentication = await getAuthStatus(config.baseUrl, {
        homeDir: this.homeDirectory,
        fetchImpl: this.options.fetchImpl,
      });
    } catch {
      localAuthentication = { status: "unknown" };
    }
    const updateAvailable = await this.remoteWorkerBehindLocal(profile);
    const [receipt, credentials] = await Promise.all([this.receipts.read(profile), this.credentials.read(profile)]);
    const job = this.renewalJob(profile);
    // Hosted clients live in the Worker; a Worker that cannot answer simply leaves the count unknown.
    const hosted = receipt && credentials
      ? await this.worker.manageClients({ endpoint: receipt.productionEndpoint, sessionSyncToken: credentials.sessionSyncToken }).then((data) => isClientList(data) ? data.clients.filter((client) => client.approved).length : null).catch(() => null)
      : null;
    const renewal = {
      installed: managed.renewalInstalled,
      ...(job ? { scheduler: job.scheduler, label: job.label, schedule: job.schedule, log: job.log } : {}),
      lastRun: receipt?.lastRenewal ?? null,
    };
    const data = {
      profile,
      localAuthentication,
      managed,
      renewal,
      hostedClients: hosted,
      protocols: [...SUPPORTED_PROTOCOL_VERSIONS],
      updateAvailable,
      ...(input.verbose ? { serviceVersion: VERSION } : {}),
      ...(input.logs ? { logs: { available: false, reason: "live_tail_required" } } : {}),
    };
    const theme = this.theme();
    // "missing", "not deployed" and the recovery warning are the words a person scans for,
    // so they carry the tone; the labels stay quiet.
    const row = (label: string, value: string) => `${theme.dim(`${label}:`)} ${theme.status(value, { pass: "success", warn: "warning", fail: "danger", unknown: "muted", "not deployed": "warning", missing: "warning", "not connected": "warning", stored: "success", installed: "success", connected: "success" })}`;
    return {
      data,
      text: [
        row("Moodle MCP", managed.readiness),
        row("Worker", managed.worker?.workerName ?? "not deployed"),
        row("Credentials", managed.credentialsStored ? "stored" : "missing"),
        row("Renewal", managed.renewalInstalled ? "installed" : "missing"),
        ...(managed.renewalInstalled && job ? [`  ${theme.dim(`${job.schedule}; you only hear from it when Moodle signs you out`)}`] : []),
        `  ${theme.dim("Last run:")} ${renewalRunText(renewal.lastRun, theme)}`,
        ...(managed.renewalInstalled && job && input.verbose ? [`  ${theme.dim("Log:")} ${theme.dim(job.log)}`] : []),
        row("Local clients", managed.clientsConnected ? "connected" : "not connected"),
        `${theme.dim("Hosted clients:")} ${hosted === null ? theme.dim("unknown") : hosted ? `${hosted} approved` : theme.dim("none")}`,
        ...(managed.recoveryActive ? [`${theme.dim("Release:")} ${theme.tone("warning", "the recovery Worker is live; OAuth sign-in is disabled until")} ${theme.key("moodle mcp deploy")} ${theme.tone("warning", "succeeds.")}`] : []),
        ...(updateAvailable ? [`${theme.dim("Update:")} remote Worker is behind this CLI. Run ${theme.key("moodle update")} to update it.`] : []),
        ...(input.logs ? [`${theme.dim("Logs:")} use a live sanitized tail from an interactive terminal`] : []),
      ].join("\n"),
      next: [
        ...(updateAvailable ? ["moodle update"] : []),
        ...(managed.readiness === "fail" ? ["moodle mcp login"] : []),
        ...(!managed.clientsConnected ? ["moodle mcp connect"] : []),
        ...(hosted ? [] : ["moodle mcp pair"]),
      ],
    };
  }

  async login(): Promise<McpCommandOutput> {
    const profile = deriveMcpProfile((await this.config()).baseUrl);
    await this.prepareToolchain();
    const progress = this.progress();
    try {
      // Sign-in can wait on the browser for up to two minutes, so say so rather than
      // leaving the terminal blank.
      progress.begin("Reading your Moodle session (a browser sign-in may be required)");
      const recovery = await this.deployment(false).recover(profile);
      const theme = this.theme();
      const done = (line: string) => `${theme.tone("success", "✓")} ${line}`;
      return {
        data: recovery,
        text: [done("New Moodle session acquired."), done("Remote session updated."), done("MCP readiness restored.")].join("\n"),
        next: ["moodle mcp status"],
      };
    } finally {
      progress.clear();
    }
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
    const theme = this.theme();
    const text = [
      ...connected.map((item) => `${theme.tone("success", "✓")} ${item.client} ${theme.dim(item.changed ? `· ${item.configPath}` : "· already connected")}`),
      ...(input.showToken ? ["", theme.subject("MCP access token"), `  ${credentials.mcpAccessToken}`] : []),
    ].join("\n");
    return {
      data: { profile, mode: input.mode, connected: connected.map(({ client, configPath, changed }) => ({ client, configPath, changed })) },
      text,
      next: ["moodle mcp status"],
    };
  }

  async manageClients(input: { revoke?: boolean; clientId?: string }): Promise<McpCommandOutput> {
    if (input.clientId && !/^[A-Za-z0-9_-]{1,128}$/u.test(input.clientId)) throw new UsageError("The OAuth client ID is invalid.");
    const profile = deriveMcpProfile((await this.config()).baseUrl);
    const receipt = await this.receipts.read(profile);
    const credentials = await this.credentials.read(profile);
    if (!receipt || !credentials) throw new UsageError(`No managed Moodle MCP deployment exists for profile ${profile}.`);
    const data = await this.worker.manageClients({ endpoint: receipt.productionEndpoint, sessionSyncToken: credentials.sessionSyncToken, ...input });
    const theme = this.theme();
    if (input.revoke) {
      return { data, text: theme.tone("success", input.clientId ? "OAuth client revoked." : "All OAuth access revoked."), next: ["moodle mcp pair"] };
    }
    const clients = isClientList(data) ? data.clients : [];
    return {
      data,
      text: clients.length
        ? [
          theme.subject("OAuth clients"),
          ...clients.map((client) => `  ${theme.status(client.approved ? "approved" : "pending", { approved: "success", pending: "warning" }).padEnd(theme.enabled ? 18 : 9)} ${client.clientName}  ${theme.dim(client.clientId)}`),
        ].join("\n")
        : theme.dim("No OAuth clients."),
      next: clients.length ? [`moodle mcp revoke ${clients[0].clientId}`, "moodle mcp pair"] : ["moodle mcp pair"],
    };
  }

  async pair(): Promise<McpCommandOutput> {
    const profile = deriveMcpProfile((await this.config()).baseUrl);
    const [receipt, credentials] = await Promise.all([
      this.receipts.read(profile),
      this.credentials.read(profile),
    ]);
    if (!receipt || !credentials) throw new UsageError(`No managed Moodle MCP deployment exists for profile ${profile}.`);

    const pairing = await this.worker.createPairing({
      endpoint: receipt.productionEndpoint,
      sessionSyncToken: credentials.sessionSyncToken,
    });
    const endpoint = `${receipt.productionEndpoint.replace(/\/$/u, "")}/mcp`;
    return {
      data: {
        profile,
        endpoint,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        authorizationServer: pairing.authorizationServer,
      },
      text: pairingCopy({ endpoint, code: pairing.code, expiresAt: pairing.expiresAt }, this.theme()),
      next: ["moodle mcp clients"],
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
    await deleteCachedSession((await this.config()).baseUrl, { homeDir: this.homeDirectory });
    return {
      data: result,
      text: [
        this.theme().tone("success", "Moodle MCP has been removed."),
        `  ${this.theme().dim("Worker:")} ${result.workerRemoved ? "deleted" : "not present"}`,
        `  ${this.theme().dim("Renewal job, client registrations, deployment credentials:")} deleted`,
        `  ${this.theme().dim("Local Moodle configuration:")} kept ${this.theme().dim("(its authentication cache was removed)")}`,
      ].join("\n"),
      next: ["moodle mcp deploy"],
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
    const outcome = uploaded ? { state: "healthy", reasonCode: "SESSION_VALID" } : { state: decision.state, reasonCode: decision.reasonCode };
    // Status shows this instead of asking people to open the scheduler's log.
    receipt = { ...receipt, lastRenewal: { at: new Date().toISOString(), ...outcome } };
    await this.receipts.write(receipt);
    const theme = this.theme();
    if (uploaded) {
      return {
        data: { profile, ...outcome, revision: receipt.sessionRevision },
        text: theme.tone("success", "Moodle MCP session renewed."),
        next: ["moodle mcp status"],
      };
    }
    // A background job cannot open a browser, so record why no replacement cookie was found.
    const detail = decision.state === "needs_sign_in" && signInDetail ? { detail: signInDetail } : {};
    return {
      data: { profile, ...outcome, revision: receipt.sessionRevision, ...detail },
      text: [renewalResultText(decision, theme), signInDetail].filter(Boolean).join("\n"),
      next: [decision.state === "needs_sign_in" ? "moodle mcp login" : "moodle mcp status"],
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
    return { data: { profile, revision: uploaded.revision }, text: this.theme().tone("success", "Moodle MCP session updated."), next: ["moodle mcp status"] };
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
        onBrowserOpened: (url: string) => this.announceWait(
          `${ONBOARDING_COPY.waitingForSignIn}\n\n  ${url}`,
          "Waiting for Moodle sign-in",
        ),
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
      // Wrangler opens Cloudflare's authorization page and prints nothing of its own,
      // because its output is captured.
      this.announceWait(ONBOARDING_COPY.cloudflareSignIn, "Waiting for Cloudflare authorization");
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
    // A spinner and a readline prompt share the same line, so stop the animation first.
    this.progress().clear();
    if (this.options.prompt) return this.options.prompt(question);
    const input = this.options.stdin ?? process.stdin;
    const output = this.options.stderr ?? process.stderr;
    const readline = createInterface({ input, output });
    return readline.question(question).finally(() => readline.close());
  }

  private workerBundlePath(): string {
    return this.options.workerBundlePath ?? process.env.MOODLE_BUNDLED_WORKER ?? fileURLToPath(new URL("./worker/worker.js", import.meta.url));
  }

  private wrangler(): NodeWranglerDeploymentAdapter {
    this.wranglerInstance ??= new NodeWranglerDeploymentAdapter();
    return this.wranglerInstance;
  }

  async workerState(): Promise<{ behind: boolean; ready: boolean } | null> {
    try {
      const profile = deriveMcpProfile((await this.config()).baseUrl);
      const [receipt, credentials] = await Promise.all([this.receipts.read(profile), this.credentials.read(profile)]);
      if (!receipt || !credentials) return null;
      const behind = await this.remoteWorkerBehindLocal(profile);
      // A receipt only proves a deploy once happened; the Worker itself says whether it still answers.
      const readiness = await this.worker.getReadiness({ endpoint: receipt.productionEndpoint, sessionSyncToken: credentials.sessionSyncToken }).catch(() => null);
      return { behind, ready: readiness?.status === "pass" };
    } catch {
      return null;
    }
  }

  // The first-use Wrangler download asks a question, so it runs before a spinner
  // owns the terminal rather than drawing its prompt underneath one.
  private async prepareToolchain(yes = false): Promise<void> {
    if (this.options.createDeployment || this.options.wrangler) return;
    await this.wrangler().prepare({ yes });
  }

  private releaseDigest(): Promise<string> {
    return readFile(this.workerBundlePath()).then((content) => sha256(content));
  }

  // True when a deployment receipt exists but its recorded release digest no
  // longer matches the Worker bundle shipped with this CLI, i.e. the remote
  // Worker is running older code than the locally installed package. Best
  // effort: any failure to read the receipt or bundle reports "no update".
  private async remoteWorkerBehindLocal(profile: string): Promise<boolean> {
    try {
      const receipt = await this.receipts.read(profile);
      if (!receipt) return false;
      return receipt.releaseDigest !== (await this.releaseDigest());
    } catch {
      return false;
    }
  }

  private isInteractive(): boolean {
    return Boolean((this.options.stdin ?? process.stdin).isTTY);
  }

  // Progress belongs on stderr so that --json and --yaml keep stdout to themselves.
  // One shared reporter, so anything else that writes can stop the animation first.
  private theme(): Theme {
    return createTheme(this.options.color?.() ?? false);
  }

  private renewalJob(profile: string): RenewalJobDescription | undefined {
    const platform = process.platform;
    return platform === "darwin" || platform === "linux" || platform === "win32" ? describeRenewalJob(platform, this.homeDirectory, profile) : undefined;
  }

  private progress(): ProgressReporter {
    this.progressReporter ??= createProgressReporter({ stream: this.options.stderr ?? process.stderr });
    return this.progressReporter;
  }

  // Sign-in moves to a browser window, so the terminal has to say what it is waiting
  // for and then keep a live line running until the browser comes back.
  private announceWait(message: string, waitingFor: string): void {
    const progress = this.progress();
    progress.clear();
    (this.options.stderr ?? process.stderr).write(`${message}\n\n`);
    progress.begin(waitingFor);
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

function renewalResultText(decision: RenewalDecision, theme: Theme): string {
  if (decision.state === "offline") return `${theme.tone("warning", "Moodle is unreachable.")} The remote session was preserved.`;
  if (decision.state === "needs_sign_in") return `${theme.tone("warning", "Moodle MCP needs sign-in.")} Run ${theme.key("moodle mcp login")}.`;
  if (decision.state === "conflict") return "Moodle MCP refreshed the remote session revision without overwriting it.";
  if (decision.reasonCode === "RENEWAL_AGENT_MISSING") return theme.tone("success", "Moodle MCP renewal agent installed.");
  return theme.tone("success", "Moodle MCP session is ready.");
}

function isClientList(value: unknown): value is { clients: Array<{ clientId: string; clientName: string; approved: boolean }> } {
  return typeof value === "object" && value !== null && Array.isArray((value as { clients?: unknown }).clients);
}

function renewalRunText(lastRun: { at: string; state: string; reasonCode: string | null } | null, theme: Theme): string {
  if (!lastRun) return theme.dim("never (the job has not reported yet)");
  const ago = Math.max(0, Math.round((Date.now() - Date.parse(lastRun.at)) / 60000));
  const when = ago < 1 ? "just now" : ago < 120 ? `${ago} min ago` : ago < 48 * 60 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} days ago`;
  return `${when} ${theme.status(lastRun.state.replaceAll("_", " "), { healthy: "success", "needs sign in": "warning", offline: "warning", conflict: "warning" })}`;
}

function pairingCopy(input: { endpoint: string; code: string; expiresAt: string | number }, theme: Theme): string {
  const expires = new Date(input.expiresAt);
  const minutes = Math.max(0, Math.round((expires.getTime() - Date.now()) / 60000));
  return [
    "Add this custom connector in Claude, then approve it with the pairing code.",
    "",
    theme.subject("Connector URL"),
    `  ${theme.key(input.endpoint)}`,
    "",
    theme.subject("Pairing code"),
    `  ${theme.key(formatPairingCode(input.code))}`,
    "",
    theme.dim(`One approval, valid for ${minutes} minutes (until ${expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}).`),
  ].join("\n");
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

async function readAll(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let value = "";
  for await (const chunk of input) value += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  return value + decoder.decode();
}

function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function truncateName(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const suffix = sha256(value).slice(0, 8);
  return `${value.slice(0, maximum - suffix.length - 1).replace(/-+$/u, "")}-${suffix}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
