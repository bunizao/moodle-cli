import {
  SessionBroker,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type MoodleSessionUpstream,
  type SessionBrokerEnv,
  type SessionCandidate,
} from "../src/worker/index.js";

const MOODLE_ORIGIN = "https://lms.example.edu";
const OLD_COOKIE = "old-cookie-secret";
const NEW_COOKIE = "new-cookie-secret";

class MemoryStorage implements DurableObjectStorageLike {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  private transactionTail = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async transaction<T>(callback: (transaction: DurableObjectStorageLike) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
}

function state(storage = new MemoryStorage()): DurableObjectStateLike & { storage: MemoryStorage } {
  return { storage };
}

function env(encryptionKey = "encryption-key-current", previous?: string): SessionBrokerEnv {
  return {
    MOODLE_ORIGIN,
    SESSION_ENCRYPTION_KEY: encryptionKey,
    SESSION_ENCRYPTION_KEY_PREVIOUS: previous,
  };
}

function candidate(cookieValue: string, expectedRevision: number | null): SessionCandidate {
  return {
    moodleOrigin: MOODLE_ORIGIN,
    cookieName: "MoodleSession",
    cookieValue,
    expectedRevision,
  };
}

function putSession(broker: SessionBroker, input: SessionCandidate): Promise<Response> {
  return broker.fetch(new Request("https://session-broker/session", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

function validUpstream(): MoodleSessionUpstream {
  return {
    validate: vi.fn(async () => ({ valid: true as const, sesskey: "sess", moodleUserId: 42, remainingSeconds: 7200 })),
    touch: vi.fn(async () => ({ alive: true, remainingSeconds: 7200 })),
  };
}

describe("SessionBroker Durable Object", () => {
  it("reports a missing session as an authenticated readiness failure", async () => {
    const broker = new SessionBroker(state(), env(), { upstream: validUpstream(), now: () => 1_000 });

    const response = await broker.fetch(new Request("https://session-broker/readyz"));

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/health+json; charset=utf-8");
    expect(await response.json()).toMatchObject({
      status: "fail",
      serviceId: "moodle-mcp",
      version: "0.7.0-alpha.3",
      checks: { "moodle:session": [{ status: "fail", code: "SESSION_MISSING" }] },
    });
  });

  it("encrypts a validated candidate and keeps the previous session when validation fails", async () => {
    const objectState = state();
    const upstream = validUpstream();
    vi.mocked(upstream.validate)
      .mockResolvedValueOnce({ valid: true, sesskey: "old-sess", moodleUserId: 42, remainingSeconds: 7200 })
      .mockResolvedValueOnce({ valid: false, code: "SESSION_EXPIRED" });
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => 10_000 });

    const accepted = await putSession(broker, candidate(OLD_COOKIE, null));
    const rejected = await putSession(broker, candidate(NEW_COOKIE, 1));

    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ revision: 1, status: "accepted" });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: "SESSION_CANDIDATE_INVALID" });
    expect(JSON.stringify(objectState.storage.values.get("session"))).not.toContain(OLD_COOKIE);
    expect(JSON.stringify(objectState.storage.values.get("session"))).not.toContain(NEW_COOKIE);

    await broker.alarm();
    expect(upstream.touch).toHaveBeenCalledWith(expect.objectContaining({ cookieValue: OLD_COOKIE, sesskey: "old-sess" }));
  });

  it("rejects the wrong Moodle origin and stale revisions without changing the active session", async () => {
    const upstream = validUpstream();
    const broker = new SessionBroker(state(), env(), { upstream, now: () => 20_000 });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);

    const wrongOrigin = await putSession(broker, { ...candidate(NEW_COOKIE, 1), moodleOrigin: "https://evil.example" });
    const stale = await putSession(broker, candidate(NEW_COOKIE, 0));

    expect(wrongOrigin.status).toBe(403);
    expect(await wrongOrigin.json()).toMatchObject({ code: "MOODLE_ORIGIN_MISMATCH" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    expect(upstream.validate).toHaveBeenCalledTimes(2);

    await broker.alarm();
    expect(upstream.touch).toHaveBeenLastCalledWith(expect.objectContaining({ cookieValue: OLD_COOKIE }));
  });

  it("captures Moodle cookie rotation and re-encrypts old records with the current key", async () => {
    const objectState = state();
    const initialUpstream = validUpstream();
    vi.mocked(initialUpstream.touch).mockResolvedValueOnce({
      alive: true,
      remainingSeconds: 3600,
      rotatedCookie: NEW_COOKIE,
    });
    const initial = new SessionBroker(objectState, env("old-encryption-key"), { upstream: initialUpstream, now: () => 30_000 });
    expect((await putSession(initial, candidate(OLD_COOKIE, null))).status).toBe(201);
    await initial.alarm();
    const afterCookieRotation = JSON.stringify(objectState.storage.values.get("session"));
    expect(afterCookieRotation).not.toContain(NEW_COOKIE);
    const staleAfterRotation = await putSession(initial, candidate(OLD_COOKIE, 1));
    expect(staleAfterRotation.status).toBe(409);
    expect(await staleAfterRotation.json()).toMatchObject({ code: "SESSION_REVISION_CONFLICT" });

    const rotatedKeyUpstream = validUpstream();
    const withRotatedKey = new SessionBroker(
      objectState,
      env("new-encryption-key", "old-encryption-key"),
      { upstream: rotatedKeyUpstream, now: () => 40_000 },
    );
    await withRotatedKey.alarm();

    expect(rotatedKeyUpstream.touch).toHaveBeenCalledWith(expect.objectContaining({ cookieValue: NEW_COOKIE }));
    expect(JSON.stringify(objectState.storage.values.get("session"))).not.toBe(afterCookieRotation);
    expect(JSON.stringify(objectState.storage.values.get("session"))).not.toContain(NEW_COOKIE);
  });

  it("backs alarms off after network failures while preserving the current cookie", async () => {
    const objectState = state();
    const upstream = validUpstream();
    let now = 100_000;
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => now });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);
    vi.mocked(upstream.touch).mockRejectedValue(new Error("network down"));

    await broker.alarm();
    expect(objectState.storage.alarm).toBe(160_000);
    now = 200_000;
    await broker.alarm();
    expect(objectState.storage.alarm).toBe(320_000);

    vi.mocked(upstream.touch).mockResolvedValue({ alive: true, remainingSeconds: 600 });
    now = 400_000;
    await broker.alarm();
    expect(upstream.touch).toHaveBeenLastCalledWith(expect.objectContaining({ cookieValue: OLD_COOKIE }));
    expect(objectState.storage.alarm).toBe(700_000);
  });

  it("serializes concurrent compare-and-swap updates", async () => {
    const upstream = validUpstream();
    const broker = new SessionBroker(state(), env(), { upstream, now: () => 500_000 });

    const [first, second] = await Promise.all([
      putSession(broker, candidate(OLD_COOKIE, null)),
      putSession(broker, candidate(NEW_COOKIE, null)),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
  });

  it("does not let an in-flight alarm overwrite a newer uploaded revision", async () => {
    const upstream = validUpstream();
    const broker = new SessionBroker(state(), env(), { upstream, now: () => 600_000 });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);

    let finishTouch!: (result: { alive: true; remainingSeconds: number; rotatedCookie: string }) => void;
    const inFlightTouch = new Promise<{ alive: true; remainingSeconds: number; rotatedCookie: string }>((resolve) => {
      finishTouch = resolve;
    });
    vi.mocked(upstream.touch).mockReturnValueOnce(inFlightTouch);
    const alarm = broker.alarm();
    await vi.waitFor(() => expect(upstream.touch).toHaveBeenCalledOnce());

    expect((await putSession(broker, candidate(NEW_COOKIE, 1))).status).toBe(201);
    finishTouch({ alive: true, remainingSeconds: 600, rotatedCookie: "stale-alarm-cookie" });
    await alarm;

    vi.mocked(upstream.touch).mockResolvedValue({ alive: true, remainingSeconds: 600 });
    await broker.alarm();
    expect(upstream.touch).toHaveBeenLastCalledWith(expect.objectContaining({ cookieValue: NEW_COOKIE }));
  });

  it("executes MCP inside the session-owning Durable Object without returning the cookie", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("cookie")).toBe(`MoodleSession=${OLD_COOKIE}`);
      return Response.json([{
        error: false,
        data: {
          userid: 42,
          username: "ada",
          fullname: "Ada Lovelace",
          sitename: "Example Moodle",
          siteurl: MOODLE_ORIGIN,
          sesskey: "sess",
        },
      }]);
    });
    const broker = new SessionBroker(state(), env(), {
      upstream: validUpstream(),
      fetchImpl,
      now: () => 700_000,
    });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);

    const response = await broker.fetch(new Request("https://session-broker/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_user",
            arguments: {},
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
            },
          },
        },
        context: { protocolVersion: "2026-07-28", method: "tools/call", toolName: "get_user" },
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      response: {
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { user: { userid: 42, fullname: "Ada Lovelace" } } },
      },
    });
    expect(JSON.stringify(body)).not.toContain(OLD_COOKIE);
  });
});

describe("encrypted session lifecycle", () => {
  it("encrypts the complete record and refuses an account switch", async () => {
    const objectState = state();
    const upstream = validUpstream();
    const broker = new SessionBroker(objectState, env(), { upstream });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);
    const persisted = objectState.storage.values.get("session") as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(["encrypted_session", "version"]);
    expect(JSON.stringify(persisted)).not.toContain('"sesskey"');
    expect(JSON.stringify(persisted)).not.toContain(OLD_COOKIE);
    vi.mocked(upstream.validate).mockResolvedValue({ valid: true, sesskey: "other", moodleUserId: 99, remainingSeconds: 7200 });
    const switched = await putSession(broker, candidate(NEW_COOKIE, 1));
    expect(switched.status).toBe(409);
    expect(await switched.json()).toMatchObject({ code: "SESSION_ACCOUNT_MISMATCH" });
    expect(objectState.storage.values.get("session")).toEqual(persisted);
  });

  it("fails closed with the wrong key and preserves recoverable ciphertext", async () => {
    const objectState = state();
    const broker = new SessionBroker(objectState, env(), { upstream: validUpstream() });
    await putSession(broker, candidate(OLD_COOKIE, null));
    const stored = structuredClone(objectState.storage.values.get("session"));
    const wrong = new SessionBroker(objectState, env("wrong"), { upstream: validUpstream() });
    expect((await wrong.fetch(new Request("https://broker/readyz"))).status).toBe(503);
    expect(objectState.storage.values.get("session")).toEqual(stored);
  });
});
