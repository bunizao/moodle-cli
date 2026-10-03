import { FetchMoodleSessionUpstream } from "../src/worker/index.js";

const ORIGIN = "https://lms.example.edu";

describe("Worker Moodle session upstream", () => {
  it("calls the Cloudflare global fetch without binding a receiver", async () => {
    const originalFetch = globalThis.fetch;
    const bindingSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new Error("Illegal invocation");
      return Promise.resolve(new Response('<script>window.M = {"sesskey":"sess-123","userid":42}</script>'));
    });
    vi.stubGlobal("fetch", bindingSensitiveFetch);
    try {
      const upstream = new FetchMoodleSessionUpstream(ORIGIN);
      await expect(upstream.validate({
        moodleOrigin: ORIGIN,
        cookieName: "MoodleSession",
        cookieValue: "candidate-cookie",
        expectedRevision: 0,
      })).resolves.toMatchObject({ valid: true, sesskey: "sess-123" });
      expect(bindingSensitiveFetch).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("validates only against the configured Moodle origin and captures cookie rotation", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${ORIGIN}/my/`);
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(new Headers(init?.headers).get("cookie")).toBe("MoodleSession=candidate-cookie");
      return new Response('<script>window.M = {"sesskey":"sess-123","userid":42}</script>', {
        status: 200,
        headers: { "set-cookie": "MoodleSession=rotated-cookie; Path=/; Secure; HttpOnly" },
      });
    });
    const upstream = new FetchMoodleSessionUpstream(ORIGIN, fetchImpl as unknown as typeof fetch);

    const result = await upstream.validate({
      moodleOrigin: ORIGIN,
      cookieName: "MoodleSession",
      cookieValue: "candidate-cookie",
      expectedRevision: 0,
    });

    expect(result).toEqual({
      valid: true,
      sesskey: "sess-123",
      moodleUserId: 42,
      remainingSeconds: null,
      rotatedCookie: "rotated-cookie",
    });
  });

  it("touches the AJAX session services and reports the remaining server time", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/lib/ajax/service.php?sesskey=sess-123");
      expect(String(url)).toContain("info=core_session_touch%2Ccore_session_time_remaining");
      expect(JSON.parse(String(init?.body))).toEqual([
        { index: 0, methodname: "core_session_touch", args: {} },
        { index: 1, methodname: "core_session_time_remaining", args: {} },
      ]);
      return Response.json([
        { error: false, data: {} },
        { error: false, data: { timeremaining: 900 } },
      ]);
    });
    const upstream = new FetchMoodleSessionUpstream(ORIGIN, fetchImpl as unknown as typeof fetch);

    const result = await upstream.touch({
      moodleOrigin: ORIGIN,
      cookieName: "MoodleSession",
      cookieValue: "candidate-cookie",
      sesskey: "sess-123",
    });

    expect(result).toEqual({ alive: true, remainingSeconds: 900 });
  });

  it("distinguishes an expired session from an unreachable Moodle service", async () => {
    const expired = new FetchMoodleSessionUpstream(ORIGIN, vi.fn(async () => new Response("login", {
      status: 302,
      headers: { location: "/login/index.php" },
    })) as unknown as typeof fetch);
    const unreachable = new FetchMoodleSessionUpstream(ORIGIN, vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch);

    await expect(expired.validate({
      moodleOrigin: ORIGIN,
      cookieName: "MoodleSession",
      cookieValue: "expired",
      expectedRevision: 0,
    })).resolves.toEqual({ valid: false, code: "SESSION_EXPIRED" });
    await expect(unreachable.validate({
      moodleOrigin: ORIGIN,
      cookieName: "MoodleSession",
      cookieValue: "candidate",
      expectedRevision: 0,
    })).rejects.toThrow("Moodle returned HTTP 503");
  });
  it.each(["config", "launch"])("bounds token capture when %s stops answering", async stage => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (stage === "launch" && String(input).includes("service-nologin.php")) {
        return Response.json([{ data: { enablemobilewebservice: 1 } }]);
      }
      started();
      return new Promise<Response>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
    });
    try {
      const upstream = new FetchMoodleSessionUpstream(ORIGIN, fetchImpl);
      const captured = upstream.captureMobileToken({ name: "MoodleSession", value: "fixture" });
      await pending;
      const assertion = expect(captured).rejects.toThrow("fixture timeout");
      controller.abort(new Error("fixture timeout"));
      await assertion;
      expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
      expect(fetchImpl.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
    } finally {
      controller.abort();
      timeout.mockRestore();
    }
  });

});
