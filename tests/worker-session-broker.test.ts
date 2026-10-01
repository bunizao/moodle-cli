import { LATEST_VERSION_URL } from "../src/update-core.js";
import { VERSION } from "../src/version.js";
import {
  SessionBroker,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type MoodleSessionUpstream,
  type SessionBrokerEnv,
  type SessionCandidate,
  type RecoveredSession,
  type SessionRecoveryProvider,
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
      version: VERSION,
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
        result: { structuredContent: { user: { id: 42, name: "Ada Lovelace" } } },
      },
    });
    expect(JSON.stringify(body)).not.toContain(OLD_COOKIE);
  });

  function mcp(broker: SessionBroker, request: Record<string, unknown>, context: Record<string, unknown>): Promise<Response> {
    return broker.fetch(new Request("https://session-broker/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { jsonrpc: "2.0", id: 1, ...request }, context }),
    }));
  }

  it("answers MCP without a Moodle session and points every tool call to the sign-in page", async () => {
    const signInUrl = "https://moodle-mcp.example.workers.dev/oauth/login";
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === LATEST_VERSION_URL) return Response.json({ latest: VERSION });
      throw new Error("Moodle must not be called without a session.");
    });
    const broker = new SessionBroker(state(), env(), { upstream: validUpstream(), fetchImpl, now: () => 1_000 });

    const initialize = await mcp(broker, { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } }, { protocolVersion: "2025-06-18", method: "initialize", signInUrl });
    expect(initialize.status).toBe(200);
    expect((await initialize.json() as { response: { result: { instructions: string } } }).response.result.instructions).toContain(`open ${signInUrl} and sign in`);

    const list = await mcp(broker, { method: "tools/list", params: {} }, { protocolVersion: "2025-06-18", method: "tools/list", signInUrl });
    const tools = (await list.json() as { response: { result: { tools: Array<{ name: string }> } } }).response.result.tools.map(tool => tool.name);
    expect(tools).toContain("units");
    expect(tools).not.toContain("submit");

    const call = await mcp(broker, { method: "tools/call", params: { name: "units", arguments: {} } }, { protocolVersion: "2025-06-18", method: "tools/call", toolName: "units", signInUrl });
    expect(call.status).toBe(200);
    expect(await call.json()).toMatchObject({
      response: {
        result: {
          isError: true,
          structuredContent: { error: { type: "MOODLE_AUTH_REQUIRED", recovery: { action: "open_url", url: signInUrl } } },
        },
      },
    });
    expect(fetchImpl.mock.calls.every(([input]) => String(input) === LATEST_VERSION_URL)).toBe(true);
  });

  it("stops using an expired session and falls back to the CLI hint without a sign-in page", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("Moodle must not be called with an expired session.");
    });
    const upstream = validUpstream();
    const broker = new SessionBroker(state(), env(), { upstream, fetchImpl, now: () => now });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);
    now += 7200 * 1000 + 1;
    // The expiry is only an estimate; Moodle confirms the session is gone.
    vi.mocked(upstream.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });

    const call = await mcp(broker, { method: "tools/call", params: { name: "units", arguments: {} } }, { protocolVersion: "2025-06-18", method: "tools/call", toolName: "units" });
    const body = await call.json();
    expect(body).toMatchObject({
      response: { result: { isError: true, structuredContent: { error: { type: "MOODLE_AUTH_REQUIRED", recovery: { action: "moodle mcp login" } } } } },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(OLD_COOKIE);
  });

  it("refuses a sign-in link that is not https", async () => {
    const broker = new SessionBroker(state(), env(), { upstream: validUpstream(), now: () => 1_000 });
    const response = await mcp(broker, { method: "tools/list", params: {} }, { method: "tools/list", signInUrl: "javascript:alert(1)" });
    expect(response.status).toBe(400);
  });

  it("tells the client about a newer release on initialize and remembers the check for a day", async () => {
    const objectState = state();
    const registry = vi.fn(async () => Response.json({ latest: "99.0.0" }));
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === LATEST_VERSION_URL) return registry();
      return Response.json([{ error: false, data: { userid: 42, username: "ada", fullname: "Ada", sitename: "S", siteurl: MOODLE_ORIGIN, sesskey: "sess" } }]);
    });
    let now = 900_000;
    // A session that outlives the day-long cache, so the third initialize reaches the registry.
    const upstream = validUpstream();
    vi.mocked(upstream.validate).mockResolvedValue({ valid: true, sesskey: "sess", moodleUserId: 42, remainingSeconds: 48 * 60 * 60 });
    const broker = new SessionBroker(objectState, env(), { upstream, fetchImpl, now: () => now });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);

    const initialize = () => broker.fetch(new Request("https://session-broker/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } },
        context: { protocolVersion: "2025-06-18", method: "initialize" },
      }),
    }));

    const first = await (await initialize()).json() as { response: { result: { instructions: string } } };
    expect(first.response.result.instructions).toContain("moodle-cli 99.0.0 is available");
    expect(first.response.result.instructions).toContain("moodle update");
    expect(registry).toHaveBeenCalledTimes(1);

    now += 60_000;
    const second = await (await initialize()).json() as { response: { result: { instructions: string } } };
    expect(second.response.result.instructions).toContain("99.0.0");
    expect(registry).toHaveBeenCalledTimes(1);

    now += 25 * 60 * 60 * 1000;
    await initialize();
    expect(registry).toHaveBeenCalledTimes(2);

    const ready = await (await broker.fetch(new Request("https://session-broker/readyz"))).json();
    expect(ready).toMatchObject({ version: VERSION, latest_version: "99.0.0" });
    expect(JSON.stringify(objectState.storage.values.get("latest_version"))).not.toContain(OLD_COOKIE);
  });

  it("leaves tool calls untouched by the registry lookup", async () => {
    const registry = vi.fn(async () => Response.json({ latest: "99.0.0" }));
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === LATEST_VERSION_URL) return registry();
      return Response.json([{ error: false, data: { userid: 42, username: "ada", fullname: "Ada", sitename: "S", siteurl: MOODLE_ORIGIN, sesskey: "sess" } }]);
    });
    const broker = new SessionBroker(state(), env(), { upstream: validUpstream(), fetchImpl, now: () => 950_000 });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);

    const response = await broker.fetch(new Request("https://session-broker/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_user", arguments: {} } },
        context: { protocolVersion: "2025-06-18", method: "tools/call", toolName: "get_user" },
      }),
    }));

    expect(response.status).toBe(200);
    expect(registry).not.toHaveBeenCalled();
    const ready = await (await broker.fetch(new Request("https://session-broker/readyz"))).json() as Record<string, unknown>;
    expect(ready.latest_version).toBeUndefined();
  });

  it("returns authenticated Moodle file bytes through the remote MCP path", async () => {
    const fileUrl = `${MOODLE_ORIGIN}/pluginfile.php/1/slides.pdf`;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(fileUrl);
      expect(new Headers(init?.headers).get("cookie")).toBe(`MoodleSession=${OLD_COOKIE}`);
      const response = new Response("slides", {
        headers: {
          "content-disposition": 'attachment; filename="slides.pdf"',
          "content-type": "application/pdf",
        },
      });
      Object.defineProperty(response, "url", { value: fileUrl });
      return response;
    });
    const broker = new SessionBroker(state(), env(), {
      upstream: validUpstream(),
      fetchImpl,
      now: () => 800_000,
    });
    expect((await putSession(broker, candidate(OLD_COOKIE, null))).status).toBe(201);

    const response = await broker.fetch(new Request("https://session-broker/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_file",
            arguments: { source: fileUrl },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
            },
          },
        },
        context: { protocolVersion: "2026-07-28", method: "tools/call", toolName: "get_file" },
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      response: {
        result: {
          content: [
            { type: "text", text: expect.any(String) },
            { type: "resource", resource: { mimeType: "application/pdf", blob: "c2xpZGVz" } },
          ],
          structuredContent: { file: { name: "slides.pdf", bytes: 6 } },
        },
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

describe("SessionBroker adoption from a remote sign-in", () => {
  function adopt(broker: SessionBroker, cookieValue: string, allowNewOwner: boolean): Promise<Response> {
    return broker.fetch(new Request("https://session-broker/session/adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookieName: "MoodleSession", cookieValue, allowNewOwner }),
    }));
  }

  it("needs a claim for a fresh Worker and then pins the account that claimed it", async () => {
    const objectState = state();
    const upstream = validUpstream();
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => 30_000 });

    const unclaimed = await adopt(broker, OLD_COOKIE, false);
    expect(unclaimed.status).toBe(403);
    expect(await unclaimed.json()).toMatchObject({ code: "OWNER_CLAIM_REQUIRED" });
    expect(objectState.storage.values.get("session")).toBeUndefined();

    expect((await adopt(broker, OLD_COOKIE, true)).status).toBe(201);

    vi.mocked(upstream.validate).mockResolvedValueOnce({ valid: true, sesskey: "other", moodleUserId: 43, remainingSeconds: 7200 });
    const stranger = await adopt(broker, NEW_COOKIE, true);
    expect(stranger.status).toBe(409);
    expect(await stranger.json()).toMatchObject({ code: "SESSION_ACCOUNT_MISMATCH" });

    const renewed = await adopt(broker, NEW_COOKIE, false);
    expect(renewed.status).toBe(201);
    expect(await renewed.json()).toMatchObject({ revision: 2 });
  });

  it("reports a cookie Moodle does not accept as not signed in", async () => {
    const upstream = validUpstream();
    vi.mocked(upstream.validate).mockResolvedValueOnce({ valid: false, code: "SESSION_EXPIRED" });
    const broker = new SessionBroker(state(), env(), { upstream, now: () => 40_000 });

    const response = await adopt(broker, OLD_COOKIE, true);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "SESSION_CANDIDATE_INVALID" });
  });
});

describe("SessionBroker renewal from a Moodle mobile token", () => {
  const TOKEN = { wstoken: "ws-token-secret", privatetoken: "private-token-secret" };
  const MINTED_COOKIE = "minted-cookie-secret";

  function mobileUpstream(): MoodleSessionUpstream & Required<Pick<MoodleSessionUpstream, "captureMobileToken" | "mintSession">> {
    return {
      ...validUpstream(),
      captureMobileToken: vi.fn(async () => TOKEN),
      mintSession: vi.fn(async () => ({ name: "MoodleSession", value: MINTED_COOKIE })),
    };
  }

  async function readSession(objectState: { storage: MemoryStorage }, broker: SessionBroker) {
    const ready = await broker.fetch(new Request("https://session-broker/readyz"));
    return { stored: JSON.stringify(objectState.storage.values.get("session")), health: await ready.json() as { checks: Record<string, Array<Record<string, unknown>>> } };
  }

  it("keeps an encrypted token where the site allows it and reports self-renewal", async () => {
    const objectState = state();
    const upstream = mobileUpstream();
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => 1_000 });

    const accepted = await putSession(broker, candidate(OLD_COOKIE, null));

    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ renewal: "mobile_token" });
    expect(upstream.captureMobileToken).toHaveBeenCalledWith({ name: "MoodleSession", value: OLD_COOKIE });
    const { stored, health } = await readSession(objectState, broker);
    expect(stored).not.toContain(TOKEN.wstoken);
    expect(stored).not.toContain(TOKEN.privatetoken);
    expect(health.checks["moodle:session"][0]).toMatchObject({ renewal: "mobile_token" });

    // A later upload for the same account keeps the token instead of asking again.
    await putSession(broker, candidate(NEW_COOKIE, 1));
    expect(upstream.captureMobileToken).toHaveBeenCalledTimes(1);
  });

  it("stays on the sign-in path where the site offers no token", async () => {
    const objectState = state();
    const upstream = mobileUpstream();
    vi.mocked(upstream.captureMobileToken).mockResolvedValue(null);
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => 1_000 });

    expect(await (await putSession(broker, candidate(OLD_COOKIE, null))).json()).toMatchObject({ renewal: "sign_in" });
    await broker.alarm();

    expect(upstream.mintSession).not.toHaveBeenCalled();
    expect(objectState.storage.alarm).toBeNull();
    expect((await readSession(objectState, broker)).health.checks["moodle:session"][0]).toMatchObject({ code: "SESSION_EXPIRED", renewal: "sign_in" });
  });

  it("mints a new cookie for the same account when the session dies, at most once per six minutes", async () => {
    let now = 1_000;
    const objectState = state();
    const upstream = mobileUpstream();
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => now });
    await putSession(broker, candidate(OLD_COOKIE, null));
    vi.mocked(upstream.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });

    const renewed = await broker.fetch(new Request("https://session-broker/session/touch", { method: "POST" }));

    expect(await renewed.json()).toMatchObject({ status: "kept_alive", revision: 2 });
    expect(upstream.mintSession).toHaveBeenCalledWith(42, TOKEN);
    expect(upstream.validate).toHaveBeenLastCalledWith(expect.objectContaining({ cookieValue: MINTED_COOKIE }));
    expect((await readSession(objectState, broker)).health.checks["moodle:session"][0]).toMatchObject({ code: "SESSION_VALID", revision: 2 });

    // Dying again inside Moodle's rate limit waits for the retry alarm.
    now += 60_000;
    vi.mocked(upstream.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });
    await broker.alarm();
    expect(upstream.mintSession).toHaveBeenCalledTimes(1);
    expect(objectState.storage.alarm).toBe(now + 30 * 60 * 1000);

    now = objectState.storage.alarm!;
    vi.mocked(upstream.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });
    await broker.alarm();
    expect(upstream.mintSession).toHaveBeenCalledTimes(2);
    expect((await readSession(objectState, broker)).health.checks["moodle:session"][0]).toMatchObject({ code: "SESSION_VALID", revision: 3 });
  });

  it("refuses a minted cookie that belongs to another account", async () => {
    const objectState = state();
    const upstream = mobileUpstream();
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => 1_000 });
    await putSession(broker, candidate(OLD_COOKIE, null));
    vi.mocked(upstream.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });
    vi.mocked(upstream.validate).mockResolvedValueOnce({ valid: true, sesskey: "other", moodleUserId: 99, remainingSeconds: 7200 });

    const response = await broker.fetch(new Request("https://session-broker/session/touch", { method: "POST" }));

    expect(await response.json()).toMatchObject({ code: "SESSION_EXPIRED" });
    expect((await readSession(objectState, broker)).health.checks["moodle:session"][0]).toMatchObject({ code: "SESSION_EXPIRED", revision: 1 });
  });

  function callTool(broker: SessionBroker, name: string, args: Record<string, unknown>): Promise<Response> {
    return broker.fetch(new Request("https://session-broker/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        context: { protocolVersion: "2025-06-18", method: "tools/call", toolName: name },
      }),
    }));
  }

  const SITE_INFO = { userid: 42, username: "ada", fullname: "Ada Lovelace", sitename: "Example Moodle", siteurl: MOODLE_ORIGIN, sesskey: "sess" };
  const REFUSED = [{ error: true, exception: { errorcode: "servicerequireslogin", message: "Expired" } }];

  it("does not expire a session uploaded while a failing touch was in flight", async () => {
    const objectState = state();
    const upstream = mobileUpstream();
    vi.mocked(upstream.captureMobileToken).mockResolvedValue(null);
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => 1_000 });
    await putSession(broker, candidate(OLD_COOKIE, null));

    let finishTouch!: (result: { alive: false; remainingSeconds: null }) => void;
    vi.mocked(upstream.touch).mockReturnValueOnce(new Promise((resolve) => { finishTouch = resolve; }));
    const alarm = broker.alarm();
    await vi.waitFor(() => expect(upstream.touch).toHaveBeenCalledOnce());
    expect((await putSession(broker, candidate(NEW_COOKIE, 1))).status).toBe(201);
    const alarmForNewSession = objectState.storage.alarm;
    finishTouch({ alive: false, remainingSeconds: null });
    await alarm;

    expect((await readSession(objectState, broker)).health.checks["moodle:session"][0]).toMatchObject({ code: "SESSION_VALID", revision: 2 });
    expect(objectState.storage.alarm).toBe(alarmForNewSession);
  });

  it("fetches a fresh token at the next sign-in once Moodle refuses the kept one", async () => {
    const FRESH = { wstoken: "fresh-ws-secret", privatetoken: "fresh-private-secret" };
    let now = 1_000;
    const objectState = state();
    const upstream = mobileUpstream();
    const broker = new SessionBroker(objectState, env(), { upstream, now: () => now });
    await putSession(broker, candidate(OLD_COOKIE, null));
    vi.mocked(upstream.mintSession).mockResolvedValueOnce(null);
    vi.mocked(upstream.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });
    await broker.alarm();

    vi.mocked(upstream.captureMobileToken).mockResolvedValueOnce(FRESH);
    const accepted = await putSession(broker, candidate(NEW_COOKIE, 1));
    expect(await accepted.json()).toMatchObject({ renewal: "mobile_token" });
    expect(upstream.captureMobileToken).toHaveBeenCalledTimes(2);

    now += 7 * 60 * 1000;
    vi.mocked(upstream.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });
    await broker.alarm();
    expect(upstream.mintSession).toHaveBeenLastCalledWith(42, FRESH);
  });

  it("renews when Moodle refuses a session the record still calls live", async () => {
    const upstream = mobileUpstream();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Headers(init?.headers).get("cookie") === `MoodleSession=${MINTED_COOKIE}`
      ? Response.json([{ error: false, data: SITE_INFO }])
      : Response.json(REFUSED));
    const broker = new SessionBroker(state(), env(), { upstream, fetchImpl, now: () => 1_000 });
    await putSession(broker, candidate(OLD_COOKIE, null));

    const body = await (await callTool(broker, "get_user", {})).json();

    expect(body).toMatchObject({ response: { result: { structuredContent: { user: { id: 42 } } } } });
    expect(upstream.mintSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain(MINTED_COOKIE);
  });

  it("shares one mint between the parallel reads of a single tool call", async () => {
    const upstream = mobileUpstream();
    let finishMint!: (cookie: { name: string; value: string }) => void;
    vi.mocked(upstream.mintSession).mockReturnValueOnce(new Promise((resolve) => { finishMint = resolve; }));
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (new Headers(init?.headers).get("cookie") !== `MoodleSession=${MINTED_COOKIE}`) return Response.json(REFUSED);
      const info = new URL(String(input)).searchParams.get("info");
      return Response.json([{ error: false, data: info === "core_enrol_get_users_courses" ? [{ id: 5, fullname: "Unit", shortname: "U" }] : [] }]);
    });
    const broker = new SessionBroker(state(), env(), { upstream, fetchImpl, now: () => 1_000 });
    await putSession(broker, candidate(OLD_COOKIE, null));

    const pending = callTool(broker, "list_activities", { courseId: 5 });
    await vi.waitFor(() => expect(upstream.mintSession).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    finishMint({ name: "MoodleSession", value: MINTED_COOKIE });
    const body = await (await pending).json();

    expect(body).not.toMatchObject({ response: { result: { isError: true } } });
    expect(upstream.mintSession).toHaveBeenCalledTimes(1);
  });

  it("renews an expired session before answering MCP, so the client never sees it signed out", async () => {
    let now = 1_000;
    const upstream = mobileUpstream();
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ latest: VERSION }));
    const broker = new SessionBroker(state(), env(), { upstream, fetchImpl, now: () => now });
    await putSession(broker, candidate(OLD_COOKIE, null));
    now += 7200 * 1000 + 1;
    vi.mocked(upstream.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });

    const response = await broker.fetch(new Request("https://session-broker/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } },
        context: { protocolVersion: "2025-06-18", method: "initialize", signInUrl: "https://moodle-mcp.example.workers.dev/oauth/login" },
      }),
    }));

    expect(upstream.mintSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await response.json())).not.toContain("not signed in");
  });

  it("mints from the kept token first and asks the recovery service only when that fails", async () => {
    const upstream = mobileUpstream();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    const recovery: SessionRecoveryProvider = {
      recover: vi.fn(async () => ({ moodleOrigin: MOODLE_ORIGIN, cookieName: "MoodleSession", cookieValue: NEW_COOKIE })),
    };
    let now = 1_000;
    const broker = new SessionBroker(state(), env(), { upstream, recovery, now: () => now });
    await putSession(broker, candidate(OLD_COOKIE, null));

    await broker.alarm();
    expect(upstream.mintSession).toHaveBeenCalledTimes(1);
    expect(recovery.recover).not.toHaveBeenCalled();

    // Moodle's autologin allowance is spent, so the service takes over.
    vi.mocked(upstream.mintSession).mockResolvedValueOnce(null);
    now += 7 * 60 * 1000;
    await broker.alarm();
    expect(upstream.mintSession).toHaveBeenCalledTimes(2);
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    expect(upstream.validate).toHaveBeenLastCalledWith(expect.objectContaining({ cookieValue: NEW_COOKIE }));
  });
});

describe("optional external session recovery", () => {
  const recovered = (): RecoveredSession => ({ moodleOrigin: MOODLE_ORIGIN, cookieName: "MoodleSession", cookieValue: NEW_COOKIE });
  const touch = (broker: SessionBroker) => broker.fetch(new Request("https://session-broker/session/touch", { method: "POST" }));
  const callTool = (broker: SessionBroker, name: string, args: Record<string, unknown>) => broker.fetch(new Request("https://session-broker/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      context: { protocolVersion: "2025-06-18", method: "tools/call", toolName: name },
    }),
  }));
  const getUser = (broker: SessionBroker) => callTool(broker, "get_user", {});
  // A broker with no usable session answers tools with the CLI sign-in hint.
  const expectSignedOut = async (response: Response) => {
    expect(await response.json()).toMatchObject({ response: { result: { isError: true, structuredContent: { error: { type: "MOODLE_AUTH_REQUIRED" } } } } });
  };
  const provider = (): SessionRecoveryProvider => ({ recover: vi.fn(async () => recovered()) });

  it("keeps the unconfigured behavior and never bootstraps a missing account", async () => {
    const upstream = validUpstream();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    const disabled = new SessionBroker(state(), env(), { upstream });
    await putSession(disabled, candidate(OLD_COOKIE, null));
    expect((await touch(disabled)).status).toBe(409);
    const recovery = provider();
    const missing = new SessionBroker(state(), env(), { upstream, recovery });
    await expectSignedOut(await getUser(missing));
    await missing.alarm();
    expect(recovery.recover).not.toHaveBeenCalled();
  });

  it("keeps normal renewal HTTP-only, including an estimated expiry that is still alive", async () => {
    const upstream = validUpstream();
    const recovery = provider();
    let now = 1_000;
    const broker = new SessionBroker(state(), env(), { upstream, recovery, now: () => now,
      fetchImpl: async () => Response.json([{ error: false, data: { userid: 42, fullname: "Ada", username: "ada", sitename: "Moodle", siteurl: MOODLE_ORIGIN } }]),
    });
    await putSession(broker, candidate(OLD_COOKIE, null));
    expect((await touch(broker)).status).toBe(200);
    now += 3 * 60 * 60 * 1000;
    expect((await getUser(broker)).status).toBe(200);
    expect(upstream.touch).toHaveBeenCalledTimes(2);
    expect(recovery.recover).not.toHaveBeenCalled();
  });

  it.each(["throws", "unknown"])("does not launch recovery when Moodle is unreachable (%s)", async (failure) => {
    const upstream = validUpstream();
    const recovery = provider();
    const broker = new SessionBroker(state(), env(), { upstream, recovery });
    await putSession(broker, candidate(OLD_COOKIE, null));
    if (failure === "throws") vi.mocked(upstream.touch).mockRejectedValue(new Error("network outage"));
    else vi.mocked(upstream.touch).mockResolvedValue({ alive: null, remainingSeconds: null });
    expect((await touch(broker)).status).toBe(503);
    expect(recovery.recover).not.toHaveBeenCalled();
  });

  it("validates, encrypts and retries the read with the same pinned account", async () => {
    const upstream = validUpstream();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    const recovery = provider();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (new Headers(init?.headers).get("cookie") === `MoodleSession=${OLD_COOKIE}`) {
        return Response.json([{ error: true, exception: { errorcode: "servicerequireslogin", message: "Expired" } }]);
      }
      return Response.json([{ error: false, data: { userid: 42, fullname: "Ada", username: "ada", sitename: "Moodle", siteurl: MOODLE_ORIGIN } }]);
    });
    const objectState = state();
    const broker = new SessionBroker(objectState, env(), { upstream, recovery, fetchImpl });
    await putSession(broker, candidate(OLD_COOKIE, null));
    const body = await (await getUser(broker)).json();
    expect(body).toMatchObject({ response: { result: { structuredContent: { user: { id: 42 } } } } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(recovery.recover).toHaveBeenCalledExactlyOnceWith({ moodleOrigin: MOODLE_ORIGIN, moodleUserId: 42, reason: "SESSION_EXPIRED", signal: expect.any(AbortSignal) });
    expect(upstream.validate).toHaveBeenLastCalledWith({ ...recovered(), expectedRevision: 1 });
    expect(JSON.stringify(body)).not.toContain(NEW_COOKIE);
    expect(JSON.stringify(objectState.storage.values.get("session"))).not.toContain(NEW_COOKIE);
    expect((await putSession(broker, candidate(OLD_COOKIE, 1))).status).toBe(409);
  });

  it("shares one recovery between the parallel reads of a single tool call", async () => {
    const upstream = validUpstream();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    let finish!: (value: RecoveredSession) => void;
    const recovery: SessionRecoveryProvider = { recover: vi.fn(() => new Promise<RecoveredSession>((resolve) => { finish = resolve; })) };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (new Headers(init?.headers).get("cookie") === `MoodleSession=${OLD_COOKIE}`) {
        return Response.json([{ error: true, exception: { errorcode: "servicerequireslogin", message: "Expired" } }]);
      }
      const info = new URL(String(input)).searchParams.get("info");
      const data = info === "core_enrol_get_users_courses" ? [{ id: 5, fullname: "Unit", shortname: "U" }] : [];
      return Response.json([{ error: false, data }]);
    });
    const broker = new SessionBroker(state(), env(), { upstream, recovery, fetchImpl });
    await putSession(broker, candidate(OLD_COOKIE, null));

    const pending = callTool(broker, "list_activities", { courseId: 5 });
    await vi.waitFor(() => expect(recovery.recover).toHaveBeenCalledTimes(1));
    // Let the second parallel read be rejected while the first one waits for the provider.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    finish(recovered());
    const body = await (await pending).json();

    expect(body).toMatchObject({ response: { result: { structuredContent: { total: 0 } } } });
    expect(recovery.recover).toHaveBeenCalledTimes(1);
  });

  it("still recovers when a routine cookie rotation preceded the session dying again", async () => {
    const upstream = validUpstream();
    // The estimated expiry has passed, so the call renews first; Moodle rotates the cookie but the session is alive.
    vi.mocked(upstream.touch)
      .mockResolvedValueOnce({ alive: true, remainingSeconds: 3600, rotatedCookie: "rotated-cookie-secret" })
      .mockResolvedValue({ alive: false, remainingSeconds: null });
    const recovery = provider();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (new Headers(init?.headers).get("cookie") !== `MoodleSession=${NEW_COOKIE}`) {
        return Response.json([{ error: true, exception: { errorcode: "servicerequireslogin", message: "Expired" } }]);
      }
      return Response.json([{ error: false, data: { userid: 42, fullname: "Ada", username: "ada", sitename: "Moodle", siteurl: MOODLE_ORIGIN } }]);
    });
    let now = 1_000;
    const broker = new SessionBroker(state(), env(), { upstream, recovery, fetchImpl, now: () => now });
    await putSession(broker, candidate(OLD_COOKIE, null));
    now += 3 * 60 * 60 * 1000;

    const body = await (await getUser(broker)).json();

    expect(body).toMatchObject({ response: { result: { structuredContent: { user: { id: 42 } } } } });
    expect(recovery.recover).toHaveBeenCalledTimes(1);
  });

  it("does not recover on unrelated tool errors or loop when the replacement is rejected", async () => {
    const upstream = validUpstream();
    const recovery = provider();
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([{ error: true, exception: { errorcode: "unknownerror", message: "Unavailable" } }]));
    const broker = new SessionBroker(state(), env(), { upstream, recovery, fetchImpl });
    await putSession(broker, candidate(OLD_COOKIE, null));
    await getUser(broker);
    expect(recovery.recover).not.toHaveBeenCalled();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    fetchImpl.mockImplementation(async () => Response.json([{ error: true, exception: { errorcode: "servicerequireslogin", message: "Expired" } }]));
    const body = await (await getUser(broker)).json();
    expect(body).toMatchObject({ response: { result: { isError: true } } });
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each(["origin", "account", "invalid", "malformed"])("rejects a recovery candidate with invalid %s", async (failure) => {
    const upstream = validUpstream();
    const recovery = provider();
    const objectState = state();
    const broker = new SessionBroker(objectState, env(), { upstream, recovery });
    await putSession(broker, candidate(OLD_COOKIE, null));
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    if (failure === "origin") vi.mocked(recovery.recover).mockResolvedValue({ ...recovered(), moodleOrigin: "https://other.example" });
    if (failure === "account") vi.mocked(upstream.validate).mockResolvedValue({ valid: true, sesskey: "other", moodleUserId: 99, remainingSeconds: 3600 });
    if (failure === "invalid") vi.mocked(upstream.validate).mockResolvedValue({ valid: false, code: "SESSION_EXPIRED" });
    if (failure === "malformed") vi.mocked(recovery.recover).mockResolvedValue({ ...recovered(), cookieValue: "cookie; injected=secret" });
    expect((await touch(broker)).status).toBe(409);
    await expectSignedOut(await getUser(broker));
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    if (failure === "origin" || failure === "malformed") expect(upstream.validate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(objectState.storage.values.get("session"))).not.toContain(NEW_COOKIE);
  });

  it("coalesces overlapping calls and preserves the cooldown across object reconstruction", async () => {
    const upstream = validUpstream();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    let finish!: (value: RecoveredSession | null) => void;
    const recovery: SessionRecoveryProvider = { recover: vi.fn(() => new Promise<RecoveredSession | null>((resolve) => { finish = resolve; })) };
    const objectState = state();
    let now = 1_000;
    const broker = new SessionBroker(objectState, env(), { upstream, recovery, now: () => now });
    await putSession(broker, candidate(OLD_COOKIE, null));
    const first = touch(broker);
    await vi.waitFor(() => expect(recovery.recover).toHaveBeenCalledTimes(1));
    const second = touch(broker);
    finish(null);
    expect((await first).status).toBe(409);
    expect((await second).status).toBe(409);
    // The kept recovery path retries on the broker's slow renewal schedule.
    expect(objectState.storage.alarm).toBe(1_801_000);
    const reconstructed = new SessionBroker(objectState, env(), { upstream, recovery, now: () => now });
    expect((await touch(reconstructed)).status).toBe(409);
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    now = 1_801_000;
    vi.mocked(recovery.recover).mockResolvedValue(recovered());
    await reconstructed.alarm();
    expect(recovery.recover).toHaveBeenCalledTimes(2);
    expect((await reconstructed.fetch(new Request("https://session-broker/readyz"))).status).toBe(200);
  });

  it("does not overwrite a newer manual upload while recovery is running", async () => {
    const upstream = validUpstream();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    let finish!: (value: RecoveredSession) => void;
    const recovery: SessionRecoveryProvider = { recover: vi.fn(() => new Promise<RecoveredSession>((resolve) => { finish = resolve; })) };
    const broker = new SessionBroker(state(), env(), { upstream, recovery });
    await putSession(broker, candidate(OLD_COOKIE, null));
    const pending = touch(broker);
    await vi.waitFor(() => expect(recovery.recover).toHaveBeenCalledTimes(1));
    await putSession(broker, candidate("manual-cookie", 1));
    finish(recovered());
    expect((await pending).status).toBe(200);
    vi.mocked(upstream.touch).mockResolvedValue({ alive: true, remainingSeconds: 3600 });
    await broker.alarm();
    expect(upstream.touch).toHaveBeenLastCalledWith(expect.objectContaining({ cookieValue: "manual-cookie" }));
  });

  it("bounds slow recovery, aborts the provider and discards late results", async () => {
    const upstream = validUpstream();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    let finish!: (value: RecoveredSession) => void;
    const recovery: SessionRecoveryProvider = { recover: vi.fn(() => new Promise<RecoveredSession>((resolve) => { finish = resolve; })) };
    const broker = new SessionBroker(state(), env(), { upstream, recovery, recoveryTimeoutMs: 10 });
    await putSession(broker, candidate(OLD_COOKIE, null));
    expect((await touch(broker)).status).toBe(409);
    expect(vi.mocked(recovery.recover).mock.calls[0][0].signal.aborted).toBe(true);
    finish(recovered());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstream.validate).toHaveBeenCalledTimes(1);
    expect((await broker.fetch(new Request("https://session-broker/readyz"))).status).toBe(503);
  });

  it("uses the configured Service binding and does not expose provider errors", async () => {
    const upstream = validUpstream();
    vi.mocked(upstream.touch).mockResolvedValue({ alive: false, remainingSeconds: null });
    const service = { fetch: vi.fn(async () => { throw new Error(`private diagnostics: ${NEW_COOKIE}`); }) };
    const broker = new SessionBroker(state(), { ...env(), MOODLE_SESSION_RECOVERY: service }, { upstream });
    await putSession(broker, candidate(OLD_COOKIE, null));
    const response = await touch(broker);
    expect(await response.text()).not.toContain(NEW_COOKIE);
    await touch(broker);
    expect(service.fetch).toHaveBeenCalledTimes(1);
  });
});
