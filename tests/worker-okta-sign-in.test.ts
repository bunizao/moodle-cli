import { describe, expect, it, vi } from "vitest";

import {
  SessionBroker,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type MoodleSessionUpstream,
  type SessionBrokerEnv,
} from "../src/worker/index.js";
import { MAX_TRANSIENT_FAILURES, MIN_ATTEMPT_INTERVAL_MS } from "../src/worker/okta-sign-in.js";
import { fakeOkta, MOODLE, OKTA, PASSWORD, TOTP_SECRET, USERNAME } from "./fake-okta.js";

const MOODLE_ORIGIN = `https://${MOODLE}`;

class MemoryStorage implements DurableObjectStorageLike {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;

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
}

function env(overrides: Partial<SessionBrokerEnv> = {}): SessionBrokerEnv {
  return {
    MOODLE_ORIGIN,
    SESSION_ENCRYPTION_KEY: "encryption-key-current",
    OKTA_USERNAME: USERNAME,
    OKTA_PASSWORD: PASSWORD,
    OKTA_TOTP_SECRET: TOTP_SECRET,
    ...overrides,
  };
}

// Moodle accepts what the fake SP issued and names the account by cookie.
function upstream(userFor: (cookie: string) => number = () => 42): MoodleSessionUpstream {
  return {
    validate: vi.fn(async (candidate) => candidate.cookieValue.startsWith("authed-") || candidate.cookieValue === "uploaded"
      ? { valid: true as const, sesskey: "sess", moodleUserId: userFor(candidate.cookieValue), remainingSeconds: 7200 }
      : { valid: false as const, code: "SESSION_INVALID" as const }),
    touch: vi.fn(async () => ({ alive: true, remainingSeconds: 7200 })),
  };
}

function listTools(broker: SessionBroker): Promise<Response> {
  return broker.fetch(new Request("https://session-broker/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, context: { method: "tools/list" } }),
  }));
}

async function health(broker: SessionBroker) {
  const response = await broker.fetch(new Request("https://session-broker/readyz"));
  return await response.json() as { checks: Record<string, Array<Record<string, unknown>>> };
}

function idxCalls(okta: ReturnType<typeof fakeOkta>): number {
  return okta.requests.filter((request) => request.url.hostname === OKTA && request.url.pathname.startsWith("/idp/idx/")).length;
}

function setup(options: { env?: Partial<SessionBrokerEnv>; factor?: "google_otp" | "phone_number"; offline?: boolean; userFor?: (cookie: string) => number } = {}) {
  const clock = { now: Date.UTC(2026, 10, 9, 12) };
  const storage = new MemoryStorage();
  const okta = fakeOkta({ now: () => clock.now, factor: options.factor, offline: options.offline });
  const moodle = upstream(options.userFor);
  const objectState: DurableObjectStateLike = { storage };
  const broker = (overrides: Partial<SessionBrokerEnv> = {}) => new SessionBroker(objectState, env({ ...options.env, ...overrides }), {
    upstream: moodle,
    fetchImpl: okta.fetch as typeof fetch,
    now: () => clock.now,
  });
  return { clock, storage, okta, moodle, broker };
}

describe("Worker signs in to Moodle through Okta by itself", () => {
  it("signs in when no session exists and stores it the same way an upload would", async () => {
    const { storage, okta, moodle, broker } = setup();
    const worker = broker();

    await listTools(worker);

    expect(moodle.validate).toHaveBeenCalledWith(expect.objectContaining({ cookieName: "MoodleSession", cookieValue: "authed-1" }));
    const checks = (await health(worker)).checks;
    expect(checks["moodle:session"]?.[0]).toMatchObject({ status: "pass", code: "SESSION_VALID", revision: 1, renewal: "okta" });
    expect(checks["okta:sign-in"]?.[0]).toMatchObject({ status: "pass", code: "OKTA_READY" });
    expect(storage.alarm).not.toBeNull();
    expect(okta.requests.some((request) => request.url.pathname === "/idp/idx/challenge/answer")).toBe(true);

    // Everything at rest is encrypted: the password, the session cookies Okta
    // and Moodle set, and the device token.
    const stored = JSON.stringify([...storage.values.entries()]);
    for (const secret of [PASSWORD, TOTP_SECRET, USERNAME, "authed-1", "okta-session-1", "dt-1"]) {
      expect(stored).not.toContain(secret);
    }
  });

  it("keeps the device token and Okta session between runs, so the next sign-in skips the password", async () => {
    const { clock, okta, broker } = setup();
    await listTools(broker());
    const idxBefore = idxCalls(okta);
    const requestsBefore = okta.requests.length;

    // The Moodle session dies; a new object (as after eviction) renews it.
    clock.now += 7200 * 1000 + 1;
    await listTools(broker());

    const second = okta.requests.slice(requestsBefore).filter((request) => request.url.hostname === OKTA);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((request) => request.cookies.get("DT") === "dt-1")).toBe(true);
    expect(second.some((request) => request.cookies.get("sid") === "okta-session-1")).toBe(true);
    expect(idxCalls(okta)).toBe(idxBefore);
    expect((await health(broker())).checks["moodle:session"]?.[0]).toMatchObject({ status: "pass", revision: 2 });
  });

  it("never retries a rejected password, and changing a secret lifts the block", async () => {
    const { clock, okta, broker } = setup({ env: { OKTA_PASSWORD: "wrong password" } });

    await listTools(broker());
    expect((await health(broker())).checks["okta:sign-in"]?.[0]).toMatchObject({ status: "fail", code: "OKTA_CREDENTIALS_REJECTED" });
    const attempts = okta.requests.length;

    clock.now += 24 * 60 * 60 * 1000;
    await listTools(broker());
    await broker().alarm();
    expect(okta.requests.length).toBe(attempts);

    // The owner fixes the password: a different digest, a fresh start.
    await listTools(broker({ OKTA_PASSWORD: PASSWORD }));
    const checks = (await health(broker({ OKTA_PASSWORD: PASSWORD }))).checks;
    expect(checks["moodle:session"]?.[0]).toMatchObject({ status: "pass" });
    expect(checks["okta:sign-in"]?.[0]).toMatchObject({ status: "pass", code: "OKTA_READY" });
  });

  it("blocks an MFA factor okta-auth cannot answer without retrying", async () => {
    const { clock, okta, broker } = setup({ factor: "phone_number" });

    await listTools(broker());
    const attempts = okta.requests.length;
    clock.now += 24 * 60 * 60 * 1000;
    await listTools(broker());

    expect(okta.requests.length).toBe(attempts);
    expect((await health(broker())).checks["okta:sign-in"]?.[0]).toMatchObject({ status: "fail", code: "OKTA_MFA_UNSUPPORTED" });
  });

  it("blocks a TOTP secret that is not base32 before anything reaches Okta", async () => {
    const { okta, broker } = setup({ env: { OKTA_TOTP_SECRET: "not base32!" } });

    await listTools(broker());

    expect(okta.requests).toHaveLength(0);
    expect((await health(broker())).checks["okta:sign-in"]?.[0]).toMatchObject({ status: "fail", code: "OKTA_INVALID_SECRET" });
  });

  it("backs off after transient failures, stops after a few, and an upload restarts it", async () => {
    const { clock, storage, moodle, broker } = setup({ offline: true });
    const attempt = vi.fn();
    const counting = () => new SessionBroker({ storage }, env(), {
      upstream: moodle,
      fetchImpl: (async () => { attempt(); throw new TypeError("fetch failed"); }) as typeof fetch,
      now: () => clock.now,
    });

    await listTools(counting());
    expect(attempt).toHaveBeenCalledTimes(1);
    // Inside the backoff window nothing is sent.
    await listTools(counting());
    expect(attempt).toHaveBeenCalledTimes(1);

    for (let failures = 1; failures < MAX_TRANSIENT_FAILURES; failures++) {
      clock.now += 60 * 60 * 1000;
      await listTools(counting());
    }
    expect(attempt).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES);
    expect((await health(counting())).checks["okta:sign-in"]?.[0]).toMatchObject({ status: "fail", code: "OKTA_RETRIES_EXHAUSTED" });
    clock.now += 60 * 60 * 1000;
    await listTools(counting());
    expect(attempt).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES);

    // A session uploaded from the CLI proves the way back, so Okta may try again
    // once that session dies.
    const upload = await broker().fetch(new Request("https://session-broker/session", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ moodleOrigin: MOODLE_ORIGIN, cookieName: "MoodleSession", cookieValue: "uploaded", expectedRevision: null }),
    }));
    expect(upload.status).toBe(201);
    expect((await health(counting())).checks["okta:sign-in"]?.[0]).toMatchObject({ status: "pass", failures: 0 });
    clock.now += 7200 * 1000 + MIN_ATTEMPT_INTERVAL_MS;
    await listTools(counting());
    expect(attempt).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES + 1);
  });

  it("refuses an Okta account that signs in to a different Moodle user, and keeps the stored one", async () => {
    const { clock, okta, broker } = setup({ userFor: (cookie) => (cookie === "uploaded" ? 42 : 43) });
    const worker = broker();
    await worker.fetch(new Request("https://session-broker/session", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ moodleOrigin: MOODLE_ORIGIN, cookieName: "MoodleSession", cookieValue: "uploaded", expectedRevision: null }),
    }));
    clock.now += 7200 * 1000 + 1;

    await listTools(worker);
    const attempts = okta.requests.length;
    clock.now += 24 * 60 * 60 * 1000;
    await listTools(worker);

    expect(okta.requests.length).toBe(attempts);
    const checks = (await health(worker)).checks;
    expect(checks["okta:sign-in"]?.[0]).toMatchObject({ status: "fail", code: "OKTA_ACCOUNT_MISMATCH" });
    expect(checks["moodle:session"]?.[0]).toMatchObject({ revision: 1 });
  });

  it("does nothing without all three secrets", async () => {
    const { okta, broker } = setup({ env: { OKTA_TOTP_SECRET: undefined } });
    const worker = broker();

    await listTools(worker);

    expect(okta.requests).toHaveLength(0);
    expect((await health(worker)).checks).not.toHaveProperty("okta:sign-in");
  });

  it("signs in again from the alarm once a stored session expires", async () => {
    const { clock, storage, moodle, broker } = setup();
    const worker = broker();
    await listTools(worker);
    vi.mocked(moodle.touch).mockResolvedValueOnce({ alive: false, remainingSeconds: null });
    clock.now += 30 * 60 * 1000;

    await worker.alarm();

    expect((await health(worker)).checks["moodle:session"]?.[0]).toMatchObject({ status: "pass", revision: 2 });
    expect(storage.alarm).toBeGreaterThan(clock.now);
  });
});
