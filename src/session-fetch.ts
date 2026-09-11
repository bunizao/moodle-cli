const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchWithSession(
  input: string,
  init: RequestInit,
  moodleOrigin: string,
  cookie: { name: string; value: string },
  fetchImpl: typeof fetch = (url, options) => fetch(url, options),
): Promise<Response> {
  let url = new URL(input);
  const initialOrigin = url.origin;
  const trustedOrigin = new URL(moodleOrigin).origin;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;

  for (let hop = 0; ; hop += 1) {
    signal.throwIfAborted();
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("The request destination is not allowed.");
    }
    headers.delete("cookie");
    if (url.origin === trustedOrigin) headers.set("cookie", `${cookie.name}=${cookie.value}`);
    if (url.origin !== initialOrigin) {
      headers.delete("authorization");
      headers.delete("proxy-authorization");
    }
    const response = await fetchImpl(url.toString(), { ...init, method, body, headers: Object.fromEntries(headers), signal, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error("The request exceeded its redirect limit.");
    const next = new URL(location, url);
    if (url.protocol === "https:" && next.protocol !== "https:") {
      throw new Error("The request refused an insecure redirect.");
    }
    if (next.origin !== url.origin && method !== "GET" && method !== "HEAD") {
      throw new Error("The request refused a cross-origin form redirect.");
    }
    if ((response.status === 303 && method !== "HEAD") || ([301, 302].includes(response.status) && method === "POST")) {
      method = "GET";
      body = undefined;
      for (const header of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(header);
    }
    url = next;
  }
}
