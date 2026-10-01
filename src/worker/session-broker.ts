import { createEncryptionKeyring, decryptValue, encryptValue, type EncryptionKeyring } from "./crypto.js";
import { createMoodleClientCore, MoodleClientCoreApiError } from "../moodle-client-core.js";
import { createMoodleGateway, MoodleGatewayError, type MoodleGateway } from "../mcp/gateway.js";
import { createMoodleMcpServer } from "../mcp/server.js";
import { fetchLatestVersion, isNewerVersion, updateHint, UPDATE_CHECK_TTL_MS, type LatestVersionRecord } from "../update-core.js";
import { VERSION } from "../version.js";
import type { McpRequestContext } from "../mcp/protocol.js";
import type { MobileToken } from "../mobile-login-core.js";
import { FetchMoodleSessionUpstream } from "./moodle-upstream.js";
import { problemResponse } from "./problems.js";
import { WORKER_SERVICE_ID, WORKER_SERVICE_VERSION } from "./http.js";
import { isRecoveredSession, ServiceBindingSessionRecovery, type SessionRecoveryProvider, type SessionRecoveryServiceBinding } from "./session-recovery.js";

const SESSION_STORAGE_KEY = "session";
const DEFAULT_TOUCH_DELAY_MS = 30 * 60 * 1000;
const MIN_TOUCH_DELAY_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const SESSION_STALE_MS = 24 * 60 * 60 * 1000;
const LATEST_VERSION_KEY = "latest_version";
const SESSION_EXPIRING_MS = 15 * 60 * 1000;
// Moodle refuses a second autologin key for the same user within six minutes.
const MINT_INTERVAL_MS = 6 * 60 * 1000;
const MINT_RETRY_MS = 30 * 60 * 1000;
const MAX_MINT_RETRIES = 6;
const RECOVERY_STORAGE_KEY = "session_recovery";
const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
const RECOVERY_TIMEOUT_MS = 60 * 1000;

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
  transaction?<T>(callback: (transaction: DurableObjectStorageLike) => Promise<T>): Promise<T>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export interface SessionBrokerEnv {
  MOODLE_ORIGIN: string;
  SESSION_ENCRYPTION_KEY: string;
  SESSION_ENCRYPTION_KEY_PREVIOUS?: string;
  SESSION_CREDENTIAL_ID?: string;
  MOODLE_SESSION_RECOVERY?: SessionRecoveryServiceBinding;
}

export interface SessionCandidate {
  moodleOrigin: string;
  cookieName: string;
  cookieValue: string;
  expectedRevision: number | null;
}

export interface SessionValidationSuccess {
  valid: true;
  sesskey: string;
  moodleUserId: number;
  remainingSeconds: number | null;
  rotatedCookie?: string;
}

export interface SessionValidationFailure {
  valid: false;
  code: "SESSION_EXPIRED" | "SESSION_INVALID";
}

export interface SessionTouchResult {
  alive: boolean | null;
  remainingSeconds: number | null;
  rotatedCookie?: string;
}

export interface MoodleSessionUpstream {
  validate(candidate: SessionCandidate): Promise<SessionValidationSuccess | SessionValidationFailure>;
  touch(session: {
    moodleOrigin: string;
    cookieName: string;
    cookieValue: string;
    sesskey: string;
  }): Promise<SessionTouchResult>;
  // Only where the site enables Moodle's mobile service: a live cookie buys a
  // durable token, and the token later mints a fresh cookie with nobody present.
  captureMobileToken?(cookie: { name: string; value: string }): Promise<MobileToken | null>;
  mintSession?(moodleUserId: number, token: MobileToken): Promise<{ name: string; value: string } | null>;
}

export interface SessionBrokerDependencies {
  upstream: MoodleSessionUpstream;
  fetchImpl?: typeof fetch;
  now?: () => number;
  recovery?: SessionRecoveryProvider;
  recoveryTimeoutMs?: number;
}

interface StoredSession {
  cookie_value: string;
  cookie_name: string;
  revision: number;
  sesskey: string;
  moodle_user_id: number;
  last_verified_at: number;
  last_touch_at: number | null;
  last_error_code: string | null;
  next_alarm_at: number | null;
  expires_at: number | null;
  failure_count: number;
  mobile_token?: MobileToken;
  last_mint_at?: number;
  mobile_token_failed?: boolean;
}

export class SessionBroker {
  private readonly now: () => number;
  private readonly dependencies: SessionBrokerDependencies;
  private keyringPromise: Promise<EncryptionKeyring> | undefined;
  private renewing: Promise<StoredSession | null> | null = null;
  private readonly recovery: SessionRecoveryProvider | undefined;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: SessionBrokerEnv,
    dependencies?: SessionBrokerDependencies,
  ) {
    this.dependencies = dependencies ?? { upstream: new FetchMoodleSessionUpstream(env.MOODLE_ORIGIN) };
    this.now = this.dependencies.now ?? Date.now;
    this.recovery = this.dependencies.recovery
      ?? (env.MOODLE_SESSION_RECOVERY ? new ServiceBindingSessionRecovery(env.MOODLE_SESSION_RECOVERY) : undefined);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch {
      return problemResponse(503, "SESSION_UNAVAILABLE", "Service Unavailable", "The encrypted session could not be read. Restore its encryption key before retrying.");
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" && request.method === "POST") return this.handleMcp(request);
    if (url.pathname === "/readyz" && request.method === "GET") return this.ready();
    if (url.pathname === "/session" && request.method === "PUT") return this.replaceSession(request);
    if (url.pathname === "/session/adopt" && request.method === "POST") return this.adoptSession(request);
    if (url.pathname === "/session/touch" && request.method === "POST") return this.touchNow();
    return problemResponse(404, "NOT_FOUND", "Not Found", "The requested session route does not exist.");
  }

  private async handleMcp(request: Request): Promise<Response> {
    let envelope: unknown;
    try {
      envelope = await request.json();
    } catch {
      return problemResponse(400, "INVALID_JSON", "Bad Request", "The internal MCP request is not valid JSON.");
    }
    if (!isMcpEnvelope(envelope)) {
      return problemResponse(400, "MCP_PROTOCOL_METADATA_INVALID", "Bad Request", "The internal MCP request is invalid.");
    }

    const { signInUrl, ...context } = envelope.context;
    const session = await this.loadSession();
    // Without a usable session the connector still initializes and lists tools, so a
    // hosted client shows it as connected and every tool call says where to sign in.
    let live = session && isLive(session, this.now()) ? session : null;
    // The expiry is an estimate, so ask Moodle before renewing; a dead cookie renews
    // inside the touch.
    if (session && !live) {
      const touched = await this.touchSession();
      live = typeof touched === "object" && isLive(touched, this.now()) ? touched : null;
    }
    const signedIn = live !== null;
    const gateway = live
      ? this.gatewayFor(live)
      : signedOutGateway();
    // Only initialize pays for the registry lookup, and only once a day; every
    // session then starts with the notice until the Worker is redeployed.
    const initializing = isRecord(envelope.request) && envelope.request.method === "initialize";
    const latest = initializing ? await this.latestVersion(true) : undefined;
    const instructions = [
      ...(signedIn ? [] : [signInUrl ? `Moodle is not signed in yet; ask the user to open ${signInUrl} and sign in.` : "Moodle is not signed in yet; ask the user to run moodle mcp login."]),
      ...(latest && isNewerVersion(latest, VERSION) ? [`${updateHint(VERSION, latest)} to redeploy this server.`] : []),
    ];
    const server = createMoodleMcpServer(gateway, { instructions, ...(signInUrl ? { signInUrl } : {}) });
    const response = await server.handle(envelope.request, context);
    return Response.json({ response }, { headers: { "cache-control": "private, no-store" } });
  }

  // The record can call a session live after Moodle has dropped it, so a refused
  // read recovers here once and retries; the core shares that recovery with any
  // other read already in flight.
  private gatewayFor(session: StoredSession): MoodleGateway {
    let used = session;
    return createMoodleGateway(createMoodleClientCore(this.env.MOODLE_ORIGIN, {
      cookie: { name: session.cookie_name, value: session.cookie_value },
      sesskey: session.sesskey,
      userid: session.moodle_user_id,
      fetchImpl: this.dependencies.fetchImpl,
      onLoginRequired: async () => {
        const renewed = await this.recoverRejected(used);
        if (!renewed) throw new MoodleClientCoreApiError("No usable Moodle session could be recovered.", "servicerequireslogin");
        used = renewed;
        return {
          cookie: { name: renewed.cookie_name, value: renewed.cookie_value },
          pageContext: {
            sesskey: renewed.sesskey,
            user_info: { userid: renewed.moodle_user_id, username: "", fullname: "", sitename: "", siteurl: this.env.MOODLE_ORIGIN },
          },
        };
      },
    }));
  }

  async alarm(): Promise<void> {
    try {
      await this.touchSession();
    } catch {
      await this.state.storage.setAlarm(this.now() + MAX_BACKOFF_MS);
    }
  }

  // The Worker can only report a newer release; deploying one needs the owner's
  // Cloudflare credentials, which stay on their machine.
  private async latestVersion(refresh: boolean): Promise<string | undefined> {
    const cached = await this.state.storage.get<LatestVersionRecord>(LATEST_VERSION_KEY);
    if (cached && this.now() - cached.checked_at < UPDATE_CHECK_TTL_MS) return cached.latest;
    if (!refresh) return cached?.latest;
    const latest = await fetchLatestVersion(this.dependencies.fetchImpl, 3000);
    if (!latest) return cached?.latest;
    await this.state.storage.put<LatestVersionRecord>(LATEST_VERSION_KEY, { latest, checked_at: this.now() });
    return latest;
  }

  private async ready(): Promise<Response> {
    const session = await this.loadSession();
    const health = readiness(session, this.now());
    const latest = await this.latestVersion(false);
    return Response.json({ ...health, version: VERSION, ...(latest ? { latest_version: latest } : {}), encryptionKeyId: (await this.keyring()).current.id, ...(this.env.SESSION_CREDENTIAL_ID ? { credentialId: this.env.SESSION_CREDENTIAL_ID } : {}) }, {
      status: health.status === "fail" ? 503 : 200,
      headers: { "content-type": "application/health+json; charset=utf-8" },
    });
  }

  private async replaceSession(request: Request): Promise<Response> {
    const input = await readJson(request);
    if (input instanceof Response) return input;
    if (!isSessionCandidate(input)) {
      return problemResponse(400, "SESSION_CANDIDATE_INVALID", "Bad Request", "The session candidate is invalid.");
    }
    if (normalizeOrigin(input.moodleOrigin) !== normalizeOrigin(this.env.MOODLE_ORIGIN)) {
      return problemResponse(403, "MOODLE_ORIGIN_MISMATCH", "Forbidden", "The session candidate belongs to a different Moodle origin.");
    }
    return this.storeSession(input, (current) => (current?.revision ?? null) === input.expectedRevision ? "ok" : "revision_conflict");
  }

  // A browser sign-in replaces whatever session is stored, so it skips the revision
  // check. The account check still applies, and only a claimed sign-in may be first.
  private async adoptSession(request: Request): Promise<Response> {
    const input = await readJson(request);
    if (input instanceof Response) return input;
    const candidate = isRecord(input)
      ? { moodleOrigin: this.env.MOODLE_ORIGIN, cookieName: input.cookieName, cookieValue: input.cookieValue, expectedRevision: null }
      : undefined;
    if (!isSessionCandidate(candidate) || !isRecord(input) || typeof input.allowNewOwner !== "boolean") {
      return problemResponse(400, "SESSION_CANDIDATE_INVALID", "Bad Request", "The session candidate is invalid.");
    }
    const allowNewOwner = input.allowNewOwner;
    return this.storeSession(candidate, (current) => current || allowNewOwner ? "ok" : "owner_claim_required");
  }

  private async storeSession(
    input: SessionCandidate,
    admit: (current: StoredSession | undefined) => "ok" | "revision_conflict" | "owner_claim_required",
  ): Promise<Response> {
    let validation: SessionValidationSuccess | SessionValidationFailure;
    try {
      validation = await this.dependencies.upstream.validate(input);
    } catch {
      return problemResponse(503, "MOODLE_UNREACHABLE", "Service Unavailable", "Moodle could not be reached to validate the session candidate.");
    }
    if (!validation.valid) {
      return problemResponse(422, "SESSION_CANDIDATE_INVALID", "Unprocessable Content", "Moodle rejected the session candidate.");
    }

    const now = this.now();
    const nextAlarmAt = nextTouchAt(now, validation.remainingSeconds);
    if (!Number.isSafeInteger(validation.moodleUserId) || validation.moodleUserId <= 0) {
      return problemResponse(422, "SESSION_IDENTITY_UNKNOWN", "Unprocessable Content", "Moodle did not provide a valid account identity.");
    }
    const result = await this.transaction(async (storage) => {
      const current = await this.readSession(storage);
      const admission = admit(current);
      if (admission !== "ok") return admission;
      if (current && current.moodle_user_id !== validation.moodleUserId) return "identity_mismatch" as const;
      const session: StoredSession = {
        cookie_value: validation.rotatedCookie ?? input.cookieValue,
        cookie_name: input.cookieName,
        revision: (current?.revision ?? 0) + 1,
        sesskey: validation.sesskey,
        moodle_user_id: validation.moodleUserId,
        last_verified_at: now,
        last_touch_at: null,
        last_error_code: null,
        next_alarm_at: nextAlarmAt,
        expires_at: expiresAt(now, validation.remainingSeconds),
        failure_count: 0,
        // The account check above makes the stored token safe to keep, unless
        // Moodle already refused it; then this sign-in fetches a fresh one.
        ...(current?.mobile_token && !current.mobile_token_failed ? { mobile_token: current.mobile_token } : {}),
        ...(current?.last_mint_at !== undefined ? { last_mint_at: current.last_mint_at } : {}),
      };
      await this.writeSession(storage, session);
      return session;
    });

    if (result === "identity_mismatch") {
      return problemResponse(409, "SESSION_ACCOUNT_MISMATCH", "Conflict", "This Worker belongs to another Moodle account. Create a separate deployment for that account.");
    }
    if (result === "revision_conflict") {
      return problemResponse(409, "SESSION_REVISION_CONFLICT", "Conflict", "The remote Moodle session has a newer revision.");
    }
    if (result === "owner_claim_required") {
      return problemResponse(403, "OWNER_CLAIM_REQUIRED", "Forbidden", "This Worker has no owner yet. Sign in with the pairing code from the deployment.");
    }
    await this.state.storage.setAlarm(nextAlarmAt);
    const renewal = result.mobile_token || await this.captureMobileToken(result) ? "mobile_token" : "sign_in";
    return Response.json(
      { status: "accepted", revision: result.revision, lastVerifiedAt: new Date(result.last_verified_at).toISOString(), renewal },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }

  private async touchNow(): Promise<Response> {
    const result = await this.touchSession();
    if (result === "missing") {
      return problemResponse(409, "SESSION_MISSING", "Conflict", "No Moodle session is available.");
    }
    if (result === "unreachable") {
      return problemResponse(503, "MOODLE_UNREACHABLE", "Service Unavailable", "Moodle could not be reached.");
    }
    if (result === "expired") {
      return problemResponse(409, "SESSION_EXPIRED", "Conflict", "The Moodle session has expired.");
    }
    return Response.json({ status: "kept_alive", revision: result.revision, nextAlarmAt: result.next_alarm_at });
  }

  private async touchSession(): Promise<StoredSession | "missing" | "unreachable" | "expired"> {
    const current = await this.loadSession();
    if (!current) return "missing";

    const cookie = current.cookie_value;

    let touched: SessionTouchResult;
    try {
      touched = await this.dependencies.upstream.touch({
        moodleOrigin: this.env.MOODLE_ORIGIN,
        cookieName: current.cookie_name,
        cookieValue: cookie,
        sesskey: current.sesskey,
      });
    } catch {
      await this.recordFailure(current, "MOODLE_UNREACHABLE");
      return "unreachable";
    }

    if (touched.alive === null) {
      await this.recordFailure(current, "MOODLE_UNREACHABLE");
      return "unreachable";
    }
    if (!touched.alive) {
      const renewed = await this.renewOnce(current);
      if (renewed) return renewed;
      // The mint attempt may have stamped last_mint_at on this same session, so
      // re-read it; anything newer was uploaded meanwhile and this touch says
      // nothing about it.
      const latest = await this.loadSession();
      if (!latest) return "missing";
      if (!sameSession(latest, current)) return latest;
      // A kept token or a recovery service retries on a slow schedule, in case
      // Moodle or the service was only briefly unwell; without either, only a new
      // sign-in brings the session back.
      const retries = Boolean(latest.mobile_token || this.recovery);
      const retryAt = retries && latest.failure_count < MAX_MINT_RETRIES ? this.now() + MINT_RETRY_MS : null;
      const expired = {
        ...latest,
        last_error_code: "SESSION_EXPIRED",
        expires_at: this.now(),
        next_alarm_at: retryAt,
        failure_count: retries ? latest.failure_count + 1 : latest.failure_count,
      };
      if (await this.putIfCurrent(latest, expired)) {
        if (retryAt) await this.state.storage.setAlarm(retryAt);
        else await this.state.storage.deleteAlarm?.();
      }
      return "expired";
    }

    const now = this.now();
    const nextAlarmAt = nextTouchAt(now, touched.remainingSeconds);
    const nextCookie = touched.rotatedCookie ?? cookie;
    const updated: StoredSession = {
      ...current,
      cookie_value: nextCookie,
      revision: touched.rotatedCookie ? current.revision + 1 : current.revision,
      last_verified_at: now,
      last_touch_at: now,
      last_error_code: null,
      next_alarm_at: nextAlarmAt,
      expires_at: expiresAt(now, touched.remainingSeconds),
      failure_count: 0,
    };
    if (await this.putIfCurrent(current, updated)) {
      await this.state.storage.setAlarm(nextAlarmAt);
      return updated;
    }
    return await this.loadSession() ?? "missing";
  }

  // Trade a live cookie for a durable token once, right after it is stored. Any
  // failure just leaves the Worker on the sign-in path.
  private async captureMobileToken(session: StoredSession): Promise<boolean> {
    const { upstream } = this.dependencies;
    if (!upstream.captureMobileToken) return false;
    let token: MobileToken | null;
    try {
      token = await upstream.captureMobileToken({ name: session.cookie_name, value: session.cookie_value });
    } catch {
      return false;
    }
    // Without the private token Moodle will not issue an autologin key.
    if (!token?.privatetoken) return false;
    const mobileToken: MobileToken = { wstoken: token.wstoken, privatetoken: token.privatetoken };
    return this.transaction(async (storage) => {
      const current = await this.readSession(storage);
      if (current?.moodle_user_id !== session.moodle_user_id) return false;
      await this.writeSession(storage, { ...current, mobile_token: mobileToken, mobile_token_failed: false });
      return true;
    });
  }

  // Concurrent reads that all find the session dead share one renewal, so a single
  // outage never spends Moodle's one-key-per-six-minutes allowance or the recovery
  // service's cooldown twice. The mobile token goes first: it is Moodle's own path
  // and needs nobody. A site without it can still come back through the owner's
  // recovery service.
  private renewOnce(current: StoredSession): Promise<StoredSession | null> {
    this.renewing ??= (async () => await this.renewFromMobileToken(current) ?? await this.recoverFromService(current))()
      .finally(() => { this.renewing = null; });
    return this.renewing;
  }

  // Moodle refused a cookie the record still calls live. Someone may already have
  // replaced it; otherwise mint a fresh one the same way an expired record would.
  private async recoverRejected(used: StoredSession): Promise<StoredSession | null> {
    const latest = await this.loadSession();
    if (!latest || latest.moodle_user_id !== used.moodle_user_id) return null;
    if (!sameSession(latest, used)) return isLive(latest, this.now()) ? latest : this.renewOnce(latest);
    return this.renewOnce(latest);
  }

  private async renewFromMobileToken(current: StoredSession): Promise<StoredSession | null> {
    const { upstream } = this.dependencies;
    const token = current.mobile_token;
    const now = this.now();
    if (!upstream.mintSession || !token) return null;
    if (current.last_mint_at !== undefined && now - current.last_mint_at < MINT_INTERVAL_MS) return null;
    // Record the attempt before making it, so concurrent callers and a restarted
    // object stay inside Moodle's rate limit.
    const attempted: StoredSession = { ...current, last_mint_at: now };
    if (!await this.putIfCurrent(current, attempted)) return null;
    try {
      const cookie = await upstream.mintSession(current.moodle_user_id, token);
      const validation = cookie
        ? await upstream.validate({ moodleOrigin: this.env.MOODLE_ORIGIN, cookieName: cookie.name, cookieValue: cookie.value, expectedRevision: null })
        : null;
      if (!cookie || !validation?.valid || validation.moodleUserId !== current.moodle_user_id) {
        // Moodle answered and said no (revoked token, service turned off), so the
        // next sign-in should not keep this token.
        await this.putIfCurrent(attempted, { ...attempted, mobile_token_failed: true });
        return null;
      }
      const nextAlarmAt = nextTouchAt(now, validation.remainingSeconds);
      const renewed: StoredSession = {
        ...attempted,
        cookie_value: validation.rotatedCookie ?? cookie.value,
        cookie_name: cookie.name,
        revision: attempted.revision + 1,
        sesskey: validation.sesskey,
        last_verified_at: now,
        last_touch_at: null,
        last_error_code: null,
        next_alarm_at: nextAlarmAt,
        expires_at: expiresAt(now, validation.remainingSeconds),
        failure_count: 0,
        mobile_token_failed: false,
      };
      if (!await this.putIfCurrent(attempted, renewed)) return null;
      await this.state.storage.setAlarm(nextAlarmAt);
      return renewed;
    } catch {
      return null;
    }
  }

  // Asks the owner's recovery service for a fresh cookie. The service only learns the
  // origin and account; its candidate is validated and stored like any upload, so it
  // cannot switch accounts or overwrite a newer session.
  private async recoverFromService(expected: StoredSession): Promise<StoredSession | null> {
    if (!this.recovery) return null;
    const claimed = await this.transaction(async (storage) => {
      const current = await this.readSession(storage);
      if (!current || !sameSession(current, expected)) return false;
      const previous = await storage.get<{ retryAfter: number }>(RECOVERY_STORAGE_KEY);
      if (previous && previous.retryAfter > this.now()) return false;
      // Persist before external I/O so eviction or another request cannot launch a second recovery.
      await storage.put(RECOVERY_STORAGE_KEY, { retryAfter: this.now() + RECOVERY_COOLDOWN_MS });
      return true;
    });
    if (!claimed) return null;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let recovered: Awaited<ReturnType<SessionRecoveryProvider["recover"]>>;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Moodle session recovery timed out."));
        }, this.dependencies.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS);
      });
      recovered = await Promise.race([
        this.recovery.recover({ moodleOrigin: this.env.MOODLE_ORIGIN, moodleUserId: expected.moodle_user_id, reason: "SESSION_EXPIRED", signal: controller.signal }),
        timeout,
      ]);
    } catch {
      // Provider diagnostics may contain credentials; keep failures inside the broker.
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!isRecoveredSession(recovered) || normalizeOrigin(recovered.moodleOrigin) !== normalizeOrigin(this.env.MOODLE_ORIGIN)) return null;
    const stored = await this.storeSession(
      { ...recovered, expectedRevision: expected.revision },
      (current) => current?.revision === expected.revision ? "ok" : "revision_conflict",
    );
    if (!stored.ok) return null;
    const latest = await this.loadSession();
    return latest && isLive(latest, this.now()) ? latest : null;
  }

  private async recordFailure(current: StoredSession, code: string): Promise<void> {
    const failureCount = current.failure_count + 1;
    const nextAlarmAt = this.now() + Math.min(MIN_TOUCH_DELAY_MS * (2 ** (failureCount - 1)), MAX_BACKOFF_MS);
    const updated = {
      ...current,
      last_error_code: code,
      next_alarm_at: nextAlarmAt,
      failure_count: failureCount,
    } satisfies StoredSession;
    if (await this.putIfCurrent(current, updated)) await this.state.storage.setAlarm(nextAlarmAt);
  }

  private putIfCurrent(expected: StoredSession, updated: StoredSession): Promise<boolean> {
    return this.transaction(async (storage) => {
      const current = await this.readSession(storage);
      if (current?.revision !== expected.revision || current.cookie_value !== expected.cookie_value
        || current.last_mint_at !== expected.last_mint_at) return false;
      await this.writeSession(storage, updated);
      return true;
    });
  }

  private async readSession(storage: DurableObjectStorageLike): Promise<StoredSession | undefined> {
    const record = await storage.get<Record<string, unknown>>(SESSION_STORAGE_KEY);
    if (!record) return undefined;
    if (record.version === 2 && typeof record.encrypted_session === "string") {
      const decrypted = await decryptValue(record.encrypted_session, await this.keyring());
      const session = JSON.parse(decrypted.value) as StoredSession;
      if (typeof session.cookie_value !== "string" || typeof session.sesskey !== "string"
        || !Number.isSafeInteger(session.moodle_user_id) || session.moodle_user_id <= 0) throw new Error("Invalid encrypted session.");
      return session;
    }
    if (typeof record.encrypted_cookie !== "string") throw new Error("Invalid legacy session.");
    const { encrypted_cookie, ...metadata } = record;
    const cookie = await decryptValue(encrypted_cookie, await this.keyring());
    return { ...metadata, cookie_value: cookie.value } as unknown as StoredSession;
  }

  private async writeSession(storage: DurableObjectStorageLike, session: StoredSession): Promise<void> {
    await storage.put(SESSION_STORAGE_KEY, {
      version: 2,
      encrypted_session: await encryptValue(JSON.stringify(session), await this.keyring()),
    });
  }

  private async loadSession(): Promise<StoredSession | undefined> {
    return this.transaction(async (storage) => {
      const record = await storage.get<{ version?: number; encrypted_session?: string }>(SESSION_STORAGE_KEY);
      if (!record) return undefined;
      const session = await this.readSession(storage);
      if (session && (record.version !== 2 || (await decryptValue(record.encrypted_session!, await this.keyring())).needsRotation)) {
        await this.writeSession(storage, session);
      }
      return session;
    });
  }

  private transaction<T>(callback: (storage: DurableObjectStorageLike) => Promise<T>): Promise<T> {
    if (this.state.storage.transaction) return this.state.storage.transaction(callback);
    return callback(this.state.storage);
  }

  private keyring(): Promise<EncryptionKeyring> {
    this.keyringPromise ??= createEncryptionKeyring(
      this.env.SESSION_ENCRYPTION_KEY,
      this.env.SESSION_ENCRYPTION_KEY_PREVIOUS,
    );
    return this.keyringPromise;
  }
}

function readiness(session: StoredSession | undefined, now: number) {
  let status: "pass" | "warn" | "fail" = "pass";
  let sessionStatus: "pass" | "warn" | "fail" = "pass";
  let sessionCode = "SESSION_VALID";
  let upstreamStatus: "pass" | "fail" = "pass";
  let upstreamCode = "MOODLE_REACHABLE";

  if (!session) {
    status = "fail";
    sessionStatus = "fail";
    sessionCode = "SESSION_MISSING";
  } else if (session.last_error_code === "MOODLE_UNREACHABLE" || session.last_error_code === "SESSION_DECRYPTION_FAILED") {
    status = "fail";
    upstreamStatus = "fail";
    upstreamCode = "MOODLE_UNREACHABLE";
  } else if (session.last_error_code === "SESSION_EXPIRED" || (session.expires_at !== null && session.expires_at <= now)) {
    status = "fail";
    sessionStatus = "fail";
    sessionCode = "SESSION_EXPIRED";
  } else if (session.expires_at !== null && session.expires_at - now <= SESSION_EXPIRING_MS) {
    status = "warn";
    sessionStatus = "warn";
    sessionCode = "SESSION_EXPIRING";
  } else if (now - session.last_verified_at > SESSION_STALE_MS) {
    status = "warn";
    sessionStatus = "warn";
    sessionCode = "SESSION_SYNC_STALE";
  }

  return {
    status,
    sessionSchemaVersion: 2,
    serviceId: WORKER_SERVICE_ID,
    version: WORKER_SERVICE_VERSION,
    checks: {
      "moodle:session": [{
        status: sessionStatus,
        code: sessionCode,
        ...(session ? { time: new Date(session.last_verified_at).toISOString(), revision: session.revision } : {}),
        // How the session comes back after it expires: by itself, or by a new sign-in.
        renewal: session?.mobile_token ? "mobile_token" : "sign_in",
      }],
      "moodle:upstream": [{ status: upstreamStatus, code: upstreamCode }],
    },
  };
}

function nextTouchAt(now: number, remainingSeconds: number | null): number {
  if (remainingSeconds === null) return now + DEFAULT_TOUCH_DELAY_MS;
  const halfLifetimeMs = Math.floor(remainingSeconds / 2) * 1000;
  return now + Math.max(MIN_TOUCH_DELAY_MS, Math.min(DEFAULT_TOUCH_DELAY_MS, halfLifetimeMs));
}

function expiresAt(now: number, remainingSeconds: number | null): number | null {
  return remainingSeconds === null ? null : now + Math.max(0, remainingSeconds) * 1000;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function isSessionCandidate(value: unknown): value is SessionCandidate {
  if (!isRecord(value)) return false;
  return typeof value.moodleOrigin === "string"
    && typeof value.cookieName === "string"
    && /^MoodleSession[A-Za-z0-9_-]*$/.test(value.cookieName)
    && typeof value.cookieValue === "string"
    && value.cookieValue.length > 0
    && value.cookieValue.length <= 4096
    && !/[\u0000-\u001f\u007f;]/.test(value.cookieValue)
    && (value.expectedRevision === null
      || (Number.isInteger(value.expectedRevision) && (value.expectedRevision as number) >= 0));
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return problemResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported Media Type", "Session updates must use application/json.");
  }
  try {
    return await request.json();
  } catch {
    return problemResponse(400, "INVALID_JSON", "Bad Request", "The request body is not valid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpEnvelope(value: unknown): value is { request: unknown; context: McpRequestContext & { signInUrl?: string } } {
  if (!isRecord(value) || !("request" in value) || !isRecord(value.context)) return false;
  return (value.context.signInUrl === undefined || (typeof value.context.signInUrl === "string" && value.context.signInUrl.startsWith("https://")))
    && (value.context.protocolVersion === undefined || typeof value.context.protocolVersion === "string")
    && (value.context.method === undefined || typeof value.context.method === "string")
    && (value.context.toolName === undefined || typeof value.context.toolName === "string");
}

function isLive(session: StoredSession, now: number): boolean {
  return session.last_error_code !== "SESSION_EXPIRED" && (session.expires_at === null || session.expires_at > now);
}

function sameSession(a: StoredSession, b: StoredSession): boolean {
  return a.revision === b.revision && a.cookie_value === b.cookie_value;
}

// Every read fails the same way, so the MCP server maps it to one auth error that
// names the sign-in link. The Worker never offers submit, signed in or not.
function signedOutGateway(): MoodleGateway {
  const fail = async (): Promise<never> => {
    throw new MoodleGatewayError("auth", "No Moodle session is signed in.");
  };
  return {
    getUser: fail,
    getOverview: fail,
    getDue: fail,
    listCourses: fail,
    getCourse: fail,
    listActivities: fail,
    getActivity: fail,
    getQuizAttempt: fail,
    getGrades: fail,
    listForums: fail,
    searchForums: fail,
    getThread: fail,
    getFile: fail,
    listThreads: fail,
    listNewsForums: fail,
  };
}
