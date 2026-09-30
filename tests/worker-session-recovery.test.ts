import { ServiceBindingSessionRecovery, isRecoveredSession, type SessionRecoveryRequest } from "../src/worker/index.js";

const request = (): SessionRecoveryRequest => ({
  moodleOrigin: "https://lms.example.edu",
  moodleUserId: 42,
  reason: "SESSION_EXPIRED",
  signal: new AbortController().signal,
});
const candidate = () => ({ moodleOrigin: "https://lms.example.edu", cookieName: "MoodleSession", cookieValue: "candidate-secret" });

describe("Service binding session recovery", () => {
  it("sends account context only through the private binding with no redirects", async () => {
    const input = request();
    const fetch = vi.fn(async (req: Request) => {
      expect(req.url).toBe("https://session-recovery/recover");
      expect(req.method).toBe("POST");
      expect(req.redirect).toBe("manual");
      expect(req.headers.get("authorization")).toBeNull();
      expect(req.headers.get("cookie")).toBeNull();
      expect(await req.json()).toEqual({ moodleOrigin: input.moodleOrigin, moodleUserId: 42, reason: "SESSION_EXPIRED" });
      return Response.json(candidate());
    });
    await expect(new ServiceBindingSessionRecovery({ fetch }).recover(input)).resolves.toEqual(candidate());
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("forwards cancellation and accepts an explicit unavailable response", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (req: Request) => {
      controller.abort();
      expect(req.signal.aborted).toBe(true);
      return new Response(null, { status: 204 });
    });
    await expect(new ServiceBindingSessionRecovery({ fetch }).recover({ ...request(), signal: controller.signal })).resolves.toBeNull();
  });

  it.each([
    () => new Response("private-cookie", { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    () => new Response(JSON.stringify(candidate()), { headers: { "content-type": "text/html" } }),
    () => Response.json({ ...candidate(), cookieName: "Authorization" }),
    () => Response.json({ ...candidate(), cookieValue: "a; other=b" }),
  ])("rejects failed responses and unsafe cookies without exposing the response", async (response) => {
    const recovery = new ServiceBindingSessionRecovery({ fetch: async () => response() });
    await expect(recovery.recover(request())).rejects.toThrow(/session recovery/);
    try { await recovery.recover(request()); } catch (error) {
      expect(String(error)).not.toContain("private-cookie");
      expect(String(error)).not.toContain("candidate-secret");
    }
  });

  it("caps streamed bodies by bytes even without Content-Length and cancels oversized streams", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)); },
      cancel,
    });
    const recovery = new ServiceBindingSessionRecovery({ fetch: async () => new Response(stream, { headers: { "content-type": "application/json" } }) });
    await expect(recovery.recover(request())).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([null, [], {}, { ...candidate(), cookieValue: "" }, { ...candidate(), cookieValue: "a\r\nb" }, { ...candidate(), cookieValue: "a".repeat(4097) }])("rejects malformed candidates", (value) => {
    expect(isRecoveredSession(value)).toBe(false);
  });
});
