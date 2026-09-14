import { fetchWithSession } from "../src/session-fetch.js";

const origin = "https://moodle.example";
const cookie = { name: "MoodleSession", value: "synthetic-secret" };

describe("session-aware redirect handling", () => {
  it("keeps same-origin authentication and strips credentials on foreign hops", async () => {
    const seen: Array<{ url: string; cookie: string | null; authorization: string | null }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      const url = String(input);
      seen.push({ url, cookie: headers.get("cookie"), authorization: headers.get("authorization") });
      if (url.endsWith("/start")) return Response.redirect(`${origin}/same`, 302);
      if (url.endsWith("/same")) return Response.redirect("https://cdn.example/file", 302);
      return new Response("file");
    });
    const result = await fetchWithSession(`${origin}/start`, { headers: { authorization: "Bearer synthetic" } }, origin, cookie, fetcher);
    expect(await result.text()).toBe("file");
    expect(seen.map((entry) => entry.cookie)).toEqual(["MoodleSession=synthetic-secret", "MoodleSession=synthetic-secret", null]);
    expect(seen.at(-1)?.authorization).toBeNull();
  });

  it("never forwards an AJAX POST body to a foreign redirect", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.redirect("https://outside.example/collect", 307));
    await expect(fetchWithSession(`${origin}/ajax?sesskey=private`, { method: "POST", body: "private-body" }, origin, cookie, fetcher)).rejects.toThrow("cross-origin");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects downgrade, embedded credentials, unsupported schemes and redirect loops", async () => {
    for (const target of ["http://moodle.example/path", "https://user:pass@outside.example/path", "file:///tmp/private"]) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: target } }));
      await expect(fetchWithSession(`${origin}/start`, {}, origin, cookie, fetcher)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const loop = vi.fn<typeof fetch>(async () => Response.redirect(`${origin}/loop`, 302));
    await expect(fetchWithSession(`${origin}/start`, {}, origin, cookie, loop)).rejects.toThrow("redirect");
    expect(loop.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("keeps caller cancellation and adds a finite request deadline", async () => {
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      init?.signal?.throwIfAborted();
      return new Response("ok");
    });
    await expect(fetchWithSession(`${origin}/my`, { signal: abort.signal }, origin, cookie, fetcher)).rejects.toThrow();
  });
});
