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

  it("gives each redirect hop its own idle limit", async () => {
    vi.useFakeTimers();
    try {
      // Three hops of 20 s each: 60 s in total, but no single hop goes quiet for 30 s.
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        await new Promise((resolve, reject) => {
          setTimeout(resolve, 20_000);
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
        const url = String(input);
        if (url.endsWith("/start")) return Response.redirect(`${origin}/sso`, 302);
        if (url.endsWith("/sso")) return Response.redirect(`${origin}/file`, 302);
        return new Response("file");
      });
      const response = fetchWithSession(`${origin}/start`, {}, origin, cookie, fetcher);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await (await response).text()).toBe("file");
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a slow body run past the limit while chunks keep arriving, and stops a stalled one", async () => {
    vi.useFakeTimers();
    try {
      // Like a real socket, the body errors as soon as the request signal aborts.
      const streamed = (chunks: number, stallAfter?: number) => vi.fn<typeof fetch>(async (_url, init) => {
        let sent = 0;
        const aborted = new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        aborted.catch(() => undefined);
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            const wait = sent === stallAfter ? new Promise(() => undefined) : new Promise((resolve) => setTimeout(resolve, 20_000));
            await Promise.race([wait, aborted]);
            controller.enqueue(new Uint8Array([sent++]));
            if (sent === chunks) controller.close();
          },
        }));
      });

      const slow = await fetchWithSession(`${origin}/pluginfile.php/1/big.pdf`, {}, origin, cookie, streamed(4));
      const body = slow.arrayBuffer();
      await vi.advanceTimersByTimeAsync(80_000);
      expect(new Uint8Array(await body)).toEqual(new Uint8Array([0, 1, 2, 3]));

      const stalled = await fetchWithSession(`${origin}/pluginfile.php/1/big.pdf`, {}, origin, cookie, streamed(4, 1));
      const failing = expect(stalled.arrayBuffer()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      await failing;
    } finally {
      vi.useRealTimers();
    }
  });
});
