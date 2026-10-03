// A remote Chrome in the owner's Cloudflare account that they sign in to Moodle
// with through Live View. The Worker never sees what they type; it only reads the
// Moodle cookie back out of the browser once they are signed in.

const CDP_TIMEOUT_MS = 15_000;
// Idle limit for an abandoned attempt. The waiting page polls every few seconds and
// Live View streams frames, so an attempt in progress never gets near it.
const BROWSER_IDLE_MS = 60_000;

export interface BrowserRunBinding {
  acquire(options?: { keepAlive?: number }): Promise<{ sessionId: string }>;
  connectSession(sessionId: string, options?: { targetId?: string }): Promise<{ webSocket: { fetch(url: string, init: RequestInit): Promise<Response> } }>;
  getLiveView(sessionId: string, options: { targetId: string; mode: "tab"; expiresInMs: number }): Promise<{ devtoolsFrontendUrl: string }>;
  closeSession(sessionId: string): Promise<unknown>;
  devtools: {
    listTargets(sessionId: string): Promise<Array<{ id: string; type: string }>>;
    newTarget(sessionId: string, url?: string): Promise<{ id: string }>;
  };
}

export interface LoginBrowserHandle {
  sessionId: string;
  targetId: string;
}

export interface MoodleCookie {
  name: string;
  value: string;
}

export interface LoginBrowser {
  open(url: string, liveViewTtlMs: number): Promise<LoginBrowserHandle & { liveViewUrl: string }>;
  // Throws when the browser is gone, so the caller can end the attempt.
  readMoodleCookie(handle: LoginBrowserHandle, moodleOrigin: string): Promise<MoodleCookie | null>;
  close(handle: LoginBrowserHandle): Promise<void>;
}

interface CdpSocket {
  accept(): void;
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export function createBrowserRunLogin(binding: BrowserRunBinding): LoginBrowser {
  async function withPage<T>(handle: LoginBrowserHandle, use: (send: CdpSend) => Promise<T>): Promise<T> {
    const connection = await binding.connectSession(handle.sessionId, { targetId: handle.targetId });
    const response = await connection.webSocket.fetch("https://browser-binding.invalid", { headers: { Upgrade: "websocket" } });
    const socket = (response as Response & { webSocket?: CdpSocket }).webSocket;
    if (!socket) throw new Error("Browser Run did not return a WebSocket.");
    socket.accept();
    try {
      return await use(cdpSender(socket));
    } finally {
      socket.close();
    }
  }

  return {
    async open(url, liveViewTtlMs) {
      const { sessionId } = await binding.acquire({ keepAlive: BROWSER_IDLE_MS });
      try {
        const targets = await binding.devtools.listTargets(sessionId);
        const targetId = targets.find((target) => target.type === "page")?.id
          ?? (await binding.devtools.newTarget(sessionId, "about:blank")).id;
        const handle = { sessionId, targetId };
        await withPage(handle, (send) => send("Page.navigate", { url }));
        const liveView = await binding.getLiveView(sessionId, { targetId, mode: "tab", expiresInMs: liveViewTtlMs });
        return { ...handle, liveViewUrl: liveView.devtoolsFrontendUrl };
      } catch (error) {
        await binding.closeSession(sessionId).catch(() => undefined);
        throw error;
      }
    },

    readMoodleCookie(handle, moodleOrigin) {
      return withPage(handle, async (send) => {
        const result = await send("Network.getCookies", { urls: [moodleOrigin] }) as { cookies?: Array<{ name?: unknown; value?: unknown }> };
        const cookie = result.cookies?.find((item) => typeof item.name === "string" && item.name.startsWith("MoodleSession"));
        return typeof cookie?.name === "string" && typeof cookie.value === "string" && cookie.value
          ? { name: cookie.name, value: cookie.value }
          : null;
      });
    },

    async close(handle) {
      await binding.closeSession(handle.sessionId).catch(() => undefined);
    },
  };
}

type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function cdpSender(socket: CdpSocket): CdpSend {
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  socket.addEventListener("message", (event) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
    } catch {
      return;
    }
    const entry = message.id === undefined ? undefined : pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id!);
    if (message.error) entry.reject(new Error(message.error.message ?? "CDP command failed."));
    else entry.resolve(message.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out.`));
    }, CDP_TIMEOUT_MS);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
