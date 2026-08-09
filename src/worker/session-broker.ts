import { createEncryptionKeyring, decryptValue, encryptValue, type EncryptionKeyring } from "./crypto.js";
import { createMoodleClientCore } from "../moodle-client-core.js";
import { createMoodleGateway } from "../mcp/gateway.js";
import { createMoodleMcpServer } from "../mcp/server.js";
import type { McpRequestContext } from "../mcp/protocol.js";
import { FetchMoodleSessionUpstream } from "./moodle-upstream.js";
import { problemResponse } from "./problems.js";
import { WORKER_SERVICE_ID, WORKER_SERVICE_VERSION } from "./http.js";

const SESSION_STORAGE_KEY = "session";
const DEFAULT_TOUCH_DELAY_MS = 30 * 60 * 1000;
const MIN_TOUCH_DELAY_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const SESSION_STALE_MS = 24 * 60 * 60 * 1000;
const SESSION_EXPIRING_MS = 15 * 60 * 1000;

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
}

export interface SessionBrokerDependencies {
  upstream: MoodleSessionUpstream;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface StoredSession {
  encrypted_cookie: string;
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
}

export class SessionBroker {
  private readonly now: () => number;
  private readonly dependencies: SessionBrokerDependencies;
  private keyringPromise: Promise<EncryptionKeyring> | undefined;

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: SessionBrokerEnv,
    dependencies?: SessionBrokerDependencies,
  ) {
    this.dependencies = dependencies ?? { upstream: new FetchMoodleSessionUpstream(env.MOODLE_ORIGIN) };
    this.now = this.dependencies.now ?? Date.now;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" && request.method === "POST") return this.handleMcp(request);
    if (url.pathname === "/readyz" && request.method === "GET") return this.ready();
    if (url.pathname === "/session" && request.method === "PUT") return this.replaceSession(request);
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

    const session = await this.state.storage.get<StoredSession>(SESSION_STORAGE_KEY);
    if (!session) {
      return problemResponse(503, "SESSION_MISSING", "Service Unavailable", "No Moodle session is available.");
    }
    if (session.last_error_code === "SESSION_EXPIRED" || (session.expires_at !== null && session.expires_at <= this.now())) {
      return problemResponse(503, "SESSION_EXPIRED", "Service Unavailable", "The Moodle session has expired.");
    }

    let cookieValue: string;
    try {
      cookieValue = (await decryptValue(session.encrypted_cookie, await this.keyring())).value;
    } catch {
      return problemResponse(503, "SESSION_UNAVAILABLE", "Service Unavailable", "The Moodle session is unavailable.");
    }

    const client = createMoodleClientCore(this.env.MOODLE_ORIGIN, {
      cookie: { name: session.cookie_name, value: cookieValue },
      sesskey: session.sesskey,
      userid: session.moodle_user_id,
      fetchImpl: this.dependencies.fetchImpl,
    });
    const server = createMoodleMcpServer(createMoodleGateway(client));
    const response = await server.handle(envelope.request, envelope.context);
    return Response.json({ response }, { headers: { "cache-control": "private, no-store" } });
  }

  async alarm(): Promise<void> {
    await this.touchSession();
  }

  private async ready(): Promise<Response> {
    const session = await this.state.storage.get<StoredSession>(SESSION_STORAGE_KEY);
    const health = readiness(session, this.now());
    return Response.json(health, {
      status: health.status === "fail" ? 503 : 200,
      headers: { "content-type": "application/health+json; charset=utf-8" },
    });
  }

  private async replaceSession(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return problemResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported Media Type", "Session updates must use application/json.");
    }

    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return problemResponse(400, "INVALID_JSON", "Bad Request", "The request body is not valid JSON.");
    }
    if (!isSessionCandidate(input)) {
      return problemResponse(400, "SESSION_CANDIDATE_INVALID", "Bad Request", "The session candidate is invalid.");
    }
    if (normalizeOrigin(input.moodleOrigin) !== normalizeOrigin(this.env.MOODLE_ORIGIN)) {
      return problemResponse(403, "MOODLE_ORIGIN_MISMATCH", "Forbidden", "The session candidate belongs to a different Moodle origin.");
    }

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
    const keyring = await this.keyring();
    const encryptedCookie = await encryptValue(validation.rotatedCookie ?? input.cookieValue, keyring);
    const result = await this.transaction(async (storage) => {
      const current = await storage.get<StoredSession>(SESSION_STORAGE_KEY);
      const currentRevision = current?.revision ?? null;
      if (currentRevision !== input.expectedRevision) return null;
      const session: StoredSession = {
        encrypted_cookie: encryptedCookie,
        cookie_name: input.cookieName,
        revision: (currentRevision ?? 0) + 1,
        sesskey: validation.sesskey,
        moodle_user_id: validation.moodleUserId,
        last_verified_at: now,
        last_touch_at: null,
        last_error_code: null,
        next_alarm_at: nextAlarmAt,
        expires_at: expiresAt(now, validation.remainingSeconds),
        failure_count: 0,
      };
      await storage.put(SESSION_STORAGE_KEY, session);
      return session;
    });

    if (!result) {
      return problemResponse(409, "SESSION_REVISION_CONFLICT", "Conflict", "The remote Moodle session has a newer revision.");
    }
    await this.state.storage.setAlarm(nextAlarmAt);
    return Response.json(
      { status: "accepted", revision: result.revision, lastVerifiedAt: new Date(result.last_verified_at).toISOString() },
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
    const current = await this.state.storage.get<StoredSession>(SESSION_STORAGE_KEY);
    if (!current) return "missing";

    let cookie: string;
    let needsKeyRotation = false;
    try {
      const decrypted = await decryptValue(current.encrypted_cookie, await this.keyring());
      cookie = decrypted.value;
      needsKeyRotation = decrypted.needsRotation;
    } catch {
      await this.recordFailure(current, "SESSION_DECRYPTION_FAILED");
      return "unreachable";
    }

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
      const expired = { ...current, last_error_code: "SESSION_EXPIRED", expires_at: this.now(), next_alarm_at: null };
      if (await this.putIfCurrent(current, expired)) await this.state.storage.deleteAlarm?.();
      return "expired";
    }

    const now = this.now();
    const nextAlarmAt = nextTouchAt(now, touched.remainingSeconds);
    const nextCookie = touched.rotatedCookie ?? cookie;
    const updated: StoredSession = {
      ...current,
      encrypted_cookie: touched.rotatedCookie || needsKeyRotation
        ? await encryptValue(nextCookie, await this.keyring())
        : current.encrypted_cookie,
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
    return await this.state.storage.get<StoredSession>(SESSION_STORAGE_KEY) ?? "missing";
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
      const current = await storage.get<StoredSession>(SESSION_STORAGE_KEY);
      if (current?.revision !== expected.revision || current.encrypted_cookie !== expected.encrypted_cookie) return false;
      await storage.put(SESSION_STORAGE_KEY, updated);
      return true;
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
    serviceId: WORKER_SERVICE_ID,
    version: WORKER_SERVICE_VERSION,
    checks: {
      "moodle:session": [{
        status: sessionStatus,
        code: sessionCode,
        ...(session ? { time: new Date(session.last_verified_at).toISOString(), revision: session.revision } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpEnvelope(value: unknown): value is { request: unknown; context: McpRequestContext } {
  if (!isRecord(value) || !("request" in value) || !isRecord(value.context)) return false;
  return (value.context.protocolVersion === undefined || typeof value.context.protocolVersion === "string")
    && (value.context.method === undefined || typeof value.context.method === "string")
    && (value.context.toolName === undefined || typeof value.context.toolName === "string");
}
